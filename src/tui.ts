// TUI dashboard. Renders to the terminal in two possible modes:
//   * follow  — a daemon is already running; we just tail data/samples.jsonl
//   * probe   — no daemon; we run probes ourselves and keep samples in memory
// Mode is auto-detected on startup by checking whether data/state.json was
// updated within the last few cycles. Keys: q quit, l zh/en, r refresh now.
// No external deps — raw ANSI escapes + a tiny CJK-aware width helper.
import { collectSample, type Sample } from "./probe";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

const DATA_DIR = new URL("../data/", import.meta.url).pathname;
const SAMPLES_PATH = `${DATA_DIR}samples.jsonl`;
const STATE_PATH = `${DATA_DIR}state.json`;

// -------- ANSI --------
const ESC = "\x1b[";
const RESET = ESC + "0m";
const DIM = ESC + "2m";
const BOLD = ESC + "1m";
const fg = (n: number) => ESC + n + "m";
const bg = (n: number) => ESC + n + "m";
const CURSOR_HIDE = ESC + "?25l";
const CURSOR_SHOW = ESC + "?25h";
const ALT_ON = ESC + "?1049h";   // alternate screen buffer
const ALT_OFF = ESC + "?1049l";
const CLEAR = ESC + "2J" + ESC + "H";

const COLOR = {
  ok:  fg(32),  warn: fg(33),  bad: fg(31),
  restricted: fg(35),  skipped: fg(90),  unknown: fg(90),
  info: fg(36),  muted: fg(90),  bold: BOLD,
};
const CELL_BG: Record<string, string> = {
  ok: bg(42), warn: bg(43), bad: bg(41), restricted: bg(45),
  skipped: bg(100), unknown: bg(40),
};

// -------- CJK-aware width --------
function chWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) return 0;
  if (cp >= 0x1100 && (
       cp <= 0x115F
    || cp === 0x2329 || cp === 0x232A
    || (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F)
    || (cp >= 0xAC00 && cp <= 0xD7A3)
    || (cp >= 0xF900 && cp <= 0xFAFF)
    || (cp >= 0xFE30 && cp <= 0xFE4F)
    || (cp >= 0xFF00 && cp <= 0xFF60)
    || (cp >= 0xFFE0 && cp <= 0xFFE6)
  )) return 2;
  return 1;
}
function visWidth(s: string): number {
  // strip ANSI escapes first
  const noAnsi = s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  let w = 0;
  for (const ch of noAnsi) w += chWidth(ch.codePointAt(0)!);
  return w;
}
function padEndVis(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - visWidth(s)));
}

// -------- i18n (TUI subset) --------
type Lang = "zh" | "en";
const T = {
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
      unknown: "未知",
    } as Record<string, string>,
    netSub: {
      healthy: "所有检查通过 · 代理通畅 · 国内国际访问均可用",
      direct_blocked_proxy_ok: "国内畅通，海外直连按预期受限，代理可用",
      degraded: "部分检查偏慢或偶发失败",
      proxy_bad: "国内正常但代理或上游不工作",
      broadband_bad: "路由器能通，国内公网挂了",
      wifi_bad: "信号过弱或未连上",
      lan_bad: "Wi-Fi 连上但路由器不响应",
      unknown: "等待采样",
    } as Record<string, string>,
    aiTitle: { ok: "正常", proxy_only: "正常（代理路径）", degraded: "部分可用", direct_only: "代理异常", fail: "不可达", skipped: "无法判断", unknown: "未知" } as Record<string, string>,
    aiSub: {
      ok: "Anthropic & OpenAI 均可达（代理稳定，直连 {n}/2）",
      proxy_only: "Anthropic & OpenAI 通过代理可达，直连均被屏蔽",
      degraded: "仅 {ok} 代理可达；{fail} 代理失败",
      direct_only: "代理路径失败，但仍有直连可达 — 代理异常",
      fail: "Anthropic 与 OpenAI 均不可达",
      skipped: "代理与直连皆挂，无法判断",
      unknown: "等待采样",
    } as Record<string, string>,
    layer: { wifi: "Wi-Fi", lan: "局域网", broadband: "国内", overseas_direct: "国际直连", proxy: "代理", ai: "AI 服务" } as Record<string, string>,
    timeline: { overall: "总体", wifi: "Wi-Fi", lan: "局域网", broadband: "国内", overseas_direct: "国际直连", proxy: "代理" } as Record<string, string>,
    sw: { ok: "正常", warn: "略慢", bad: "异常", restricted: "海外受限", skipped: "跳过", unknown: "—" } as Record<string, string>,
    metric: {
      gw: "网关", baidu: "百度", reachable: "{n}/{total} 可达",
      egress: "出口", listening: "已监听", notListening: "未监听", loss: "丢包",
      linkEthernet: "以太网", linkOther: "非 Wi-Fi 连接", linkNone: "无 Wi-Fi 接口",
      proxyNone: "未配置代理",
    },
    tsSignedIn: "Tailscale: 已签入 ({addr})",
    tsExitNode: "Tailscale: exit node 启用（{addr}）",
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
      unknown: "Unknown",
    } as Record<string, string>,
    netSub: {
      healthy: "All checks pass · proxy OK · domestic & overseas reachable",
      direct_blocked_proxy_ok: "Domestic OK, overseas direct limited (expected), proxy works",
      degraded: "Some checks slow or intermittent",
      proxy_bad: "Domestic OK but proxy or upstream not working",
      broadband_bad: "Router reachable but domestic Internet is down",
      wifi_bad: "Signal too weak or not connected",
      lan_bad: "Wi-Fi connected but router not responding",
      unknown: "Waiting for samples",
    } as Record<string, string>,
    aiTitle: { ok: "Reachable", proxy_only: "Reachable (via proxy)", degraded: "Partially reachable", direct_only: "Proxy broken", fail: "Unreachable", skipped: "Cannot determine", unknown: "Unknown" } as Record<string, string>,
    aiSub: {
      ok: "Anthropic & OpenAI reachable (proxy stable, direct: {n}/2)",
      proxy_only: "Anthropic & OpenAI reachable via proxy; direct blocked",
      degraded: "Only {ok} reachable via proxy; {fail} failed",
      direct_only: "Proxy path failing; some direct routes still work",
      fail: "Both Anthropic and OpenAI unreachable",
      skipped: "Proxy down and direct also blocked — cannot determine",
      unknown: "Waiting for samples",
    } as Record<string, string>,
    layer: { wifi: "Wi-Fi", lan: "Router", broadband: "Domestic", overseas_direct: "Direct", proxy: "Proxy", ai: "AI" } as Record<string, string>,
    timeline: { overall: "overall", wifi: "Wi-Fi", lan: "router", broadband: "CN", overseas_direct: "direct", proxy: "proxy" } as Record<string, string>,
    sw: { ok: "OK", warn: "slow", bad: "down", restricted: "blocked", skipped: "skipped", unknown: "—" } as Record<string, string>,
    metric: {
      gw: "gw", baidu: "baidu", reachable: "{n}/{total} up",
      egress: "out", listening: "listening", notListening: "not listening", loss: "loss",
      linkEthernet: "Ethernet", linkOther: "Wired", linkNone: "no Wi-Fi interface",
      proxyNone: "no proxy configured",
    },
    tsSignedIn: "Tailscale: signed in ({addr})",
    tsExitNode: "Tailscale: exit node active ({addr})",
  },
};

function tpl(s: string, p: Record<string, string | number>) {
  for (const [k, v] of Object.entries(p)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

// -------- state --------
let lang: Lang = pickLang();
function pickLang(): Lang {
  if (process.env.CANIREACH_LANG === "zh") return "zh";
  if (process.env.CANIREACH_LANG === "en") return "en";
  const sys = (process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || "").toLowerCase();
  return sys.startsWith("zh") ? "zh" : "en";
}

const samples: Sample[] = [];
let mode: "probe" | "follow" = "probe";
let probing = false;
let lastErr: string | null = null;
let spinFrame = 0;
let lastSamplesMtime = 0;
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// -------- map verdict / layer state to bucket --------
function stateBucket(st: string | undefined): string {
  return st === "ok" ? "ok" : st === "degraded" ? "warn" : st === "fail" ? "bad" : st === "skipped" ? "skipped" : "unknown";
}
function overallBucket(v: string): string {
  if (v === "healthy") return "ok";
  if (v === "direct_blocked_proxy_ok") return "restricted";
  if (v === "degraded") return "warn";
  if (v === "unknown") return "unknown";
  return "bad";
}
function overseasBucket(s: Sample, st: string): string {
  if (st === "fail" && s.verdict?.layers?.find((l) => l.layer === "proxy")?.state === "ok") return "restricted";
  return stateBucket(st);
}

function colorize(bucket: string, text: string): string {
  const col = (COLOR as Record<string, string>)[bucket] ?? COLOR.unknown;
  return col + text + RESET;
}

// -------- icons / dots --------
const ICON = {
  ok: "✓", warn: "!", bad: "✕", restricted: "◇", skipped: "·", unknown: "·",
};
function dot(bucket: string) { return colorize(bucket, "●"); }
function icon(bucket: string) { return colorize(bucket, ICON[bucket as keyof typeof ICON] ?? "·"); }

// -------- main render --------
function render() {
  const out: string[] = [];
  const D = T[lang];
  const w = Math.min(process.stdout.columns || 100, 110);
  const sep = COLOR.muted + "─".repeat(Math.min(w, 100)) + RESET;

  // Header line
  const updated = samples.length ? new Date(samples[samples.length - 1].t).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-GB", { hour12: false }) : "—";
  const cycle = tpl(D.cycle, { n: samples.length });
  const spinner = probing ? "  " + COLOR.info + SPINNER[spinFrame % SPINNER.length] + " " + D.probing + RESET : "";
  const modeTag = COLOR.muted + "  · " + (mode === "follow" ? D.modeFollow : D.modeProbe) + RESET;
  // Tailscale indicator — only when interesting (signed in or exit-node).
  const ts = samples[samples.length - 1]?.tailscale;
  let tsText = "";
  if (ts?.exitNodeActive)  tsText = "  ·  " + tpl((D as any).tsExitNode, { addr: ts.address ?? "?" });
  else if (ts?.signedIn)   tsText = "  ·  " + tpl((D as any).tsSignedIn, { addr: ts.address ?? "?" });
  out.push(BOLD + D.title + RESET + spinner + modeTag);
  out.push(COLOR.muted + `${D.updated} ${updated}  ·  ${cycle}${tsText}` + RESET);
  out.push("");

  // No data yet
  if (samples.length === 0) {
    out.push(COLOR.muted + D.waiting + RESET);
    out.push("");
    out.push(COLOR.muted + D.keys + RESET);
    return out.join("\n");
  }

  const latest = samples[samples.length - 1];
  const ver = latest.verdict;

  // ---- network banner ----
  const netB = overallBucket(ver.overall);
  out.push(icon(netB) + "  " + BOLD + padEndVis(D.netLabel, 10) + RESET + colorize(netB, D.netTitle[ver.overall] ?? ver.overall));
  out.push(COLOR.muted + "    " + (D.netSub[ver.overall] ?? "") + RESET);
  out.push("");

  // ---- AI banner ----
  const aiState = ver.ai?.state ?? "unknown";
  const aiB = aiState === "ok" || aiState === "proxy_only" ? "ok"
            : aiState === "degraded" || aiState === "direct_only" ? "warn"
            : aiState === "fail" ? "bad"
            : "unknown";
  let aiSub: string;
  if (aiState === "ok") {
    const n = ["anthropic_direct","openai_direct"].filter((lbl) => latest.https?.find((h) => h.label === lbl)?.ok).length;
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

  // ---- layers ----
  out.push(BOLD + D.secLayers + RESET);
  for (const key of ["wifi", "lan", "broadband", "overseas_direct", "proxy", "ai"]) {
    const layer = ver.layers.find((l) => l.layer === key);
    const st = layer?.state ?? "unknown";
    const bucket = key === "overseas_direct" ? overseasBucket(latest, st) : stateBucket(st);
    const sw = D.sw[bucket] ?? "—";
    const metric = layerMetric(latest, key as any);
    out.push(`  ${dot(bucket)} ${padEndVis(D.layer[key], 12)} ${colorize(bucket, padEndVis(sw, 12))}${COLOR.muted}${metric}${RESET}`);
  }
  out.push("");

  // ---- timeline heatmap ----
  const tlWidth = Math.max(20, Math.min(80, w - 18));
  const window = samples.slice(-tlWidth);
  out.push(BOLD + tpl(D.secTimeline, { n: window.length }) + RESET);
  const rows: { key: string; series: (string | undefined)[] }[] = [
    { key: "overall", series: window.map((s) => overallBucket(s.verdict.overall)) },
    { key: "wifi", series: window.map((s) => stateBucket(s.verdict.layers.find((l) => l.layer === "wifi")?.state)) },
    { key: "lan", series: window.map((s) => stateBucket(s.verdict.layers.find((l) => l.layer === "lan")?.state)) },
    { key: "broadband", series: window.map((s) => stateBucket(s.verdict.layers.find((l) => l.layer === "broadband")?.state)) },
    { key: "overseas_direct", series: window.map((s) => overseasBucket(s, s.verdict.layers.find((l) => l.layer === "overseas_direct")?.state ?? "unknown")) },
    { key: "proxy", series: window.map((s) => stateBucket(s.verdict.layers.find((l) => l.layer === "proxy")?.state)) },
  ];
  for (const r of rows) {
    const cells = r.series.map((b) => (CELL_BG[b ?? "unknown"] ?? CELL_BG.unknown) + " " + RESET).join("");
    out.push(`  ${padEndVis(D.timeline[r.key], 14)} ${cells}`);
  }
  out.push("");

  // ---- ping ----
  out.push(BOLD + D.secPing + RESET);
  const pingTargets = [
    [D.metric.gw, latest.iface?.gateway ?? "—"],
    ["223.5.5.5", "223.5.5.5"],
    ["1.1.1.1", "1.1.1.1"],
    ["8.8.8.8", "8.8.8.8"],
  ];
  for (const [label, target] of pingTargets) {
    const valNow = samples.slice(-1).map((s) => s.pings.find((p) => p.target === target));
    const vals = samples.slice(-20).map((s) => s.pings.find((p) => p.target === target));
    const last = valNow[0];
    const oks = vals.filter((p) => p?.ok && p.avgMs != null).map((p) => p!.avgMs!).sort((a, b) => a - b);
    const p95 = oks.length ? oks[Math.min(oks.length - 1, Math.floor(oks.length * 0.95))] : null;
    const losses = vals.filter((p) => p && !p.ok).length;
    const lossPct = vals.length ? (losses / vals.length) * 100 : 0;
    const cur = last?.ok ? `${Math.round(last.avgMs ?? 0)} ms` : COLOR.bad + D.metric.loss + RESET;
    const p95Txt = p95 != null ? `${Math.round(p95)} ms` : "—";
    const lossTxt = lossPct > 0 ? COLOR.warn + ` · ${lossPct.toFixed(0)}% ${D.metric.loss}` + RESET : "";
    out.push(`  ${padEndVis(label, 14)} ${padEndVis(cur, 10)} ${COLOR.muted}p95${RESET} ${p95Txt}${lossTxt}`);
  }
  out.push("");

  // ---- AI endpoints ----
  const aiLabels = ["anthropic_proxy", "anthropic_direct", "openai_proxy", "openai_direct"];
  const tail = samples.slice(-20);
  out.push(BOLD + tpl(D.secAi, { n: tail.length }) + RESET);
  for (const lbl of aiLabels) {
    const hits = tail.map((s) => s.https.find((h) => h.label === lbl));
    const ok = hits.filter((h) => h?.ok).length;
    const total = hits.length;
    const avgs = hits.filter((h) => h?.ok && h.totalMs != null).map((h) => h!.totalMs);
    const avg = avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null;
    const okCol = ok === total ? COLOR.ok : ok === 0 ? COLOR.bad : COLOR.warn;
    out.push(`  ${padEndVis(lbl, 20)} ${okCol}${ok}/${total}${RESET}  ${COLOR.muted}${avg != null ? Math.round(avg) + " ms" : "—"}${RESET}`);
  }
  out.push("");

  // ---- egress IPs ----
  const counts: Record<string, number> = {};
  for (const s of tail) {
    const ip = s.proxyEgress?.ip;
    if (ip) counts[ip] = (counts[ip] || 0) + 1;
  }
  const ipList = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([ip, n]) => `${ip} ×${n}`).join("  ");
  out.push(BOLD + D.secEgress + RESET + "  " + COLOR.muted + (ipList || "—") + RESET);
  out.push("");

  out.push(COLOR.muted + D.keys + RESET);
  return out.join("\n");
}

function latestProxyMbps(): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const d = samples[i].proxyDownload;
    if (d?.ok && d.mbps != null) return d.mbps;
  }
  return null;
}

function fmtMbps(mbps: number): string {
  return mbps >= 10 ? Math.round(mbps).toString() : mbps.toFixed(1);
}

function layerMetric(s: Sample, key: "wifi" | "lan" | "broadband" | "overseas_direct" | "proxy" | "ai"): string {
  const D = T[lang];
  switch (key) {
    case "wifi": {
      const linkType = s.iface?.linkType;
      if (linkType === "ethernet" || linkType === "other") {
        return s.iface?.hardwarePort || (D.metric as any).linkEthernet || "Ethernet";
      }
      if (s.wifi?.status === "no_interface") return (D.metric as any).linkNone || "no Wi-Fi";
      if (s.wifi?.status === "not_wifi")     return (D.metric as any).linkOther || "Wired";
      return s.wifi ? `${s.wifi.rssi ?? "?"} dBm · ${s.wifi.txRate ?? "?"} Mbps` : "—";
    }
    case "lan": {
      const gw = s.iface?.gateway;
      const p = s.pings.find((x) => x.target === gw);
      if (!gw) return "—";
      const short = gw.split(".").slice(-2).join(".");
      return `${short} · ${p?.ok ? Math.round(p.avgMs!) + " ms" : D.metric.loss}`;
    }
    case "broadband": {
      const b = s.https.find((h) => h.label === "baidu_direct");
      return b ? `${D.metric.baidu} ${b.ok ? Math.round(b.totalMs) + " ms" : "fail"}` : "—";
    }
    case "overseas_direct": {
      const direct = s.https.filter((h) =>
        h.via === "direct" && !["baidu_direct", "taobao_direct", "anthropic_direct", "openai_direct"].includes(h.label));
      const ok = direct.filter((h) => h.ok).length;
      return tpl(D.metric.reachable, { n: ok, total: direct.length });
    }
    case "proxy": {
      // Distinguish "explicitly no proxy" (proxyUrl === null) from older samples that
      // pre-date the field (proxyUrl === undefined) — the latter falls through normally.
      if (s.proxyConfig && s.proxyConfig.proxyUrl === null) return (D.metric as any).proxyNone || "no proxy configured";
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

// -------- redraw loop --------
function draw() {
  process.stdout.write(CLEAR);
  process.stdout.write(render());
  process.stdout.write("\n");
}

let drawTimer: NodeJS.Timeout | null = null;
function scheduleDraw() {
  if (drawTimer) return;
  drawTimer = setTimeout(() => {
    drawTimer = null;
    draw();
  }, 50);
}

// -------- daemon-file follow mode --------
async function loadSamplesTail(limit = 240): Promise<Sample[]> {
  if (!existsSync(SAMPLES_PATH)) return [];
  try {
    const text = await readFile(SAMPLES_PATH, "utf8");
    const lines = text.trim().split("\n").slice(-limit);
    const out: Sample[] = [];
    for (const l of lines) {
      try { out.push(JSON.parse(l) as Sample); } catch { /* skip partial line */ }
    }
    return out;
  } catch {
    return [];
  }
}

// Heuristic: a daemon is "alive" if data/state.json was touched within ~3 cycles.
async function daemonAlive(): Promise<boolean> {
  if (!existsSync(STATE_PATH)) return false;
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

// -------- probe loop (probe mode only) --------
const INTERVAL_MS = parseInt(process.env.CANIREACH_INTERVAL_MS || "60000", 10);
const DOWNLOAD_EVERY = parseInt(process.env.CANIREACH_DOWNLOAD_EVERY || "10", 10);
let probeTimer: NodeJS.Timeout | null = null;
let followTimer: NodeJS.Timeout | null = null;
let probeCycle = 0;

async function probeOnce() {
  probeCycle++;
  const withDownload = DOWNLOAD_EVERY > 0 && probeCycle % DOWNLOAD_EVERY === 1;
  probing = true;
  scheduleDraw();
  try {
    const s = await collectSample({ withDownload });
    samples.push(s);
    if (samples.length > 240) samples.shift();
    lastErr = null;
  } catch (e) {
    lastErr = String(e);
  }
  probing = false;
  scheduleDraw();
}

function scheduleNextProbe() {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = setTimeout(async () => {
    await probeOnce();
    scheduleNextProbe();
  }, INTERVAL_MS);
}

// Poll the daemon's samples.jsonl on a faster cadence than the daemon writes it.
// We re-read the tail only when the file's mtime changes — cheap, no fs.watch needed.
async function followPoll() {
  try {
    const st = await stat(SAMPLES_PATH);
    if (st.mtimeMs === lastSamplesMtime) return;
    lastSamplesMtime = st.mtimeMs;
    const fresh = await loadSamplesTail(240);
    if (fresh.length === 0) return;
    samples.splice(0, samples.length, ...fresh);
    scheduleDraw();
  } catch { /* file might not exist yet */ }
}

function scheduleFollow() {
  if (followTimer) clearInterval(followTimer);
  followTimer = setInterval(followPoll, Math.min(15_000, INTERVAL_MS / 3));
}

// -------- keyboard --------
function setupKeys() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", async (k) => {
    const s = String(k);
    if (s === "q" || s === "\x03") { cleanup(); process.exit(0); }
    if (s === "l") { lang = lang === "zh" ? "en" : "zh"; scheduleDraw(); }
    if (s === "r") {
      if (mode === "follow") {
        lastSamplesMtime = 0;     // force re-read
        await followPoll();
      } else {
        if (probeTimer) clearTimeout(probeTimer);
        await probeOnce();
        scheduleNextProbe();
      }
    }
  });
}

function cleanup() {
  if (drawTimer) clearTimeout(drawTimer);
  if (probeTimer) clearTimeout(probeTimer);
  if (followTimer) clearInterval(followTimer);
  process.stdout.write(CURSOR_SHOW + ALT_OFF + RESET + "\n");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}

// spinner animation while probing
setInterval(() => {
  if (probing) { spinFrame++; scheduleDraw(); }
}, 100);

process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

// -------- entry --------
export async function runTui() {
  process.stdout.write(ALT_ON + CURSOR_HIDE);
  setupKeys();

  // Always seed from disk if we have history — instant first frame even in probe mode.
  const seed = await loadSamplesTail(240);
  if (seed.length) {
    samples.push(...seed);
    try { lastSamplesMtime = (await stat(SAMPLES_PATH)).mtimeMs; } catch {}
  }

  mode = (await daemonAlive()) ? "follow" : "probe";
  draw();        // first frame (history if seeded, otherwise "waiting…")

  if (mode === "follow") {
    scheduleFollow();
  } else {
    await probeOnce();
    scheduleNextProbe();
  }
}
