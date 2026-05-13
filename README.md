# canireach

> Can I reach the AI? Local network + AI-service-availability monitor, designed for unstable / restricted-routing networks. **TUI by default**, web dashboard with charts under `--web`.

Continuously samples Wi-Fi, LAN, domestic Internet, overseas direct, proxy health, and Anthropic / OpenAI API reachability. Both UIs answer two questions at a glance:

1. **Is the network up?** (wifi → lan → broadband → overseas direct → proxy)
2. **Is the AI up?** (api.anthropic.com / api.openai.com, both direct and via proxy)

Bilingual UI (zh / en), one-key toggle.

## Run

Requires [Bun](https://bun.sh/). Once Bun is on `$PATH`:

```sh
npx canireach              # terminal UI (default — runs probes in-process)
npx canireach --web        # web dashboard on http://localhost:8787 (spawns daemon + server)
npx canireach --once       # single probe, prints JSON
npx canireach --help
```

If you've cloned this repo locally:

```sh
bun src/cli.ts             # same as `npx canireach`
bun src/cli.ts --web
```

### TUI keys

| key | action |
|---|---|
| `q` | quit |
| `l` | toggle language (zh / en) |
| `r` | refresh now |

### Environment variables (all optional)

- `CANIREACH_LANG=zh|en` — force UI language (otherwise auto-detected from `$LANG`).
- `CANIREACH_INTERVAL_MS=60000` — probe interval (TUI and daemon).
- `CANIREACH_PORT=8787` — web dashboard port.
- `CANIREACH_DOWNLOAD_EVERY=10` — daemon-mode throughput sample cadence.

## Layout

- `src/cli.ts` — entry point. Dispatches between TUI, web, and one-shot modes.
- `src/tui.ts` — terminal UI. Runs probes in-process and renders with raw ANSI + Unicode, no extra deps.
- `src/probe.ts` — one-shot collector. Runs all probes once, prints JSON.
- `src/daemon.ts` — long-running collector for web mode. Writes `data/samples.jsonl` and `data/state.json` each interval.
- `src/server.ts` — Bun HTTP server serving `public/index.html` + JSON APIs over the samples.
- `src/verdict.ts` — turns a sample into a layered verdict + a distinct AI-services verdict.
- `public/index.html` — single-page dashboard (Chart.js, vendored).
- `data/` — JSONL samples, latest state, rolling conclusions (gitignored).
- `logs/` — daemon/server stdout+stderr (gitignored).

## Verdict layers

The probe targets a layered diagnosis so a single bad sample tells you *where* the problem is:

| Layer | Pass condition | Failure interpretation |
|---|---|---|
| wifi | RSSI > -75, status=connected | weak/disconnected Wi-Fi |
| lan | ping gateway OK | router / Wi-Fi LAN issue |
| broadband (domestic) | ping 223.5.5.5 OK, https baidu 200 | ISP / upstream broadband issue |
| overseas_direct | https cloudflare/github/google direct | usually partial — informational, common when overseas routes are restricted |
| proxy | port 7897 listening, https google via proxy 200, egress IP fetched | local proxy app or upstream node |
| ai (independent) | Anthropic & OpenAI API endpoints reachable (any HTTP response counts) via proxy and/or direct | proxy down, or AI provider unreachable from both routes |

The "ai" layer is reported as a **separate top-level indicator** — both UIs show two headlines: 网络 (general internet, the first five layers) and AI 服务.
