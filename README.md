# graph-dstat

Realtime L7 firewall telemetry dashboard.

## The file

**[`l7-firewall-graph.html`](l7-firewall-graph.html)** — the whole app. One file, no build step,
no CDN, no fonts to download, no dependencies. Open it in a browser and it works.

It polls an nginx `stub_status` endpoint once per second and renders a rolling 60-second
window: each new second slides in at the right edge and the oldest second slides off the
left. The chart glides continuously rather than jumping, because the x-axis is mapped to
wall-clock time, not to sample index.

### Data source

```
GET https://graph.vshield.pro/7VTnnXWvhdVeUC6q?_=<epoch-ms>
```

```
Active connections: 141
server accepts handled requests
 464546603 464546603 3173921738
Reading: 0 Writing: 1 Waiting: 140
```

The `?_=` cache-buster is appended on every poll. `accepts`, `handled` and `requests` are
monotonic counters, so the dashboard differentiates them into per-second rates and divides
by the *measured* elapsed time, which means a late response can never inflate `req/s`.

The stacked main chart relies on the `stub_status` invariant:

```
active === reading + writing + waiting
```

### What's on screen

| Panel | Shows |
| --- | --- |
| KPI rail | active connections, req/s, conn/s, connection state, drops/s, lifetime requests |
| Main chart | active connections stacked by reading / writing / waiting |
| Heat strip | per-second request density across the window |
| Mini charts | req/s (area), new conn/s (bars), dropped/s (bars) |
| Event stream | spikes, sample gaps, drops, counter resets, feed errors |
| Gauge | active connections against a configurable capacity |

Window is switchable 30s / 60s / 2m / 5m (15 min of history is retained for exports).
`SPACE` pauses, `1`–`4` switch window, `E` exports CSV, `P` exports a PNG snapshot,
`C` clears the log, `G` opens settings.

### If the feed is blocked by CORS

A browser fetch is cross-origin, so the endpoint must send `Access-Control-Allow-Origin`.
On nginx:

```nginx
add_header Access-Control-Allow-Origin  *;
add_header Access-Control-Allow-Methods GET;
```

Until that's in place, **Transport: AUTO** (the default) tries a direct fetch first and
then falls back through public CORS relays, and **Transport: DEMO** renders synthetic
traffic — calibrated to live readings of this endpoint — so the UI is usable offline.

## Verifying

```
cd tools && npm install && npm run verify
```

`tools/verify-l7-graph.js` loads the real HTML in jsdom, stubs `fetch` with bodies captured
from the live endpoint, and drives the page: 68 assertions over parsing, rate maths, the
rolling window, counter resets, out-of-order replies, gap detection, canvas rendering,
the tooltip, CSV/PNG export, error back-off and recovery, demo mode, and pause/resume.

The harness stubs `clientWidth`/`clientHeight`, because jsdom has no layout engine and every
chart bails out on its zero-size guard without it.
