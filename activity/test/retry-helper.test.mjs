// Synthetic retry scheduling only: no providers, real activity or host settings.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { MAX_RETRY_DELAY_MS, MAX_TRANSIENT_RETRIES, TOTAL_RETRY_MS, RetryDeadlineError,
  retryAfterMs, retryDelayMs, retryOperation, transientFailure } from "../retry.ts";
import { runSafetyReview } from "../judge.ts";

assert.equal(MAX_TRANSIENT_RETRIES, 5);
assert.equal(TOTAL_RETRY_MS, 30_000);
for (let retry = 1; retry <= 5; retry++) {
  const upper = Math.min(MAX_RETRY_DELAY_MS, 100 * 2 ** (retry - 1));
  assert.equal(retryDelayMs(retry, undefined, () => 0), upper / 2);
  assert.equal(retryDelayMs(retry, undefined, () => 1), upper);
}
assert.equal(retryAfterMs({ headers: { "Retry-After": "999999" } }), 999999000);
assert.equal(retryAfterMs({ headers: { "Retry-After": "20" } }), 20_000);
assert.equal(retryAfterMs({ retryAfterMs: 20_000 }), 20_000);
assert.equal(retryAfterMs({ response: { headers: new Headers({ "retry-after": "0.25" }) } }), 250);
assert.equal(retryAfterMs({ headers: { "retry-after": "Tue, 27 Oct 2026 00:00:01 GMT" } }, Date.parse("2026-10-27T00:00:00Z")), 1000);
assert.equal(retryAfterMs({ retryAfterMs: Infinity }), undefined);
assert.equal(retryAfterMs({ retryAfterMs: -1 }), undefined);
assert.equal(retryAfterMs({ headers: { "retry-after": "invalid" } }), undefined);
assert.equal(retryAfterMs({ headers: { "retry-after": "-1" } }), undefined);
assert.equal(retryDelayMs(1, { retryAfterMs: 999999 }, () => 0), 999999);
assert.equal(retryDelayMs(1, { headers: { "Retry-After": "20" } }, () => 0), 20_000);

// Exact 20-second server floor under a fake clock: no wall-clock sleep or early dispatch.
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
try {
  let calls = 0;
  let scheduled;
  const pending = retryOperation(async () => {
    if (++calls === 1) throw Object.assign(new Error("busy"), { status: 429, headers: { "Retry-After": "20" } });
    return "ready";
  }, { shouldRetry: transientFailure, onRetry: (_error, _retry, delay) => { scheduled = delay; } });
  await flush();
  assert.equal(scheduled, 20_000);
  assert.equal(calls, 1);
  // A cooling request must not serialize an unrelated healthy one.
  assert.equal(await retryOperation(async () => "healthy", { shouldRetry: transientFailure }), "healthy");
  mock.timers.tick(19_999);
  await flush();
  assert.equal(calls, 1, "no request before the complete server floor");
  mock.timers.tick(1);
  await flush();
  assert.equal(await pending, "ready");
  assert.equal(calls, 2);

  let deadlineCalls = 0;
  const expired = assert.rejects(retryOperation(async () => {
    deadlineCalls++;
    throw Object.assign(new Error("busy"), { status: 429, retryAfterMs: 20_000 });
  }, { expiresAt: Date.now() + 10_000, shouldRetry: transientFailure }), RetryDeadlineError);
  await flush();
  mock.timers.tick(9_999);
  await flush();
  assert.equal(deadlineCalls, 1);
  mock.timers.tick(1);
  await expired;
  assert.equal(deadlineCalls, 1, "a floor beyond the remaining deadline cannot cause an early retry");
} finally {
  mock.timers.reset();
}

for (const error of [Object.assign(new Error("busy"), { status: 429 }),
  Object.assign(new Error("busy"), { status: 503 }), Object.assign(new Error("network"), { code: "ECONNRESET" }),
  new Error("503 service unavailable"), new Error("429 rate limit")]) assert.equal(transientFailure(error), true);
for (const error of [new Error("unknown failure"), new Error("malformed 503 response"), new Error("incompatible identity"),
  Object.assign(new Error("invalid API key"), { status: 429 }), Object.assign(new Error("quota exceeded"), { status: 429 }),
  Object.assign(new Error("conflict"), { status: 409 }), Object.assign(new Error("missing artifact"), { code: "ENOENT" }),
  Object.assign(new Error("forbidden"), { status: 503 }), Object.assign(new Error("bad schema"), { status: 503 }),
  Object.assign(new Error("bad request"), { status: 400 })]) assert.equal(transientFailure(error), false);

// Cancellation during Retry-After must interrupt the backoff, not launch again.
const cancelled = new AbortController();
let abortCalls = 0;
const start = Date.now();
await assert.rejects(retryOperation(async () => {
  abortCalls++;
  throw Object.assign(new Error("busy"), { status: 429, retryAfterMs: 999999 });
}, { signal: cancelled.signal, shouldRetry: transientFailure,
  onRetry: () => setTimeout(() => cancelled.abort(), 10) }), { name: "AbortError" });
assert.equal(abortCalls, 1);
assert.ok(Date.now() - start < 500, "abort does not wait for the server-requested delay");

let deadlineCalls = 0;
await assert.rejects(retryOperation(async () => {
  deadlineCalls++;
  throw Object.assign(new Error("busy"), { status: 503, retryAfterMs: 999999 });
}, { expiresAt: Date.now() + 20, shouldRetry: transientFailure }), RetryDeadlineError);
assert.equal(deadlineCalls, 1, "backoff cannot renew the deadline");
let observedSignal;
await assert.rejects(retryOperation(async (signal) => {
  observedSignal = signal;
  return new Promise(() => {});
}, { expiresAt: Date.now() + 15, shouldRetry: transientFailure }), RetryDeadlineError);
assert.equal(observedSignal.aborted, true, "deadline reaches the transport signal");

let expiredCalls = 0;
await assert.rejects(retryOperation(async () => { expiredCalls++; },
  { expiresAt: Date.now() - 1, shouldRetry: transientFailure }), RetryDeadlineError);
assert.equal(expiredCalls, 0);
let permanentCalls = 0;
await assert.rejects(retryOperation(async () => {
  permanentCalls++;
  throw Object.assign(new Error("bad request"), { status: 400 });
}, { shouldRetry: transientFailure }), /bad request/);
assert.equal(permanentCalls, 1);

// Both reviews must enter their first attempt before either is released.
let entered = 0;
let release;
const barrier = new Promise((resolve) => { release = resolve; });
const overlapping = () => runSafetyReview(async () => {
  entered++;
  if (entered === 2) release();
  await barrier;
  return { ok: true, allow: true, reason: "synthetic read" };
}, new AbortController().signal, undefined, Date.now() + 500);
const pair = await Promise.all([overlapping(), overlapping()]);
assert.equal(entered, 2);
assert.ok(pair.every((result) => result.ok && result.allow), "healthy reviews overlap without a global queue");

let malformedCalls = 0;
const malformed = await runSafetyReview(async () => {
  malformedCalls++;
  return { ok: false, reason: "invalid JSON", retryable: true, retryCause: "invalid JSON" };
}, new AbortController().signal);
assert.equal(malformed.ok, false);
assert.equal(malformedCalls, 1, "even legacy invalid-JSON retry flags cannot enable blind retries");

// If timers are delayed by synchronous work, the fixed deadline still wins.
const late = await runSafetyReview(async () => {
  const until = Date.now() + 20;
  while (Date.now() < until) { /* synthetic event-loop stall */ }
  return { ok: true, allow: true, reason: "late synthetic response" };
}, new AbortController().signal, undefined, Date.now() + 5);
assert.equal(late.ok, false);
assert.match(late.reason, /timed out/);
console.log("retry helper tests passed (jitter, full Retry-After floor, abort, deadline, permanent errors, concurrency)");
