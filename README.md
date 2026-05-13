# canireach

> Can I reach the AI? Local network + AI-service-availability monitor for this Mac, designed for unstable / restricted-routing networks.

Continuously samples Wi-Fi, LAN, domestic Internet, overseas direct, proxy health, and Anthropic / OpenAI API reachability. The dashboard answers two questions at a glance:

1. **Is the network up?** (wifi → lan → broadband → overseas direct → proxy)
2. **Is the AI up?** (api.anthropic.com / api.openai.com, both direct and via proxy)

## Layout

- `src/probe.ts` — one-shot collector. Runs all probes once, prints JSON.
- `src/daemon.ts` — long-running collector. Writes `data/samples.jsonl` and `data/state.json` every interval.
- `src/server.ts` — bun HTTP server serving `public/index.html` + JSON APIs over the samples.
- `src/verdict.ts` — turns raw samples into a layered verdict + a distinct AI-services verdict.
- `data/` — JSONL samples (one line per cycle), latest state, rolling conclusions (gitignored).
- `logs/` — daemon/server stdout+stderr (gitignored).

## Run

```sh
~/.bun/bin/bun src/daemon.ts          # collector
~/.bun/bin/bun src/server.ts          # dashboard on http://localhost:8787
~/.bun/bin/bun src/probe.ts           # one-shot, prints JSON
```

Environment variables (all optional):

- `CANIREACH_INTERVAL_MS` — collector interval, default 60000.
- `CANIREACH_DOWNLOAD_EVERY` — run a throughput probe every Nth cycle, default 10.
- `CANIREACH_PORT` — dashboard port, default 8787.

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

The "ai" layer is reported as a **separate top-level indicator** — the dashboard shows two banners: "网络" (general internet, covers the first five layers) and "AI 服务".
