"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPoller } = require("../lib/poller");
const { STATUS } = require("../lib/health");

const quiet = { log() {}, warn() {}, error() {} };
const nowFactory = (start) => {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
};

function makePoller(fetchers, extra = {}) {
  const clock = nowFactory(Date.parse("2026-08-10T00:00:00.000Z"));
  const p = createPoller({
    fetchers,
    intervalMs: 15000,
    staleAfterMs: 180000,
    retry: { tries: 2, baseMs: 1, maxMs: 2, sleep: async () => {}, jitter: () => 0 },
    logger: quiet,
    now: clock.now,
    ...extra,
  });
  p.health.startedAt = new Date(clock.now()).toISOString();
  return { p, clock };
}

test("a healthy poll records a success timestamp and a trustworthy total", async () => {
  const { p } = makePoller({
    youtube: async () => ({ live: true, viewers: 9, status: "ok" }),
    twitch: async () => ({ live: false, viewers: 0, status: "offline" }),
  });
  const snap = await p.runOnce();
  assert.equal(snap.total, 9);
  assert.equal(snap.totalKnown, true);
  assert.equal(snap.poller.status, STATUS.OK);
  assert.ok(snap.lastSuccessAt, "lastSuccessAt must be stamped");
});

test("UPSTREAM ERROR: a throwing fetcher becomes unknown, not offline", async () => {
  const { p } = makePoller({
    youtube: async () => {
      throw new Error("HTTP 429");
    },
    twitch: async () => ({ live: false, viewers: 0, status: "offline" }),
  });
  const snap = await p.runOnce();
  assert.equal(snap.platforms.youtube.status, "error");
  assert.notEqual(snap.platforms.youtube.status, "offline", "a rate-limited scrape must never read as offline");
  assert.equal(snap.confidence, "partial");
  assert.equal(snap.poller.status, STATUS.DEGRADED);
});

test("a timeout is reported as timeout, distinctly from a generic error", async () => {
  const { p } = makePoller({
    youtube: async () => {
      const e = new Error("timeout after 10000ms");
      e.code = "ETIMEDOUT";
      throw e;
    },
  });
  const snap = await p.runOnce();
  assert.equal(snap.platforms.youtube.status, "timeout");
});

test("failing fetchers are retried before being declared unknown", async () => {
  let calls = 0;
  const { p } = makePoller({
    youtube: async () => {
      calls += 1;
      if (calls < 2) throw new Error("transient");
      return { live: true, viewers: 4, status: "ok" };
    },
  });
  const snap = await p.runOnce();
  assert.equal(calls, 2, "should have retried once");
  assert.equal(snap.platforms.youtube.status, "ok");
  assert.equal(snap.total, 4);
});

test("EVERY platform failing does not count as a successful poll", async () => {
  const { p, clock } = makePoller({
    youtube: async () => {
      throw new Error("down");
    },
    twitch: async () => {
      throw new Error("down");
    },
  });
  const snap = await p.runOnce();
  assert.equal(snap.totalKnown, false, "an all-error poll must not publish a confident 0");
  assert.equal(snap.confidence, "unknown");
  assert.equal(p.health.consecutiveFailedPolls, 1);
  assert.equal(p.health.lastSuccessAt, null);

  // The clock moves past the stale window with no success: the poller must
  // admit it is blind rather than keep serving a fresh-looking updatedAt.
  clock.advance(200000);
  assert.equal(p.snapshot().poller.status, STATUS.STALE);
  assert.equal(p.snapshot().poller.stale, true);
});

test("STALE DATA: updatedAt stays fresh but poller health goes stale", async () => {
  const { p, clock } = makePoller({
    youtube: async () => ({ live: true, viewers: 5, status: "ok" }),
  });
  await p.runOnce();
  const good = p.snapshot();
  assert.equal(good.poller.stale, false);

  clock.advance(200000);
  const stale = p.snapshot();
  assert.equal(stale.total, 5, "the last known number is still exposed…");
  assert.equal(stale.poller.stale, true, "…but flagged as untrustworthy");
  assert.equal(stale.poller.lastSuccessAgeSeconds, 200);
});

test("DEAD POLLER: staleness fires an alert exactly once per repeat window", async () => {
  const fired = [];
  const alerter = {
    fire: async (key, message) => fired.push({ key, message }),
    clear: async (key) => fired.push({ key, cleared: true }),
    isActive: () => fired.some((f) => !f.cleared),
  };
  const { p, clock } = makePoller(
    {
      youtube: async () => {
        throw new Error("down");
      },
    },
    { alerter }
  );
  await p.runOnce();
  assert.equal(fired.length, 0, "one failed poll is not yet a dead poller");

  clock.advance(200000);
  p.watchdogCheck();
  await new Promise((r) => setImmediate(r));
  assert.equal(fired.length, 1);
  assert.equal(fired[0].key, "poller-stale");
  assert.match(fired[0].message, /NOT trustworthy/);
});

test("the alert clears once the poller recovers", async () => {
  const events = [];
  let active = false;
  const alerter = {
    fire: async (key, message) => {
      active = true;
      events.push(["fire", key, message]);
    },
    clear: async (key, message) => {
      active = false;
      events.push(["clear", key, message]);
    },
    isActive: () => active,
  };
  let broken = true;
  const { p, clock } = makePoller(
    {
      youtube: async () => {
        if (broken) throw new Error("down");
        return { live: true, viewers: 3, status: "ok" };
      },
    },
    { alerter }
  );
  await p.runOnce();
  clock.advance(200000);
  p.watchdogCheck();
  await new Promise((r) => setImmediate(r));
  assert.equal(events[0][0], "fire");

  broken = false;
  await p.runOnce();
  assert.equal(events.at(-1)[0], "clear");
  assert.equal(p.snapshot().poller.stale, false);
});

test("overlapping polls are refused instead of stacking up", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { p } = makePoller({ youtube: () => gate.then(() => ({ live: false, viewers: 0, status: "offline" })) });
  const first = p.runOnce();
  const second = await p.runOnce();
  assert.equal(second, null, "the second tick must be skipped, not run concurrently");
  assert.equal(p.health.skippedPolls, 1);
  release();
  await first;
});

test("WEDGED POLL: the watchdog abandons it and re-arms the loop", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { p, clock } = makePoller(
    { youtube: () => gate.then(() => ({ live: true, viewers: 99, status: "ok" })) },
    { hardDeadlineMs: 60000, setTimeout: () => null, clearTimeout: () => {} }
  );
  const hung = p.runOnce();

  clock.advance(120000); // past the hard deadline
  p.watchdogCheck();
  assert.equal(p.health.wedgeRecoveries, 1);
  assert.equal(p.health.inFlightSince, null, "the wedged poll must no longer block the loop");

  // The abandoned poll finishing later must not overwrite state with its result.
  release();
  const late = await hung;
  assert.equal(late, null, "an abandoned poll's result is discarded");
  assert.equal(p.snapshot().total, 0);
  assert.notEqual(p.snapshot().total, 99);
});

test("a fetcher returning junk is unknown, not a crash", async () => {
  const { p } = makePoller({ youtube: async () => undefined });
  const snap = await p.runOnce();
  assert.equal(snap.platforms.youtube.status, "error");
  assert.equal(snap.totalKnown, false);
});

test("SLOW onPoll: the watchdog does not re-arm while a tick is still finishing its hooks", async () => {
  // Regression (2026-09-25): runOnce() clears `running` before awaiting onPoll (the here.now push,
  // up to 10 s). The watchdog saw running=false + no timer and logged "no timer armed — re-arming"
  // on ~half of all ticks, firing an extra poll each time.
  let releasePush;
  const pushGate = new Promise((r) => (releasePush = r));
  const timers = [];
  const { p } = makePoller(
    { youtube: async () => ({ live: false, viewers: 0, status: "offline" }) },
    {
      onPoll: () => pushGate,
      setTimeout: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimeout: () => {},
    }
  );
  p.start();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); // poll done, push pending
  p.watchdogCheck();
  assert.equal(p.health.wedgeRecoveries, 0, "a tick still in its onPoll hook is not an idle loop");
  assert.equal(timers.length, 0, "no extra poll may be scheduled while the tick is finishing");
  releasePush();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(timers.length, 1, "the tick re-arms itself once its hooks finish");
  p.stop();
});
