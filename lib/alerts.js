"use strict";

// Dead-poller alerting.
//
// SAFE BY DEFAULT: the only sink enabled out of the box is "log", which writes
// to stdout and appends a line to alerts.log. Nothing leaves the machine unless
// you deliberately configure the "webhook" or "command" sink. See the Alerting
// section of the README.
//
// Sinks:
//   log     (default) console + alerts.log — no network, no messages sent
//   none              no-op, for when you genuinely don't want to know
//   command           runs a local command with the alert JSON as argv[1]
//                     (e.g. terminal-notifier, a Shortcuts CLI call, a script)
//   webhook           POSTs the alert JSON to a URL you configure (Slack/Discord)

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const DEFAULT_REPEAT_MS = 15 * 60 * 1000;
const MAX_ALERT_LOG_BYTES = 512 * 1024;

function createAlerter(opts = {}) {
  const sink = opts.sink || "log";
  const repeatMs = opts.repeatMs ?? DEFAULT_REPEAT_MS;
  const logPath = opts.logPath || null;
  const webhookUrl = opts.webhookUrl || null;
  const command = opts.command || null;
  const commandTimeoutMs = opts.commandTimeoutMs ?? 10000;
  const logger = opts.logger || console;
  const now = opts.now || (() => Date.now());
  const send = opts.send; // test seam: replaces the real sink dispatch

  // One entry per alert key. Bounded by the number of distinct keys the caller
  // uses (currently three: poller-stale, poller-crash, watchdog-unreachable),
  // so it cannot grow.
  const active = new Map();
  // Seed from a persisted dump so a one-shot process (watchdog.js under
  // launchd) still honours the repeat throttle across runs.
  for (const e of opts.initial || []) {
    if (e && e.key) active.set(e.key, { key: e.key, since: e.since ?? null, lastSentAt: e.lastSentAt ?? 0, count: e.count ?? 0 });
  }

  function record(key) {
    let e = active.get(key);
    if (!e) {
      e = { key, since: null, lastSentAt: 0, count: 0 };
      active.set(key, e);
    }
    return e;
  }

  async function dispatch(payload) {
    if (send) return send(payload);
    if (sink === "none") return { delivered: false, sink: "none" };

    const line = `[${payload.at}] ALERT ${payload.severity.toUpperCase()} ${payload.key}: ${payload.message}`;

    if (sink === "log") {
      logger.error(line);
      if (logPath) appendBounded(logPath, line + "\n");
      return { delivered: true, sink: "log" };
    }

    if (sink === "command") {
      if (!command) throw new Error('alerts.sink is "command" but alerts.command is not set');
      // Always mirror to the log too, so a broken command never loses the alert.
      logger.error(line);
      if (logPath) appendBounded(logPath, line + "\n");
      await new Promise((resolve, reject) => {
        execFile(command, [JSON.stringify(payload)], { timeout: commandTimeoutMs }, (err) =>
          err ? reject(new Error(err.message.split("\n")[0])) : resolve()
        );
      });
      return { delivered: true, sink: "command" };
    }

    if (sink === "webhook") {
      if (!webhookUrl) throw new Error('alerts.sink is "webhook" but alerts.webhookUrl is not set');
      logger.error(line);
      if (logPath) appendBounded(logPath, line + "\n");
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: line, ...payload }),
        signal: AbortSignal.timeout(commandTimeoutMs),
      });
      if (!res.ok) throw new Error(`webhook ${res.status}`);
      return { delivered: true, sink: "webhook" };
    }

    throw new Error(`unknown alerts.sink "${sink}"`);
  }

  // Raise (or re-raise) an alert. Re-raises are throttled to one per repeatMs
  // so a poller that stays dead overnight produces a handful of lines, not 5760.
  async function fire(key, message, extra = {}) {
    const e = record(key);
    const t = now();
    const first = e.since == null;
    if (first) e.since = new Date(t).toISOString();
    if (!first && t - e.lastSentAt < repeatMs) return { suppressed: true, since: e.since };
    e.lastSentAt = t;
    e.count += 1;
    const payload = {
      key,
      severity: "critical",
      state: first ? "raised" : "ongoing",
      message,
      at: new Date(t).toISOString(),
      since: e.since,
      occurrence: e.count,
      ...extra,
    };
    try {
      const r = await dispatch(payload);
      return { suppressed: false, payload, ...r };
    } catch (err) {
      logger.error(`alert sink "${sink}" failed: ${err.message}`);
      return { suppressed: false, payload, delivered: false, error: err.message };
    }
  }

  // Clear an alert. Only emits if the alert was actually active.
  async function clear(key, message, extra = {}) {
    const e = active.get(key);
    if (!e || e.since == null) return { suppressed: true };
    const t = now();
    const payload = {
      key,
      severity: "info",
      state: "resolved",
      message,
      at: new Date(t).toISOString(),
      since: e.since,
      downSeconds: Math.round((t - Date.parse(e.since)) / 1000),
      ...extra,
    };
    active.delete(key);
    try {
      const r = await dispatch(payload);
      return { suppressed: false, payload, ...r };
    } catch (err) {
      logger.error(`alert sink "${sink}" failed: ${err.message}`);
      return { suppressed: false, payload, delivered: false, error: err.message };
    }
  }

  function isActive(key) {
    const e = active.get(key);
    return !!(e && e.since != null);
  }

  // Serialisable throttle state, for processes that don't stay resident.
  function dump() {
    return [...active.values()];
  }

  return { fire, clear, isActive, dump, sink };
}

// alerts.log must not become the next unbounded file. Keep the tail only.
function appendBounded(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text);
    const { size } = fs.statSync(file);
    if (size > MAX_ALERT_LOG_BYTES) {
      const buf = fs.readFileSync(file);
      const tail = buf.subarray(buf.length - Math.floor(MAX_ALERT_LOG_BYTES / 2));
      fs.writeFileSync(file, tail);
    }
  } catch {
    /* alerting must never take the poller down */
  }
}

module.exports = { createAlerter, MAX_ALERT_LOG_BYTES };
