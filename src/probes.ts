// Individual probes. Each returns a small JSON-serializable result.
// Errors are caught and reported as part of the result, never thrown — one bad
// probe must not break the cycle.
import { run, curlMetrics } from "./util";

// -------- types --------
export type WifiInfo = {
  // `not_wifi` = primary route is via a wired interface; Wi-Fi may or may not be
  // physically present but is irrelevant. `no_interface` = no Wi-Fi hardware visible.
  status: "connected" | "disconnected" | "not_wifi" | "no_interface" | "unknown";
  device: string | null;      // the Wi-Fi device probed (e.g. "en0"), if any
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

export type LinkType = "wifi" | "ethernet" | "other" | "unknown";

export type TailscaleInfo = {
  installed: boolean;        // tailscaled-ish process found
  signedIn: boolean;         // a utun has a CGNAT (100.64.0.0/10) address
  exitNodeActive: boolean;   // the default route goes via that utun
  address: string | null;    // the 100.x address, if signedIn
  device: string | null;     // the utun device, e.g. "utun4"
};

export type InterfaceInfo = {
  primaryService: string | null;
  primaryDevice: string | null;
  hardwarePort: string | null;   // e.g. "Wi-Fi", "Ethernet Adapter (en3)", "Thunderbolt Bridge"
  linkType: LinkType;
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
  proxyUrl: string | null;       // detected proxy URL, or null if no proxy is configured
  proxyPort: number | null;      // port parsed from proxyUrl (for the listener check)
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

// -------- Hardware ports --------
// Parse `networksetup -listallhardwareports` once and look up port info per device.
async function parseHardwarePorts(): Promise<Map<string, string>> {
  const r = await run("/usr/sbin/networksetup", ["-listallhardwareports"], { timeoutMs: 2000 });
  const out = new Map<string, string>();
  const blocks = r.stdout.split(/\n\s*\n/);
  for (const blk of blocks) {
    const port = blk.match(/Hardware Port:\s*([^\n]+)/)?.[1]?.trim();
    const dev = blk.match(/Device:\s*(\S+)/)?.[1];
    if (port && dev) out.set(dev, port);
  }
  return out;
}

function classifyLink(hardwarePort: string | null): LinkType {
  if (!hardwarePort) return "unknown";
  const lower = hardwarePort.toLowerCase();
  if (lower.includes("wi-fi") || lower.includes("wifi") || lower.includes("airport")) return "wifi";
  if (lower.includes("ethernet") || lower.includes("lan") || lower.includes("usb 10/100")
      || lower.includes("thunderbolt bridge")) return "ethernet";
  return "other";
}

// -------- WiFi --------
export async function probeWifi(primaryDevice: string | null, ports?: Map<string, string>): Promise<WifiInfo> {
  // Empty WifiInfo helper.
  const empty = (status: WifiInfo["status"], device: string | null): WifiInfo => ({
    status, device, ssid: null, ssidRedacted: false, bssid: null, channel: null, band: null,
    rssi: null, noise: null, txRate: null, phyMode: null, security: null, countryCode: null,
  });

  const hardware = ports ?? await parseHardwarePorts();
  // Pick the Wi-Fi device dynamically. If the primary route is via a non-Wi-Fi device,
  // that's the more important fact — short-circuit with "not_wifi".
  let wifiDev: string | null = null;
  for (const [dev, port] of hardware) {
    if (classifyLink(port) === "wifi") { wifiDev = dev; break; }
  }
  if (primaryDevice && primaryDevice !== wifiDev) {
    return empty("not_wifi", wifiDev);
  }
  if (!wifiDev) return empty("no_interface", null);

  // `ipconfig getsummary <device>` exposes SSID/BSSID without sudo on recent macOS.
  // SSID will be literal "<redacted>" unless the app has location permission.
  const r = await run("/usr/sbin/ipconfig", ["getsummary", wifiDev], { timeoutMs: 3000 });
  const sp = await run("/usr/sbin/system_profiler", ["SPAirPortDataType", "-detailLevel", "basic"], { timeoutMs: 6000 });

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
  const status: WifiInfo["status"] = statusMatch
    ? (statusMatch[1].toLowerCase() === "connected" ? "connected" : "disconnected")
    : "unknown";

  return {
    status,
    device: wifiDev,
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
export async function probeInterface(ports?: Map<string, string>): Promise<InterfaceInfo> {
  const def = await run("/sbin/route", ["-n", "get", "default"], { timeoutMs: 2000 });
  const gateway = def.stdout.match(/gateway:\s*(\S+)/)?.[1] ?? null;
  const dev = def.stdout.match(/interface:\s*(\S+)/)?.[1] ?? null;

  const summary = dev ? await run("/usr/sbin/ipconfig", ["getsummary", dev], { timeoutMs: 2000 }) : null;
  const ipv4 = summary?.stdout.match(/Addresses\s*:\s*<array>\s*\{\s*\n\s*0\s*:\s*([\d.]+)/)?.[1] ?? null;
  const mask = summary?.stdout.match(/SubnetMasks\s*:\s*<array>\s*\{\s*\n\s*0\s*:\s*([\d.]+)/)?.[1] ?? null;
  const dhcpServer = summary?.stdout.match(/server_identifier \(ip\): ([\d.]+)/)?.[1] ?? null;
  const dnsLine = summary?.stdout.match(/domain_name_server \(ip_mult\):\s*\{([^}]*)\}/)?.[1] ?? "";
  const dhcpDns = dnsLine.split(",").map((s) => s.trim()).filter(Boolean);

  // Map device → hardware port (Wi-Fi, Ethernet Adapter, etc.) for link-type classification.
  const hardware = ports ?? await parseHardwarePorts();
  const hardwarePort = dev ? (hardware.get(dev) ?? null) : null;
  const linkType = classifyLink(hardwarePort);

  // Map device → service name via networksetup (used for the user-facing service label).
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
    hardwarePort,
    linkType,
    ipv4,
    gateway,
    subnetMask: mask,
    dhcpServer,
    dhcpDns,
  };
}

// -------- Tailscale --------
// Detected without depending on the `tailscale` CLI being on PATH (the Mac App Store
// build doesn't install it by default). Three signals: daemon presence, a utun with a
// CGNAT (100.64.0.0/10) address, and whether the default route uses that utun.
export async function probeTailscale(primaryDevice: string | null): Promise<TailscaleInfo> {
  const ps = await run("/bin/ps", ["-A", "-o", "comm"], { timeoutMs: 1500 });
  const installed = /tailscaled|io\.tailscale/i.test(ps.stdout);

  const ifc = await run("/sbin/ifconfig", [], { timeoutMs: 1500 });
  // Split by lines starting at column 0 (interface name) — each block is one interface.
  const blocks = ifc.stdout.split(/\n(?=\S)/);
  let device: string | null = null;
  let address: string | null = null;
  for (const blk of blocks) {
    const name = blk.match(/^(utun\d+):/)?.[1];
    if (!name) continue;
    const m = blk.match(/inet (100\.(\d+)\.\d+\.\d+)/);
    if (!m) continue;
    const second = parseInt(m[2], 10);
    if (second >= 64 && second <= 127) {        // CGNAT range
      device = name;
      address = m[1];
      break;
    }
  }
  const signedIn = !!address;
  const exitNodeActive = signedIn && primaryDevice === device;
  return { installed, signedIn, exitNodeActive, address, device };
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

// -------- proxy detection --------
// Resolution order:
//   1. CANIREACH_PROXY env override
//   2. Standard env vars (https_proxy / http_proxy / all_proxy)
//   3. macOS system proxy (`scutil --proxy`)
//   4. null  ⇒ no proxy; the verdict treats this as "skipped", not "fail"
export async function detectProxyUrl(): Promise<string | null> {
  const override = process.env.CANIREACH_PROXY?.trim();
  if (override === "none" || override === "off") return null;   // explicit opt-out
  if (override) return override;

  const env = process.env.https_proxy || process.env.HTTPS_PROXY
           || process.env.http_proxy  || process.env.HTTP_PROXY
           || process.env.all_proxy   || process.env.ALL_PROXY;
  if (env && env.trim()) return env.trim();

  const sc = await run("/usr/sbin/scutil", ["--proxy"], { timeoutMs: 2000 });
  const httpsEn = /HTTPSEnable\s*:\s*1/.test(sc.stdout);
  const httpEn  = /HTTPEnable\s*:\s*1/.test(sc.stdout);
  if (httpsEn) {
    const host = sc.stdout.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
    const port = sc.stdout.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
    if (host && port) return `http://${host}:${port}`;
  }
  if (httpEn) {
    const host = sc.stdout.match(/HTTPProxy\s*:\s*(\S+)/)?.[1];
    const port = sc.stdout.match(/HTTPPort\s*:\s*(\d+)/)?.[1];
    if (host && port) return `http://${host}:${port}`;
  }
  return null;
}

function portFromProxyUrl(url: string | null): number | null {
  if (!url) return null;
  try { return parseInt(new URL(url).port, 10) || null; } catch { return null; }
}

// -------- proxy config + egress --------
export async function probeProxyConfig(proxyUrl: string | null): Promise<ProxyConfig> {
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

  // Listener check — only run lsof if we actually have a proxy port to look at.
  let listening = false;
  let listenerProcess: string | null = null;
  const port = portFromProxyUrl(proxyUrl);
  if (port) {
    const ls = await run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { timeoutMs: 2000 });
    listening = ls.stdout.includes("LISTEN");
    const procMatch = ls.stdout.split("\n").find((l) => l.includes("LISTEN"));
    listenerProcess = procMatch ? procMatch.trim().split(/\s+/)[0] : null;
  }

  return {
    proxyUrl,
    proxyPort: port,
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
