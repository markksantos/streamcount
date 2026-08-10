#!/usr/bin/env node
// streamcount — one number for total live viewers across YouTube, Twitch, Kick (and X, pending).
// Zero dependencies. Node 18+.
//
// Poller health is reported separately from stream status everywhere: a dead or
// stalled poller must never be mistaken for a quiet stream. See lib/health.js.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const { createPoller } = require("./lib/poller");
const { createAlerter } = require("./lib/alerts");
const { rotateIfLarge } = require("./lib/logrotate");
const { fetchWithTimeout } = require("./lib/retry");

const ROOT = __dirname;
const CONFIG_PATH = process.env.STREAMCOUNT_CONFIG || path.join(ROOT, "config.json");
if (!fs.existsSync(CONFIG_PATH)) {
  console.error("No config.json — copy config.example.json to config.json and set your channel handles.");
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

// Every hardening knob is optional so an existing config.json keeps working.
const POLL_MS = Math.max(5, config.pollSeconds ?? 15) * 1000;
const REQUEST_TIMEOUT_MS = Math.max(2, config.requestTimeoutSeconds ?? 10) * 1000;
const STALE_AFTER_MS = Math.max(1, config.staleAfterMinutes ?? 3) * 60 * 1000;
const RETRY_TRIES = Math.max(1, config.retryAttempts ?? 2);
const LOG_CFG = config.log || {};
// Config paths are relative to the project unless given as absolute.
const inRoot = (p, fallback) => (p === null ? null : path.resolve(ROOT, p || fallback));
const LOG_PATH = inRoot(LOG_CFG.path, "streamcount.log");
const LOG_MAX_BYTES = Math.max(1, LOG_CFG.maxMegabytes ?? 5) * 1024 * 1024;
const LOG_HEARTBEAT_MS = Math.max(1, LOG_CFG.heartbeatMinutes ?? 4) * 60 * 1000;
const ALERT_CFG = config.alerts || {};

// Load optional secrets (KICK_CLIENT_ID / KICK_CLIENT_SECRET) from secrets.env — git-ignored.
const secretsPath = path.join(ROOT, "secrets.env");
if (fs.existsSync(secretsPath)) {
  for (const line of fs.readFileSync(secretsPath, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?([^"'\n]*)["']?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---------------------------------------------------------------- fetchers
// Each returns { live, viewers, status }.
//   ok / offline            we reached the platform and believe the answer
//   error / timeout         we did NOT reach it — the viewer count is UNKNOWN,
//                           and lib/health.js refuses to sum it as zero
//   needs_keys / unsupported / disabled   nothing to poll
// Throwing is how a fetcher says "unknown"; lib/poller.js retries then marks it.

async function fetchYouTube(handle) {
  const res = await fetchWithTimeout(
    `https://www.youtube.com/@${handle}/live`,
    { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } },
    REQUEST_TIMEOUT_MS
  );
  // A 429/503 used to fall through the regex and get reported as "offline".
  if (!res.ok) throw new Error(`youtube HTTP ${res.status}`);
  const html = await res.text();
  // Main-video count renders as runs: [{"text":"17"},{"text":" watching now"}]
  const m =
    html.match(
      /"videoViewCountRenderer":\{"viewCount":\{"runs":\[\{"text":"([\d.,KM]+)"\},\{"text":" watching now"\}/
    ) || html.match(/"concurrentViewers":"(\d+)"/);
  if (m) {
    const viewers = parseCount(m[1]);
    if (viewers == null) throw new Error(`youtube unparseable count "${m[1]}"`);
    return { live: true, viewers, status: "ok" };
  }
  // No match: only trust "offline" if this still looks like a YouTube channel
  // page. A consent wall, captcha or redesign is "unknown", not "nobody watching".
  if (!html.includes("ytInitialData")) throw new Error("youtube page shape unrecognised (blocked or redesigned?)");
  return { live: false, viewers: 0, status: "offline" };
}

async function fetchTwitch(login) {
  const res = await fetchWithTimeout(
    "https://gql.twitch.tv/gql",
    {
      method: "POST",
      headers: {
        "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko", // Twitch's public web client id
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: `{ user(login: "${login}") { stream { viewersCount } } }` }),
    },
    REQUEST_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`twitch HTTP ${res.status}`);
  const json = await res.json();
  if (json?.errors?.length) throw new Error(`twitch gql: ${json.errors[0]?.message || "error"}`);
  // user === null means no such channel (unknown-ish, but stable) — user
  // missing entirely means the response shape changed, which is unknown.
  if (!("data" in json) || json.data?.user === undefined) throw new Error("twitch response shape unrecognised");
  const stream = json.data.user?.stream;
  if (!stream) return { live: false, viewers: 0, status: "offline" };
  return { live: true, viewers: stream.viewersCount ?? 0, status: "ok" };
}

// Preferred path: local python + curl_cffi (Chrome TLS impersonation gets past
// Kick's Cloudflare, no API keys needed). Falls back to the official API if
// KICK_CLIENT_ID/SECRET are set, else reports needs_keys.
const KICK_PY = path.join(ROOT, ".venv", "bin", "python");
const KICK_PROBE = path.join(ROOT, "kick_probe.py");

function kickViaProbe(slug) {
  return new Promise((resolve, reject) => {
    execFile(KICK_PY, [KICK_PROBE, slug], { timeout: REQUEST_TIMEOUT_MS + 5000 }, (err, stdout) => {
      if (err) return reject(new Error(`kick probe: ${err.message.split("\n")[0]}`));
      // JSON.parse used to run bare inside this callback: a non-JSON line on
      // stdout (Cloudflare error, python warning) threw an uncaughtException
      // and took the whole process down. Reject instead.
      let r;
      try {
        r = JSON.parse(stdout);
      } catch {
        return reject(new Error(`kick probe: non-JSON output ${JSON.stringify(String(stdout).slice(0, 80))}`));
      }
      if (!r || typeof r.live !== "boolean") return reject(new Error("kick probe: unexpected payload"));
      resolve({ live: r.live, viewers: r.viewers ?? 0, status: r.live ? "ok" : "offline" });
    });
  });
}

let kickToken = null; // { token, expiresAt }
async function fetchKick(slug) {
  if (fs.existsSync(KICK_PY)) return kickViaProbe(slug);
  const id = process.env.KICK_CLIENT_ID;
  const secret = process.env.KICK_CLIENT_SECRET;
  if (!id || !secret) return { live: false, viewers: null, status: "needs_keys" };

  if (!kickToken || Date.now() > kickToken.expiresAt) {
    const res = await fetchWithTimeout(
      "https://id.kick.com/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
      },
      REQUEST_TIMEOUT_MS
    );
    if (!res.ok) throw new Error(`kick token ${res.status}`);
    const t = await res.json();
    kickToken = { token: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
  }

  const res = await fetchWithTimeout(
    `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`,
    { headers: { Authorization: `Bearer ${kickToken.token}`, Accept: "application/json" } },
    REQUEST_TIMEOUT_MS
  );
  if (res.status === 401) kickToken = null; // force a refresh next time round
  if (!res.ok) throw new Error(`kick channels ${res.status}`);
  const json = await res.json();
  const ch = json?.data?.[0];
  const stream = ch?.stream ?? ch?.livestream ?? {};
  const live = stream.is_live ?? stream.isLive ?? false;
  if (!live) return { live: false, viewers: 0, status: "offline" };
  return { live: true, viewers: stream.viewer_count ?? stream.viewers ?? 0, status: "ok" };
}

async function fetchX() {
  // X exposes no public/free API for live broadcast viewers. Phase 2 candidate.
  return { live: false, viewers: null, status: "unsupported" };
}

function parseCount(s) {
  s = String(s).replace(/,/g, "");
  const mult = /K$/i.test(s) ? 1e3 : /M$/i.test(s) ? 1e6 : 1;
  const n = parseFloat(s);
  // NaN used to propagate into the total and render as "NaN" on the overlay.
  return Number.isFinite(n) ? Math.round(n * mult) : null;
}

// ---------------------------------------------------------------- wiring
const channels = config.channels || {};
const REAL_FETCHERS = { youtube: fetchYouTube, twitch: fetchTwitch, kick: fetchKick, x: fetchX };

// An empty/missing handle means "I don't use this platform" — don't poll it,
// and don't let it masquerade as an offline stream.
function buildFetchers() {
  const out = {};
  for (const [name, fn] of Object.entries(REAL_FETCHERS)) {
    const handle = channels[name];
    if (name !== "x" && (!handle || !String(handle).trim())) {
      out[name] = async () => ({ live: false, viewers: null, status: "disabled" });
    } else {
      out[name] = () => fn(handle);
    }
  }
  return out;
}

const alerter = createAlerter({
  sink: ALERT_CFG.sink || "log",
  repeatMs: Math.max(1, ALERT_CFG.repeatMinutes ?? 15) * 60 * 1000,
  webhookUrl: ALERT_CFG.webhookUrl || null,
  command: ALERT_CFG.command || null,
  logPath: inRoot(ALERT_CFG.logPath, "alerts.log"),
});

let lastLogLine = "";
let lastLogAt = 0;

const poller = createPoller({
  fetchers: buildFetchers(),
  intervalMs: POLL_MS,
  staleAfterMs: STALE_AFTER_MS,
  retry: { tries: RETRY_TRIES, baseMs: 400, maxMs: 3000 },
  alerter,
  onPoll: async (snap) => {
    logPoll(snap);
    try {
      await pushToHereNow(snap);
    } catch (e) {
      console.error(`herenow push failed: ${e.message}`);
    }
  },
});

// One line per 15s forever is what grew streamcount.log to 7.4 MB. Log on
// change, plus a heartbeat so silence still proves liveness.
function logPoll(snap) {
  const parts = Object.entries(snap.platforms)
    .map(([n, p]) => `${n}:${p.status === "ok" ? p.viewers : p.status}`)
    .sort()
    .join(" ");
  const line = `total=${snap.totalKnown ? snap.total : "unknown"} poller=${snap.poller.status} ${parts}`;
  const t = Date.now();
  if (line === lastLogLine && t - lastLogAt < LOG_HEARTBEAT_MS) return;
  lastLogLine = line;
  lastLogAt = t;
  console.log(`[${snap.updatedAt}] ${line}`);
}

// ------------------------------------------------- here.now Site Data push
// Public dashboard at https://<slug>.here.now reads the newest record; only
// the owner API key (from ~/.herenow/credentials, never in the site) can write.
const PUSH_STATE = path.join(ROOT, ".herenow-push.json");
const PUSH_HEARTBEAT_MS = 4 * 60 * 1000;
let lastPush = { body: null, at: 0 };

function hereNowKey() {
  try {
    return fs.readFileSync(path.join(process.env.HOME || "", ".herenow", "credentials"), "utf8").trim();
  } catch {
    return null;
  }
}

// A here.now Site Data collection validates against the schema baked in at
// publish time (site/.herenow/data.json), so top-level `poller`/`total_known`
// are rejected until the site is republished. Rather than block the fix on a
// deploy, push the rich payload and fall back to smuggling poller health
// through the already-free-form `platforms` object under `_poller`. The site
// pages read `data.poller || data.platforms._poller`, so both shapes work.
let legacyPushSchema = false;

function pushBody(snap, legacy) {
  const poller = {
    status: snap.poller.status,
    healthy: snap.poller.healthy,
    stale: snap.poller.stale,
    reason: snap.poller.reason,
    last_success_at: snap.poller.lastSuccessAt,
    stale_after_seconds: snap.poller.staleAfterSeconds,
    interval_seconds: snap.poller.intervalSeconds,
    total_known: snap.totalKnown,
    confidence: snap.confidence,
  };
  if (legacy) {
    return JSON.stringify({
      total: snap.total,
      platforms: { ...snap.platforms, _poller: poller },
      polled_at: snap.updatedAt,
    });
  }
  return JSON.stringify({
    total: snap.total,
    total_known: snap.totalKnown,
    confidence: snap.confidence,
    platforms: snap.platforms,
    polled_at: snap.updatedAt,
    poller,
  });
}

async function pushToHereNow(snap) {
  const slug = config.herenow?.slug;
  const key = hereNowKey();
  if (!slug || !key) return;

  const body = pushBody(snap, legacyPushSchema);
  const changed = body !== lastPush.body;
  if (!changed && Date.now() - lastPush.at < PUSH_HEARTBEAT_MS) return;

  const base = `https://here.now/api/v1/publishes/${slug}/data/stats`;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  let recordId = null;
  try {
    recordId = JSON.parse(fs.readFileSync(PUSH_STATE, "utf8")).recordId;
  } catch {}

  const send = async (payload) => {
    if (recordId) {
      const res = await fetchWithTimeout(
        `${base}/${recordId}`,
        { method: "PATCH", headers, body: payload },
        REQUEST_TIMEOUT_MS
      );
      if (res.ok || res.status === 400) return res;
      if (res.status !== 404) throw new Error(`PATCH ${res.status}`);
      recordId = null; // record gone; fall through to insert
    }
    const res = await fetchWithTimeout(
      base,
      { method: "POST", headers: { ...headers, "Idempotency-Key": require("crypto").randomUUID() }, body: payload },
      REQUEST_TIMEOUT_MS
    );
    if (res.ok) {
      const { record } = await res.json();
      fs.writeFileSync(PUSH_STATE, JSON.stringify({ recordId: record.id }));
    }
    return res;
  };

  let sent = body;
  let res = await send(sent);
  if (res.status === 400 && !legacyPushSchema) {
    legacyPushSchema = true;
    console.warn(
      "here.now: collection schema predates the poller-health fields — " +
        "falling back to platforms._poller. Republish site/ to get the clean schema."
    );
    sent = pushBody(snap, true);
    res = await send(sent);
  }
  if (!res.ok) throw new Error(`push ${res.status}`);
  lastPush = { body: sent, at: Date.now() };
}

// ---------------------------------------------------------------- server
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/api/viewers") {
    return json(res, 200, poller.snapshot());
  }
  if (url === "/api/health" || url === "/healthz") {
    const snap = poller.snapshot();
    // Non-200 when unhealthy so `curl -f` / any uptime check works unmodified.
    return json(res, snap.poller.stale ? 503 : 200, {
      poller: snap.poller,
      total: snap.total,
      totalKnown: snap.totalKnown,
      confidence: snap.confidence,
      updatedAt: snap.updatedAt,
      pid: process.pid,
      alertSink: alerter.sink,
      alertActive: alerter.isActive(poller.STALE_ALERT_KEY),
    });
  }
  if (url === "/" || url === "/index.html") return serveFile(res, "index.html");
  if (url === "/overlay" || url === "/overlay.html") return serveFile(res, "overlay.html");
  res.writeHead(404);
  res.end("not found");
});

function json(res, code, payload) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, max-age=0",
  });
  res.end(JSON.stringify(payload));
}

function serveFile(res, name) {
  fs.readFile(path.join(ROOT, "public", name), (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end("error");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, max-age=0" });
    res.end(data);
  });
}

// -------------------------------------------------------- crash safety
// launchd (KeepAlive) is the restart mechanism, so the right response to an
// unexpected fault is a loud log and a non-zero exit — not limping on with a
// frozen poll loop, which is exactly what looked like "everyone went offline".
function fatal(kind) {
  return (err) => {
    console.error(`[fatal] ${kind}: ${(err && err.stack) || err}`);
    alerter
      .fire("poller-crash", `${kind}: ${(err && err.message) || err}`)
      .catch(() => {})
      .finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 2000).unref();
  };
}
process.on("uncaughtException", fatal("uncaughtException"));
process.on("unhandledRejection", fatal("unhandledRejection"));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[${new Date().toISOString()}] ${sig} — shutting down`);
    poller.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// Keep streamcount.log bounded; launchd holds the fd, so truncate in place.
if (LOG_PATH) {
  const rotate = () => {
    const r = rotateIfLarge(LOG_PATH, LOG_MAX_BYTES, Math.floor(LOG_MAX_BYTES / 8));
    if (r.rotated) console.log(`[${new Date().toISOString()}] rotated log (was ${r.was} bytes, kept ${r.kept})`);
  };
  rotate();
  setInterval(rotate, 5 * 60 * 1000).unref();
}

server.on("error", (err) => {
  console.error(`[fatal] server: ${err.message}`);
  process.exit(1);
});

server.listen(config.port, () => {
  console.log(
    `streamcount on http://localhost:${config.port}  (overlay: /overlay, json: /api/viewers, health: /api/health)`
  );
  console.log(
    `poll every ${POLL_MS / 1000}s · request timeout ${REQUEST_TIMEOUT_MS / 1000}s · ` +
      `stale after ${STALE_AFTER_MS / 60000}min · alert sink "${alerter.sink}"`
  );
  poller.start();
});
