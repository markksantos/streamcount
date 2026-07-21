# streamcount

One number: total live viewers across YouTube + Twitch + Kick (+ X, pending), summed.

## Run

```sh
node server.js
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

## Notes

- Server polls each platform every 15s; pages refresh from the local cache every 5s.
- If YouTube changes its page markup the scrape may break — fallback is the YouTube Data API v3 (`videos.list` → `liveStreamingDetails.concurrentViewers`), which needs a free API key.
