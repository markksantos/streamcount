# streamcount

One number: total live viewers across YouTube + Twitch + Kick (+ X, pending), summed.

## Run

The poller runs as a launchd agent, so it starts at login and restarts if it
dies. Nothing to do by hand:

```sh
launchctl print gui/501/com.markksantos.streamcount | grep -E 'state|pid'
tail -f streamcount.log
```

Install (already done) / reinstall after editing the plist:

```sh
cp com.markksantos.streamcount.plist ~/Library/LaunchAgents/
launchctl bootout gui/501/com.markksantos.streamcount 2>/dev/null
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.markksantos.streamcount.plist
```

For one-off foreground debugging (stop the agent first, or port 5959 is taken):

```sh
launchctl bootout gui/501/com.markksantos.streamcount && node server.js
```

- Dashboard: http://localhost:5959
- OBS browser source (transparent, just the number): http://localhost:5959/overlay
- JSON: http://localhost:5959/api/viewers

Channels, port, and poll interval live in `config.json`.

## Platform status

| Platform | How | Keys needed |
|---|---|---|
| YouTube | scrapes `youtube.com/@handle/live` | none |
| Twitch | public web GQL endpoint | none |
| Kick | `kick_probe.py` via curl_cffi (Chrome TLS impersonation beats Cloudflare) | none |
| X | — | no public/free API for broadcast viewers; phase 2 |

## Kick

Kick's Cloudflare blocks curl/Node/headless-Chrome, so the server shells out to
`.venv/bin/python kick_probe.py <slug>`, which uses `curl_cffi` to impersonate a
real Chrome TLS handshake. One-time setup (already done):

```sh
python3 -m venv .venv && ./.venv/bin/pip install curl_cffi
```

If the `.venv` is missing, the server falls back to Kick's official API
(`KICK_CLIENT_ID`/`KICK_CLIENT_SECRET` in git-ignored `secrets.env`), else
shows "needs API keys".

## Public dashboard (here.now)

Bookmarkable from anywhere: https://pastel-hollow-jmxj.here.now/ (overlay at
`/overlay.html`). Push model — this Mac's poller PATCHes one record in the
site's Site Data collection (`stats`) after each poll (only on change, plus a
4-min heartbeat); the static page reads it from browser JS every 30s. Writes
need the owner API key in `~/.herenow/credentials`; the page and site files
contain no secrets, and nothing connects inbound to this machine. If the
poller stops, the page shows an amber "stale" note after 3 minutes.

**The public page is only ever as alive as this Mac's poller.** A frozen page
(0 viewers, everything "offline", amber stale note) means the poller stopped —
not that the scrapers broke, and never anything a viewer can fix by clearing
cookies. Check `launchctl print gui/501/com.markksantos.streamcount` first.
This is exactly what happened on 2026-07-22: the poller had been started by
hand in a terminal window, the window went away at 10:22 PM, and the record
stayed frozen on its last all-offline snapshot through the next stream. Hence
the launchd agent.

Site source lives in `site/`; republish after edits with:

```sh
~/.claude/skills/here-now/scripts/publish.sh ./site --slug pastel-hollow-jmxj --client claude-code
```

## Notes

- Server polls each platform every 15s; pages refresh from the local cache every 5s.
- If YouTube changes its page markup the scrape may break — fallback is the YouTube Data API v3 (`videos.list` → `liveStreamingDetails.concurrentViewers`), which needs a free API key.
