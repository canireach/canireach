# netmon

Local network state collector + dashboard for diagnosing flaky WiFi / GFW / proxy issues on this Mac.

## Layout

- `src/probe.ts` — one-shot collector. Runs all probes once, prints JSON.
- `src/daemon.ts` — long-running collector. Writes `data/samples.jsonl` and `data/state.json` every interval.
- `src/server.ts` — bun HTTP server serving `public/index.html` + JSON APIs over the samples.
- `src/verdict.ts` — turns raw samples into a layered verdict (wifi → lan → broadband → gfw → proxy).
- `data/` — JSONL samples (one line per cycle) and latest state.
- `logs/` — daemon/server stdout+stderr.

## Run

```sh
~/.bun/bin/bun src/daemon.ts          # collector
~/.bun/bin/bun src/server.ts          # dashboard on http://localhost:8787
~/.bun/bin/bun src/probe.ts           # one-shot, prints JSON
```

## Verdict layers

The probe targets a layered diagnosis so a single bad sample tells you *where* the problem is:

| Layer | Pass condition | Failure interpretation |
|---|---|---|
| wifi | RSSI > -75, status=connected | weak/disconnected Wi-Fi |
| lan | ping gateway < 50ms loss=0 | router/WiFi LAN issue |
| broadband (domestic) | ping 223.5.5.5 OK, https baidu 200 | ISP/upstream issue |
| gfw (overseas direct) | https cloudflare/github direct 200 | usually GFW — informational, not a "fault" |
| proxy | port 7897 listening, https google via proxy 200, egress IP fetched | local proxy app or upstream node |
