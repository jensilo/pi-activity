// Synthetic aggregate timing only. No provider calls, private captures or tool inputs.
import assert from "node:assert/strict";
import { ActivityObservations } from "../observations.ts";
import { OBSERVATION_ENTRY_TYPE } from "../version.ts";

function fixture(options = {}) {
  let monotonic = 0,
    wall = 1000;
  const observations = new ActivityObservations({
    ...options,
    now: () => wall,
    monotonicNow: () => monotonic,
  });
  observations.beginTurn();
  return {
    observations,
    at(ms, timestamp = wall) {
      monotonic = ms;
      wall = timestamp;
    },
    wait() {
      return observations.view().telemetry.guardWait;
    },
    turn() {
      return observations.view().selected.telemetry.guardWait;
    },
  };
}
const checkpoint = (data) => ({
  type: "custom",
  customType: OBSERVATION_ENTRY_TYPE,
  data,
});
const wait = (wallMs, coverage = "complete") => ({ wallMs, coverage });
const restore = (data, options = {}) => {
  const f = fixture(options);
  f.observations.restore([checkpoint(data)]);
  return f;
};

// Parallel waits count their union, not the sum of gate latencies.
const parallel = fixture();
const first = parallel.observations.gateWaitStarted();
assert.equal(typeof first, "symbol");
parallel.at(10);
const second = parallel.observations.gateWaitStarted();
assert.notEqual(first, second);
parallel.at(20);
parallel.observations.gateWaitFinished(first);
parallel.at(30);
parallel.observations.gateWaitFinished(second);
assert.deepEqual(parallel.wait(), wait(30));
assert.deepEqual(parallel.turn(), wait(30));
parallel.at(40);
const serial = parallel.observations.gateWaitStarted();
parallel.at(47);
parallel.observations.gateWaitFinished(serial);
assert.deepEqual(parallel.wait(), wait(37), "idle gaps are excluded");
parallel.at(99);
parallel.observations.gateWaitFinished(serial);
parallel.observations.gateWaitFinished(undefined);
parallel.observations.gateWaitFinished(Symbol());
assert.deepEqual(
  parallel.wait(),
  wait(37),
  "unknown and duplicate finishes are inert",
);
assert.deepEqual(parallel.observations.view().totals, {
  files: 0,
  sh: 0,
  mcp: 0,
  blocked: 0,
});
assert.deepEqual(
  parallel.observations.view().history,
  [],
  "waiting does not create action receipts or need call IDs",
);

// Overlapping gates are independent even when observation call IDs collide.
const independent = fixture({ maxHistory: 0 });
const event = { toolCallId: "synthetic-reused-id", toolName: "fixture" };
const one = independent.observations.gateWaitStarted();
independent.observations.executionStart(event);
independent.at(5);
const two = independent.observations.gateWaitStarted();
independent.observations.executionStart(event);
independent.observations.gate(event, "block");
independent.at(10);
independent.observations.gateWaitFinished(one);
independent.at(15);
independent.observations.gateWaitFinished(two);
assert.deepEqual(independent.wait(), wait(15));
assert.equal(
  independent.observations.view().totals.blocked,
  1,
  "admission accounting is unchanged",
);

// Wall timestamps jump forward/backward while the monotonic duration remains exact.
const clocks = fixture();
clocks.at(10, 9000);
const clockToken = clocks.observations.gateWaitStarted();
clocks.at(15, 1);
assert.deepEqual(clocks.wait(), wait(5));
clocks.at(22, 9_000_000);
clocks.observations.gateWaitFinished(clockToken);
assert.deepEqual(clocks.wait(), wait(12));
assert.equal(clocks.observations.view().selected.startedAt, 1000);

// Live views and snapshots project elapsed without changing accumulated totals.
const live = fixture();
const liveToken = live.observations.gateWaitStarted();
live.at(10);
for (let n = 0; n < 3; n++) {
  assert.deepEqual(live.wait(), wait(10));
  assert.deepEqual(live.turn(), wait(10));
  const snapshot = live.observations.snapshot();
  assert.deepEqual(snapshot.telemetry.guardWait, wait(10));
  assert.deepEqual(snapshot.turns.at(-1).telemetry.guardWait, wait(10));
  assert.equal(snapshot.guardWaitPending, 1);
  assert.ok(!JSON.stringify(snapshot).includes("Symbol"));
  assert.deepEqual(Object.keys(snapshot.telemetry.guardWait).sort(), [
    "coverage",
    "wallMs",
  ]);
  snapshot.telemetry.guardWait.wallMs = 12345;
}
live.at(15);
assert.deepEqual(live.wait(), wait(15));
live.observations.gateWaitFinished(liveToken);
assert.deepEqual(live.wait(), wait(15));
assert.equal(live.observations.snapshot().guardWaitPending, 0);
live.at(100);
assert.deepEqual(live.wait(), wait(15));

// Interrupts finalize only observed time. Late tokens are inert, even without a scope.
const turns = fixture();
const oldScope = turns.observations.scope();
const interrupted = turns.observations.gateWaitStarted(oldScope);
turns.at(8);
turns.observations.endTurn(oldScope);
assert.deepEqual(turns.wait(), wait(8, "partial"));
assert.deepEqual(turns.turn(), wait(8, "partial"));
turns.at(200);
turns.observations.gateWaitFinished(interrupted, oldScope);
turns.observations.gateWaitFinished(interrupted);
assert.equal(turns.observations.gateWaitStarted(oldScope), undefined);
turns.observations.beginTurn();
assert.deepEqual(turns.turn(), wait(0));
const newToken = turns.observations.gateWaitStarted();
turns.at(205);
turns.observations.gateWaitFinished(newToken);
assert.deepEqual(turns.wait(), wait(13, "partial"));
assert.deepEqual(turns.turn(), wait(5));
assert.deepEqual(
  turns.observations.view().turns[0].telemetry.guardWait,
  wait(8, "partial"),
);
const beginInterrupt = turns.observations.gateWaitStarted();
turns.at(208);
turns.observations.beginTurn();
assert.deepEqual(turns.wait(), wait(16, "partial"));
assert.deepEqual(turns.turn(), wait(0));
turns.observations.gateWaitFinished(beginInterrupt);
assert.deepEqual(turns.wait(), wait(16, "partial"));

// The fixed pending marker survives zero history and captures no offline downtime.
const pending = fixture({ maxHistory: 0 });
const pendingToken = pending.observations.gateWaitStarted();
pending.at(20);
const pendingSnapshot = pending.observations.snapshot();
assert.equal(pendingSnapshot.history.length, 0);
assert.equal(pendingSnapshot.guardWaitPending, 1);
const resumed = restore(pendingSnapshot, { maxHistory: 0 });
resumed.at(100_000, 999_999_999);
assert.deepEqual(resumed.wait(), wait(20, "partial"));
assert.deepEqual(resumed.turn(), wait(20, "partial"));
assert.equal(resumed.observations.snapshot().guardWaitPending, 0);
resumed.observations.gateWaitFinished(pendingToken);
const resumedToken = resumed.observations.gateWaitStarted();
resumed.at(100_007);
resumed.observations.gateWaitFinished(resumedToken);
assert.deepEqual(resumed.wait(), wait(27, "partial"));
assert.deepEqual(resumed.turn(), wait(27, "partial"));

// Eviction does not lose interruption evidence or lifetime totals.
const evicted = fixture({ maxHistory: 1, maxTurns: 1 });
evicted.at(0);
const evictedToken = evicted.observations.gateWaitStarted();
for (let n = 0; n < 4; n++)
  evicted.observations.toolResult({
    toolCallId: `synthetic-${n}`,
    toolName: "fixture",
    isError: false,
  });
evicted.at(9);
const evictedSnapshot = evicted.observations.snapshot();
assert.equal(evictedSnapshot.history.length, 1);
assert.equal(evictedSnapshot.omitted, 3);
assert.equal(evictedSnapshot.guardWaitPending, 1);
assert.deepEqual(restore(evictedSnapshot).wait(), wait(9, "partial"));
evicted.observations.gateWaitFinished(evictedToken);
evicted.observations.beginTurn();
evicted.at(30);
const current = evicted.observations.gateWaitStarted();
evicted.at(34);
evicted.observations.gateWaitFinished(current);
assert.deepEqual(evicted.wait(), wait(13));
assert.deepEqual(evicted.turn(), wait(4));
assert.equal(evicted.observations.snapshot().turns.length, 1);
assert.deepEqual(restore(evicted.observations.snapshot()).wait(), wait(13));

// A tree switch selects only its supplied branch and clears every old token.
const branchA = fixture();
const tokenA = branchA.observations.gateWaitStarted();
branchA.at(11);
const snapshotA = branchA.observations.snapshot();
const branchB = fixture();
const tokenB = branchB.observations.gateWaitStarted();
branchB.at(3);
branchB.observations.gateWaitFinished(tokenB);
branchA.at(50_000);
branchA.observations.restore([checkpoint(branchB.observations.snapshot())]);
branchA.observations.gateWaitFinished(tokenA);
assert.deepEqual(branchA.wait(), wait(3));
const newA = branchA.observations.gateWaitStarted();
branchA.at(50_005);
branchA.observations.gateWaitFinished(newA);
assert.deepEqual(branchA.wait(), wait(8));
branchA.observations.restore([checkpoint(snapshotA)]);
assert.deepEqual(
  branchA.wait(),
  wait(11, "partial"),
  "restoring another branch does not merge its elapsed time",
);
branchA.observations.restore([]);
assert.deepEqual(branchA.wait(), wait(0));

// Legacy absent fields retain all other aggregates, but cannot claim measured wait.
const legacy = structuredClone(parallel.observations.snapshot());
delete legacy.guardWaitPending;
delete legacy.telemetry.guardWait;
for (const turn of legacy.turns) delete turn.telemetry.guardWait;
legacy.totals.blocked = 7;
const old = restore(legacy);
assert.equal(old.observations.view().totals.blocked, 7);
assert.deepEqual(old.wait(), wait(0, "unavailable"));
assert.deepEqual(old.turn(), wait(0, "unavailable"));
const oldToken = old.observations.gateWaitStarted();
old.at(6);
old.observations.gateWaitFinished(oldToken);
assert.deepEqual(old.wait(), wait(6, "partial"));
assert.deepEqual(old.turn(), wait(6, "partial"));
old.observations.beginTurn();
assert.deepEqual(old.turn(), wait(0));
const prior = fixture();
prior.observations.restore([{ type: "message" }]);
assert.deepEqual(prior.wait(), wait(0, "unavailable"));
assert.deepEqual(prior.turn(), wait(0, "unavailable"));
const priorToken = prior.observations.gateWaitStarted();
prior.at(4);
prior.observations.gateWaitFinished(priorToken);
assert.deepEqual(prior.wait(), wait(4, "partial"));
assert.deepEqual(prior.turn(), wait(4, "partial"));
prior.observations.beginTurn();
assert.deepEqual(
  prior.turn(),
  wait(0),
  "a genuinely new turn has full measurement coverage",
);

// Validate both optional fields strictly and fall back only to a valid checkpoint.
const validSnapshot = parallel.observations.snapshot();
const corruptions = [
  (s) => {
    s.telemetry.guardWait = null;
  },
  (s) => {
    s.telemetry.guardWait = { wallMs: 1 };
  },
  (s) => {
    s.telemetry.guardWait = { wallMs: 1, coverage: "incomplete" };
  },
  ...[-1, NaN, Infinity, "1", undefined].map((wallMs) => (s) => {
    s.telemetry.guardWait = { wallMs, coverage: "complete" };
  }),
  (s) => {
    s.turns[0].telemetry.guardWait.wallMs = -1;
  },
  (s) => {
    s.turns[0].telemetry.guardWait.coverage = false;
  },
  ...[-1, 0.5, 513, NaN, Infinity, "1", null].map((count) => (s) => {
    s.guardWaitPending = count;
  }),
  (s) => {
    s.totals.blocked = -1;
  },
  (s) => {
    s.telemetry.classifier.byInput.shell.success = -1;
  },
];
for (const corrupt of corruptions) {
  const invalid = structuredClone(validSnapshot);
  corrupt(invalid);
  const rejected = restore(invalid);
  assert.deepEqual(rejected.wait(), wait(0, "partial"));
  assert.equal(rejected.observations.view().coverage, "incomplete");
  const fallback = fixture();
  fallback.observations.restore([
    checkpoint(validSnapshot),
    checkpoint(invalid),
  ]);
  assert.deepEqual(fallback.wait(), wait(37, "partial"));
  assert.deepEqual(fallback.turn(), wait(37, "partial"));
}
const messagesAfter = fixture();
messagesAfter.observations.restore([
  checkpoint(validSnapshot),
  { type: "message" },
]);
assert.deepEqual(messagesAfter.wait(), wait(37, "partial"));
assert.deepEqual(messagesAfter.turn(), wait(37, "partial"));
const messagesBefore = fixture();
messagesBefore.observations.restore([
  { type: "message" },
  checkpoint(validSnapshot),
]);
assert.deepEqual(messagesBefore.wait(), wait(37));

// Overflow rejects new tokens, bounds runtime state and reports possible undercount.
const bounded = fixture();
const tokens = Array.from({ length: 512 }, () =>
  bounded.observations.gateWaitStarted(),
);
assert.ok(tokens.every((token) => typeof token === "symbol"));
assert.equal(new Set(tokens).size, 512);
for (let n = 0; n < 100; n++)
  assert.equal(bounded.observations.gateWaitStarted(), undefined);
bounded.at(12);
const boundedSnapshot = bounded.observations.snapshot();
assert.equal(boundedSnapshot.guardWaitPending, 512);
assert.deepEqual(boundedSnapshot.telemetry.guardWait, wait(12, "partial"));
for (const token of tokens) bounded.observations.gateWaitFinished(token);
assert.deepEqual(bounded.wait(), wait(12, "partial"));
bounded.at(90);
bounded.observations.gateWaitFinished(undefined);
assert.deepEqual(bounded.wait(), wait(12, "partial"));
assert.equal(bounded.observations.snapshot().guardWaitPending, 0);
assert.ok(Buffer.byteLength(JSON.stringify(boundedSnapshot)) < 65536);

// Invalid injected clocks never poison persisted finite aggregates or throw.
for (const clock of [
  () => NaN,
  () => {
    throw new Error("Synthetic clock failure");
  },
]) {
  const broken = new ActivityObservations({ monotonicNow: clock });
  const token = broken.gateWaitStarted();
  assert.deepEqual(broken.view().telemetry.guardWait, wait(0, "partial"));
  broken.gateWaitFinished(token);
  assert.deepEqual(broken.snapshot().telemetry.guardWait, wait(0, "partial"));
}
const backwards = fixture();
backwards.at(10);
const backwardsToken = backwards.observations.gateWaitStarted();
backwards.at(5);
assert.deepEqual(backwards.wait(), wait(0, "partial"));
backwards.observations.gateWaitFinished(backwardsToken);
assert.deepEqual(backwards.wait(), wait(0, "partial"));
const saturating = fixture();
let saturatedToken = saturating.observations.gateWaitStarted();
saturating.at(Number.MAX_VALUE);
saturating.observations.gateWaitFinished(saturatedToken);
saturating.at(0);
saturatedToken = saturating.observations.gateWaitStarted();
saturating.at(Number.MAX_VALUE);
saturating.observations.gateWaitFinished(saturatedToken);
assert.deepEqual(saturating.wait(), wait(Number.MAX_VALUE, "partial"));
assert.deepEqual(
  restore(saturating.observations.snapshot()).wait(),
  wait(Number.MAX_VALUE, "partial"),
);
const defaultClock = new ActivityObservations({ now: () => 1000 });
const defaultToken = defaultClock.gateWaitStarted();
defaultClock.gateWaitFinished(defaultToken);
assert.ok(Number.isFinite(defaultClock.view().telemetry.guardWait.wallMs));
assert.equal(defaultClock.view().telemetry.guardWait.coverage, "complete");

console.log(
  "guard wait tests passed: bounded union timing, live projection, interrupts, strict checkpoints and branch restoration",
);
