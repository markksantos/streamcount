<div align="center">

# 📡 streamcount

**One number for your total live audience — every platform, summed**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](#)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?style=for-the-badge&logo=python&logoColor=white)](#)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-000000?style=for-the-badge)](#)
[![macOS](https://img.shields.io/badge/macOS-LaunchAgent-000000?style=for-the-badge&logo=apple&logoColor=white)](#)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](#)

[Features](#-features) · [Getting Started](#-getting-started) · [Configuration](#️-configuration) · [Tech Stack](#️-tech-stack)

</div>

---

When you multistream, your audience is scattered — 8 on YouTube, 1 on Twitch, 2 on Kick. No platform shows you the total, so you end up eyeballing three dashboards mid-stream and doing mental arithmetic.

streamcount polls every platform you're live on and gives you a single number. Put it on a second monitor, burn it into your scene as an OBS overlay, or read it from your phone while you're on camera.

No API keys. No accounts. No third-party service between you and your own numbers.

---

## ✨ Features

- **One aggregate number** — YouTube, Twitch and Kick polled in parallel every 15s and summed into a single live total
- **Per-platform breakdown** — see exactly where the audience is, with each platform's own state (live, offline, unreachable, unsupported)
- **OBS overlay** — transparent browser-source page that renders just the number, ready to drop into a scene
- **Phone-friendly public dashboard** — optional push to a static page you can bookmark and check from anywhere, with no inbound connection to your machine
- **Keyless Kick support** — clears Kick's Cloudflare challenge with a Chrome TLS-impersonation probe, so no developer keys are needed
- **"0" never lies** — a zero is only ever shown when every platform was actually reached and said nobody is watching. If the poller couldn't ask, you get `?`, not `0` ([why this matters](#-poller-health-the-0-problem))
- **Poller health is reported separately from stream status** — `/api/health`, a health chip on every page, and a `poller` block on the public record
- **Dead-poller alerting** — an external watchdog notices when the poller stops answering and alerts through a configurable sink (defaults to a local log; sends nothing anywhere)
- **Runs unattended** — installs as a LaunchAgent that starts at login and restarts itself if it dies, with request timeouts, retry-with-backoff, an anti-wedge watchdog and bounded logs
- **Zero npm dependencies** — standard-library Node, tests included (`npm test`)
- **Local by default** — nothing leaves your machine unless you explicitly turn on the public dashboard or a network alert sink

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- Python 3.12+ (only if you want Kick)

### Installation

```bash
git clone https://github.com/markksantos/streamcount.git
cd streamcount
cp config.example.json config.json
```

Put your channel handles in `config.json`, then start it:

```bash
node server.js
```

- Dashboard: <http://localhost:5959>
- OBS browser source: <http://localhost:5959/overlay>
- JSON: <http://localhost:5959/api/viewers>
- Health: <http://localhost:5959/api/health> (200 when healthy, 503 when the poller is blind)

Run the tests with `npm test` — no dependencies to install, and they make no
network calls.

### Kick (optional)

Kick sits behind Cloudflare, which blocks curl, Node's `fetch` and even headless
Chrome. The way through is a real Chrome TLS handshake, which `curl_cffi`
impersonates:

```bash
python3 -m venv .venv && ./.venv/bin/pip install curl_cffi
```

The server shells out to `.venv/bin/python kick_probe.py <slug>` automatically
once that exists. If it's missing, Kick falls back to the official API
(`KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` in a git-ignored `secrets.env`), and
otherwise reports "needs API keys".

### Run it unattended (macOS)

A foreground `node server.js` dies with its terminal window — which means a
frozen counter the moment you close the tab. Install the LaunchAgent instead:

```bash
cp com.markksantos.streamcount.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.markksantos.streamcount.plist
```

Edit `WorkingDirectory` and the `node` path in the plist to match your machine
first. It sets `RunAtLoad` and `KeepAlive`, so the poller starts at login and
comes back if it crashes. Check on it with:

```bash
launchctl print gui/$(id -u)/com.markksantos.streamcount | grep -E 'state|pid'
tail -f streamcount.log
```

To run in the foreground for debugging, stop the agent first or port 5959 will
already be taken:

```bash
launchctl bootout gui/$(id -u)/com.markksantos.streamcount && node server.js
```

---

## ⚙️ Configuration

Copy `config.example.json` to `config.json` (git-ignored, so your handles stay yours):

| Field | Default | What it does |
|-------|---------|-------------|
| `port` | `5959` | Local port for the dashboard, overlay and JSON API |
| `pollSeconds` | `15` | How often every platform is polled |
| `requestTimeoutSeconds` | `10` | Hard timeout on every outbound request (Node's `fetch` has none by default) |
| `retryAttempts` | `2` | Attempts per platform per poll, with exponential backoff + jitter |
| `staleAfterMinutes` | `3` | No successful poll for this long ⇒ poller is **stale**: pages show `?` and the alert fires |
| `log.maxMegabytes` | `5` | `streamcount.log` is truncated in place past this, keeping the tail in `streamcount.log.1` |
| `log.heartbeatMinutes` | `4` | Identical poll results are logged at most this often instead of every tick |
| `alerts.*` | — | See [Alerting](#-alerting) |
| `channels.youtube` | — | YouTube handle, without the `@`. Leave empty to skip the platform entirely |
| `channels.twitch` | — | Twitch login name |
| `channels.kick` | — | Kick channel slug |
| `channels.x` | — | X handle (reserved — see below) |
| `herenow.slug` | `""` | Optional public-dashboard slug; leave empty to stay fully local |

---

## 🩺 Poller health: the "0" problem

On 2026-07-22 the poller died at 10:22 PM on an all-offline snapshot. Every
page kept rendering that frozen record, so an entire stream showed `0 viewers ·
offline` while all three scrapers were perfectly healthy. Nothing on screen
could tell the difference between *nobody is watching* and *nobody is looking*.

That ambiguity is now designed out. Two independent questions are answered
separately, everywhere:

| Question | Where it's answered |
|---|---|
| Is anyone watching? | `total`, `platforms[].live` |
| Do we actually **know** that? | `totalKnown`, `confidence`, and the whole `poller` block |

Per-platform status now distinguishes *reached it* from *couldn't ask*:

| Status | Meaning | Counts toward the total? |
|---|---|---|
| `ok` | live, with a viewer count | yes |
| `offline` | reached the platform, nobody is live | yes, as a real `0` |
| `error` / `timeout` | **we could not ask** — the count is unknown | no, and it poisons `confidence` |
| `disabled` / `needs_keys` / `unsupported` | nothing to poll | no |

So a rate-limited YouTube scrape reads `unreachable`, not `offline` — the old
code fell straight through the regex and reported an empty stream. And if
*every* pollable platform fails, `totalKnown` goes `false` and every surface
shows `?` rather than a confident zero.

Poller status itself is one of:

| Status | Meaning |
|---|---|
| `starting` | process just came up, first poll in flight |
| `ok` | a poll reached upstream within the last couple of intervals |
| `degraded` | reachable but some platforms are erroring, or the loop is running late |
| `stale` | no successful poll for `staleAfterMinutes` — **numbers are not trustworthy** |
| `dead` | `/api/health` doesn't answer at all — concluded by the pages and the watchdog, never by the server itself |

```console
$ curl -s localhost:5959/api/health | jq '{status: .poller.status, totalKnown, confidence}'
{ "status": "ok", "totalKnown": true, "confidence": "full" }
```

`/api/health` returns **503** when the poller is stale, so `curl -f` or any
off-the-shelf uptime check works without extra glue.

### What keeps it alive

- **Timeouts on every outbound request** — a hung fetch used to wedge the loop silently
- **Retry with exponential backoff + jitter** before a platform is declared unreachable
- **No overlapping polls** — a self-scheduling loop replaced `setInterval`, which used to stack polls on top of a hung one
- **An anti-wedge watchdog** inside the process abandons a poll that overruns its deadline and re-arms the loop; the abandoned poll's result is discarded rather than overwriting fresher data
- **Crash-safe restart** — `uncaughtException` / `unhandledRejection` are logged loudly and exit non-zero so launchd's `KeepAlive` restarts a clean process, instead of limping on with a dead poll loop
- **Bounded logs** — `streamcount.log` is truncated in place past `log.maxMegabytes` (launchd holds the fd, so renaming wouldn't work), and identical results are logged on change plus a heartbeat rather than every 15 seconds

---

## 🔔 Alerting

If no poll has succeeded for `staleAfterMinutes`, streamcount alerts. **Nothing
is sent off your machine by default** — the default sink writes to stdout and
appends one line to `alerts.log`.

```jsonc
"alerts": {
  "sink": "log",          // log | none | command | webhook
  "repeatMinutes": 15,    // re-alert at most this often while it stays down
  "webhookUrl": "",       // required by the webhook sink
  "command": null         // required by the command sink
}
```

| Sink | What it does |
|---|---|
| `log` *(default)* | stdout + `alerts.log`. No network. |
| `none` | no-op |
| `command` | runs a local command with the alert JSON as `argv[1]` — e.g. `terminal-notifier`, a `shortcuts run` call, or your own script |
| `webhook` | `POST`s the alert JSON to `webhookUrl` — a Slack or Discord incoming webhook works as-is |

Alerts are throttled to one per `repeatMinutes` and emit a matching `resolved`
event when the poller recovers, so an overnight outage produces a handful of
lines rather than thousands. A failing sink is logged and swallowed — alerting
can never take the poller down.

### The dead-poller watchdog

A running process cannot report its own death, so `watchdog.js` asks from
outside:

```bash
node watchdog.js          # exit 0 healthy, 1 dead-or-stale, 2 misconfigured
```

Install it as its own LaunchAgent to have it check every 5 minutes:

```bash
cp com.markksantos.streamcount.watchdog.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.markksantos.streamcount.watchdog.plist
```

It shares the alert sinks above, and persists its throttle state in
`.watchdog-state.json` so a one-shot run still honours `repeatMinutes`.

---

## 🔧 How it works

```
every 15s (never overlapping — the next poll is scheduled when this one ends)
  -> YouTube   scrape youtube.com/@handle/live for "watching now"
  -> Twitch    public web GQL endpoint
  -> Kick      curl_cffi probe with Chrome TLS impersonation
  -> X         (unsupported)
     each with a 10s timeout and 2 attempts with backoff
  -> sum ONLY the platforms that were actually reached
  -> stamp lastSuccessAt if at least one platform answered definitively
  -> serve at :5959, and optionally push one record to the public page

separately, every 5 minutes
  -> watchdog.js asks /api/health from outside and alerts if it's dead or stale
```

Each platform is fetched independently, so one failing scrape degrades to that
row reading `unreachable` rather than taking the whole total down with it. Only
platforms reporting a confirmed live state contribute to the sum — and a poll
where *nothing* could be reached is recorded as a failed poll, not as a stream
with zero viewers.

### Public dashboard

The optional public page is a **push** model: your machine PATCHes a single
record on a static host after each poll (on change, plus a 4-minute heartbeat),
and the page reads that record from browser JS every 30s. Writes need an owner
API key that lives outside the repo — the published page and site files contain
no secrets, and nothing ever connects inbound to your machine.

The tradeoff is that the public page is only ever as alive as your local
poller. Two independent signals now cover that:

- **The record stops being pushed** (poller process dead) — the page notices the
  record hasn't moved in 3 minutes and says `POLLER DEAD`, showing `?`.
- **The record is fresh but the poller is blind** (every scrape failing) — the
  pushed `poller` block carries `stale`/`reason`, and the page says
  `POLLER BLIND` instead of rendering the zero it would otherwise compute.

**A public page showing zeros and "offline" used to mean a dead poller, not a
broken scraper.** It can no longer show that at all — it shows `?` and says
which of the two happened. Check the LaunchAgent first either way.

> **Schema note.** Site Data collections validate against the schema baked in at
> publish time (`site/.herenow/data.json`). Until you republish `site/`, the
> collection rejects the top-level `poller` field, so the server automatically
> falls back to nesting it at `platforms._poller`. Both pages read either
> location, so the fallback is invisible; republishing just makes the record
> tidier.

---

## 📊 Platform support

| Platform | How | Keys needed |
|---|---|---|
| YouTube | scrapes `youtube.com/@handle/live` for the `videoViewCountRenderer` "watching now" count | none |
| Twitch | public web GQL endpoint | none |
| Kick | `kick_probe.py` via `curl_cffi` — Chrome TLS impersonation beats Cloudflare | none |
| X | — | no public or free API for live broadcast viewers |

YouTube is the fragile one: it's page-markup scraping, so a YouTube redesign
makes that row read `offline` while every other platform keeps working. The
fallback is the YouTube Data API v3 (`videos.list` →
`liveStreamingDetails.concurrentViewers`), which needs a free API key.

---

## 🛠️ Tech Stack

| Category | Technology |
|----------|-----------|
| Server | Node.js 18+, standard library only |
| Kick probe | Python 3.12 + `curl_cffi` (Chrome TLS impersonation) |
| Frontend | Vanilla HTML/CSS/JS, no build step |
| Process supervision | macOS LaunchAgent (`RunAtLoad` + `KeepAlive`) |
| Public dashboard | Static page + a single pushed data record |

---

## 📁 Project Structure

```
streamcount/
├── server.js                                   # Config, fetchers, HTTP server, wiring
├── watchdog.js                                 # External dead-poller check (one shot)
├── lib/
│   ├── poller.js                               # Poll loop: overlap guard, retries, anti-wedge watchdog
│   ├── health.js                               # Pure: "is anyone watching" vs "do we know" (no I/O)
│   ├── alerts.js                               # Alert sinks — log (default) / none / command / webhook
│   ├── retry.js                                # Backoff + fetch-with-timeout
│   └── logrotate.js                            # In-place truncation (launchd holds the fd)
├── test/                                       # node:test, zero deps, no network — `npm test`
├── kick_probe.py                               # curl_cffi Chrome-TLS probe for Kick
├── config.example.json                         # Copy to config.json
├── com.markksantos.streamcount.plist           # Poller LaunchAgent — edit paths before installing
├── com.markksantos.streamcount.watchdog.plist  # Watchdog LaunchAgent (every 5 min)
├── public/
│   ├── index.html                              # Local dashboard
│   └── overlay.html                            # OBS browser source (transparent)
└── site/
    ├── index.html                              # Public dashboard
    ├── overlay.html                            # Public overlay
    └── .herenow/data.json                      # Site Data collection schema
```

---

## 📄 License

MIT License © 2026 Mark Santos
