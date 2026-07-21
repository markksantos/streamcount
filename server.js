#!/usr/bin/env node
// streamcount — one number for total live viewers across YouTube, Twitch, Kick (and X, pending).
// Zero dependencies. Node 18+.

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));

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
// Each returns { live, viewers, status, error? }
// status: ok | offline | needs_keys | unsupported | error

async function fetchYouTube(handle) {
  const res = await fetch(`https://www.youtube.com/@${handle}/live`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  const html = await res.text();
  // Main-video count renders as runs: [{"text":"17"},{"text":" watching now"}]
  const m =
    html.match(
      /"videoViewCountRenderer":\{"viewCount":\{"runs":\[\{"text":"([\d.,KM]+)"\},\{"text":" watching now"\}/
    ) || html.match(/"concurrentViewers":"(\d+)"/);
  if (!m) return { live: false, viewers: 0, status: "offline" };
  return { live: true, viewers: parseCount(m[1]), status: "ok" };
}

async function fetchTwitch(login) {
  const res = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: {
      "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko", // Twitch's public web client id
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `{ user(login: "${login}") { stream { viewersCount } } }`,
    }),
  });
  const json = await res.json();
  const stream = json?.data?.user?.stream;
  if (!stream) return { live: false, viewers: 0, status: "offline" };
  return { live: true, viewers: stream.viewersCount ?? 0, status: "ok" };
}

let kickToken = null; // { token, expiresAt }
async function fetchKick(slug) {
  const id = process.env.KICK_CLIENT_ID;
  const secret = process.env.KICK_CLIENT_SECRET;
  if (!id || !secret) return { live: false, viewers: null, status: "needs_keys" };

  if (!kickToken || Date.now() > kickToken.expiresAt) {
    const res = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: id,
        client_secret: secret,
      }),
    });
    if (!res.ok) throw new Error(`kick token ${res.status}`);
    const t = await res.json();
    kickToken = { token: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
  }

  const res = await fetch(`https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`, {
    headers: { Authorization: `Bearer ${kickToken.token}`, Accept: "application/json" },
  });
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
  return Math.round(parseFloat(s) * mult);
}

// ---------------------------------------------------------------- poll loop
const state = {
  total: 0,
  platforms: {},
  updatedAt: null,
};

async function poll() {
  const ch = config.channels;
  const jobs = {
    youtube: () => fetchYouTube(ch.youtube),
    twitch: () => fetchTwitch(ch.twitch),
    kick: () => fetchKick(ch.kick),
    x: () => fetchX(ch.x),
  };
  await Promise.all(
    Object.entries(jobs).map(async ([name, job]) => {
      try {
        state.platforms[name] = await job();
      } catch (e) {
        state.platforms[name] = { live: false, viewers: null, status: "error", error: e.message };
      }
    })
  );
  state.total = Object.values(state.platforms).reduce(
    (sum, p) => sum + (p.status === "ok" && p.live ? p.viewers : 0),
    0
  );
  state.updatedAt = new Date().toISOString();
  const parts = Object.entries(state.platforms)
    .map(([n, p]) => `${n}:${p.status === "ok" ? p.viewers : p.status}`)
    .join(" ");
  console.log(`[${state.updatedAt}] total=${state.total} ${parts}`);
}

// ---------------------------------------------------------------- server
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/api/viewers") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(state));
  } else if (url === "/" || url === "/index.html") {
    serveFile(res, "index.html");
  } else if (url === "/overlay") {
    serveFile(res, "overlay.html");
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

function serveFile(res, name) {
  fs.readFile(path.join(ROOT, "public", name), (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end("error");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

server.listen(config.port, () => {
  console.log(`streamcount on http://localhost:${config.port}  (overlay: /overlay, json: /api/viewers)`);
  poll();
  setInterval(poll, config.pollSeconds * 1000);
});
