// Long-running collector. Writes one JSONL line per cycle to data/samples.jsonl.
// Maintains data/state.json with the latest verdict + a short rolling summary.
// Importable: `runDaemon()` kicks off the loop and returns a promise that resolves on
// SIGINT/SIGTERM. The cli wires that up in --web mode (same process as the server).
import { collectSample, type Sample } from "./probe";
import { appendFile, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const DATA_DIR = new URL("../data/", import.meta.url).pathname;
const SAMPLES_PATH = `${DATA_DIR}samples.jsonl`;
const STATE_PATH = `${DATA_DIR}state.json`;
const LOG_PATH = new URL("../logs/daemon.log", import.meta.url).pathname;

const INTERVAL_MS = parseInt(process.env.CANIREACH_INTERVAL_MS || "60000", 10);
const DOWNLOAD_EVERY = parseInt(process.env.CANIREACH_DOWNLOAD_EVERY || "10", 10);

export async function runDaemon(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(new URL("../logs/", import.meta.url).pathname, { recursive: true });

  let cycle = 0;
  let running = true;
  const startedAt = new Date().toISOString();

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stdout.write(line);
    appendFile(LOG_PATH, line).catch(() => {});
  };

  let rolling: Sample[] = await loadRollingTail();

  const stop = () => { log("signal — stopping"); running = false; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  log(`daemon up, interval=${INTERVAL_MS}ms, downloadEvery=${DOWNLOAD_EVERY}, rollingTail=${rolling.length}`);

  while (running) {
    cycle++;
    const withDownload = cycle % DOWNLOAD_EVERY === 1;
    const tStart = Date.now();
    try {
      const sample = await collectSample({ withDownload });
      await appendFile(SAMPLES_PATH, JSON.stringify(sample) + "\n");
      rolling.push(sample);
      if (rolling.length > 200) rolling = rolling.slice(-200);

      const state = buildState(sample, rolling, startedAt, cycle);
      await writeFile(STATE_PATH, JSON.stringify(state, null, 2));

      log(`cycle=${cycle} verdict=${sample.verdict.overall} cycleMs=${sample.cycleMs.toFixed(0)} egress=${sample.proxyEgress?.ip ?? "-"} rssi=${sample.wifi?.rssi ?? "-"}`);
    } catch (err) {
      log(`cycle=${cycle} ERROR ${String(err)}`);
    }
    const elapsed = Date.now() - tStart;
    if (!running) break;
    await sleep(Math.max(0, INTERVAL_MS - elapsed));
  }
  log("daemon exiting");
}

async function loadRollingTail(): Promise<Sample[]> {
  if (!existsSync(SAMPLES_PATH)) return [];
  try {
    const text = await readFile(SAMPLES_PATH, "utf8");
    const lines = text.trim().split("\n").slice(-120);
    const out: Sample[] = [];
    for (const l of lines) {
      try { out.push(JSON.parse(l) as Sample); } catch { /* skip partial */ }
    }
    return out;
  } catch {
    return [];
  }
}

function buildState(latest: Sample, tail: Sample[], startedAt: string, cycle: number) {
  const last20 = tail.slice(-20);
  const counts: Record<string, number> = {};
  for (const s of last20) counts[s.verdict.overall] = (counts[s.verdict.overall] ?? 0) + 1;

  const httpsAgg: Record<string, { ok: number; total: number; avgMs: number }> = {};
  for (const s of last20) {
    for (const h of s.https) {
      const key = h.label;
      if (!httpsAgg[key]) httpsAgg[key] = { ok: 0, total: 0, avgMs: 0 };
      httpsAgg[key].total++;
      if (h.ok) httpsAgg[key].ok++;
      httpsAgg[key].avgMs += h.totalMs;
    }
  }
  for (const k of Object.keys(httpsAgg)) httpsAgg[k].avgMs /= Math.max(1, httpsAgg[k].total);

  const egressIps = last20.map((s) => s.proxyEgress?.ip).filter(Boolean) as string[];
  const uniqueEgress = Array.from(new Set(egressIps));

  return {
    daemonStartedAt: startedAt,
    updatedAt: latest.t,
    cycle,
    interval_ms: INTERVAL_MS,
    latest,
    rolling: { windowSize: last20.length, verdictCounts: counts, httpsAgg, uniqueEgressIps: uniqueEgress },
  };
}

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }
