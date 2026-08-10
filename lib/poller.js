"use strict";

// The poll loop, with the failure modes that actually bit us designed out:
//
//   * setInterval could stack polls on top of each other when a fetch hung
//     (Node's fetch has no default timeout). Now it's a self-scheduling
//     setTimeout loop with an explicit overlap guard — polls can never overlap.
//   * A wedged poll used to freeze the numbers forever with no signal. Now a
//     watchdog re-arms the loop and the abandoned poll's result is discarded
//     via a generation counter.
//   * poll() was invoked bare from setInterval, so any rejection outside the
//     per-platform try/catch became an unhandledRejection and killed the
//     process. Everything is caught here.
//   * "every platform errored" used to look exactly like "nobody is streaming".
//     A poll now only counts as successful if at least one platform gave a
//     definitive answer.

const { aggregate, classify, pollSucceeded, STATUS } = require("./health");
const { withRetry } = require("./retry");

const STALE_ALERT_KEY = "poller-stale";

function createPoller(opts) {
  const fetchers = opts.fetchers; // { name: () => Promise<{live,viewers,status}> }
  const intervalMs = opts.intervalMs ?? 15000;
  const staleAfterMs = opts.staleAfterMs ?? 3 * 60 * 1000;
  const retryOpts = opts.retry ?? { tries: 3, baseMs: 400, maxMs: 4000 };
  const logger = opts.logger || console;
  const now = opts.now || (() => Date.now());
  const setTimeoutFn = opts.setTimeout || setTimeout;
  const clearTimeoutFn = opts.clearTimeout || clearTimeout;
  const alerter = opts.alerter || null;
  const onPoll = opts.onPoll || null; // called after every completed poll
  // A poll that runs longer than this is presumed wedged and abandoned.
  const hardDeadlineMs = opts.hardDeadlineMs ?? Math.max(intervalMs * 4, 60000);

  const state = {
    total: 0,
    totalKnown: false,
    confidence: "none",
    platforms: {},
    updatedAt: null, // last time a poll completed (successful or not)
    lastSuccessAt: null, // last time a poll got a definitive answer — the one that matters
  };

  const health = {
    startedAt: null,
    lastPollStartedAt: null,
    lastPollFinishedAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailedPolls: 0,
    unknownPlatforms: 0,
    polls: 0,
    failedPolls: 0,
    skippedPolls: 0,
    wedgeRecoveries: 0,
    inFlightSince: null,
    intervalMs,
    staleAfterMs,
  };

  let timer = null;
  let watchdogTimer = null;
  let stopped = true;
  let running = false;
  let generation = 0;

  async function pollPlatform(name, fn) {
    try {
      const res = await withRetry(() => fn(), {
        ...retryOpts,
        // Never retry a definitive answer — only genuine failures.
        onRetry: (err, attempt, delay) =>
          logger.warn(`[poll] ${name} attempt ${attempt} failed (${err.message}); retrying in ${delay}ms`),
      });
      if (!res || typeof res !== "object") throw new Error("fetcher returned no result");
      return { live: !!res.live, viewers: res.viewers ?? null, status: res.status || "error" };
    } catch (err) {
      const timedOut = err && (err.code === "ETIMEDOUT" || /timeout/i.test(err.message || ""));
      return {
        live: false,
        viewers: null,
        // "error"/"timeout" mean UNKNOWN, not zero. The UI must not sum these.
        status: timedOut ? "timeout" : "error",
        error: String((err && err.message) || err).slice(0, 200),
      };
    }
  }

  async function runOnce() {
    if (running) {
      health.skippedPolls += 1;
      logger.warn(`[poll] previous poll still in flight since ${health.inFlightSince}; skipping this tick`);
      return null;
    }
    const gen = ++generation;
    running = true;
    const startedMs = now();
    health.lastPollStartedAt = new Date(startedMs).toISOString();
    health.inFlightSince = health.lastPollStartedAt;

    let platforms = {};
    try {
      const entries = await Promise.all(
        Object.entries(fetchers).map(async ([name, fn]) => [name, await pollPlatform(name, fn)])
      );
      platforms = Object.fromEntries(entries);
    } catch (err) {
      // Should be unreachable (pollPlatform never throws) but a rejection here
      // used to be fatal. Degrade instead of dying.
      logger.error(`[poll] unexpected poll failure: ${err && err.message}`);
      health.lastError = String((err && err.message) || err).slice(0, 200);
      platforms = {};
    } finally {
      if (gen === generation) {
        running = false;
        health.inFlightSince = null;
      }
    }

    // A watchdog re-armed the loop while we were wedged; this result is stale
    // by definition, so throw it away rather than overwriting fresher data.
    if (gen !== generation) {
      logger.warn(`[poll] discarding result from abandoned poll (gen ${gen}, current ${generation})`);
      return null;
    }

    const finishedMs = now();
    const agg = aggregate(platforms);
    const ok = pollSucceeded(platforms);

    state.platforms = platforms;
    state.total = agg.total;
    state.totalKnown = agg.totalKnown;
    state.confidence = agg.confidence;
    state.updatedAt = new Date(finishedMs).toISOString();

    health.polls += 1;
    health.lastPollFinishedAt = state.updatedAt;
    health.unknownPlatforms = agg.unknownPlatforms;
    if (ok) {
      health.consecutiveFailedPolls = 0;
      health.lastSuccessAt = state.updatedAt;
      state.lastSuccessAt = state.updatedAt;
    } else {
      health.failedPolls += 1;
      health.consecutiveFailedPolls += 1;
    }

    await evaluateAlerts(finishedMs);
    if (onPoll) {
      try {
        await onPoll(snapshot(), { ok, durationMs: finishedMs - startedMs });
      } catch (err) {
        logger.error(`[poll] onPoll hook failed: ${err && err.message}`);
      }
    }
    return snapshot();
  }

  async function evaluateAlerts(nowMs) {
    if (!alerter) return;
    const h = classify(health, nowMs);
    if (h.status === STATUS.STALE) {
      const since =
        h.lastSuccessAgeSeconds == null
          ? `no successful poll since the poller started ${h.uptimeSeconds}s ago`
          : `no successful poll for ${h.lastSuccessAgeSeconds}s`;
      await alerter.fire(
        STALE_ALERT_KEY,
        `${since} (threshold ${h.staleAfterSeconds}s) — viewer numbers are NOT trustworthy`,
        { lastSuccessAt: h.lastSuccessAt, consecutiveFailedPolls: h.consecutiveFailedPolls }
      );
    } else if (alerter.isActive(STALE_ALERT_KEY)) {
      await alerter.clear(STALE_ALERT_KEY, `poller recovered — successful poll at ${h.lastSuccessAt}`);
    }
  }

  function tick() {
    timer = null;
    runOnce()
      .catch((err) => logger.error(`[poll] tick error: ${err && err.message}`))
      .finally(() => {
        if (!stopped) schedule();
      });
  }

  function schedule(delay = intervalMs) {
    if (stopped) return;
    if (timer) clearTimeoutFn(timer);
    timer = setTimeoutFn(tick, delay);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  // Independent of the poll loop, so it still fires when the loop is wedged.
  function watchdogCheck() {
    const t = now();
    if (running && health.inFlightSince) {
      const age = t - Date.parse(health.inFlightSince);
      if (age > hardDeadlineMs) {
        health.wedgeRecoveries += 1;
        logger.error(
          `[watchdog] poll wedged for ${Math.round(age / 1000)}s (deadline ${Math.round(hardDeadlineMs / 1000)}s) — abandoning it and re-arming the loop`
        );
        generation += 1; // orphan the in-flight poll
        running = false;
        health.inFlightSince = null;
        health.consecutiveFailedPolls += 1;
        health.failedPolls += 1;
        schedule(0);
        return;
      }
    }
    // The loop should never be idle with no timer armed. If it is, re-arm.
    if (!running && !timer && !stopped) {
      health.wedgeRecoveries += 1;
      logger.error("[watchdog] poll loop had no timer armed — re-arming");
      schedule(0);
    }
    // Alert even when the loop never gets far enough to call evaluateAlerts.
    evaluateAlerts(t).catch((err) => logger.error(`[watchdog] alert failed: ${err && err.message}`));
  }

  function snapshot() {
    const h = classify(health, now());
    return {
      total: state.total,
      totalKnown: state.totalKnown,
      confidence: state.confidence,
      platforms: state.platforms,
      updatedAt: state.updatedAt,
      lastSuccessAt: state.lastSuccessAt,
      poller: h,
    };
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    health.startedAt = new Date(now()).toISOString();
    const watchdogEvery = Math.max(Math.min(intervalMs, 30000), 5000);
    watchdogTimer = setInterval(watchdogCheck, watchdogEvery);
    if (watchdogTimer.unref) watchdogTimer.unref();
    tick();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeoutFn(timer);
    timer = null;
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  return { start, stop, runOnce, snapshot, watchdogCheck, health, state, STALE_ALERT_KEY };
}

module.exports = { createPoller, STALE_ALERT_KEY };
