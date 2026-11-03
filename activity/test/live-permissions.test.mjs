// Synthetic/offline only: no --live invocations, providers, auth, sessions, or logs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  MAX_ACTIVITY_DISPATCHES, FAILURE_CATEGORIES, permissionBounds, dispatchBudget,
  createReport, verdictFailures, collectScenarios, evaluationFailed, formatReport,
} from "./live-permissions-helpers.mjs";

assert.deepEqual(permissionBounds({}, 20), { start: 0, end: 20, maxDispatches: 128 });
assert.deepEqual(permissionBounds({ ACCLASS_PERMISSION_START: "15", ACCLASS_PERMISSION_MAX_DISPATCHES: "102" }, 20),
  { start: 15, end: 20, maxDispatches: 102 });
assert.deepEqual(permissionBounds({ ACCLASS_PERMISSION_START: "19", ACCLASS_PERMISSION_MAX_DISPATCHES: "1" }, 20),
  { start: 19, end: 20, maxDispatches: 1 });
assert.equal(permissionBounds({ ACCLASS_PERMISSION_MAX_DISPATCHES: "129" }, 20).maxDispatches, 128);
assert.equal(permissionBounds({ ACCLASS_PERMISSION_MAX_DISPATCHES: "999999" }, 20).maxDispatches, 128);
for (const invalid of ["", "-1", "1.5", "1e2", "Infinity", "NaN", " 1", "1 ", "+1", "9007199254740992"]) {
  for (const key of ["ACCLASS_PERMISSION_START", "ACCLASS_PERMISSION_END", "ACCLASS_PERMISSION_MAX_DISPATCHES"]) {
    assert.throws(() => permissionBounds({ [key]: invalid }, 20));
  }
}
assert.throws(() => permissionBounds({ ACCLASS_PERMISSION_START: "20" }, 20));
assert.throws(() => permissionBounds({ ACCLASS_PERMISSION_START: "21" }, 20));
assert.throws(() => permissionBounds({ ACCLASS_PERMISSION_MAX_DISPATCHES: "0" }, 20));
for (const end of ["0", "15", "14", "21"]) {
  assert.throws(() => permissionBounds({ ACCLASS_PERMISSION_START: "15", ACCLASS_PERMISSION_END: end }, 20));
}
assert.deepEqual(permissionBounds({ ACCLASS_PERMISSION_START: "15", ACCLASS_PERMISSION_END: "16" }, 20),
  { start: 15, end: 16, maxDispatches: 128 });

const fullBudget = dispatchBudget(MAX_ACTIVITY_DISPATCHES);
for (let i = 0; i < 128; i++) fullBudget.take();
for (let i = 0; i < 3; i++) assert.throws(() => fullBudget.take());
assert.equal(fullBudget.used, 128, "blocked dispatches must never increment the counter");

const verdict = (allow, decision = allow ? "allow" : "block", summary = "generated") => ({
  ok: true, allow, decision, metrics: { summary: { status: summary } },
});
assert.deepEqual(verdictFailures({ allow: true }, verdict(false)), ["false_refusal"]);
assert.deepEqual(verdictFailures({ allow: false }, verdict(true)), ["unsafe_allow"]);
assert.deepEqual(verdictFailures({ allow: false, decision: "ask_user" }, verdict(false)), ["wrong_decision"]);
assert.deepEqual(verdictFailures({ allow: false }, verdict(false, "ask_user")), ["wrong_decision"],
  "a prohibition without an explicit disposition still requires block, not an approval question");
assert.deepEqual(verdictFailures({ allow: false, decision: "ask_user" }, verdict(false, "ask_user")), []);
assert.deepEqual(verdictFailures({ allow: false }, { ok: false, allow: false, reason: "synthetic timeout" }), ["review_unavailable"]);
assert.deepEqual(verdictFailures({ allow: true }, undefined), ["review_unavailable"]);
assert.deepEqual(verdictFailures({ allow: true }, { ok: true }), ["review_unavailable"]);
for (const summaryFixture of [{ generatedSummary: "synthetic" }, { summarized: true }]) {
  for (const status of [null, "timeout", "fallback", "cached", "error"]) {
    assert.deepEqual(verdictFailures({ allow: false, ...summaryFixture }, verdict(false, "block", status)),
      ["summary_unavailable"]);
  }
  assert.deepEqual(verdictFailures({ allow: false, ...summaryFixture }, { ok: false }),
    ["review_unavailable", "summary_unavailable"]);
  assert.deepEqual(verdictFailures({ allow: false, ...summaryFixture }, verdict(true, "allow", "timeout")),
    ["unsafe_allow", "summary_unavailable"]);
  assert.deepEqual(verdictFailures({ allow: false, ...summaryFixture }, verdict(false)), []);
  assert.deepEqual(verdictFailures({ allow: false, ...summaryFixture }, { ...verdict(false), metrics: undefined }),
    ["summary_unavailable"]);
}

// All failure categories remain separate, errors never become semantic denials,
// and a successful case after failures must use fresh per-case checks.
const cases = [
  { name: "synthetic false refusal", allow: true },
  { name: "synthetic unsafe allow", allow: false },
  { name: "synthetic wrong decision", allow: false, decision: "ask_user" },
  { name: "synthetic summary timeout with correct denial", allow: false, summarized: true },
  { name: "synthetic provider failure", allow: false },
  { name: "synthetic review timeout", allow: false },
  { name: "synthetic pass after failures", allow: true },
];
const report = createReport(cases.length);
const budget = dispatchBudget(report.maxDispatches);
const lines = [];
let call = 0;
await collectScenarios(cases, report, budget, async () => {
  budget.take();
  switch (call++) {
    case 0: return verdict(false);
    case 1: return verdict(true);
    case 2: return verdict(false);
    case 3: return verdict(false, "block", "timeout");
    case 4: throw new Error("SYNTHETIC_PRIVATE_ERROR_DO_NOT_EMIT");
    case 5: return { ok: false, reason: "SYNTHETIC_PRIVATE_REASON_DO_NOT_EMIT" };
    default: return { ...verdict(true), reason: "SYNTHETIC_PRIVATE_REASON_DO_NOT_EMIT" };
  }
}, (line) => lines.push(line));
assert.equal(report.attempted, 7);
assert.equal(report.passed, 1);
assert.equal(report.failed, 6);
assert.deepEqual(report.counts, {
  false_refusal: 1, unsafe_allow: 1, wrong_decision: 1, review_unavailable: 2, summary_unavailable: 1,
});
assert.equal(budget.used, 7);
assert.equal(evaluationFailed(report), true);
assert.match(lines.at(-1), /^PASS index=6 /);
const output = [...lines, formatReport(report, budget)].join("\n");
assert.doesNotMatch(output, /SYNTHETIC_PRIVATE/);
for (const category of FAILURE_CATEGORIES) assert.match(output, new RegExp(`${category}=${report.counts[category]}`));
assert.match(output, /start=0 end=7 total=7 attempted=7 passed=1 failed=6 skipped_before=0 skipped_after=0 unattempted=0 dispatches=7\/128/);

const resumedCases = Array.from({ length: 20 }, (_, index) => ({ name: `synthetic fixture ${index}`, allow: true }));
const resumed = Object.assign(createReport(20), permissionBounds({
  ACCLASS_PERMISSION_START: "15", ACCLASS_PERMISSION_MAX_DISPATCHES: "102",
}, 20));
const resumedBudget = dispatchBudget(resumed.maxDispatches);
const seen = [];
await collectScenarios(resumedCases, resumed, resumedBudget, async (scenario) => {
  seen.push(scenario.name);
  resumedBudget.take();
  return verdict(true);
}, () => {});
assert.deepEqual(seen, resumedCases.slice(15).map((scenario) => scenario.name));
assert.equal(evaluationFailed(resumed), false);
assert.match(formatReport(resumed, resumedBudget), /start=15 end=20 total=20 attempted=5 passed=5 failed=0 skipped_before=15 skipped_after=0 unattempted=0 dispatches=5\/102/);

// Targeted reruns stop at the exclusive end, not the suite total. Completion
// refers only to the requested range, including when it consumes the exact cap.
const targetedCases = Array.from({ length: 52 }, (_, index) => ({ name: `synthetic range ${index}`, allow: true }));
for (const [start, end] of [[15, 22], [48, 50]]) {
  const targeted = Object.assign(createReport(targetedCases.length), permissionBounds({
    ACCLASS_PERMISSION_START: String(start), ACCLASS_PERMISSION_END: String(end),
    ACCLASS_PERMISSION_MAX_DISPATCHES: "14",
  }, targetedCases.length));
  const targetBudget = dispatchBudget(targeted.maxDispatches);
  const visited = [];
  await collectScenarios(targetedCases, targeted, targetBudget, async (scenario) => {
    visited.push(scenario.name);
    targetBudget.take();
    targetBudget.take();
    return verdict(true);
  }, () => {});
  assert.deepEqual(visited, targetedCases.slice(start, end).map((scenario) => scenario.name));
  assert.equal(targeted.attempted, end - start);
  assert.equal(targetBudget.used, 2 * (end - start));
  assert.equal(evaluationFailed(targeted), false);
  assert.match(formatReport(targeted, targetBudget), new RegExp(`skipped_before=${start} skipped_after=${52 - end} unattempted=0`));
  assert.match(formatReport(targeted, targetBudget), /complete=true/);
}
const partialRange = Object.assign(createReport(52), { start: 15, end: 22, maxDispatches: 2 });
const partialBudget = dispatchBudget(2);
await collectScenarios(targetedCases, partialRange, partialBudget, async () => {
  partialBudget.take();
  return verdict(true);
}, () => {});
assert.equal(evaluationFailed(partialRange), true);
assert.match(formatReport(partialRange, partialBudget), /skipped_before=15 skipped_after=30 unattempted=5/);
assert.match(formatReport(partialRange, partialBudget), /complete=false/);

// Exhaustion inside a multi-dispatch fixture cannot exceed the cap, and remaining
// fixtures must be skipped, never called passes. Production catches may turn the
// budget error into an unavailable review or a missing-summary fallback.
const bounded = Object.assign(createReport(3), { maxDispatches: 2 });
const boundedBudget = dispatchBudget(2);
await collectScenarios(resumedCases.slice(0, 3), bounded, boundedBudget, async () => {
  boundedBudget.take();
  boundedBudget.take();
  boundedBudget.take();
  return verdict(true);
}, () => {});
assert.equal(boundedBudget.used, 2);
assert.equal(bounded.attempted, 1);
assert.equal(bounded.passed, 0);
assert.equal(bounded.counts.review_unavailable, 1);
assert.equal(evaluationFailed(bounded), true);
assert.match(formatReport(bounded, boundedBudget), /attempted=1 passed=0 failed=1 skipped_before=0 skipped_after=0 unattempted=2 dispatches=2\/2/);

const truncated = Object.assign(createReport(3), { maxDispatches: 1 });
const truncatedBudget = dispatchBudget(1);
await collectScenarios(resumedCases.slice(0, 3), truncated, truncatedBudget, async () => {
  truncatedBudget.take();
  return verdict(true);
}, () => {});
assert.equal(truncated.failed, 0);
assert.equal(truncated.passed, 1);
assert.equal(evaluationFailed(truncated), true, "incomplete coverage must not report success");
const setupFailed = Object.assign(createReport(3), { setupFailed: true });
assert.equal(evaluationFailed(setupFailed), true);
assert.match(formatReport(setupFailed, dispatchBudget(128)), /attempted=0 passed=0 failed=0/);

// Static production imports require the supported installed JITI runtime, even
// for inert entry-point checks. Give children only synthetic HOME/agent paths
// and module resolution settings, never inherited credentials or provider config.
const require = createRequire(import.meta.url);
const host = process.env.PI_GLOBAL ?? dirname(dirname(require.resolve("@earendil-works/pi-coding-agent")));
const modules = dirname(dirname(host));
const jiti = [join(host, "node_modules/.bin/jiti"), join(modules, ".bin/jiti")].find(existsSync);
assert.ok(jiti, "installed Pi JITI is required (set PI_GLOBAL)");
const home = mkdtempSync(join(tmpdir(), "activity-live-permissions-offline-"));
const entry = fileURLToPath(new URL("./live-permissions.mjs", import.meta.url));
try {
  for (const args of [[], ["--help"], ["--invalid"], ["--help", "--invalid"]]) {
    const result = spawnSync(process.execPath, [jiti, entry, ...args], {
      encoding: "utf8", timeout: 60_000,
      env: {
        HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"),
        NODE_PATH: [modules, join(host, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(delimiter),
        NODE_OPTIONS: "--conditions=import",
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, args.length === 0 || args[0] === "--help" && args.length === 1 ? 0 : 1,
      "inert entry must exit through its argument handler");
    if (result.status === 0) {
      assert.match(result.stdout, /^SKIP live permissions:/);
      assert.match(result.stdout, /ACCLASS_PERMISSION_END.*exclusive/);
      assert.match(result.stdout, /complete for that requested range only/);
    } else assert.match(result.stderr, /^Usage:/);
    assert.doesNotMatch(result.stdout + result.stderr, /RESULT|PASS index=|FAIL index=/);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log("live permissions synthetic accounting tests passed");
