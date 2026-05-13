// Entry point. Dispatches:
//   canireach            → TUI mode (in-process probes, reuse daemon data if running)
//   canireach --web      → daemon + dashboard server in this same process
//   canireach --once     → run one probe and print JSON
//   canireach --help
//
// The whole CLI bundles to dist/canireach.mjs (target=node, format=esm) and runs on
// either Node or Bun. The bin script picks whichever runtime is on $PATH.
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const has = (...flags: string[]) => flags.some((f) => args.includes(f));

if (has("-h", "--help")) {
  printHelp();
  process.exit(0);
}

if (has("-w", "--web", "--server")) {
  await startWeb();
} else if (has("--once")) {
  const { collectSample } = await import("./probe");
  const sample = await collectSample();
  console.log(JSON.stringify(sample, null, 2));
} else {
  const { runTui } = await import("./tui");
  await runTui();
}

async function startWeb() {
  const port = process.env.CANIREACH_PORT || "8787";
  const url = `http://localhost:${port}`;

  // Both daemon and server run in this same process now (no child processes / .ts
  // spawning). The HTTP server's listen() keeps the event loop alive; the daemon's
  // loop runs alongside.
  const { startServer } = await import("./server");
  const { runDaemon } = await import("./daemon");

  startServer();
  // Don't await — let the daemon loop run in the background. SIGINT will end it.
  runDaemon().catch((e) => { console.error("daemon error:", e); process.exit(1); });

  console.log(`dashboard: ${url}`);
  if (!has("--no-open") && process.env.CANIREACH_NO_OPEN !== "1") {
    setTimeout(() => openBrowser(url), 1500);
  }

  // Graceful shutdown: SIGINT/SIGTERM trigger daemon's running=false, which then
  // exits the loop. We also have to actually exit the process — the HTTP server
  // would otherwise keep us alive.
  const shutdown = () => { setTimeout(() => process.exit(0), 300); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open"
            : process.platform === "win32" ? "start"
            : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Headless / no DISPLAY — silently skip; the URL is already printed.
  }
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
