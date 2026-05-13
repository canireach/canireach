// Individual probes. Each returns a small JSON-serializable result.
// Errors are caught and reported as part of the result, never thrown — one bad
// probe must not break the cycle.
import { run, curlMetrics } from "./util";

// -------- types --------
export type WifiInfo = {
  status: "connected" | "disconnected" | "unknown";
  ssid: string | null;        // may be "<redacted>" on macOS Sequoia+
  ssidRedacted: boolean;
  bssid: string | null;
  channel: number | null;
  band: "2.4" | "5" | "6" | null;
  rssi: number | null;        // dBm, more negative = weaker
  noise: number | null;       // dBm
  txRate: number | null;      // Mbps
  phyMode: string | null;
  security: string | null;
  countryCode: string | null;
  raw?: string;
};

export type InterfaceInfo = {
  primaryService: string | null;
  primaryDevice: string | null;
  ipv4: string | null;
  gateway: string | null;
  subnetMask: string | null;
  dhcpServer: string | null;
  dhcpDns: string[];
};

export type DnsResult = {
  server: string;             // resolver IP (or "system")
  domain: string;
  ok: boolean;
  ms: number;
  ips: string[];
  flags: string | null;       // e.g. status NOERROR/SERVFAIL/NXDOMAIN
  err?: string;
};

export type PingResult = {
  target: string;
  ok: boolean;
  lossPct: number;            // 0..100
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  stddevMs: number | null;
  sent: number;
  received: number;
  err?: string;
};

export type HttpResult = {
  label: string;
  url: string;
  via: "direct" | "proxy";
  ok: boolean;
  httpCode: number;
  remoteIp: string;
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  firstByteMs: number;
  totalMs: number;
  err?: string;
  timedOut: boolean;
};

export type ProxyConfig = {
  envHttp: string | null;
  envHttps: string | null;
  envAll: string | null;
  scutil: {
    HTTPEnable: boolean;
    HTTPProxy: string | null;
    HTTPPort: number | null;
    HTTPSEnable: boolean;
    HTTPSProxy: string | null;
    HTTPSPort: number | null;
    SOCKSEnable: boolean;
    SOCKSProxy: string | null;
    SOCKSPort: number | null;
    raw: string;
  };
  listening: boolean;
  listenerProcess: string | null;
};

export type CaptiveResult = {
  ok: boolean;          // returned the expected Apple "Success" payload
  httpCode: number;
  bodyHead: string;
  redirected: boolean;
  totalMs: number;
};

// -------- WiFi --------
export async function probeWifi(): Promise<WifiInfo> {
  // `ipconfig getsummary en0` exposes SSID/BSSID without sudo on recent macOS.
  // SSID will be literal "<redacted>" unless the app has location permission.
  const r = await run("/usr/sbin/ipconfig", ["getsummary", "en0"], { timeoutMs: 3000 });
  const sp = await run("/usr/sbin/system_profiler", ["SPAirPortDataType", "-detailLevel", "basic"], { timeoutMs: 6000 });

  const text = r.stdout + "\n" + sp.stdout;
  const ssidMatch = sp.stdout.match(/Current Network Information:\s*\n\s+([^\n:]+):/);
  const bssidMatch = r.stdout.match(/BSSID\s*:\s*([^\n]+)/) ?? sp.stdout.match(/BSSID:\s*([^\n]+)/);
  const channelMatch = sp.stdout.match(/Current Network Information:[\s\S]*?Channel:\s*(\d+)\s*\((\d+)GHz/);
  const rssiMatch = sp.stdout.match(/Current Network Information:[\s\S]*?Signal\s*\/\s*Noise:\s*(-?\d+)\s*dBm\s*\/\s*(-?\d+)\s*dBm/);
  const rateMatch = sp.stdout.match(/Current Network Information:[\s\S]*?Transmit Rate:\s*(\d+)/);
  const phyMatch = sp.stdout.match(/Current Network Information:[\s\S]*?PHY Mode:\s*([^\n]+)/);
  const secMatch = sp.stdout.match(/Current Network Information:[\s\S]*?Security:\s*([^\n]+)/);
  const ccMatch = sp.stdout.match(/Country Code:\s*([A-Z]{2})/);

  const ssid = ssidMatch ? ssidMatch[1].trim() : null;
  const channelNum = channelMatch ? parseInt(channelMatch[1], 10) : null;
  const bandGhz = channelMatch ? channelMatch[2] : null;
  const band = bandGhz === "2" ? "2.4" : bandGhz === "5" ? "5" : bandGhz === "6" ? "6" : null;

  const statusMatch = sp.stdout.match(/Status:\s*(\w+)/);
  const status = statusMatch
    ? (statusMatch[1].toLowerCase() === "connected" ? "connected" : "disconnected")
    : "unknown";

  return {
    status,
    ssid,
    ssidRedacted: ssid === "<redacted>" || ssid === "redacted",
    bssid: bssidMatch ? bssidMatch[1].trim() : null,
    channel: channelNum,
    band,
    rssi: rssiMatch ? parseInt(rssiMatch[1], 10) : null,
    noise: rssiMatch ? parseInt(rssiMatch[2], 10) : null,
    txRate: rateMatch ? parseInt(rateMatch[1], 10) : null,
    phyMode: phyMatch ? phyMatch[1].trim() : null,
    security: secMatch ? secMatch[1].trim() : null,
    countryCode: ccMatch ? ccMatch[1] : null,
  };
}

// -------- Interface / route --------
export async function probeInterface(): Promise<InterfaceInfo> {
  const def = await run("/sbin/route", ["-n", "get", "default"], { timeoutMs: 2000 });
  const gateway = def.stdout.match(/gateway:\s*(\S+)/)?.[1] ?? null;
  const dev = def.stdout.match(/interface:\s*(\S+)/)?.[1] ?? null;

  const summary = dev ? await run("/usr/sbin/ipconfig", ["getsummary", dev], { timeoutMs: 2000 }) : null;
  const ipv4 = summary?.stdout.match(/Addresses\s*:\s*<array>\s*\{\s*\n\s*0\s*:\s*([\d.]+)/)?.[1] ?? null;
  const mask = summary?.stdout.match(/SubnetMasks\s*:\s*<array>\s*\{\s*\n\s*0\s*:\s*([\d.]+)/)?.[1] ?? null;
  const dhcpServer = summary?.stdout.match(/server_identifier \(ip\): ([\d.]+)/)?.[1] ?? null;
  const dnsLine = summary?.stdout.match(/domain_name_server \(ip_mult\):\s*\{([^}]*)\}/)?.[1] ?? "";
  const dhcpDns = dnsLine.split(",").map((s) => s.trim()).filter(Boolean);

  // Map device -> service name via networksetup
  const services = await run("/usr/sbin/networksetup", ["-listnetworkserviceorder"], { timeoutMs: 2000 });
  let primaryService: string | null = null;
  if (dev) {
    const re = new RegExp(String.raw`\(\d+\)\s*([^\n]+)\n\(Hardware Port:[^,]+,\s*Device:\s*${dev}\)`);
    const m = services.stdout.match(re);
    primaryService = m ? m[1].trim() : null;
  }

  return {
    primaryService,
    primaryDevice: dev,
    ipv4,
    gateway,
    subnetMask: mask,
    dhcpServer,
    dhcpDns,
  };
}

// -------- DNS --------
export async function probeDns(servers: string[], domains: string[]): Promise<DnsResult[]> {
  const tasks: Promise<DnsResult>[] = [];
  for (const server of servers) {
    for (const domain of domains) {
      tasks.push(resolveOne(server, domain));
    }
  }
  return Promise.all(tasks);
}

async function resolveOne(server: string, domain: string): Promise<DnsResult> {
  const args = server === "system"
    ? [domain, "+time=2", "+tries=1", "+stats"]
    : [`@${server}`, domain, "+time=2", "+tries=1", "+stats"];
  const r = await run("/usr/bin/dig", args, { timeoutMs: 4000 });
  const ips = [...r.stdout.matchAll(/^[^;].*\s+IN\s+A\s+([\d.]+)/gm)].map((m) => m[1]);
  const status = r.stdout.match(/status:\s*(\w+)/)?.[1] ?? null;
  const queryTime = r.stdout.match(/Query time:\s*(\d+)\s*msec/)?.[1];
  const ms = queryTime ? parseInt(queryTime, 10) : r.ms;
  return {
    server,
    domain,
    ok: r.ok && status === "NOERROR" && ips.length > 0,
    ms,
    ips,
    flags: status,
    err: r.ok ? undefined : (r.stderr.trim() || (r.timedOut ? "timeout" : `exit ${r.code}`)),
  };
}

// -------- ping --------
export async function probePings(targets: string[]): Promise<PingResult[]> {
  return Promise.all(targets.map((t) => pingOne(t)));
}

async function pingOne(target: string): Promise<PingResult> {
  const r = await run("/sbin/ping", ["-c", "3", "-W", "1500", "-i", "0.3", target], { timeoutMs: 5000 });
  const lossM = r.stdout.match(/(\d+(?:\.\d+)?)%\s*packet loss/);
  const sentRecvM = r.stdout.match(/(\d+)\s+packets transmitted,\s+(\d+)\s+(?:packets )?received/);
  const statsM = r.stdout.match(/round-trip min\/avg\/max\/stddev = ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/);
  const loss = lossM ? parseFloat(lossM[1]) : 100;
  return {
    target,
    ok: r.ok && loss < 100,
    lossPct: loss,
    sent: sentRecvM ? parseInt(sentRecvM[1], 10) : 0,
    received: sentRecvM ? parseInt(sentRecvM[2], 10) : 0,
    minMs: statsM ? parseFloat(statsM[1]) : null,
    avgMs: statsM ? parseFloat(statsM[2]) : null,
    maxMs: statsM ? parseFloat(statsM[3]) : null,
    stddevMs: statsM ? parseFloat(statsM[4]) : null,
    err: r.ok ? undefined : (r.stderr.trim() || (r.timedOut ? "timeout" : `exit ${r.code}`)),
  };
}

// -------- HTTPS --------
export type HttpTarget = {
  label: string;
  url: string;
  via: "direct" | "proxy";
  expectCode?: number[];      // accepted codes
  acceptAnyCode?: boolean;    // for API endpoints where any HTTP response = reachable
};

export async function probeHttps(targets: HttpTarget[], proxy?: string): Promise<HttpResult[]> {
  return Promise.all(
    targets.map(async (t) => {
      const m = await curlMetrics({
        url: t.url,
        proxy: t.via === "proxy" ? proxy : undefined,
        timeoutMs: 8000,
        headOnly: true,
      });
      const acceptable = t.expectCode ?? [200, 204, 301, 302, 401, 403];
      const ok = t.acceptAnyCode
        ? (m.httpCode > 0 && !m.timedOut)
        : (m.ok && acceptable.includes(m.httpCode));
      return {
        label: t.label,
        url: t.url,
        via: t.via,
        ok,
        httpCode: m.httpCode,
        remoteIp: m.remoteIp,
        dnsMs: m.timeNamelookup,
        connectMs: Math.max(0, m.timeConnect - m.timeNamelookup),
        tlsMs: Math.max(0, m.timeAppconnect - m.timeConnect),
        firstByteMs: Math.max(0, m.timeStarttransfer - m.timeAppconnect),
        totalMs: m.timeTotal,
        err: ok ? undefined : (m.errorMsg ?? `http ${m.httpCode}`),
        timedOut: m.timedOut,
      };
    }),
  );
}

// -------- proxy config + egress --------
export async function probeProxyConfig(): Promise<ProxyConfig> {
  const sc = await run("/usr/sbin/scutil", ["--proxy"], { timeoutMs: 2000 });
  const raw = sc.stdout;
  const num = (k: string) => {
    const m = raw.match(new RegExp(`${k}\\s*:\\s*(\\d+)`));
    return m ? parseInt(m[1], 10) : null;
  };
  const str = (k: string) => {
    const m = raw.match(new RegExp(`${k}\\s*:\\s*([^\\n]+)`));
    return m ? m[1].trim() : null;
  };
  const bool = (k: string) => num(k) === 1;

  // Listener check
  const ls = await run("/usr/sbin/lsof", ["-nP", "-iTCP:7897", "-sTCP:LISTEN"], { timeoutMs: 2000 });
  const listening = ls.stdout.includes("LISTEN");
  const procMatch = ls.stdout.split("\n").find((l) => l.includes("LISTEN"));
  const listenerProcess = procMatch ? procMatch.trim().split(/\s+/)[0] : null;

  return {
    envHttp: process.env.http_proxy ?? process.env.HTTP_PROXY ?? null,
    envHttps: process.env.https_proxy ?? process.env.HTTPS_PROXY ?? null,
    envAll: process.env.all_proxy ?? process.env.ALL_PROXY ?? null,
    scutil: {
      HTTPEnable: bool("HTTPEnable"),
      HTTPProxy: str("HTTPProxy"),
      HTTPPort: num("HTTPPort"),
      HTTPSEnable: bool("HTTPSEnable"),
      HTTPSProxy: str("HTTPSProxy"),
      HTTPSPort: num("HTTPSPort"),
      SOCKSEnable: bool("SOCKSEnable"),
      SOCKSProxy: str("SOCKSProxy"),
      SOCKSPort: num("SOCKSPort"),
      raw,
    },
    listening,
    listenerProcess,
  };
}

export async function probeProxyEgress(proxyUrl: string): Promise<{ ok: boolean; ip: string | null; ms: number; err?: string }> {
  // ipify is small + reliable; if it fails fall back to ifconfig.me.
  const a = await curlMetrics({ url: "https://api.ipify.org", proxy: proxyUrl, timeoutMs: 6000, captureBody: true });
  if (a.ok && a.body && /^\d+\.\d+\.\d+\.\d+$/.test(a.body.trim())) {
    return { ok: true, ip: a.body.trim(), ms: a.timeTotal };
  }
  const b = await curlMetrics({ url: "https://ifconfig.me/ip", proxy: proxyUrl, timeoutMs: 6000, captureBody: true });
  if (b.ok && b.body && /^\d+\.\d+\.\d+\.\d+$/.test(b.body.trim())) {
    return { ok: true, ip: b.body.trim(), ms: b.timeTotal };
  }
  return { ok: false, ip: null, ms: Math.max(a.timeTotal, b.timeTotal), err: a.errorMsg ?? b.errorMsg ?? "no IP returned" };
}

// -------- Captive portal --------
export async function probeCaptive(): Promise<CaptiveResult> {
  const r = await curlMetrics({
    url: "http://captive.apple.com/hotspot-detect.html",
    timeoutMs: 5000,
    captureBody: true,
  });
  const body = (r.body ?? "").slice(0, 200);
  const ok = r.httpCode === 200 && /Success/i.test(body);
  return {
    ok,
    httpCode: r.httpCode,
    bodyHead: body.replace(/\s+/g, " ").slice(0, 120),
    redirected: r.httpCode >= 300 && r.httpCode < 400,
    totalMs: r.timeTotal,
  };
}

// -------- Download speed (optional, throttled) --------
export async function probeProxyDownload(proxyUrl: string, bytes = 5_000_000, timeoutMs = 12_000): Promise<{
  ok: boolean;
  bytes: number;
  ms: number;
  mbps: number | null;
  err?: string;
}> {
  const m = await curlMetrics({
    url: `https://speed.cloudflare.com/__down?bytes=${bytes}`,
    proxy: proxyUrl,
    timeoutMs,
  });
  const ok = m.ok && m.httpCode === 200 && m.sizeDownload > bytes * 0.9;
  const mbps = m.timeTotal > 0 ? (m.sizeDownload * 8) / (m.timeTotal / 1000) / 1_000_000 : null;
  return {
    ok,
    bytes: m.sizeDownload,
    ms: m.timeTotal,
    mbps,
    err: ok ? undefined : (m.errorMsg ?? `http ${m.httpCode}`),
  };
}
