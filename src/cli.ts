// Entry point. Dispatches:
//   canireach           → TUI mode (in-process probes)
//   canireach --web     → daemon + dashboard server on :8787
//   canireach --once    → run one probe and print JSON (for piping)
//   canireach --help
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const has = (...flags: string[]) => flags.some((f) => args.includes(f));

if (has("-h", "--help")) {
  printHelp();
  process.exit(0);
}

if (has("-w", "--web", "--server")) {
  startWeb();
} else if (has("--once")) {
  // Run one probe and print JSON.
  const { collectSample } = await import("./probe");
  const sample = await collectSample();
  console.log(JSON.stringify(sample, null, 2));
} else {
  // Default: TUI.
  const { runTui } = await import("./tui");
  await runTui();
}

function startWeb() {
  const here = dirname(fileURLToPath(import.meta.url));
  const bunBin = process.execPath; // when launched via bun, this IS bun
  const daemonPath = resolve(here, "daemon.ts");
  const serverPath = resolve(here, "server.ts");

  console.log(`starting daemon → ${daemonPath}`);
  const daemon = spawn(bunBin, [daemonPath], { stdio: "inherit" });
  console.log(`starting server → ${serverPath}`);
  const server = spawn(bunBin, [serverPath], { stdio: "inherit" });

  const shutdown = () => {
    daemon.kill("SIGTERM");
    server.kill("SIGTERM");
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  daemon.on("exit", (c) => { console.log(`daemon exited (${c})`); shutdown(); });
  server.on("exit", (c) => { console.log(`server exited (${c})`); shutdown(); });
}

function printHelp() {
  process.stdout.write(`canireach — local network + AI-service reachability monitor

Usage:
  canireach              Launch the terminal UI (default; runs probes in-process)
  canireach --web        Start the dashboard server on http://localhost:8787
                         (spawns the long-running daemon + bun HTTP server)
  canireach --once       Run a single probe and print the result as JSON
  canireach -h, --help   Show this help

TUI keys:
  q   quit
  l   toggle language (zh / en)
  r   refresh now

Environment variables:
  CANIREACH_LANG=zh|en           Force TUI language (overrides $LANG detection)
  CANIREACH_INTERVAL_MS=60000    Probe interval (TUI and daemon)
  CANIREACH_PORT=8787            Dashboard port (web mode only)
  CANIREACH_DOWNLOAD_EVERY=10    Daemon-mode throughput sample cadence
`);
}
