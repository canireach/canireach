// Turn a sample into a layered verdict. The layers are ordered: a failure on a lower
// layer makes higher layers indeterminate.
import type { Sample } from "./probe";
import type { HttpResult } from "./probes";

export type Layer = "wifi" | "lan" | "broadband" | "overseas_direct" | "proxy" | "ai";
export type LayerState = "ok" | "degraded" | "fail" | "skipped" | "unknown";

export type LayerVerdict = {
  layer: Layer;
  state: LayerState;
  reasons: string[];
  metrics: Record<string, number | string | boolean | null>;
};

export type AiState = "ok" | "proxy_only" | "direct_only" | "degraded" | "fail" | "skipped" | "unknown";

export type Verdict = {
  overall:
    | "healthy"
    | "direct_blocked_proxy_ok"   // domestic works, direct overseas blocked (expected), proxy fine
    | "proxy_bad"
    | "broadband_bad"
    | "wifi_bad"
    | "lan_bad"
    | "degraded"
    | "unknown";
  headline: string;
  layers: LayerVerdict[];
  ai: { state: AiState; headline: string };  // independent of `overall` — two distinct final indicators
};

export function judge(s: Sample): Verdict {
  const layers: LayerVerdict[] = [];

  // -------- Wi-Fi / link layer --------
  // This layer reports the physical link the active route is using. If the user is on
  // Ethernet / USB-C / Thunderbolt, the Wi-Fi RSSI is irrelevant — "skipped", not "fail".
  const w = s.wifi;
  const linkType = s.iface?.linkType ?? "unknown";
  const wifiReasons: string[] = [];
  let wifiState: LayerState = "ok";
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
      if (w.rssi <= -80) { wifiState = "fail"; wifiReasons.push(`weak signal ${w.rssi}dBm`); }
      else if (w.rssi <= -70) { wifiState = "degraded"; wifiReasons.push(`marginal signal ${w.rssi}dBm`); }
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
    metrics: w ? { rssi: w.rssi, noise: w.noise, channel: w.channel, txRate: w.txRate, ssid: w.ssidRedacted ? "<redacted>" : w.ssid, linkType } : { linkType },
  });

  // -------- LAN (gateway reachable) --------
  const gwPing = s.pings.find((p) => p.target === s.iface?.gateway);
  const lanReasons: string[] = [];
  let lanState: LayerState = "ok";
  if (!s.iface?.gateway) { lanState = "unknown"; lanReasons.push("no gateway"); }
  else if (!gwPing) { lanState = "unknown"; lanReasons.push("no gateway ping result"); }
  else if (!gwPing.ok) { lanState = "fail"; lanReasons.push(`gw ping loss=${gwPing.lossPct}%`); }
  else if ((gwPing.avgMs ?? 0) > 30) { lanState = "degraded"; lanReasons.push(`gw rtt ${gwPing.avgMs?.toFixed(1)}ms`); }
  layers.push({
    layer: "lan",
    state: lanState,
    reasons: lanReasons,
    metrics: { gateway: s.iface?.gateway ?? null, avgMs: gwPing?.avgMs ?? null, loss: gwPing?.lossPct ?? null },
  });

  // -------- Broadband (domestic Internet) --------
  // Conditions: ping to 223.5.5.5 AND dig of baidu.com via system DNS works AND HTTPS baidu OK.
  const bbReasons: string[] = [];
  let bbState: LayerState = "ok";
  if (lanState === "fail") {
    bbState = "skipped";
    bbReasons.push("LAN fail → cannot judge");
  } else {
    const aliPing = s.pings.find((p) => p.target === "223.5.5.5");
    const baiduHttps = s.https.find((h) => h.label === "baidu_direct");
    const baiduDns = s.dns.find((d) => d.domain === "baidu.com" && d.server === "223.5.5.5");
    if (!aliPing || !aliPing.ok) { bbState = "fail"; bbReasons.push("ping 223.5.5.5 fail"); }
    if (baiduDns && !baiduDns.ok) { bbState = worse(bbState, "fail"); bbReasons.push("dig baidu via 223.5.5.5 fail"); }
    if (baiduHttps && !baiduHttps.ok) { bbState = worse(bbState, "fail"); bbReasons.push(`baidu https fail: ${baiduHttps.err}`); }
    else if (baiduHttps && baiduHttps.totalMs > 1500) { bbState = worse(bbState, "degraded"); bbReasons.push(`baidu slow ${baiduHttps.totalMs.toFixed(0)}ms`); }
  }
  layers.push({
    layer: "broadband",
    state: bbState,
    reasons: bbReasons,
    metrics: {},
  });

  // -------- Overseas direct (informational — often fails on restricted networks) --------
  const overseasReasons: string[] = [];
  let overseasState: LayerState = "ok";
  if (bbState === "fail" || bbState === "skipped") {
    overseasState = "skipped";
    overseasReasons.push("broadband fail → cannot judge");
  } else {
    // Exclude domestic targets and AI endpoints — those have their own layers.
    const probes = s.https.filter((h) =>
      h.via === "direct"
      && !["baidu_direct", "taobao_direct", "anthropic_direct", "openai_direct"].includes(h.label));
    const okCount = probes.filter((h) => h.ok).length;
    if (probes.length === 0) overseasState = "unknown";
    else if (okCount === 0) { overseasState = "fail"; overseasReasons.push("all direct overseas fail (blocked)"); }
    else if (okCount < probes.length) { overseasState = "degraded"; overseasReasons.push(`${okCount}/${probes.length} direct overseas ok`); }
  }
  layers.push({
    layer: "overseas_direct",
    state: overseasState,
    reasons: overseasReasons,
    metrics: {},
  });

  // -------- Proxy --------
  // Three cases: (1) no proxy configured at all → "skipped", not a fault;
  //              (2) proxy configured but not listening → "fail";
  //              (3) proxy configured and listening → eval the via-proxy probes.
  const proxyReasons: string[] = [];
  let proxyState: LayerState = "ok";
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
    if (viaProxy.length === 0) { proxyState = "unknown"; proxyReasons.push("no proxy HTTPS probes"); }
    else if (okCount === 0) { proxyState = "fail"; proxyReasons.push("all proxy HTTPS fail"); }
    else if (okCount < viaProxy.length) { proxyState = "degraded"; proxyReasons.push(`${okCount}/${viaProxy.length} proxy targets ok`); }
    if (s.proxyEgress && !s.proxyEgress.ok) {
      proxyState = worse(proxyState, "degraded");
      proxyReasons.push(`egress fetch failed: ${s.proxyEgress.err ?? "unknown"}`);
    }
    // Sanity check: if the macOS system proxy is enabled and points at 127.0.0.1, its port
    // should match what we're actually using. A mismatch suggests stale system config.
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
      listenerProcess: s.proxyConfig.listenerProcess,
    },
  });

  // -------- AI services (independent indicator) --------
  // Reachability of api.anthropic.com and api.openai.com via direct and proxy.
  const aiReasons: string[] = [];
  const ant_d = s.https.find((h) => h.label === "anthropic_direct");
  const ant_p = s.https.find((h) => h.label === "anthropic_proxy");
  const oai_d = s.https.find((h) => h.label === "openai_direct");
  const oai_p = s.https.find((h) => h.label === "openai_proxy");
  const proxyOk = (h: HttpResult | undefined) => !!(h && h.ok);
  const directOk = (h: HttpResult | undefined) => !!(h && h.ok);
  const proxyHits = [proxyOk(ant_p), proxyOk(oai_p)].filter(Boolean).length;
  const directHits = [directOk(ant_d), directOk(oai_d)].filter(Boolean).length;

  // No proxy configured at all: AI is judged purely on direct probes (overseas-direct user).
  // The "direct_only" state code already captures "proxy is not the path; direct is".
  const noProxy = !s.proxyConfig.proxyUrl;
  let aiState: AiState;
  let aiHeadline: string;
  if (noProxy) {
    if (directHits === 2) {
      aiState = "direct_only";  // reachable, just no proxy in the picture
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
    state: aiState === "ok" || aiState === "proxy_only" || aiState === "direct_only" ? "ok"
         : aiState === "degraded" ? "degraded"
         : aiState === "fail" ? "fail"
         : aiState === "skipped" ? "skipped" : "unknown",
    reasons: aiReasons,
    metrics: {
      anthropic_proxy_ok: !!ant_p?.ok,
      openai_proxy_ok: !!oai_p?.ok,
      anthropic_direct_ok: !!ant_d?.ok,
      openai_direct_ok: !!oai_d?.ok,
    },
  });

  // -------- Overall verdict (general network — does NOT include AI) --------
  let overall: Verdict["overall"];
  let headline: string;
  if (wifiState === "fail") { overall = "wifi_bad"; headline = wifiReasons.join("; "); }
  else if (lanState === "fail") { overall = "lan_bad"; headline = lanReasons.join("; "); }
  else if (bbState === "fail") { overall = "broadband_bad"; headline = bbReasons.join("; "); }
  else if (proxyState === "fail") { overall = "proxy_bad"; headline = proxyReasons.join("; "); }
  else if (overseasState === "fail" && proxyState === "ok") { overall = "direct_blocked_proxy_ok"; headline = "direct overseas blocked, proxy works"; }
  else if ([wifiState, lanState, bbState, proxyState].some((s) => s === "degraded")) {
    overall = "degraded";
    headline = layers.filter((l) => l.state === "degraded" && l.layer !== "ai").flatMap((l) => l.reasons).join("; ") || "some checks slow";
  }
  else { overall = "healthy"; headline = "all green"; }

  return { overall, headline, layers, ai: { state: aiState, headline: aiHeadline } };
}

function worse(a: LayerState, b: LayerState): LayerState {
  const rank: Record<LayerState, number> = { ok: 0, degraded: 1, fail: 2, unknown: 0, skipped: 0 };
  return rank[b] > rank[a] ? b : a;
}
