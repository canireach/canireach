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
  const port = process.env.CANIREACH_PORT || "8787";
  const url = `http://localhost:${port}`;

  console.log(`starting daemon → ${daemonPath}`);
  const daemon = spawn(bunBin, [daemonPath], { stdio: "inherit" });
  console.log(`starting server → ${url}`);
  const server = spawn(bunBin, [serverPath], { stdio: "inherit" });

  // Auto-open the dashboard once the server has had a moment to bind the port.
  // The `--no-open` flag (or CANIREACH_NO_OPEN=1) skips it — useful for SSH / CI / headless.
  if (!has("--no-open") && process.env.CANIREACH_NO_OPEN !== "1") {
    setTimeout(() => openBrowser(url), 1500);
  }

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

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open"
            : process.platform === "win32" ? "start"
            : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Headless box, no $DISPLAY, etc. — silently skip; user can still hit the URL.
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
                                 env vars and system proxy detection). Use to point
                                 at a non-default port. Unset = no override.
  CANIREACH_LANG=zh|en           Force UI language (otherwise auto-detected)
  CANIREACH_INTERVAL_MS=60000    Probe interval (TUI and daemon)
  CANIREACH_PORT=8787            Dashboard port (web mode only)
  CANIREACH_DOWNLOAD_EVERY=10    Daemon-mode throughput sample cadence
  CANIREACH_NO_OPEN=1            Don't open the browser in --web mode
`);
}
