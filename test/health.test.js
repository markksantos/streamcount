"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregate, pollSucceeded, classify, STATUS } = require("../lib/health");

const T0 = Date.parse("2026-08-10T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

test("aggregate sums only platforms that answered", () => {
  const r = aggregate({
    youtube: { status: "ok", live: true, viewers: 12 },
    twitch: { status: "offline", live: false, viewers: 0 },
    kick: { status: "error", live: false, viewers: null },
    x: { status: "unsupported", live: false, viewers: null },
  });
  assert.equal(r.total, 12);
  assert.equal(r.totalKnown, true);
  assert.equal(r.confidence, "partial");
  assert.equal(r.knownPlatforms, 2);
  assert.equal(r.unknownPlatforms, 1);
  assert.equal(r.inapplicablePlatforms, 1);
});

test("all platforms erroring is UNKNOWN, never a confident zero", () => {
  const r = aggregate({
    youtube: { status: "error", live: false, viewers: null },
    twitch: { status: "timeout", live: false, viewers: null },
    kick: { status: "error", live: false, viewers: null },
    x: { status: "unsupported", live: false, viewers: null },
  });
  assert.equal(r.totalKnown, false, "an all-error poll must not claim to know the total");
  assert.equal(r.confidence, "unknown");
  assert.equal(pollSucceeded({ youtube: { status: "error" } }), false);
});

test("a genuinely offline stream is still a confident zero", () => {
  const platforms = {
    youtube: { status: "offline", live: false, viewers: 0 },
    twitch: { status: "offline", live: false, viewers: 0 },
    kick: { status: "offline", live: false, viewers: 0 },
  };
  const r = aggregate(platforms);
  assert.equal(r.total, 0);
  assert.equal(r.totalKnown, true, "reached every platform, so 0 is a real answer");
  assert.equal(r.confidence, "full");
  assert.equal(pollSucceeded(platforms), true);
});

test("nothing configured is 'none', not 'unknown'", () => {
  const r = aggregate({
    youtube: { status: "disabled" },
    twitch: { status: "disabled" },
    x: { status: "unsupported" },
  });
  assert.equal(r.confidence, "none");
  assert.equal(r.totalKnown, false);
});

test("non-numeric viewer counts cannot poison the total", () => {
  const r = aggregate({ youtube: { status: "ok", live: true, viewers: NaN } });
  assert.equal(r.total, 0);
  assert.ok(Number.isFinite(r.total));
});

test("unrecognised platform status is treated as unknown, not trusted", () => {
  const r = aggregate({ youtube: { status: "weird-new-status" } });
  assert.equal(r.totalKnown, false);
  assert.equal(r.unknownPlatforms, 1);
});

const base = { intervalMs: 15000, staleAfterMs: 180000, consecutiveFailedPolls: 0, unknownPlatforms: 0 };

test("classify: fresh success is ok", () => {
  const h = { ...base, startedAt: iso(T0), lastSuccessAt: iso(T0 + 5000), lastPollFinishedAt: iso(T0 + 5000) };
  const r = classify(h, T0 + 10000);
  assert.equal(r.status, STATUS.OK);
  assert.equal(r.healthy, true);
  assert.equal(r.stale, false);
});

test("classify: a late loop degrades before it goes stale", () => {
  const h = { ...base, startedAt: iso(T0), lastSuccessAt: iso(T0), lastPollFinishedAt: iso(T0) };
  const r = classify(h, T0 + 60000); // 60s > 2.5 intervals, < 180s stale window
  assert.equal(r.status, STATUS.DEGRADED);
  assert.equal(r.stale, false);
  assert.equal(r.lastSuccessAgeSeconds, 60);
});

test("classify: DEAD POLLER — no successful poll past the stale window", () => {
  const h = { ...base, startedAt: iso(T0), lastSuccessAt: iso(T0), lastPollFinishedAt: iso(T0) };
  const r = classify(h, T0 + 200000);
  assert.equal(r.status, STATUS.STALE);
  assert.equal(r.stale, true);
  assert.equal(r.healthy, false);
  assert.match(r.reason, /200s ago/);
});

test("classify: a poller that never succeeded goes stale after the FULL window", () => {
  const starting = classify({ ...base, startedAt: iso(T0), lastSuccessAt: null }, T0 + 5000);
  assert.equal(starting.status, STATUS.STARTING);
  assert.equal(starting.healthy, true, "don't cry wolf during the very first poll");

  // Past the startup grace but inside the stale window: worrying, not yet fatal.
  const mid = classify({ ...base, startedAt: iso(T0), lastSuccessAt: null }, T0 + 60000);
  assert.equal(mid.status, STATUS.DEGRADED, "must not be declared stale before staleAfterMs");
  assert.equal(mid.stale, false);

  const never = classify({ ...base, startedAt: iso(T0), lastSuccessAt: null }, T0 + 200000);
  assert.equal(never.status, STATUS.STALE);
  assert.equal(never.stale, true);
});

test("classify: repeated failures during startup degrade rather than read as 'starting'", () => {
  const h = { ...base, startedAt: iso(T0), lastSuccessAt: null, consecutiveFailedPolls: 3 };
  const r = classify(h, T0 + 10000);
  assert.equal(r.status, STATUS.DEGRADED);
  assert.equal(r.healthy, false);
});

test("classify: upstream errors surface as degraded even while polls are fresh", () => {
  const h = {
    ...base,
    startedAt: iso(T0),
    lastSuccessAt: iso(T0 + 5000),
    lastPollFinishedAt: iso(T0 + 5000),
    unknownPlatforms: 2,
  };
  const r = classify(h, T0 + 6000);
  assert.equal(r.status, STATUS.DEGRADED);
  assert.match(r.reason, /2 platform\(s\) unreachable/);
});
