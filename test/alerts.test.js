"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAlerter } = require("../lib/alerts");
const { rotateIfLarge } = require("../lib/logrotate");
const { withRetry } = require("../lib/retry");

function clock(start) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("the default sink sends nothing over the network", async () => {
  const lines = [];
  const a = createAlerter({ sink: "log", logPath: null, logger: { error: (l) => lines.push(l) } });
  const r = await a.fire("poller-stale", "poller is dead");
  assert.equal(r.sink, "log");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ALERT CRITICAL poller-stale: poller is dead/);
});

test('sink "none" is a true no-op', async () => {
  const a = createAlerter({ sink: "none", logPath: null });
  const r = await a.fire("poller-stale", "dead");
  assert.equal(r.delivered, false);
});

test("re-raises are throttled to one per repeat window", async () => {
  const sent = [];
  const c = clock(0);
  const a = createAlerter({ repeatMs: 60000, now: c.now, send: async (p) => sent.push(p) });

  await a.fire("k", "down");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state, "raised");

  c.advance(30000);
  const s = await a.fire("k", "still down");
  assert.equal(s.suppressed, true);
  assert.equal(sent.length, 1, "must not spam inside the repeat window");

  c.advance(40000);
  await a.fire("k", "still down");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].state, "ongoing");
  assert.equal(sent[1].occurrence, 2);
});

test("clear only emits when an alert was actually active", async () => {
  const sent = [];
  const c = clock(0);
  const a = createAlerter({ now: c.now, send: async (p) => sent.push(p) });

  assert.equal((await a.clear("k", "fine")).suppressed, true);
  assert.equal(sent.length, 0);

  await a.fire("k", "down");
  assert.equal(a.isActive("k"), true);
  c.advance(90000);
  await a.clear("k", "recovered");
  assert.equal(a.isActive("k"), false);
  assert.equal(sent.at(-1).state, "resolved");
  assert.equal(sent.at(-1).downSeconds, 90);
});

test("throttle state survives a restart via dump/initial (one-shot watchdog)", async () => {
  const sent = [];
  const c = clock(0);
  const first = createAlerter({ repeatMs: 60000, now: c.now, send: async (p) => sent.push(p) });
  await first.fire("k", "down");
  const persisted = JSON.parse(JSON.stringify(first.dump()));

  c.advance(10000);
  const second = createAlerter({ repeatMs: 60000, now: c.now, initial: persisted, send: async (p) => sent.push(p) });
  const r = await second.fire("k", "down");
  assert.equal(r.suppressed, true, "a fresh process must still honour the throttle");
  assert.equal(sent.length, 1);
});

test("a failing sink never throws into the poller", async () => {
  const errs = [];
  const a = createAlerter({
    logger: { error: (l) => errs.push(l) },
    send: async () => {
      throw new Error("webhook exploded");
    },
  });
  const r = await a.fire("k", "down");
  assert.equal(r.delivered, false);
  assert.match(r.error, /webhook exploded/);
});

test("log rotation truncates in place and keeps a tail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streamcount-"));
  const file = path.join(dir, "streamcount.log");
  fs.writeFileSync(file, "x".repeat(20000));

  assert.equal(rotateIfLarge(file, 100000, 1000).rotated, false, "small logs are left alone");

  const r = rotateIfLarge(file, 10000, 1000);
  assert.equal(r.rotated, true);
  assert.equal(fs.statSync(file).size, 0, "must truncate in place — launchd holds this fd");
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(fs.readFileSync(`${file}.1`, "utf8").includes("rotated at"));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("withRetry backs off exponentially and gives up after the last try", async () => {
  const delays = [];
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error("nope");
      },
      { tries: 3, baseMs: 100, jitter: () => 1, sleep: async (ms) => delays.push(ms) }
    ),
    /nope/
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("withRetry stops early when the error is not retryable", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error("fatal");
      },
      { tries: 5, sleep: async () => {}, shouldRetry: () => false }
    ),
    /fatal/
  );
  assert.equal(calls, 1);
});
