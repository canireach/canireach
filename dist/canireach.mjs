#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// src/util.ts
import { spawn } from "node:child_process";
async function run(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const started = performance.now();
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(cmd, args, {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr,
        timedOut,
        ms: performance.now() - started
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        timedOut,
        ms: performance.now() - started
      });
    });
    if (opts.stdin) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });
}
async function curlMetrics(opts) {
  const fmt = `
__CANIREACH__
http_code=%{http_code}
namelookup=%{time_namelookup}
connect=%{time_connect}
appconnect=%{time_appconnect}
starttransfer=%{time_starttransfer}
total=%{time_total}
size=%{size_download}
remote=%{remote_ip}
`;
  const args = ["-sS", "-w", fmt];
  if (opts.headOnly)
    args.push("-I");
  if (!opts.captureBody)
    args.push("-o", "/dev/null");
  if (opts.insecure)
    args.push("-k");
  args.push("-m", String(((opts.timeoutMs ?? 8000) / 1000).toFixed(2)));
  if (opts.proxy) {
    args.push("-x", opts.proxy);
  } else {
    args.push("--noproxy", "*");
  }
  if (opts.resolve)
    args.push("--resolve", opts.resolve);
  args.push(opts.url);
  const r = await run("/usr/bin/curl", args, {
    timeoutMs: (opts.timeoutMs ?? 8000) + 1500,
    env: { http_proxy: "", https_proxy: "", all_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" }
  });
  const sentinelIdx = r.stdout.lastIndexOf(`
__CANIREACH__
`);
  const body = sentinelIdx >= 0 ? r.stdout.slice(0, sentinelIdx) : "";
  const metricsText = sentinelIdx >= 0 ? r.stdout.slice(sentinelIdx + `
__CANIREACH__
`.length) : r.stdout;
  const parsed = parseCurlWrite(metricsText);
  return {
    ok: r.ok && parsed.http_code >= 200 && parsed.http_code < 600 && parsed.http_code !== 0,
    httpCode: parsed.http_code,
    timeNamelookup: parsed.namelookup * 1000,
    timeConnect: parsed.connect * 1000,
    timeAppconnect: parsed.appconnect * 1000,
    timeStarttransfer: parsed.starttransfer * 1000,
    timeTotal: parsed.total * 1000,
    sizeDownload: parsed.size,
    remoteIp: parsed.remote,
    errorMsg: r.ok ? undefined : r.stderr.trim() || `exit ${r.code}${r.timedOut ? " (timeout)" : ""}`,
    body: opts.captureBody ? body.trim() : undefined,
    timedOut: r.timedOut
  };
}
function parseCurlWrite(text) {
  const get = (k) => {
    const m = text.match(new RegExp(`^${k}=(.+)$`, "m"));
    return m ? m[1].trim() : "";
  };
  return {
    http_code: parseInt(get("http_code") || "0", 10),
    namelookup: parseFloat(get("namelookup") || "0"),
    connect: parseFloat(get("connect") || "0"),
    appconnect: parseFloat(get("appconnect") || "0"),
    starttransfer: parseFloat(get("starttransfer") || "0"),
    total: parseFloat(get("total") || "0"),
    size: parseInt(get("size") || "0", 10),
    remote: get("remote")
  };
}
function nowIso() {
  return new Date().toISOString();
}
var init_util = () => {};

// src/probes.ts
async function parseHardwarePorts() {
  const r = await run("/usr/sbin/networksetup", ["-listallhardwareports"], { timeoutMs: 2000 });
  const out = new Map;
  const blocks = r.stdout.split(/\n\s*\n/);
  for (const blk of blocks) {
    const port = blk.match(/Hardware Port:\s*([^\n]+)/)?.[1]?.trim();
    const dev = blk.match(/Device:\s*(\S+)/)?.[1];
    if (port && dev)
      out.set(dev, port);
  }
  return out;
}
function classifyLink(hardwarePort) {
  if (!hardwarePort)
    return "unknown";
  const lower = hardwarePort.toLowerCase();
  if (lower.includes("wi-fi") || lower.includes("wifi") || lower.includes("airport"))
    return "wifi";
  if (lower.includes("ethernet") || lower.includes("lan") || lower.includes("usb 10/100") || lower.includes("thunderbolt bridge"))
    return "ethernet";
  return "other";
}
async function probeWifi(primaryDevice, ports) {
  const empty = (status2, device) => ({
    status: status2,
    device,
    ssid: null,
    ssidRedacted: false,
    bssid: null,
    channel: null,
    band: null,
    rssi: null,
    noise: null,
    txRate: null,
    phyMode: null,
    security: null,
    countryCode: null
  });
  const hardware = ports ?? await parseHardwarePorts();
  let wifiDev = null;
  for (const [dev, port] of hardware) {
    if (classifyLink(port) === "wifi") {
      wifiDev = dev;
      break;
    }
  }
  if (primaryDevice && primaryDevice !== wifiDev) {
    return empty("not_wifi", wifiDev);
  }
  if (!wifiDev)
    return empty("no_interface", null);
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
  const status = statusMatch ? statusMatch[1].toLowerCase() === "connected" ? "connected" : "disconnected" : "unknown";
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
    countryCode: ccMatch ? ccMatch[1] : null
  };
}
async function probeInterface(ports) {
  const def = await run("/sbin/route", ["-n", "get", "default"], { timeoutMs: 2000 });
  const gateway = def.stdout.match(/gateway:\s*(\S+)/)?.[1] ?? null;
  const dev = def.stdout.match(/interface:\s*(\S+)/)?.[1] ?? null;
  const summary = dev ? await run("/usr/sbin/ipconfig", ["getsummary", dev], { timeoutMs: 2000 }) : null;
  const ipv4 = summary?.stdout.match(/Addresses\s*:\s*<array>\s*\{\s*\n\s*0\s*:\s*([\d.]+)/)?.[1] ?? null;
  const mask = summary?.stdout.match(/SubnetMasks\s*:\s*<array>\s*\{\s*\n\s*0\s*:\s*([\d.]+)/)?.[1] ?? null;
  const dhcpServer = summary?.stdout.match(/server_identifier \(ip\): ([\d.]+)/)?.[1] ?? null;
  const dnsLine = summary?.stdout.match(/domain_name_server \(ip_mult\):\s*\{([^}]*)\}/)?.[1] ?? "";
  const dhcpDns = dnsLine.split(",").map((s) => s.trim()).filter(Boolean);
  const hardware = ports ?? await parseHardwarePorts();
  const hardwarePort = dev ? hardware.get(dev) ?? null : null;
  const linkType = classifyLink(hardwarePort);
  const services = await run("/usr/sbin/networksetup", ["-listnetworkserviceorder"], { timeoutMs: 2000 });
  let primaryService = null;
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
    dhcpDns
  };
}
async function probeTailscale(primaryDevice) {
  const ps = await run("/bin/ps", ["-A", "-o", "comm"], { timeoutMs: 1500 });
  const installed = /tailscaled|io\.tailscale/i.test(ps.stdout);
  const ifc = await run("/sbin/ifconfig", [], { timeoutMs: 1500 });
  const blocks = ifc.stdout.split(/\n(?=\S)/);
  let device = null;
  let address = null;
  for (const blk of blocks) {
    const name = blk.match(/^(utun\d+):/)?.[1];
    if (!name)
      continue;
    const m = blk.match(/inet (100\.(\d+)\.\d+\.\d+)/);
    if (!m)
      continue;
    const second = parseInt(m[2], 10);
    if (second >= 64 && second <= 127) {
      device = name;
      address = m[1];
      break;
    }
  }
  const signedIn = !!address;
  const exitNodeActive = signedIn && primaryDevice === device;
  return { installed, signedIn, exitNodeActive, address, device };
}
async function probeDns(servers, domains) {
  const tasks = [];
  for (const server of servers) {
    for (const domain of domains) {
      tasks.push(resolveOne(server, domain));
    }
  }
  return Promise.all(tasks);
}
async function resolveOne(server, domain) {
  const args = server === "system" ? [domain, "+time=2", "+tries=1", "+stats"] : [`@${server}`, domain, "+time=2", "+tries=1", "+stats"];
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
    err: r.ok ? undefined : r.stderr.trim() || (r.timedOut ? "timeout" : `exit ${r.code}`)
  };
}
async function probePings(targets) {
  return Promise.all(targets.map((t) => pingOne(t)));
}
async function pingOne(target) {
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
    err: r.ok ? undefined : r.stderr.trim() || (r.timedOut ? "timeout" : `exit ${r.code}`)
  };
}
async function probeHttps(targets, proxy) {
  return Promise.all(targets.map(async (t) => {
    const m = await curlMetrics({
      url: t.url,
      proxy: t.via === "proxy" ? proxy : undefined,
      timeoutMs: 8000,
      headOnly: true
    });
    const acceptable = t.expectCode ?? [200, 204, 301, 302, 401, 403];
    const ok = t.acceptAnyCode ? m.httpCode > 0 && !m.timedOut : m.ok && acceptable.includes(m.httpCode);
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
      err: ok ? undefined : m.errorMsg ?? `http ${m.httpCode}`,
      timedOut: m.timedOut
    };
  }));
}
async function detectProxyUrl() {
  const override = process.env.CANIREACH_PROXY?.trim();
  if (override === "none" || override === "off")
    return null;
  if (override)
    return override;
  const env = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || process.env.all_proxy || process.env.ALL_PROXY;
  if (env && env.trim())
    return env.trim();
  const sc = await run("/usr/sbin/scutil", ["--proxy"], { timeoutMs: 2000 });
  const httpsEn = /HTTPSEnable\s*:\s*1/.test(sc.stdout);
  const httpEn = /HTTPEnable\s*:\s*1/.test(sc.stdout);
  if (httpsEn) {
    const host = sc.stdout.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
    const port = sc.stdout.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
    if (host && port)
      return `http://${host}:${port}`;
  }
  if (httpEn) {
    const host = sc.stdout.match(/HTTPProxy\s*:\s*(\S+)/)?.[1];
    const port = sc.stdout.match(/HTTPPort\s*:\s*(\d+)/)?.[1];
    if (host && port)
      return `http://${host}:${port}`;
  }
  return null;
}
function portFromProxyUrl(url) {
  if (!url)
    return null;
  try {
    return parseInt(new URL(url).port, 10) || null;
  } catch {
    return null;
  }
}
async function probeProxyConfig(proxyUrl) {
  const sc = await run("/usr/sbin/scutil", ["--proxy"], { timeoutMs: 2000 });
  const raw = sc.stdout;
  const num = (k) => {
    const m = raw.match(new RegExp(`${k}\\s*:\\s*(\\d+)`));
    return m ? parseInt(m[1], 10) : null;
  };
  const str = (k) => {
    const m = raw.match(new RegExp(`${k}\\s*:\\s*([^\\n]+)`));
    return m ? m[1].trim() : null;
  };
  const bool = (k) => num(k) === 1;
  let listening = false;
  let listenerProcess = null;
  const port = portFromProxyUrl(proxyUrl);
  if (port) {
    const ls = await run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { timeoutMs: 2000 });
    listening = ls.stdout.includes("LISTEN");
    const procMatch = ls.stdout.split(`
`).find((l) => l.includes("LISTEN"));
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
      raw
    },
    listening,
    listenerProcess
  };
}
async function probeProxyEgress(proxyUrl) {
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
async function probeCaptive() {
  const r = await curlMetrics({
    url: "http://captive.apple.com/hotspot-detect.html",
    timeoutMs: 5000,
    captureBody: true
  });
  const body = (r.body ?? "").slice(0, 200);
  const ok = r.httpCode === 200 && /Success/i.test(body);
  return {
    ok,
    httpCode: r.httpCode,
    bodyHead: body.replace(/\s+/g, " ").slice(0, 120),
    redirected: r.httpCode >= 300 && r.httpCode < 400,
    totalMs: r.timeTotal
  };
}
async function probeProxyDownload(proxyUrl, bytes = 5000000, timeoutMs = 12000) {
  const m = await curlMetrics({
    url: `https://speed.cloudflare.com/__down?bytes=${bytes}`,
    proxy: proxyUrl,
    timeoutMs
  });
  const ok = m.ok && m.httpCode === 200 && m.sizeDownload > bytes * 0.9;
  const mbps = m.timeTotal > 0 ? m.sizeDownload * 8 / (m.timeTotal / 1000) / 1e6 : null;
  return {
    ok,
    bytes: m.sizeDownload,
    ms: m.timeTotal,
    mbps,
    err: ok ? undefined : m.errorMsg ?? `http ${m.httpCode}`
  };
}
var init_probes = __esm(() => {
  init_util();
});

// src/verdict.ts
function judge(s) {
  const layers = [];
  const w = s.wifi;
  const linkType = s.iface?.linkType ?? "unknown";
  const wifiReasons = [];
  let wifiState = "ok";
  if (linkType === "ethernet" || linkType === "other") {
    wifiState = "skipped";
    wifiReasons.push(`primary link is ${linkType}${s.iface?.hardwarePort ? ` (${s.iface.hardwarePort})` : ""}`);
  } else if (!w || w.status === "not_wifi") {
    wifiState = "skipped";
    wifiReasons.push("primary link is not Wi-Fi");
  } else if (w.status === "no_interface") {
    wifiState = "skipped";
    wifiReasons.push("no Wi-Fi interface");
  } else if (w.status !== "connected") {
    wifiState = "fail";
    wifiReasons.push(`status=${w.status}`);
  } else {
    if (w.rssi !== null) {
      if (w.rssi <= -80) {
        wifiState = "fail";
        wifiReasons.push(`weak signal ${w.rssi}dBm`);
      } else if (w.rssi <= -70) {
        wifiState = "degraded";
        wifiReasons.push(`marginal signal ${w.rssi}dBm`);
      }
    }
    if (w.txRate !== null && w.txRate < 50) {
      wifiState = worse(wifiState, "degraded");
      wifiReasons.push(`low tx rate ${w.txRate}Mbps`);
    }
  }
  layers.push({
    layer: "wifi",
    state: wifiState,
    reasons: wifiReasons,
    metrics: w ? { rssi: w.rssi, noise: w.noise, channel: w.channel, txRate: w.txRate, ssid: w.ssidRedacted ? "<redacted>" : w.ssid, linkType } : { linkType }
  });
  const gwPing = s.pings.find((p) => p.target === s.iface?.gateway);
  const lanReasons = [];
  let lanState = "ok";
  if (!s.iface?.gateway) {
    lanState = "unknown";
    lanReasons.push("no gateway");
  } else if (!gwPing) {
    lanState = "unknown";
    lanReasons.push("no gateway ping result");
  } else if (!gwPing.ok) {
    lanState = "fail";
    lanReasons.push(`gw ping loss=${gwPing.lossPct}%`);
  } else if ((gwPing.avgMs ?? 0) > 30) {
    lanState = "degraded";
    lanReasons.push(`gw rtt ${gwPing.avgMs?.toFixed(1)}ms`);
  }
  layers.push({
    layer: "lan",
    state: lanState,
    reasons: lanReasons,
    metrics: { gateway: s.iface?.gateway ?? null, avgMs: gwPing?.avgMs ?? null, loss: gwPing?.lossPct ?? null }
  });
  const bbReasons = [];
  let bbState = "ok";
  if (lanState === "fail") {
    bbState = "skipped";
    bbReasons.push("LAN fail → cannot judge");
  } else {
    const aliPing = s.pings.find((p) => p.target === "223.5.5.5");
    const baiduHttps = s.https.find((h) => h.label === "baidu_direct");
    const baiduDns = s.dns.find((d) => d.domain === "baidu.com" && d.server === "223.5.5.5");
    if (!aliPing || !aliPing.ok) {
      bbState = "fail";
      bbReasons.push("ping 223.5.5.5 fail");
    }
    if (baiduDns && !baiduDns.ok) {
      bbState = worse(bbState, "fail");
      bbReasons.push("dig baidu via 223.5.5.5 fail");
    }
    if (baiduHttps && !baiduHttps.ok) {
      bbState = worse(bbState, "fail");
      bbReasons.push(`baidu https fail: ${baiduHttps.err}`);
    } else if (baiduHttps && baiduHttps.totalMs > 1500) {
      bbState = worse(bbState, "degraded");
      bbReasons.push(`baidu slow ${baiduHttps.totalMs.toFixed(0)}ms`);
    }
  }
  layers.push({
    layer: "broadband",
    state: bbState,
    reasons: bbReasons,
    metrics: {}
  });
  const overseasReasons = [];
  let overseasState = "ok";
  if (bbState === "fail" || bbState === "skipped") {
    overseasState = "skipped";
    overseasReasons.push("broadband fail → cannot judge");
  } else {
    const probes = s.https.filter((h) => h.via === "direct" && !["baidu_direct", "taobao_direct", "anthropic_direct", "openai_direct"].includes(h.label));
    const okCount = probes.filter((h) => h.ok).length;
    if (probes.length === 0)
      overseasState = "unknown";
    else if (okCount === 0) {
      overseasState = "fail";
      overseasReasons.push("all direct overseas fail (blocked)");
    } else if (okCount < probes.length) {
      overseasState = "degraded";
      overseasReasons.push(`${okCount}/${probes.length} direct overseas ok`);
    }
  }
  layers.push({
    layer: "overseas_direct",
    state: overseasState,
    reasons: overseasReasons,
    metrics: {}
  });
  const proxyReasons = [];
  let proxyState = "ok";
  const proxyConfigured = !!s.proxyConfig.proxyUrl;
  if (!proxyConfigured) {
    proxyState = "skipped";
    proxyReasons.push("no proxy configured");
  } else if (!s.proxyConfig.listening) {
    proxyState = "fail";
    const port = s.proxyConfig.proxyPort;
    proxyReasons.push(port ? `proxy port ${port} not listening` : "proxy not listening");
  } else {
    const viaProxy = s.https.filter((h) => h.via === "proxy");
    const okCount = viaProxy.filter((h) => h.ok).length;
    if (viaProxy.length === 0) {
      proxyState = "unknown";
      proxyReasons.push("no proxy HTTPS probes");
    } else if (okCount === 0) {
      proxyState = "fail";
      proxyReasons.push("all proxy HTTPS fail");
    } else if (okCount < viaProxy.length) {
      proxyState = "degraded";
      proxyReasons.push(`${okCount}/${viaProxy.length} proxy targets ok`);
    }
    if (s.proxyEgress && !s.proxyEgress.ok) {
      proxyState = worse(proxyState, "degraded");
      proxyReasons.push(`egress fetch failed: ${s.proxyEgress.err ?? "unknown"}`);
    }
    const sc = s.proxyConfig.scutil;
    const expectedPort = s.proxyConfig.proxyPort;
    if (sc.HTTPEnable && sc.HTTPProxy === "127.0.0.1" && expectedPort && sc.HTTPPort !== expectedPort) {
      proxyState = worse(proxyState, "degraded");
      proxyReasons.push(`system HTTP proxy port ${sc.HTTPPort} ≠ active ${expectedPort}`);
    }
  }
  layers.push({
    layer: "proxy",
    state: proxyState,
    reasons: proxyReasons,
    metrics: {
      configured: proxyConfigured,
      proxyUrl: s.proxyConfig.proxyUrl,
      listening: s.proxyConfig.listening,
      egressIp: s.proxyEgress?.ip ?? null,
      listenerProcess: s.proxyConfig.listenerProcess
    }
  });
  const aiReasons = [];
  const ant_d = s.https.find((h) => h.label === "anthropic_direct");
  const ant_p = s.https.find((h) => h.label === "anthropic_proxy");
  const oai_d = s.https.find((h) => h.label === "openai_direct");
  const oai_p = s.https.find((h) => h.label === "openai_proxy");
  const proxyOk = (h) => !!(h && h.ok);
  const directOk = (h) => !!(h && h.ok);
  const proxyHits = [proxyOk(ant_p), proxyOk(oai_p)].filter(Boolean).length;
  const directHits = [directOk(ant_d), directOk(oai_d)].filter(Boolean).length;
  const noProxy = !s.proxyConfig.proxyUrl;
  let aiState;
  let aiHeadline;
  if (noProxy) {
    if (directHits === 2) {
      aiState = "direct_only";
      aiHeadline = "Anthropic & OpenAI reachable directly (no proxy in use)";
    } else if (directHits === 1) {
      aiState = "degraded";
      const okName = directOk(ant_d) ? "Anthropic" : "OpenAI";
      const failName = directOk(ant_d) ? "OpenAI" : "Anthropic";
      aiHeadline = `Only ${okName} reachable; ${failName} direct failed (no proxy configured)`;
      aiReasons.push(`${failName} direct: ${(directOk(ant_d) ? oai_d : ant_d)?.err ?? "unknown"}`);
    } else {
      aiState = "fail";
      aiHeadline = "Anthropic & OpenAI both unreachable directly; no proxy configured to fall back on";
    }
  } else if (proxyState === "fail" && !ant_d?.ok && !oai_d?.ok) {
    aiState = "skipped";
    aiHeadline = "代理挂了且直连也不通，无法判断";
  } else if (proxyHits === 2 && directHits >= 1) {
    aiState = "ok";
    aiHeadline = `Anthropic & OpenAI 均可达（代理稳定，部分直连也通：${directHits}/2）`;
  } else if (proxyHits === 2) {
    aiState = "proxy_only";
    aiHeadline = "Anthropic & OpenAI 通过代理可达，直连均被屏蔽";
  } else if (proxyHits === 1) {
    aiState = "degraded";
    const okName = proxyOk(ant_p) ? "Anthropic" : "OpenAI";
    const failName = proxyOk(ant_p) ? "OpenAI" : "Anthropic";
    aiHeadline = `仅 ${okName} 代理可达；${failName} 代理失败`;
    aiReasons.push(`${failName} via proxy: ${(proxyOk(ant_p) ? oai_p : ant_p)?.err ?? "unknown"}`);
  } else if (directHits > 0) {
    aiState = "direct_only";
    aiHeadline = "代理路径失败，但仍有部分直连可达 — 代理 App 异常";
  } else {
    aiState = "fail";
    aiHeadline = "Anthropic 与 OpenAI 均不可达（代理 & 直连都失败）";
  }
  layers.push({
    layer: "ai",
    state: aiState === "ok" || aiState === "proxy_only" || aiState === "direct_only" ? "ok" : aiState === "degraded" ? "degraded" : aiState === "fail" ? "fail" : aiState === "skipped" ? "skipped" : "unknown",
    reasons: aiReasons,
    metrics: {
      anthropic_proxy_ok: !!ant_p?.ok,
      openai_proxy_ok: !!oai_p?.ok,
      anthropic_direct_ok: !!ant_d?.ok,
      openai_direct_ok: !!oai_d?.ok
    }
  });
  let overall;
  let headline;
  if (wifiState === "fail") {
    overall = "wifi_bad";
    headline = wifiReasons.join("; ");
  } else if (lanState === "fail") {
    overall = "lan_bad";
    headline = lanReasons.join("; ");
  } else if (bbState === "fail") {
    overall = "broadband_bad";
    headline = bbReasons.join("; ");
  } else if (proxyState === "fail") {
    overall = "proxy_bad";
    headline = proxyReasons.join("; ");
  } else if (overseasState === "fail" && proxyState === "ok") {
    overall = "direct_blocked_proxy_ok";
    headline = "direct overseas blocked, proxy works";
  } else if ([wifiState, lanState, bbState, proxyState].some((s2) => s2 === "degraded")) {
    overall = "degraded";
    headline = layers.filter((l) => l.state === "degraded" && l.layer !== "ai").flatMap((l) => l.reasons).join("; ") || "some checks slow";
  } else {
    overall = "healthy";
    headline = "all green";
  }
  return { overall, headline, layers, ai: { state: aiState, headline: aiHeadline } };
}
function worse(a, b) {
  const rank = { ok: 0, degraded: 1, fail: 2, unknown: 0, skipped: 0 };
  return rank[b] > rank[a] ? b : a;
}

// src/probe.ts
var exports_probe = {};
__export(exports_probe, {
  collectSample: () => collectSample
});
async function collectSample(opts = {}) {
  const started = performance.now();
  const iface = await probeInterface().catch(() => null);
  const gateway = iface?.gateway ?? null;
  const pingTargets = gateway ? [gateway, ...PING_TARGETS_BASE] : PING_TARGETS_BASE.slice();
  const proxyUrl = await detectProxyUrl().catch(() => null);
  const httpsTargets = proxyUrl ? [...HTTPS_DIRECT, ...HTTPS_VIA_PROXY] : HTTPS_DIRECT;
  const [wifi, tailscale, dns, pings, https, proxyConfig, proxyEgress, captive] = await Promise.all([
    probeWifi(iface?.primaryDevice ?? null).catch(() => null),
    probeTailscale(iface?.primaryDevice ?? null).catch(() => null),
    probeDns(DNS_SERVERS, DNS_DOMAINS).catch(() => []),
    probePings(pingTargets).catch(() => []),
    probeHttps(httpsTargets, proxyUrl ?? undefined).catch(() => []),
    probeProxyConfig(proxyUrl).catch(() => emptyProxyConfig(proxyUrl)),
    proxyUrl ? probeProxyEgress(proxyUrl).catch((e) => ({ ok: false, ip: null, ms: 0, err: String(e) })) : Promise.resolve(null),
    probeCaptive().catch(() => null)
  ]);
  const proxyDownload = opts.withDownload && proxyUrl ? await probeProxyDownload(proxyUrl).catch((e) => ({ ok: false, bytes: 0, ms: 0, mbps: null, err: String(e) })) : null;
  const partial = {
    t: nowIso(),
    cycleMs: performance.now() - started,
    wifi,
    iface,
    tailscale,
    dns,
    pings,
    https,
    proxyConfig,
    proxyEgress,
    captive,
    proxyDownload
  };
  const verdict = judge(partial);
  return { ...partial, verdict };
}
function emptyProxyConfig(proxyUrl) {
  return {
    proxyUrl,
    proxyPort: null,
    envHttp: null,
    envHttps: null,
    envAll: null,
    scutil: { HTTPEnable: false, HTTPProxy: null, HTTPPort: null, HTTPSEnable: false, HTTPSProxy: null, HTTPSPort: null, SOCKSEnable: false, SOCKSProxy: null, SOCKSPort: null, raw: "" },
    listening: false,
    listenerProcess: null
  };
}
var DNS_SERVERS, DNS_DOMAINS, PING_TARGETS_BASE, HTTPS_DIRECT, HTTPS_VIA_PROXY;
var init_probe = __esm(async () => {
  init_probes();
  init_util();
  DNS_SERVERS = ["system", "223.5.5.5", "119.29.29.29", "8.8.8.8", "1.1.1.1"];
  DNS_DOMAINS = ["baidu.com", "google.com", "github.com", "cloudflare.com"];
  PING_TARGETS_BASE = ["223.5.5.5", "119.29.29.29", "1.1.1.1", "8.8.8.8"];
  HTTPS_DIRECT = [
    { label: "baidu_direct", url: "https://www.baidu.com", via: "direct" },
    { label: "taobao_direct", url: "https://www.taobao.com", via: "direct" },
    { label: "google_direct", url: "https://www.google.com", via: "direct" },
    { label: "cloudflare_direct", url: "https://www.cloudflare.com", via: "direct" },
    { label: "github_direct", url: "https://github.com", via: "direct" },
    { label: "anthropic_direct", url: "https://api.anthropic.com/", via: "direct", acceptAnyCode: true },
    { label: "openai_direct", url: "https://api.openai.com/", via: "direct", acceptAnyCode: true }
  ];
  HTTPS_VIA_PROXY = [
    { label: "google_proxy", url: "https://www.google.com", via: "proxy" },
    { label: "cloudflare_proxy", url: "https://www.cloudflare.com", via: "proxy" },
    { label: "github_proxy", url: "https://github.com", via: "proxy" },
    { label: "youtube_proxy", url: "https://www.youtube.com", via: "proxy" },
    { label: "anthropic_proxy", url: "https://api.anthropic.com/", via: "proxy", acceptAnyCode: true },
    { label: "openai_proxy", url: "https://api.openai.com/", via: "proxy", acceptAnyCode: true }
  ];
  if (false) {}
});

// src/tui.ts
var exports_tui = {};
__export(exports_tui, {
  runTui: () => runTui
});
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
function chWidth(cp) {
  if (cp === 0)
    return 0;
  if (cp < 32 || cp >= 127 && cp < 160)
    return 0;
  if (cp >= 4352 && (cp <= 4447 || cp === 9001 || cp === 9002 || cp >= 11904 && cp <= 42191 && cp !== 12351 || cp >= 44032 && cp <= 55203 || cp >= 63744 && cp <= 64255 || cp >= 65072 && cp <= 65103 || cp >= 65280 && cp <= 65376 || cp >= 65504 && cp <= 65510))
    return 2;
  return 1;
}
function visWidth(s) {
  const noAnsi = s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  let w = 0;
  for (const ch of noAnsi)
    w += chWidth(ch.codePointAt(0));
  return w;
}
function padEndVis(s, n) {
  return s + " ".repeat(Math.max(0, n - visWidth(s)));
}
function tpl(s, p) {
  for (const [k, v] of Object.entries(p))
    s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
function pickLang() {
  if (process.env.CANIREACH_LANG === "zh")
    return "zh";
  if (process.env.CANIREACH_LANG === "en")
    return "en";
  const sys = (process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || "").toLowerCase();
  return sys.startsWith("zh") ? "zh" : "en";
}
function stateBucket(st) {
  return st === "ok" ? "ok" : st === "degraded" ? "warn" : st === "fail" ? "bad" : st === "skipped" ? "skipped" : "unknown";
}
function overallBucket(v) {
  if (v === "healthy")
    return "ok";
  if (v === "direct_blocked_proxy_ok")
    return "restricted";
  if (v === "degraded")
    return "warn";
  if (v === "unknown")
    return "unknown";
  return "bad";
}
function overseasBucket(s, st) {
  if (st === "fail" && s.verdict?.layers?.find((l) => l.layer === "proxy")?.state === "ok")
    return "restricted";
  return stateBucket(st);
}
function colorize(bucket, text) {
  const col = COLOR[bucket] ?? COLOR.unknown;
  return col + text + RESET;
}
function dot(bucket) {
  return colorize(bucket, "●");
}
function icon(bucket) {
  return colorize(bucket, ICON[bucket] ?? "·");
}
function render() {
  const out = [];
  const D = T[lang];
  const w = Math.min(process.stdout.columns || 100, 110);
  const sep = COLOR.muted + "─".repeat(Math.min(w, 100)) + RESET;
  const updated = samples.length ? new Date(samples[samples.length - 1].t).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-GB", { hour12: false }) : "—";
  const cycle = tpl(D.cycle, { n: samples.length });
  const spinner = probing ? "  " + COLOR.info + SPINNER[spinFrame % SPINNER.length] + " " + D.probing + RESET : "";
  const modeTag = COLOR.muted + "  · " + (mode === "follow" ? D.modeFollow : D.modeProbe) + RESET;
  const ts = samples[samples.length - 1]?.tailscale;
  let tsText = "";
  if (ts?.exitNodeActive)
    tsText = "  ·  " + tpl(D.tsExitNode, { addr: ts.address ?? "?" });
  else if (ts?.signedIn)
    tsText = "  ·  " + tpl(D.tsSignedIn, { addr: ts.address ?? "?" });
  out.push(BOLD + D.title + RESET + spinner + modeTag);
  out.push(COLOR.muted + `${D.updated} ${updated}  ·  ${cycle}${tsText}` + RESET);
  out.push("");
  if (samples.length === 0) {
    out.push(COLOR.muted + D.waiting + RESET);
    out.push("");
    out.push(COLOR.muted + D.keys + RESET);
    return out.join(`
`);
  }
  const latest = samples[samples.length - 1];
  const ver = latest.verdict;
  const netB = overallBucket(ver.overall);
  out.push(icon(netB) + "  " + BOLD + padEndVis(D.netLabel, 10) + RESET + colorize(netB, D.netTitle[ver.overall] ?? ver.overall));
  out.push(COLOR.muted + "    " + (D.netSub[ver.overall] ?? "") + RESET);
  out.push("");
  const aiState = ver.ai?.state ?? "unknown";
  const aiB = aiState === "ok" || aiState === "proxy_only" ? "ok" : aiState === "degraded" || aiState === "direct_only" ? "warn" : aiState === "fail" ? "bad" : "unknown";
  let aiSub;
  if (aiState === "ok") {
    const n = ["anthropic_direct", "openai_direct"].filter((lbl) => latest.https?.find((h) => h.label === lbl)?.ok).length;
    aiSub = tpl(D.aiSub.ok, { n });
  } else if (aiState === "degraded") {
    const aP = latest.https?.find((h) => h.label === "anthropic_proxy")?.ok;
    aiSub = tpl(D.aiSub.degraded, { ok: aP ? "Anthropic" : "OpenAI", fail: aP ? "OpenAI" : "Anthropic" });
  } else {
    aiSub = D.aiSub[aiState] ?? "";
  }
  out.push(icon(aiB) + "  " + BOLD + padEndVis(D.aiLabel, 10) + RESET + colorize(aiB, D.aiTitle[aiState] ?? aiState));
  out.push(COLOR.muted + "    " + aiSub + RESET);
  out.push("");
  out.push(BOLD + D.secLayers + RESET);
  for (const key of ["wifi", "lan", "broadband", "overseas_direct", "proxy", "ai"]) {
    const layer = ver.layers.find((l) => l.layer === key);
    const st = layer?.state ?? "unknown";
    const bucket = key === "overseas_direct" ? overseasBucket(latest, st) : stateBucket(st);
    const sw = D.sw[bucket] ?? "—";
    const metric = layerMetric(latest, key);
    out.push(`  ${dot(bucket)} ${padEndVis(D.layer[key], 12)} ${colorize(bucket, padEndVis(sw, 12))}${COLOR.muted}${metric}${RESET}`);
  }
  out.push("");
  const tlWidth = Math.max(20, Math.min(80, w - 18));
  const window = samples.slice(-tlWidth);
  out.push(BOLD + tpl(D.secTimeline, { n: window.length }) + RESET);
  const rows = [
    { key: "overall", series: window.map((s) => overallBucket(s.verdict.overall)) },
    { key: "wifi", series: window.map((s) => stateBucket(s.verdict.layers.find((l) => l.layer === "wifi")?.state)) },
    { key: "lan", series: window.map((s) => stateBucket(s.verdict.layers.find((l) => l.layer === "lan")?.state)) },
    { key: "broadband", series: window.map((s) => stateBucket(s.verdict.layers.find((l) => l.layer === "broadband")?.state)) },
    { key: "overseas_direct", series: window.map((s) => overseasBucket(s, s.verdict.layers.find((l) => l.layer === "overseas_direct")?.state ?? "unknown")) },
    { key: "proxy", series: window.map((s) => stateBucket(s.verdict.layers.find((l) => l.layer === "proxy")?.state)) }
  ];
  for (const r of rows) {
    const cells = r.series.map((b) => (CELL_BG[b ?? "unknown"] ?? CELL_BG.unknown) + " " + RESET).join("");
    out.push(`  ${padEndVis(D.timeline[r.key], 14)} ${cells}`);
  }
  out.push("");
  out.push(BOLD + D.secPing + RESET);
  const pingTargets = [
    [D.metric.gw, latest.iface?.gateway ?? "—"],
    ["223.5.5.5", "223.5.5.5"],
    ["1.1.1.1", "1.1.1.1"],
    ["8.8.8.8", "8.8.8.8"]
  ];
  for (const [label, target] of pingTargets) {
    const valNow = samples.slice(-1).map((s) => s.pings.find((p) => p.target === target));
    const vals = samples.slice(-20).map((s) => s.pings.find((p) => p.target === target));
    const last = valNow[0];
    const oks = vals.filter((p) => p?.ok && p.avgMs != null).map((p) => p.avgMs).sort((a, b) => a - b);
    const p95 = oks.length ? oks[Math.min(oks.length - 1, Math.floor(oks.length * 0.95))] : null;
    const losses = vals.filter((p) => p && !p.ok).length;
    const lossPct = vals.length ? losses / vals.length * 100 : 0;
    const cur = last?.ok ? `${Math.round(last.avgMs ?? 0)} ms` : COLOR.bad + D.metric.loss + RESET;
    const p95Txt = p95 != null ? `${Math.round(p95)} ms` : "—";
    const lossTxt = lossPct > 0 ? COLOR.warn + ` · ${lossPct.toFixed(0)}% ${D.metric.loss}` + RESET : "";
    out.push(`  ${padEndVis(label, 14)} ${padEndVis(cur, 10)} ${COLOR.muted}p95${RESET} ${p95Txt}${lossTxt}`);
  }
  out.push("");
  const aiLabels = ["anthropic_proxy", "anthropic_direct", "openai_proxy", "openai_direct"];
  const tail = samples.slice(-20);
  out.push(BOLD + tpl(D.secAi, { n: tail.length }) + RESET);
  for (const lbl of aiLabels) {
    const hits = tail.map((s) => s.https.find((h) => h.label === lbl));
    const ok = hits.filter((h) => h?.ok).length;
    const total = hits.length;
    const avgs = hits.filter((h) => h?.ok && h.totalMs != null).map((h) => h.totalMs);
    const avg = avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null;
    const okCol = ok === total ? COLOR.ok : ok === 0 ? COLOR.bad : COLOR.warn;
    out.push(`  ${padEndVis(lbl, 20)} ${okCol}${ok}/${total}${RESET}  ${COLOR.muted}${avg != null ? Math.round(avg) + " ms" : "—"}${RESET}`);
  }
  out.push("");
  const counts = {};
  for (const s of tail) {
    const ip = s.proxyEgress?.ip;
    if (ip)
      counts[ip] = (counts[ip] || 0) + 1;
  }
  const ipList = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([ip, n]) => `${ip} ×${n}`).join("  ");
  out.push(BOLD + D.secEgress + RESET + "  " + COLOR.muted + (ipList || "—") + RESET);
  out.push("");
  out.push(COLOR.muted + D.keys + RESET);
  return out.join(`
`);
}
function latestProxyMbps() {
  for (let i = samples.length - 1;i >= 0; i--) {
    const d = samples[i].proxyDownload;
    if (d?.ok && d.mbps != null)
      return d.mbps;
  }
  return null;
}
function fmtMbps(mbps) {
  return mbps >= 10 ? Math.round(mbps).toString() : mbps.toFixed(1);
}
function layerMetric(s, key) {
  const D = T[lang];
  switch (key) {
    case "wifi": {
      const linkType = s.iface?.linkType;
      if (linkType === "ethernet" || linkType === "other") {
        return s.iface?.hardwarePort || D.metric.linkEthernet || "Ethernet";
      }
      if (s.wifi?.status === "no_interface")
        return D.metric.linkNone || "no Wi-Fi";
      if (s.wifi?.status === "not_wifi")
        return D.metric.linkOther || "Wired";
      return s.wifi ? `${s.wifi.rssi ?? "?"} dBm · ${s.wifi.txRate ?? "?"} Mbps` : "—";
    }
    case "lan": {
      const gw = s.iface?.gateway;
      const p = s.pings.find((x) => x.target === gw);
      if (!gw)
        return "—";
      const short = gw.split(".").slice(-2).join(".");
      return `${short} · ${p?.ok ? Math.round(p.avgMs) + " ms" : D.metric.loss}`;
    }
    case "broadband": {
      const b = s.https.find((h) => h.label === "baidu_direct");
      return b ? `${D.metric.baidu} ${b.ok ? Math.round(b.totalMs) + " ms" : "fail"}` : "—";
    }
    case "overseas_direct": {
      const direct = s.https.filter((h) => h.via === "direct" && !["baidu_direct", "taobao_direct", "anthropic_direct", "openai_direct"].includes(h.label));
      const ok = direct.filter((h) => h.ok).length;
      return tpl(D.metric.reachable, { n: ok, total: direct.length });
    }
    case "proxy": {
      if (s.proxyConfig && s.proxyConfig.proxyUrl === null)
        return D.metric.proxyNone || "no proxy configured";
      const eg = s.proxyEgress?.ip;
      if (eg) {
        const mbps = latestProxyMbps();
        return mbps != null ? `${D.metric.egress} ${eg} · ${fmtMbps(mbps)} Mbps` : `${D.metric.egress} ${eg}`;
      }
      return s.proxyConfig?.listening ? D.metric.listening : D.metric.notListening;
    }
    case "ai": {
      if (s.proxyConfig && s.proxyConfig.proxyUrl === null) {
        const aD = s.https.find((h) => h.label === "anthropic_direct")?.ok;
        const oD = s.https.find((h) => h.label === "openai_direct")?.ok;
        return `direct A=${aD ? "✓" : "✕"} O=${oD ? "✓" : "✕"}`;
      }
      const aP = s.https.find((h) => h.label === "anthropic_proxy")?.ok;
      const oP = s.https.find((h) => h.label === "openai_proxy")?.ok;
      return `proxy A=${aP ? "✓" : "✕"} O=${oP ? "✓" : "✕"}`;
    }
  }
}
function draw() {
  process.stdout.write(CLEAR);
  process.stdout.write(render());
  process.stdout.write(`
`);
}
function scheduleDraw() {
  if (drawTimer)
    return;
  drawTimer = setTimeout(() => {
    drawTimer = null;
    draw();
  }, 50);
}
async function loadSamplesTail(limit = 240) {
  if (!existsSync(SAMPLES_PATH))
    return [];
  try {
    const text = await readFile(SAMPLES_PATH, "utf8");
    const lines = text.trim().split(`
`).slice(-limit);
    const out = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l));
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}
async function daemonAlive() {
  if (!existsSync(STATE_PATH))
    return false;
  try {
    const text = await readFile(STATE_PATH, "utf8");
    const state = JSON.parse(text);
    const updatedAt = new Date(state.updatedAt ?? 0).getTime();
    const interval = state.interval_ms ?? 60000;
    return Date.now() - updatedAt < interval * 3;
  } catch {
    return false;
  }
}
async function probeOnce() {
  probeCycle++;
  const withDownload = DOWNLOAD_EVERY > 0 && probeCycle % DOWNLOAD_EVERY === 1;
  probing = true;
  scheduleDraw();
  try {
    const s = await collectSample({ withDownload });
    samples.push(s);
    if (samples.length > 240)
      samples.shift();
    lastErr = null;
  } catch (e) {
    lastErr = String(e);
  }
  probing = false;
  scheduleDraw();
}
function scheduleNextProbe() {
  if (probeTimer)
    clearTimeout(probeTimer);
  probeTimer = setTimeout(async () => {
    await probeOnce();
    scheduleNextProbe();
  }, INTERVAL_MS);
}
async function followPoll() {
  try {
    const st = await stat(SAMPLES_PATH);
    if (st.mtimeMs === lastSamplesMtime)
      return;
    lastSamplesMtime = st.mtimeMs;
    const fresh = await loadSamplesTail(240);
    if (fresh.length === 0)
      return;
    samples.splice(0, samples.length, ...fresh);
    scheduleDraw();
  } catch {}
}
function scheduleFollow() {
  if (followTimer)
    clearInterval(followTimer);
  followTimer = setInterval(followPoll, Math.min(15000, INTERVAL_MS / 3));
}
function setupKeys() {
  if (process.stdin.isTTY)
    process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", async (k) => {
    const s = String(k);
    if (s === "q" || s === "\x03") {
      cleanup();
      process.exit(0);
    }
    if (s === "l") {
      lang = lang === "zh" ? "en" : "zh";
      scheduleDraw();
    }
    if (s === "r") {
      if (mode === "follow") {
        lastSamplesMtime = 0;
        await followPoll();
      } else {
        if (probeTimer)
          clearTimeout(probeTimer);
        await probeOnce();
        scheduleNextProbe();
      }
    }
  });
}
function cleanup() {
  if (drawTimer)
    clearTimeout(drawTimer);
  if (probeTimer)
    clearTimeout(probeTimer);
  if (followTimer)
    clearInterval(followTimer);
  process.stdout.write(CURSOR_SHOW + ALT_OFF + RESET + `
`);
  if (process.stdin.isTTY)
    process.stdin.setRawMode(false);
  process.stdin.pause();
}
async function runTui() {
  process.stdout.write(ALT_ON + CURSOR_HIDE);
  setupKeys();
  const seed = await loadSamplesTail(240);
  if (seed.length) {
    samples.push(...seed);
    try {
      lastSamplesMtime = (await stat(SAMPLES_PATH)).mtimeMs;
    } catch {}
  }
  mode = await daemonAlive() ? "follow" : "probe";
  draw();
  if (mode === "follow") {
    scheduleFollow();
  } else {
    await probeOnce();
    scheduleNextProbe();
  }
}
var DATA_DIR, SAMPLES_PATH, STATE_PATH, ESC = "\x1B[", RESET, DIM, BOLD, fg = (n) => ESC + n + "m", bg = (n) => ESC + n + "m", CURSOR_HIDE, CURSOR_SHOW, ALT_ON, ALT_OFF, CLEAR, COLOR, CELL_BG, T, lang, samples, mode = "probe", probing = false, lastErr = null, spinFrame = 0, lastSamplesMtime = 0, SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏", ICON, drawTimer = null, INTERVAL_MS, DOWNLOAD_EVERY, probeTimer = null, followTimer = null, probeCycle = 0;
var init_tui = __esm(async () => {
  await init_probe();
  DATA_DIR = new URL("../data/", import.meta.url).pathname;
  SAMPLES_PATH = `${DATA_DIR}samples.jsonl`;
  STATE_PATH = `${DATA_DIR}state.json`;
  RESET = ESC + "0m";
  DIM = ESC + "2m";
  BOLD = ESC + "1m";
  CURSOR_HIDE = ESC + "?25l";
  CURSOR_SHOW = ESC + "?25h";
  ALT_ON = ESC + "?1049h";
  ALT_OFF = ESC + "?1049l";
  CLEAR = ESC + "2J" + ESC + "H";
  COLOR = {
    ok: fg(32),
    warn: fg(33),
    bad: fg(31),
    restricted: fg(35),
    skipped: fg(90),
    unknown: fg(90),
    info: fg(36),
    muted: fg(90),
    bold: BOLD
  };
  CELL_BG = {
    ok: bg(42),
    warn: bg(43),
    bad: bg(41),
    restricted: bg(45),
    skipped: bg(100),
    unknown: bg(40)
  };
  T = {
    zh: {
      title: "canireach · 网络与 AI 服务可达性",
      updated: "已更新",
      cycle: "样本 {n} 条",
      probing: "采集中…",
      waiting: "等待首次采样完成（约 8-10 秒）…",
      keys: "[q] 退出  [l] zh/en  [r] 立即刷新",
      modeFollow: "跟随 daemon",
      modeProbe: "进程内采集",
      netLabel: "网络",
      aiLabel: "AI 服务",
      secLayers: "分层状态",
      secTimeline: "时间线（最近 {n} 次采样，每格 ≈ 一个周期）",
      secPing: "Ping（最新 · p95 / 丢包）",
      secAi: "AI 端点（最近 {n} 次）",
      secEgress: "代理出口 IP",
      netTitle: {
        healthy: "正常",
        direct_blocked_proxy_ok: "正常（海外直连受限）",
        degraded: "略慢",
        proxy_bad: "代理异常",
        broadband_bad: "宽带异常",
        wifi_bad: "Wi-Fi 异常",
        lan_bad: "局域网异常",
        unknown: "未知"
      },
      netSub: {
        healthy: "所有检查通过 · 代理通畅 · 国内国际访问均可用",
        direct_blocked_proxy_ok: "国内畅通，海外直连按预期受限，代理可用",
        degraded: "部分检查偏慢或偶发失败",
        proxy_bad: "国内正常但代理或上游不工作",
        broadband_bad: "路由器能通，国内公网挂了",
        wifi_bad: "信号过弱或未连上",
        lan_bad: "Wi-Fi 连上但路由器不响应",
        unknown: "等待采样"
      },
      aiTitle: { ok: "正常", proxy_only: "正常（代理路径）", degraded: "部分可用", direct_only: "代理异常", fail: "不可达", skipped: "无法判断", unknown: "未知" },
      aiSub: {
        ok: "Anthropic & OpenAI 均可达（代理稳定，直连 {n}/2）",
        proxy_only: "Anthropic & OpenAI 通过代理可达，直连均被屏蔽",
        degraded: "仅 {ok} 代理可达；{fail} 代理失败",
        direct_only: "代理路径失败，但仍有直连可达 — 代理异常",
        fail: "Anthropic 与 OpenAI 均不可达",
        skipped: "代理与直连皆挂，无法判断",
        unknown: "等待采样"
      },
      layer: { wifi: "Wi-Fi", lan: "局域网", broadband: "国内", overseas_direct: "国际直连", proxy: "代理", ai: "AI 服务" },
      timeline: { overall: "总体", wifi: "Wi-Fi", lan: "局域网", broadband: "国内", overseas_direct: "国际直连", proxy: "代理" },
      sw: { ok: "正常", warn: "略慢", bad: "异常", restricted: "海外受限", skipped: "跳过", unknown: "—" },
      metric: {
        gw: "网关",
        baidu: "百度",
        reachable: "{n}/{total} 可达",
        egress: "出口",
        listening: "已监听",
        notListening: "未监听",
        loss: "丢包",
        linkEthernet: "以太网",
        linkOther: "非 Wi-Fi 连接",
        linkNone: "无 Wi-Fi 接口",
        proxyNone: "未配置代理"
      },
      tsSignedIn: "Tailscale: 已签入 ({addr})",
      tsExitNode: "Tailscale: exit node 启用（{addr}）"
    },
    en: {
      title: "canireach · network + AI reachability",
      updated: "updated",
      cycle: "{n} samples",
      probing: "probing…",
      waiting: "Waiting for the first sample (8-10s)…",
      keys: "[q] quit  [l] zh/en  [r] refresh now",
      modeFollow: "following daemon",
      modeProbe: "in-process",
      netLabel: "Network",
      aiLabel: "AI",
      secLayers: "Layers",
      secTimeline: "Timeline (last {n} samples, each cell ≈ one cycle)",
      secPing: "Ping (latest · p95 / loss)",
      secAi: "AI endpoints (recent {n})",
      secEgress: "Proxy egress IPs",
      netTitle: {
        healthy: "Healthy",
        direct_blocked_proxy_ok: "Healthy (overseas direct blocked)",
        degraded: "Slow",
        proxy_bad: "Proxy down",
        broadband_bad: "Broadband down",
        wifi_bad: "Wi-Fi down",
        lan_bad: "LAN down",
        unknown: "Unknown"
      },
      netSub: {
        healthy: "All checks pass · proxy OK · domestic & overseas reachable",
        direct_blocked_proxy_ok: "Domestic OK, overseas direct limited (expected), proxy works",
        degraded: "Some checks slow or intermittent",
        proxy_bad: "Domestic OK but proxy or upstream not working",
        broadband_bad: "Router reachable but domestic Internet is down",
        wifi_bad: "Signal too weak or not connected",
        lan_bad: "Wi-Fi connected but router not responding",
        unknown: "Waiting for samples"
      },
      aiTitle: { ok: "Reachable", proxy_only: "Reachable (via proxy)", degraded: "Partially reachable", direct_only: "Proxy broken", fail: "Unreachable", skipped: "Cannot determine", unknown: "Unknown" },
      aiSub: {
        ok: "Anthropic & OpenAI reachable (proxy stable, direct: {n}/2)",
        proxy_only: "Anthropic & OpenAI reachable via proxy; direct blocked",
        degraded: "Only {ok} reachable via proxy; {fail} failed",
        direct_only: "Proxy path failing; some direct routes still work",
        fail: "Both Anthropic and OpenAI unreachable",
        skipped: "Proxy down and direct also blocked — cannot determine",
        unknown: "Waiting for samples"
      },
      layer: { wifi: "Wi-Fi", lan: "Router", broadband: "Domestic", overseas_direct: "Direct", proxy: "Proxy", ai: "AI" },
      timeline: { overall: "overall", wifi: "Wi-Fi", lan: "router", broadband: "CN", overseas_direct: "direct", proxy: "proxy" },
      sw: { ok: "OK", warn: "slow", bad: "down", restricted: "blocked", skipped: "skipped", unknown: "—" },
      metric: {
        gw: "gw",
        baidu: "baidu",
        reachable: "{n}/{total} up",
        egress: "out",
        listening: "listening",
        notListening: "not listening",
        loss: "loss",
        linkEthernet: "Ethernet",
        linkOther: "Wired",
        linkNone: "no Wi-Fi interface",
        proxyNone: "no proxy configured"
      },
      tsSignedIn: "Tailscale: signed in ({addr})",
      tsExitNode: "Tailscale: exit node active ({addr})"
    }
  };
  lang = pickLang();
  samples = [];
  ICON = {
    ok: "✓",
    warn: "!",
    bad: "✕",
    restricted: "◇",
    skipped: "·",
    unknown: "·"
  };
  INTERVAL_MS = parseInt(process.env.CANIREACH_INTERVAL_MS || "60000", 10);
  DOWNLOAD_EVERY = parseInt(process.env.CANIREACH_DOWNLOAD_EVERY || "10", 10);
  setInterval(() => {
    if (probing) {
      spinFrame++;
      scheduleDraw();
    }
  }, 100);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
});

// src/server.ts
var exports_server = {};
__export(exports_server, {
  startServer: () => startServer
});
import { createServer } from "node:http";
import { readFile as readFile2 } from "node:fs/promises";
import { existsSync as existsSync2 } from "node:fs";
function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const out = await route(url);
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`internal error: ${e}`);
    }
  });
  server.listen(PORT, () => {
    console.log(`canireach server listening on http://localhost:${PORT}`);
  });
  return server;
}
async function route(url) {
  const p = url.pathname;
  if (p === "/api/state") {
    if (!existsSync2(STATE_PATH2))
      return json({ error: "no state yet" }, 503);
    return text(await readFile2(STATE_PATH2, "utf8"), "application/json");
  }
  if (p === "/api/samples") {
    const limit = parseInt(url.searchParams.get("limit") || "240", 10);
    const samples2 = await loadTail(limit);
    return json({ count: samples2.length, samples: samples2 });
  }
  if (p === "/api/series") {
    const limit = parseInt(url.searchParams.get("limit") || "240", 10);
    const samples2 = await loadTail(limit);
    return json(buildSeries(samples2));
  }
  if (p === "/api/conclusions") {
    const body = existsSync2(CONCLUSIONS_PATH) ? await readFile2(CONCLUSIONS_PATH, "utf8") : "_(no conclusions yet — the 20-min loop will populate this)_";
    return text(body, "text/markdown; charset=utf-8");
  }
  if (p === "/" || p === "/index.html")
    return serveStatic("index.html", "text/html; charset=utf-8");
  if (p === "/chart.js")
    return serveStatic("chart.js", "application/javascript; charset=utf-8");
  if (p === "/favicon.svg")
    return serveStatic("favicon.svg", "image/svg+xml");
  return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
}
function json(obj, status = 200) {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
}
function text(body, contentType, status = 200) {
  return { status, headers: { "content-type": contentType }, body };
}
async function serveStatic(name, contentType) {
  try {
    const data = await readFile2(`${PUBLIC_DIR}${name}`);
    return { status: 200, headers: { "content-type": contentType, "cache-control": "no-store" }, body: data };
  } catch {
    return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
  }
}
async function loadTail(limit) {
  if (!existsSync2(SAMPLES_PATH2))
    return [];
  const t = await readFile2(SAMPLES_PATH2, "utf8");
  const lines = t.trim().split(`
`);
  return lines.slice(-limit).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}
function buildSeries(samples2) {
  const t = samples2.map((s) => s.t);
  const verdict = samples2.map((s) => s.verdict?.overall ?? "unknown");
  const layerStateOf = (s, name) => s.verdict?.layers?.find((l) => l.layer === name)?.state ?? "unknown";
  const wifi = {
    rssi: samples2.map((s) => s.wifi?.rssi ?? null),
    txRate: samples2.map((s) => s.wifi?.txRate ?? null),
    noise: samples2.map((s) => s.wifi?.noise ?? null),
    channel: samples2.map((s) => s.wifi?.channel ?? null),
    ssid: samples2.map((s) => s.wifi?.ssidRedacted ? "<redacted>" : s.wifi?.ssid ?? null)
  };
  const gw = samples2.map((s) => {
    const p = s.pings?.find((x) => x.target === s.iface?.gateway);
    return p?.avgMs ?? null;
  });
  const ali = samples2.map((s) => s.pings?.find((x) => x.target === "223.5.5.5")?.avgMs ?? null);
  const cf = samples2.map((s) => s.pings?.find((x) => x.target === "1.1.1.1")?.avgMs ?? null);
  const goo = samples2.map((s) => s.pings?.find((x) => x.target === "8.8.8.8")?.avgMs ?? null);
  const httpsLabels = new Set;
  for (const s of samples2)
    for (const h of s.https ?? [])
      httpsLabels.add(h.label);
  const https = {};
  for (const lbl of httpsLabels) {
    https[lbl] = { totalMs: [], ok: [], timedOut: [] };
    for (const s of samples2) {
      const h = s.https?.find((x) => x.label === lbl);
      https[lbl].totalMs.push(h ? h.ok ? h.totalMs : null : null);
      https[lbl].ok.push(h ? h.ok : null);
      https[lbl].timedOut.push(h ? !!h.timedOut : null);
    }
  }
  const dnsServers = Array.from(new Set(samples2.flatMap((s) => (s.dns ?? []).map((d) => d.server))));
  const dns = {};
  for (const sv of dnsServers) {
    dns[sv] = samples2.map((s) => {
      const rows = (s.dns ?? []).filter((d) => d.server === sv);
      if (rows.length === 0)
        return null;
      const okRows = rows.filter((r) => r.ok);
      if (okRows.length === 0)
        return null;
      return okRows.reduce((a, r) => a + r.ms, 0) / okRows.length;
    });
  }
  const proxy = {
    egressIp: samples2.map((s) => s.proxyEgress?.ip ?? null),
    egressMs: samples2.map((s) => s.proxyEgress?.ms ?? null),
    listening: samples2.map((s) => s.proxyConfig?.listening ?? null),
    downloadMbps: samples2.map((s) => s.proxyDownload?.mbps ?? null)
  };
  const captive = samples2.map((s) => s.captive?.ok ?? null);
  const layers = {
    wifi: samples2.map((s) => layerStateOf(s, "wifi")),
    lan: samples2.map((s) => layerStateOf(s, "lan")),
    broadband: samples2.map((s) => layerStateOf(s, "broadband")),
    overseas_direct: samples2.map((s) => layerStateOf(s, "overseas_direct")),
    proxy: samples2.map((s) => layerStateOf(s, "proxy")),
    ai: samples2.map((s) => layerStateOf(s, "ai"))
  };
  const ai = {
    state: samples2.map((s) => s.verdict?.ai?.state ?? null),
    anthropicProxy: samples2.map((s) => s.https?.find((h) => h.label === "anthropic_proxy")?.ok ?? null),
    anthropicDirect: samples2.map((s) => s.https?.find((h) => h.label === "anthropic_direct")?.ok ?? null),
    openaiProxy: samples2.map((s) => s.https?.find((h) => h.label === "openai_proxy")?.ok ?? null),
    openaiDirect: samples2.map((s) => s.https?.find((h) => h.label === "openai_direct")?.ok ?? null)
  };
  return { t, verdict, wifi, pings: { gw, ali, cf, goo }, https, dns, proxy, captive, layers, ai };
}
var PORT, DATA_DIR2, PUBLIC_DIR, SAMPLES_PATH2, STATE_PATH2, CONCLUSIONS_PATH;
var init_server = __esm(() => {
  PORT = parseInt(process.env.CANIREACH_PORT || "8787", 10);
  DATA_DIR2 = new URL("../data/", import.meta.url).pathname;
  PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;
  SAMPLES_PATH2 = `${DATA_DIR2}samples.jsonl`;
  STATE_PATH2 = `${DATA_DIR2}state.json`;
  CONCLUSIONS_PATH = `${DATA_DIR2}conclusions.md`;
});

// src/daemon.ts
var exports_daemon = {};
__export(exports_daemon, {
  runDaemon: () => runDaemon
});
import { appendFile, writeFile, mkdir, readFile as readFile3 } from "node:fs/promises";
import { existsSync as existsSync3 } from "node:fs";
async function runDaemon() {
  await mkdir(DATA_DIR3, { recursive: true });
  await mkdir(new URL("../logs/", import.meta.url).pathname, { recursive: true });
  let cycle = 0;
  let running = true;
  const startedAt = new Date().toISOString();
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}
`;
    process.stdout.write(line);
    appendFile(LOG_PATH, line).catch(() => {});
  };
  let rolling = await loadRollingTail();
  const stop = () => {
    log("signal — stopping");
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log(`daemon up, interval=${INTERVAL_MS2}ms, downloadEvery=${DOWNLOAD_EVERY2}, rollingTail=${rolling.length}`);
  while (running) {
    cycle++;
    const withDownload = cycle % DOWNLOAD_EVERY2 === 1;
    const tStart = Date.now();
    try {
      const sample = await collectSample({ withDownload });
      await appendFile(SAMPLES_PATH3, JSON.stringify(sample) + `
`);
      rolling.push(sample);
      if (rolling.length > 200)
        rolling = rolling.slice(-200);
      const state = buildState(sample, rolling, startedAt, cycle);
      await writeFile(STATE_PATH3, JSON.stringify(state, null, 2));
      log(`cycle=${cycle} verdict=${sample.verdict.overall} cycleMs=${sample.cycleMs.toFixed(0)} egress=${sample.proxyEgress?.ip ?? "-"} rssi=${sample.wifi?.rssi ?? "-"}`);
    } catch (err) {
      log(`cycle=${cycle} ERROR ${String(err)}`);
    }
    const elapsed = Date.now() - tStart;
    if (!running)
      break;
    await sleep(Math.max(0, INTERVAL_MS2 - elapsed));
  }
  log("daemon exiting");
}
async function loadRollingTail() {
  if (!existsSync3(SAMPLES_PATH3))
    return [];
  try {
    const text2 = await readFile3(SAMPLES_PATH3, "utf8");
    const lines = text2.trim().split(`
`).slice(-120);
    const out = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l));
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}
function buildState(latest, tail, startedAt, cycle) {
  const last20 = tail.slice(-20);
  const counts = {};
  for (const s of last20)
    counts[s.verdict.overall] = (counts[s.verdict.overall] ?? 0) + 1;
  const httpsAgg = {};
  for (const s of last20) {
    for (const h of s.https) {
      const key = h.label;
      if (!httpsAgg[key])
        httpsAgg[key] = { ok: 0, total: 0, avgMs: 0 };
      httpsAgg[key].total++;
      if (h.ok)
        httpsAgg[key].ok++;
      httpsAgg[key].avgMs += h.totalMs;
    }
  }
  for (const k of Object.keys(httpsAgg))
    httpsAgg[k].avgMs /= Math.max(1, httpsAgg[k].total);
  const egressIps = last20.map((s) => s.proxyEgress?.ip).filter(Boolean);
  const uniqueEgress = Array.from(new Set(egressIps));
  return {
    daemonStartedAt: startedAt,
    updatedAt: latest.t,
    cycle,
    interval_ms: INTERVAL_MS2,
    latest,
    rolling: { windowSize: last20.length, verdictCounts: counts, httpsAgg, uniqueEgressIps: uniqueEgress }
  };
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
var DATA_DIR3, SAMPLES_PATH3, STATE_PATH3, LOG_PATH, INTERVAL_MS2, DOWNLOAD_EVERY2;
var init_daemon = __esm(async () => {
  await init_probe();
  DATA_DIR3 = new URL("../data/", import.meta.url).pathname;
  SAMPLES_PATH3 = `${DATA_DIR3}samples.jsonl`;
  STATE_PATH3 = `${DATA_DIR3}state.json`;
  LOG_PATH = new URL("../logs/daemon.log", import.meta.url).pathname;
  INTERVAL_MS2 = parseInt(process.env.CANIREACH_INTERVAL_MS || "60000", 10);
  DOWNLOAD_EVERY2 = parseInt(process.env.CANIREACH_DOWNLOAD_EVERY || "10", 10);
});

// src/cli.ts
import { spawn as spawn2 } from "node:child_process";
var args = process.argv.slice(2);
var has = (...flags) => flags.some((f) => args.includes(f));
if (has("-h", "--help")) {
  printHelp();
  process.exit(0);
}
if (has("-w", "--web", "--server")) {
  await startWeb();
} else if (has("--once")) {
  const { collectSample: collectSample2 } = await init_probe().then(() => exports_probe);
  const sample = await collectSample2();
  console.log(JSON.stringify(sample, null, 2));
} else {
  const { runTui: runTui2 } = await init_tui().then(() => exports_tui);
  await runTui2();
}
async function startWeb() {
  const port = process.env.CANIREACH_PORT || "8787";
  const url = `http://localhost:${port}`;
  const { startServer: startServer2 } = await Promise.resolve().then(() => (init_server(), exports_server));
  const { runDaemon: runDaemon2 } = await init_daemon().then(() => exports_daemon);
  startServer2();
  runDaemon2().catch((e) => {
    console.error("daemon error:", e);
    process.exit(1);
  });
  console.log(`dashboard: ${url}`);
  if (!has("--no-open") && process.env.CANIREACH_NO_OPEN !== "1") {
    setTimeout(() => openBrowser(url), 1500);
  }
  const shutdown = () => {
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn2(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}
function printHelp() {
  process.stdout.write(`canireach — local network + AI-service reachability monitor

Usage:
  canireach                Launch the terminal UI (default; runs probes in-process)
  canireach --web          Start the dashboard server on http://localhost:8787
                           and open it in your browser (use --no-open to skip)
  canireach --once         Run a single probe and print the result as JSON
  canireach -h, --help     Show this help

TUI keys:
  q   quit
  l   toggle language (zh / en)
  r   refresh now

Environment variables:
  CANIREACH_PROXY=URL            Force this proxy URL for proxy-probes (overrides
                                 env vars and system proxy detection). Use \`none\`
                                 or \`off\` to explicitly disable proxy probes.
  CANIREACH_LANG=zh|en           Force UI language (otherwise auto-detected)
  CANIREACH_INTERVAL_MS=60000    Probe interval (TUI and daemon)
  CANIREACH_PORT=8787            Dashboard port (web mode only)
  CANIREACH_DOWNLOAD_EVERY=10    Daemon-mode throughput sample cadence
  CANIREACH_NO_OPEN=1            Don't open the browser in --web mode
`);
}
