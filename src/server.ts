// HTTP server for the web dashboard. Uses node:http so the bundle runs on both
// plain Node (`npx canireach --web`) and Bun (`bunx canireach --web`).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const PORT = parseInt(process.env.CANIREACH_PORT || "8787", 10);
const DATA_DIR = new URL("../data/", import.meta.url).pathname;
const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;
const SAMPLES_PATH = `${DATA_DIR}samples.jsonl`;
const STATE_PATH = `${DATA_DIR}state.json`;
const CONCLUSIONS_PATH = `${DATA_DIR}conclusions.md`;

type Response = { status: number; headers: Record<string, string>; body: string | Buffer };

export function startServer(): ReturnType<typeof createServer> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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

async function route(url: URL): Promise<Response> {
  const p = url.pathname;

  if (p === "/api/state") {
    if (!existsSync(STATE_PATH)) return json({ error: "no state yet" }, 503);
    return text(await readFile(STATE_PATH, "utf8"), "application/json");
  }
  if (p === "/api/samples") {
    const limit = parseInt(url.searchParams.get("limit") || "240", 10);
    const samples = await loadTail(limit);
    return json({ count: samples.length, samples });
  }
  if (p === "/api/series") {
    const limit = parseInt(url.searchParams.get("limit") || "240", 10);
    const samples = await loadTail(limit);
    return json(buildSeries(samples));
  }
  if (p === "/api/conclusions") {
    const body = existsSync(CONCLUSIONS_PATH)
      ? await readFile(CONCLUSIONS_PATH, "utf8")
      : "_(no conclusions yet — the 20-min loop will populate this)_";
    return text(body, "text/markdown; charset=utf-8");
  }
  if (p === "/" || p === "/index.html") return serveStatic("index.html", "text/html; charset=utf-8");
  if (p === "/chart.js")                return serveStatic("chart.js", "application/javascript; charset=utf-8");
  if (p === "/favicon.svg")             return serveStatic("favicon.svg", "image/svg+xml");

  return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
}

function json(obj: unknown, status = 200): Response {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
}
function text(body: string, contentType: string, status = 200): Response {
  return { status, headers: { "content-type": contentType }, body };
}
async function serveStatic(name: string, contentType: string): Promise<Response> {
  try {
    const data = await readFile(`${PUBLIC_DIR}${name}`);
    return { status: 200, headers: { "content-type": contentType, "cache-control": "no-store" }, body: data };
  } catch {
    return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
  }
}

async function loadTail(limit: number) {
  if (!existsSync(SAMPLES_PATH)) return [];
  const t = await readFile(SAMPLES_PATH, "utf8");
  const lines = t.trim().split("\n");
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

  const dnsServers = Array.from(new Set(samples.flatMap((s) => (s.dns ?? []).map((d: any) => d.server))));
  const dns: Record<string, (number | null)[]> = {};
  for (const sv of dnsServers) {
    dns[sv] = samples.map((s) => {
      const rows = (s.dns ?? []).filter((d: any) => d.server === sv);
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
