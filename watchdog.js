#!/usr/bin/env node
// External dead-poller watchdog.
//
// The in-process alerter in lib/poller.js can only warn while the process is
// alive. The failure that actually hurt — a poller that is simply gone, leaving
// the last snapshot frozen — is invisible from inside. So this runs as a
// separate one-shot process (launchd StartInterval, or cron) and asks the
// question from outside:
//
//   * /api/health unreachable        -> poller is DEAD
//   * /api/health says stale         -> poller is running but blind
//   * otherwise                      -> healthy, clear any active alert
//
// Uses the same alert sinks as the server (default "log": no network, nothing
// sent anywhere). Usage: node watchdog.js [--json]

const fs = require("fs");
const path = require("path");
const { createAlerter } = require("./lib/alerts");
const { rotateIfLarge } = require("./lib/logrotate");

const ROOT = __dirname;
const CONFIG_PATH = process.env.STREAMCOUNT_CONFIG || path.join(ROOT, "config.json");
const STATE_PATH = process.env.STREAMCOUNT_WATCHDOG_STATE || path.join(ROOT, ".watchdog-state.json");
const KEY = "poller-unreachable";

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const config = readJson(CONFIG_PATH, null);
  if (!config) {
    console.error(`watchdog: no config at ${CONFIG_PATH}`);
    process.exit(2);
  }
  const port = config.port || 5959;
  const alertCfg = config.alerts || {};
  const timeoutMs = Math.max(2, config.requestTimeoutSeconds ?? 10) * 1000;

  const alerter = createAlerter({
    sink: alertCfg.sink || "log",
    repeatMs: Math.max(1, alertCfg.repeatMinutes ?? 15) * 60 * 1000,
    webhookUrl: alertCfg.webhookUrl || null,
    command: alertCfg.command || null,
    // Relative to the project unless given as an absolute path.
    logPath: alertCfg.logPath === null ? null : path.resolve(ROOT, alertCfg.logPath || "alerts.log"),
    initial: readJson(STATE_PATH, []),
  });

  let verdict;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    const p = body.poller || {};
    if (p.stale) {
      verdict = { ok: false, status: "stale", message: `poller is running (pid ${body.pid}) but ${p.reason}` };
    } else {
      verdict = { ok: true, status: p.status, message: `poller ${p.status} — ${p.reason}`, health: body };
    }
  } catch (err) {
    verdict = {
      ok: false,
      status: "dead",
      message:
        `no answer from http://127.0.0.1:${port}/api/health (${err.message}) — ` +
        `the poller process is not running. Any numbers on the dashboard are frozen, not real.`,
    };
  }

  if (verdict.ok) {
    await alerter.clear(KEY, `poller reachable again — ${verdict.message}`);
  } else {
    await alerter.fire(KEY, verdict.message, { detected: verdict.status, port });
  }

  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(alerter.dump()));
  } catch {}

  // Every 5 minutes forever adds up; keep our own launchd log bounded too.
  rotateIfLarge(path.join(ROOT, "watchdog.log"), 1024 * 1024, 128 * 1024);

  if (process.argv.includes("--json")) console.log(JSON.stringify(verdict));
  else console.log(`[${new Date().toISOString()}] watchdog: ${verdict.status} — ${verdict.message}`);
  process.exit(verdict.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`watchdog: ${(err && err.stack) || err}`);
  process.exit(2);
});
