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
- **Per-platform breakdown** — see exactly where the audience is, with each platform's own state (live, offline, unsupported)
- **OBS overlay** — transparent browser-source page that renders just the number, ready to drop into a scene
- **Phone-friendly public dashboard** — optional push to a static page you can bookmark and check from anywhere, with no inbound connection to your machine
- **Keyless Kick support** — clears Kick's Cloudflare challenge with a Chrome TLS-impersonation probe, so no developer keys are needed
- **Honest staleness** — every reading is timestamped; if the poller stops, pages say so in amber instead of quietly showing a frozen number
- **Runs unattended** — installs as a LaunchAgent that starts at login and restarts itself if it dies
- **Zero npm dependencies** — the whole server is one file of standard-library Node
- **Local by default** — nothing leaves your machine unless you explicitly turn on the public dashboard

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
| `channels.youtube` | — | YouTube handle, without the `@` |
| `channels.twitch` | — | Twitch login name |
| `channels.kick` | — | Kick channel slug |
| `channels.x` | — | X handle (reserved — see below) |
| `herenow.slug` | `""` | Optional public-dashboard slug; leave empty to stay fully local |

---

## 🔧 How it works

```
every 15s
  -> YouTube   scrape youtube.com/@handle/live for "watching now"
  -> Twitch    public web GQL endpoint
  -> Kick      curl_cffi probe with Chrome TLS impersonation
  -> X         (unsupported)
  -> sum the platforms that are actually live
  -> serve at :5959, and optionally push one record to the public page
```

Each platform is fetched independently, so one failing scrape degrades to that
row reading `error` rather than taking the whole total down with it. Only
platforms reporting a confirmed live state contribute to the sum.

### Public dashboard

The optional public page is a **push** model: your machine PATCHes a single
record on a static host after each poll (on change, plus a 4-minute heartbeat),
and the page reads that record from browser JS every 30s. Writes need an owner
API key that lives outside the repo — the published page and site files contain
no secrets, and nothing ever connects inbound to your machine.

The tradeoff is that the public page is only ever as alive as your local
poller. If the poller stops, the record freezes on its last snapshot, so the
page shows an amber "stale" note after 3 minutes rather than pretending a
three-hour-old zero is current. **A public page showing zeros and "offline" is
a dead poller, not a broken scraper** — check the LaunchAgent first.

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
├── server.js                          # Poller, fetchers, HTTP server (zero deps)
├── kick_probe.py                      # curl_cffi Chrome-TLS probe for Kick
├── config.example.json                # Copy to config.json
├── com.markksantos.streamcount.plist  # LaunchAgent — edit paths before installing
├── public/
│   ├── index.html                     # Local dashboard
│   └── overlay.html                   # OBS browser source (transparent)
└── site/
    ├── index.html                     # Public dashboard
    └── overlay.html                   # Public overlay
```

---

## 📄 License

MIT License © 2026 Mark Santos
