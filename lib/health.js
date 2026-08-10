"use strict";

// Poller-health classification. Pure functions, no I/O, no timers.
//
// This module exists to break one specific ambiguity that cost a whole stream
// on 2026-07-22: the dashboard read "0 / offline" while the poller was dead.
// A frozen record and a genuinely quiet stream looked identical.
//
// Two questions must be answered separately:
//   1. Is anyone watching?          -> stream status  (per-platform live/offline)
//   2. Do we actually know that?    -> poller health  (this module)
//
// A platform is only "offline" if we reached it and it told us so. If the
// request failed, the honest answer is "unknown", never "0".

const STATUS = {
  STARTING: "starting", // process just came up, no poll has completed yet
  OK: "ok", // a poll reached upstream recently, everything answered
  DEGRADED: "degraded", // reachable, but some platforms are erroring or the loop is late
  STALE: "stale", // nothing has succeeded for staleAfterMs — treat the numbers as meaningless
  DEAD: "dead", // the API itself is unreachable (only a client or the watchdog can conclude this)
};

// Statuses where we actually talked to the platform and believe the answer.
const DEFINITIVE = new Set(["ok", "offline"]);
// Statuses where the request failed — we do NOT know whether anyone is watching.
const UNKNOWN = new Set(["error", "timeout"]);
// Statuses where there is nothing to poll in the first place.
const INAPPLICABLE = new Set(["unsupported", "needs_keys", "disabled"]);

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Sum only the platforms we actually heard from, and say how much of the
// picture we are missing. `totalKnown: false` means the UI must not render a
// confident number — that is the whole point.
function aggregate(platforms) {
  let total = 0;
  let known = 0;
  let unknown = 0;
  let live = 0;
  let inapplicable = 0;

  for (const p of Object.values(platforms || {})) {
    const status = p && p.status;
    if (DEFINITIVE.has(status)) {
      known += 1;
      if (status === "ok" && p.live) {
        total += toNumber(p.viewers);
        live += 1;
      }
    } else if (UNKNOWN.has(status)) {
      unknown += 1;
    } else if (INAPPLICABLE.has(status)) {
      inapplicable += 1;
    } else if (status != null) {
      // Unrecognised status: be pessimistic, count it as not-known.
      unknown += 1;
    }
  }

  let confidence;
  if (known === 0 && unknown === 0) confidence = "none"; // nothing pollable configured
  else if (known === 0) confidence = "unknown"; // every pollable platform failed
  else if (unknown > 0) confidence = "partial";
  else confidence = "full";

  return {
    total,
    totalKnown: known > 0,
    confidence,
    knownPlatforms: known,
    unknownPlatforms: unknown,
    inapplicablePlatforms: inapplicable,
    livePlatforms: live,
  };
}

// A poll "succeeded" if at least one platform gave a definitive answer.
// All-errors is a failed poll even though the loop itself ran fine — otherwise
// a rate-limited scraper looks exactly like an empty stream. A config with
// nothing pollable still counts as success (there was nothing to fail at), but
// a poll that produced no platform results at all does not.
function pollSucceeded(platforms) {
  if (!platforms || Object.keys(platforms).length === 0) return false;
  const a = aggregate(platforms);
  return a.knownPlatforms > 0 || a.unknownPlatforms === 0;
}

function parseTime(v) {
  if (v == null) return null;
  const ms = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

// Classify from the poller's own point of view. A running process can never
// report DEAD about itself — the worst it can honestly say is STALE.
// `h` is the health record kept by lib/poller.js.
function classify(h, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const intervalMs = h.intervalMs > 0 ? h.intervalMs : 15000;
  const staleAfterMs = h.staleAfterMs > 0 ? h.staleAfterMs : 3 * 60 * 1000;
  // Allow the loop to be a couple of intervals late before we start complaining.
  const graceMs = Math.max(intervalMs * 2.5, 30000);

  const startedAt = parseTime(h.startedAt);
  const lastSuccess = parseTime(h.lastSuccessAt);
  const lastFinish = parseTime(h.lastPollFinishedAt);

  const ageMs = lastSuccess == null ? null : Math.max(0, now - lastSuccess);
  const uptimeMs = startedAt == null ? 0 : Math.max(0, now - startedAt);

  let status;
  let reason;

  if (lastSuccess == null) {
    // Never succeeded. Give it the full stale window before crying wolf — but
    // don't pretend it's merely "starting" once polls are visibly failing.
    if (uptimeMs >= staleAfterMs) {
      status = STATUS.STALE;
      reason = `no successful poll since start ${Math.round(uptimeMs / 1000)}s ago`;
    } else if (uptimeMs < graceMs && !(h.consecutiveFailedPolls > 1)) {
      status = STATUS.STARTING;
      reason = "no poll has completed yet";
    } else {
      status = STATUS.DEGRADED;
      reason = `no successful poll since start ${Math.round(uptimeMs / 1000)}s ago`;
    }
  } else if (ageMs >= staleAfterMs) {
    status = STATUS.STALE;
    reason = `last successful poll was ${Math.round(ageMs / 1000)}s ago`;
  } else if (ageMs >= graceMs) {
    status = STATUS.DEGRADED;
    reason = `last successful poll was ${Math.round(ageMs / 1000)}s ago (interval is ${Math.round(intervalMs / 1000)}s)`;
  } else if (h.consecutiveFailedPolls > 0) {
    status = STATUS.DEGRADED;
    reason = `${h.consecutiveFailedPolls} consecutive failed poll(s)`;
  } else if (h.unknownPlatforms > 0) {
    status = STATUS.DEGRADED;
    reason = `${h.unknownPlatforms} platform(s) unreachable`;
  } else {
    status = STATUS.OK;
    reason = "polling normally";
  }

  return {
    status,
    reason,
    healthy: status === STATUS.OK || status === STATUS.STARTING,
    // `stale` is the flag the UI keys off to stop trusting the numbers at all.
    stale: status === STATUS.STALE,
    lastSuccessAt: h.lastSuccessAt || null,
    lastSuccessAgeSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
    lastPollFinishedAt: h.lastPollFinishedAt || null,
    lastPollAgeSeconds: lastFinish == null ? null : Math.round((now - lastFinish) / 1000),
    startedAt: h.startedAt || null,
    uptimeSeconds: Math.round(uptimeMs / 1000),
    consecutiveFailedPolls: h.consecutiveFailedPolls || 0,
    polls: h.polls || 0,
    failedPolls: h.failedPolls || 0,
    skippedPolls: h.skippedPolls || 0,
    wedgeRecoveries: h.wedgeRecoveries || 0,
    intervalSeconds: Math.round(intervalMs / 1000),
    staleAfterSeconds: Math.round(staleAfterMs / 1000),
  };
}

module.exports = { STATUS, DEFINITIVE, UNKNOWN, INAPPLICABLE, aggregate, pollSucceeded, classify };
