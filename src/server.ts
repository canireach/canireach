// Bun HTTP server. Serves the dashboard HTML and a few JSON endpoints over the JSONL log.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const PORT = parseInt(process.env.NETMON_PORT || "8787", 10);
const DATA_DIR = new URL("../data/", import.meta.url).pathname;
const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;
const SAMPLES_PATH = `${DATA_DIR}samples.jsonl`;
const STATE_PATH = `${DATA_DIR}state.json`;
const CONCLUSIONS_PATH = `${DATA_DIR}conclusions.md`;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/state") {
      if (!existsSync(STATE_PATH)) return Response.json({ error: "no state yet" }, { status: 503 });
      const text = await readFile(STATE_PATH, "utf8");
      return new Response(text, { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/api/samples") {
      const limit = parseInt(url.searchParams.get("limit") || "240", 10);
      const samples = await loadTail(limit);
      return Response.json({ count: samples.length, samples });
    }
    if (url.pathname === "/api/series") {
      // Compact time-series shaped for charting.
      const limit = parseInt(url.searchParams.get("limit") || "240", 10);
      const samples = await loadTail(limit);
      return Response.json(buildSeries(samples));
    }
    if (url.pathname === "/api/conclusions") {
      const text = existsSync(CONCLUSIONS_PATH) ? await readFile(CONCLUSIONS_PATH, "utf8") : "_(no conclusions yet — the 20-min loop will populate this)_";
      return new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveFile(`${PUBLIC_DIR}index.html`, "text/html; charset=utf-8");
    }
    if (url.pathname === "/chart.js") {
      // Vendored Chart.js (UMD). If missing, fetch from CDN at first request and cache.
      return serveFile(`${PUBLIC_DIR}chart.js`, "application/javascript; charset=utf-8");
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`netmon server listening on http://localhost:${server.port}`);

async function loadTail(limit: number) {
  if (!existsSync(SAMPLES_PATH)) return [];
  const text = await readFile(SAMPLES_PATH, "utf8");
  const lines = text.trim().split("\n");
  return lines.slice(-limit).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function buildSeries(samples: any[]) {
  const t = samples.map((s) => s.t);
  const verdict = samples.map((s) => s.verdict?.overall ?? "unknown");
  const layerStateOf = (s: any, name: string) =>
    s.verdict?.layers?.find((l: any) => l.layer === name)?.state ?? "unknown";

  const wifi = {
    rssi: samples.map((s) => s.wifi?.rssi ?? null),
    txRate: samples.map((s) => s.wifi?.txRate ?? null),
    noise: samples.map((s) => s.wifi?.noise ?? null),
    channel: samples.map((s) => s.wifi?.channel ?? null),
    ssid: samples.map((s) => s.wifi?.ssidRedacted ? "<redacted>" : s.wifi?.ssid ?? null),
  };

  const gw = samples.map((s) => {
    const p = s.pings?.find((x: any) => x.target === s.iface?.gateway);
    return p?.avgMs ?? null;
  });
  const ali = samples.map((s) => s.pings?.find((x: any) => x.target === "223.5.5.5")?.avgMs ?? null);
  const cf  = samples.map((s) => s.pings?.find((x: any) => x.target === "1.1.1.1")?.avgMs ?? null);
  const goo = samples.map((s) => s.pings?.find((x: any) => x.target === "8.8.8.8")?.avgMs ?? null);

  // HTTPS per-label series. Failed requests (timeouts, TLS errors, blocked) become NULL
  // so the latency chart shows a gap rather than a misleading 8000ms "latency".
  const httpsLabels = new Set<string>();
  for (const s of samples) for (const h of s.https ?? []) httpsLabels.add(h.label);
  const https: Record<string, { totalMs: (number|null)[]; ok: (boolean|null)[]; timedOut: (boolean|null)[] }> = {};
  for (const lbl of httpsLabels) {
    https[lbl] = { totalMs: [], ok: [], timedOut: [] };
    for (const s of samples) {
      const h = s.https?.find((x: any) => x.label === lbl);
      https[lbl].totalMs.push(h ? (h.ok ? h.totalMs : null) : null);
      https[lbl].ok.push(h ? h.ok : null);
      https[lbl].timedOut.push(h ? !!h.timedOut : null);
    }
  }

  // DNS per-server avg query time on overseas vs domestic domains
  const dnsServers = Array.from(new Set(samples.flatMap((s) => (s.dns ?? []).map((d: any) => d.server))));
  const dns: Record<string, (number | null)[]> = {};
  for (const server of dnsServers) {
    dns[server] = samples.map((s) => {
      const rows = (s.dns ?? []).filter((d: any) => d.server === server);
      if (rows.length === 0) return null;
      const okRows = rows.filter((r: any) => r.ok);
      if (okRows.length === 0) return null;
      return okRows.reduce((a: number, r: any) => a + r.ms, 0) / okRows.length;
    });
  }

  const proxy = {
    egressIp: samples.map((s) => s.proxyEgress?.ip ?? null),
    egressMs: samples.map((s) => s.proxyEgress?.ms ?? null),
    listening: samples.map((s) => s.proxyConfig?.listening ?? null),
    downloadMbps: samples.map((s) => s.proxyDownload?.mbps ?? null),
  };

  const captive = samples.map((s) => s.captive?.ok ?? null);

  const layers = {
    wifi: samples.map((s) => layerStateOf(s, "wifi")),
    lan: samples.map((s) => layerStateOf(s, "lan")),
    broadband: samples.map((s) => layerStateOf(s, "broadband")),
    overseas_direct: samples.map((s) => layerStateOf(s, "overseas_direct")),
    proxy: samples.map((s) => layerStateOf(s, "proxy")),
    ai: samples.map((s) => layerStateOf(s, "ai")),
  };

  const ai = {
    state: samples.map((s) => s.verdict?.ai?.state ?? null),
    anthropicProxy: samples.map((s) => s.https?.find((h: any) => h.label === "anthropic_proxy")?.ok ?? null),
    anthropicDirect: samples.map((s) => s.https?.find((h: any) => h.label === "anthropic_direct")?.ok ?? null),
    openaiProxy: samples.map((s) => s.https?.find((h: any) => h.label === "openai_proxy")?.ok ?? null),
    openaiDirect: samples.map((s) => s.https?.find((h: any) => h.label === "openai_direct")?.ok ?? null),
  };

  return { t, verdict, wifi, pings: { gw, ali, cf, goo }, https, dns, proxy, captive, layers, ai };
}

async function serveFile(path: string, contentType: string): Promise<Response> {
  try {
    const data = await readFile(path);
    return new Response(data, { headers: { "content-type": contentType, "cache-control": "no-store" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
