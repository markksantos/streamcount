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
| Kick | official API (`api.kick.com/public/v1`) | Kick dev app client id + secret |
| X | — | no public/free API for broadcast viewers; phase 2 |

## Kick setup (one-time)

1. Enable 2FA on your Kick account, then go to https://kick.com/settings/developer and create an app (any redirect URL works — we only use client-credentials).
2. Put the credentials in `secrets.env` in this folder (git-ignored):

```
KICK_CLIENT_ID=...
KICK_CLIENT_SECRET=...
```

3. Restart the server. Kick row flips from "needs API keys" to a live count.

## Notes

- Server polls each platform every 15s; pages refresh from the local cache every 5s.
- If YouTube changes its page markup the scrape may break — fallback is the YouTube Data API v3 (`videos.list` → `liveStreamingDetails.concurrentViewers`), which needs a free API key.
