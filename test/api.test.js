"use strict";

// End-to-end: boots the real server.js and the real watchdog.js against a
// throwaway config with no channels configured, so the test makes zero
// outbound network calls.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function writeConfig(dir, port) {
  const file = path.join(dir, "config.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      port,
      pollSeconds: 5,
      requestTimeoutSeconds: 3,
      staleAfterMinutes: 1,
      log: { path: null },
      alerts: { sink: "none", logPath: null },
      herenow: { slug: "" },
      channels: { youtube: "", twitch: "", kick: "", x: "" },
    })
  );
  return file;
}

async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw lastErr;
}

test("server exposes poller health separately from stream status", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streamcount-api-"));
  const port = await freePort();
  const configPath = writeConfig(dir, port);

  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, STREAMCOUNT_CONFIG: configPath, HOME: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  t.after(() => {
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const viewers = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/viewers`);
    const body = await res.json();
    if (!body.poller) throw new Error("no poller block yet");
    return body;
  });

  assert.ok(viewers.poller, "/api/viewers must carry a poller block");
  assert.ok("totalKnown" in viewers, "/api/viewers must say whether the total is knowable");
  assert.ok(["ok", "starting", "degraded"].includes(viewers.poller.status), viewers.poller.status);
  assert.equal(viewers.confidence, "none", "no channels configured");
  assert.equal(viewers.totalKnown, false, "with nothing pollable, 0 is not a claim we can make");
  assert.ok(viewers.poller.intervalSeconds > 0);
  assert.equal(viewers.poller.staleAfterSeconds, 60);

  const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(healthRes.status, 200, "healthy poller answers 200");
  const health = await healthRes.json();
  assert.equal(health.poller.stale, false);
  assert.equal(health.alertSink, "none");
  assert.equal(typeof health.pid, "number");

  // The watchdog must agree while the process is alive.
  const alive = await runWatchdog(configPath, dir);
  assert.equal(alive.code, 0, alive.out);
  assert.match(alive.out, /"status":"(ok|starting|degraded)"/);

  // DEAD POLLER: kill the process and confirm the watchdog says so distinctly.
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));

  const dead = await runWatchdog(configPath, dir);
  assert.equal(dead.code, 1, "watchdog must exit non-zero when the poller is gone");
  assert.match(dead.out, /"status":"dead"/);
  assert.match(dead.out, /not running/);
  assert.equal(stderr.includes("uncaughtException"), false, stderr);
});

function runWatchdog(configPath, home) {
  return new Promise((resolve) => {
    const wd = spawn(process.execPath, [path.join(ROOT, "watchdog.js"), "--json"], {
      cwd: ROOT,
      env: {
        ...process.env,
        STREAMCOUNT_CONFIG: configPath,
        STREAMCOUNT_WATCHDOG_STATE: path.join(home, "watchdog-state.json"),
        HOME: home,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    wd.stdout.on("data", (d) => (out += d));
    wd.stderr.on("data", (d) => (out += d));
    wd.on("exit", (code) => resolve({ code, out }));
  });
}
