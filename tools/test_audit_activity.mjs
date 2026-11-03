import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { aggregate, createAudit } from "./audit_activity.mjs";

const probs = { read_only: 0.9, outbound: 0.1, egress: 0.1, remote_mutation: 0.1, accesses_secrets: 0.3, destructive: 0.1 };
const preds = { read_only: true, outbound: false, egress: false, remote_mutation: false, accesses_secrets: true, destructive: false };
const base = { session: "private-session", tool: "read", modes: { auto: true, readOnly: false, remoteReadOnly: false },
  prefilter: { verdict: "block", reason: "base:accesses_secrets", wallMs: 5, inferenceMs: 2 },
  classifier: { probs, preds, identity: { configuredModel: "/private/model/path", configuredQuant: "q8", daemonIdentityVerified: false }, appliedHeads: ["accesses_secrets"] },
  wallMs: 25, cmd: "DO_NOT_PRINT_PRIVATE_COMMAND", input: { text: "DO_NOT_PRINT_INPUT" } };
const records = [
  { ...base, callId: "secret-id-1", judge: { outcome: "allow", wallMs: 10, costTotalUsd: 0.01, reason: "DO_NOT_PRINT_JUDGE_REASON" },
    summary: { status: "generated", attempted: true, wallMs: 5, costTotalUsd: 0.001 }, final: { verdict: "allow", decision: "judge-allow" } },
  { ...base, callId: "secret-id-2", judge: { outcome: "deny", wallMs: 20 }, summary: { status: "shared", costTotalUsd: 0.001 },
    prompt: { outcome: "allow" }, final: { verdict: "allow", decision: "user-allow" } },
  { ...base, callId: "secret-id-3", judge: { outcome: "unavailable", wallMs: 30 }, summary: { status: "failed", attempted: true },
    final: { verdict: "block", decision: "judge-block" } },
  { tool: "write", prefilter: { verdict: "allow", reason: "base:mutation-in-cwd" }, final: { verdict: "allow" } },
  { ...base, callId: "secret-id-4", classifier: { probs: { ...probs, read_only: -1 }, preds }, final: { verdict: "block" } },
];
const report = aggregate([...records, records[0], null]);
assert.equal(report.records, 5);
assert.equal(report.duplicates, 1);
assert.equal(report.malformed, 1);
assert.equal(report.classifierRecords, 3);
assert.equal(report.invalidClassifierRecords, 1);
assert.equal(report.totals.compared, 2);
assert.equal(report.totals.disagreements, 1);
assert.equal(report.totals.disagreementRate, 0.5);
assert.equal(report.totals.overrides.allow, 1);
assert.equal(report.costs.judge.totalKnownUsd, 0.01);
assert.equal(report.costs.judge.unknownCalls, 2);
assert.equal(report.costs.summary.totalKnownUsd, 0.001, "shared summary not charged twice");
assert.equal(report.costs.summary.unknownCalls, 1);
const legacy = report.classifierSchemas["six-head"];
assert.equal(legacy.records, 3);
assert.equal(legacy.heads.accesses_secrets.selectedLabelSupport.mean, 0.3);
assert.equal(legacy.heads.outbound.selectedLabelSupport.mean, 0.9);
assert.equal(legacy.heads.accesses_secrets.true, 3);
assert.equal(legacy.heads.outbound.false, 3);
assert.ok(Math.abs(legacy.supportSpread.mean - 0.6) < 1e-10);
assert.equal(report.classifierSchemas["nine-head"].records, 0);
assert.equal(report.classifierSchemas["nine-head"].heads.exposes_secrets.score.mean, null);
assert.equal(report.latencyMs.judge.mean, 20);
assert.match(report.note, /not calibrated correctness confidence/);
assert.match(report.note, /selected subset/);
assert.doesNotMatch(JSON.stringify(report), /DO_NOT_PRINT|secret-id|private-session|\/private\/model\/path/);
assert.equal(aggregate([]).latencyMs.judge.mean, null);
assert.equal(aggregate([{ ...base, judge: { outcome: "allow", costTotalUsd: 0 } }]).costs.judge.knownCalls, 1);
assert.equal(aggregate([{ ...base, summary: { status: "failed", attempted: false } }]).costs.summary.unknownCalls, 0);
// Match current runtime telemetry, including raw negatives with no eligible heads.
const currentProbs = { local_state_change: 0.2, outbound: 0.2, egress: 0.2, remote_state_change: 0.2,
  delegated_execution: 0.2, exposes_secrets: 0.2, destructive: 0.2, host_control_change: 0.4, fetched_or_generated_execution: 0.2 };
const currentPreds = Object.fromEntries(Object.keys(currentProbs).map((head) => [head, false]));
const actionEvidence = { representation: "runtime-action-evidence-json/1", classification: "complete",
  eligibility: "positive-risk-signals-only", backendBehavior: "unverified", effectCoverage: "incomplete" };
const current = { ...base, tool: "mcp_lookup", callId: "current-call", input: { token: "DO_NOT_PRINT_MCP_CREDENTIAL" },
  prefilter: { source: "action", verdict: "block", reason: "auto:action-review", wallMs: 5, inferenceMs: 2 },
  classifier: { probs: currentProbs, preds: currentPreds, appliedHeads: [], actionEvidence, identity: base.classifier.identity },
  actionEvidence, judge: { outcome: "allow", wallMs: 10, costTotalUsd: 0 }, final: { verdict: "allow" } };
const positive = { ...current, callId: "current-positive", classifier: { ...current.classifier,
  preds: { ...currentPreds, exposes_secrets: true }, appliedHeads: ["exposes_secrets"] } };
const mixed = aggregate([...records, current, positive, current]);
assert.equal(mixed.records, 7);
assert.equal(mixed.duplicates, 1);
assert.equal(mixed.classifierRecords, 5);
assert.equal(mixed.invalidClassifierRecords, 1);
assert.deepEqual(mixed.classifierSchemas["six-head"], legacy, "current records cannot change historical statistics or identities");
const nine = mixed.classifierSchemas["nine-head"];
assert.equal(nine.records, 2);
assert.deepEqual(Object.keys(nine.heads), Object.keys(currentProbs));
assert.equal(nine.heads.exposes_secrets.true, 1);
assert.equal(nine.heads.exposes_secrets.false, 1);
assert.equal(nine.heads.exposes_secrets.score.mean, 0.2);
assert.equal(nine.heads.exposes_secrets.selectedLabelSupport.mean, 0.5);
assert.ok(Math.abs(nine.supportSpread.mean - 0.4) < 1e-10);
assert.equal(Object.values(nine.minimumSupportBins).reduce((sum, bin) => sum + bin.count, 0), 2);
assert.equal(nine.identities.length, 1);
assert.equal(nine.identities[0].count, 2);
assert.equal(legacy.identities[0].count, 3);
assert.equal(nine.identities[0].appliedHeads[""], 1, "all-negative MCP has no eligible positive heads");
assert.equal(nine.identities[0].appliedHeads.exposes_secrets, 1);
assert.match(mixed.note, /not automatically a classifier error/);
assert.doesNotMatch(JSON.stringify(mixed), /DO_NOT_PRINT|secret-id|current-call|private-session|\/private\/model\/path/);
assert.equal(aggregate([current]).totals.disagreements, 1, "route disagreement is not an accuracy label");

const guardRecords = ["readOnly", "remoteReadOnly"].flatMap((guard) => ["allow", "deny", "unavailable"].map((outcome) => ({
  ...current, callId: `synthetic-guard-${guard}-${outcome}`,
  classifier: { ...current.classifier, preds: { ...currentPreds, remote_state_change: true }, appliedHeads: ["remote_state_change"] },
  modes: { auto: true, readOnly: guard === "readOnly", remoteReadOnly: guard === "remoteReadOnly" },
  prefilter: { ...current.prefilter, reason: guard === "readOnly" ? "read-only" : "remote-read-only" },
  judge: { outcome, wallMs: 1, costTotalUsd: 0 },
  final: { verdict: outcome === "allow" ? "allow" : "block", decision: outcome === "allow" ? "judge-allow" : "judge-block" },
})));
const guarded = aggregate([...guardRecords, { tool: "write", modes: { auto: true, readOnly: true, remoteReadOnly: false },
  prefilter: { verdict: "block", reason: "read-only" }, final: { verdict: "block", decision: "hard-block" } }]);
assert.equal(guarded.records, 7);
assert.equal(guarded.totals.judge.allow, 2);
assert.equal(guarded.totals.judge.deny, 2);
assert.equal(guarded.totals.judge.unavailable, 2);
assert.equal(guarded.totals.judge["not-reviewed"], 1, "only deterministic native mutation bypasses review");
assert.equal(guarded.totals.final.allow, 2, "guard review can permit the exact action");
assert.equal(guarded.totals.final.block, 5, "denial, unavailability and native hard block remain final");
assert.equal(Object.keys(guarded.totals.overrides).length, 0, "guard outcomes contain no human override");

const { exposes_secrets: omittedProbability, ...missingProbs } = currentProbs;
const { exposes_secrets: omittedPrediction, ...missingPreds } = currentPreds;
const invalidClassifiers = [
  {}, false, "unknown",
  { probs: missingProbs, preds: currentPreds },
  { probs: currentProbs, preds: missingPreds },
  { probs: currentProbs, preds },
  { probs, preds: currentPreds },
  { probs: { ...probs, ...currentProbs }, preds: { ...preds, ...currentPreds } },
  { probs: { ...currentProbs, extra_head: 0 }, preds: currentPreds },
  { probs: currentProbs, preds: { ...currentPreds, extra_head: false } },
  { probs: Object.values(currentProbs), preds: currentPreds },
  { probs: currentProbs, preds: Object.values(currentPreds) },
  { probs: null, preds: currentPreds },
  { probs: currentProbs, preds: null },
  ...[-0.01, 1.01, NaN, Infinity, "0.2", null].map((value) => ({ probs: { ...currentProbs, exposes_secrets: value }, preds: currentPreds })),
  ...[0, 1, "false", null].map((value) => ({ probs: currentProbs, preds: { ...currentPreds, exposes_secrets: value } })),
];
const invalid = aggregate(invalidClassifiers.map((classifier, index) => ({ ...current, callId: `invalid-${index}`, classifier })));
assert.equal(invalid.records, invalidClassifiers.length);
assert.equal(invalid.invalidClassifierRecords, invalidClassifiers.length);
assert.equal(invalid.classifierRecords, 0);
assert.equal(invalid.latencyMs.action.count, invalidClassifiers.length, "invalid vectors still contribute operational statistics");
assert.equal(invalid.costs.judge.knownCalls, invalidClassifiers.length);
assert.equal(invalid.totals.disagreements, invalidClassifiers.length);
for (const bucket of Object.values(invalid.classifierSchemas)) {
  assert.equal(bucket.records, 0);
  assert.equal(bucket.supportSpread.count, 0);
  assert.deepEqual(bucket.minimumSupportBins, {});
  assert.deepEqual(bucket.identities, []);
  for (const head of Object.values(bucket.heads)) {
    assert.equal(head.true, 0);
    assert.equal(head.false, 0, "missing/malformed predictions must not become negatives");
    assert.equal(head.score.count, 0);
  }
}
assert.equal(aggregate([{ classifier: null }, {}]).invalidClassifierRecords, 0);
const bounds = aggregate([{ classifier: { probs: Object.fromEntries(Object.keys(currentProbs).map((head) => [head, 1])),
  preds: Object.fromEntries(Object.keys(currentPreds).map((head) => [head, true])) } }]);
assert.equal(bounds.classifierSchemas["nine-head"].minimumSupportBins["0.8–1.0 inclusive"].count, 1);
assert.equal(aggregate([{ classifier: { probs: Object.fromEntries(Object.keys(currentProbs).map((head) => [head, 0])),
  preds: currentPreds } }]).classifierRecords, 1);
const incremental = createAudit();
incremental.add(current);
const snapshot = incremental.result();
incremental.add(records[0]);
assert.equal(snapshot.classifierSchemas["six-head"].records, 0);
assert.deepEqual(incremental.result(), aggregate([current, records[0]]));

const privateLabels = aggregate([{ ...current, tool: "DO_NOT_PRINT_BUSINESS_TOOL",
  prefilter: { verdict: "DO_NOT_PRINT_VERDICT", reason: "DO_NOT_PRINT_BUSINESS_REASON" },
  judge: { outcome: "DO_NOT_PRINT_JUDGE" }, final: { verdict: "DO_NOT_PRINT_FINAL" },
  prompt: { outcome: "DO_NOT_PRINT_OVERRIDE" }, summary: { status: "DO_NOT_PRINT_SUMMARY" },
  classifier: { ...current.classifier, appliedHeads: ["DO_NOT_PRINT_HEAD"],
    identity: { configuredQuant: "DO_NOT_PRINT_QUANT", configuredDevice: "DO_NOT_PRINT_DEVICE", configuredThresholds: { outbound: "DO_NOT_PRINT_THRESHOLD" } } } }]);
assert.doesNotMatch(JSON.stringify(privateLabels), /DO_NOT_PRINT/);
assert.equal(privateLabels.tools["mcp/custom"], 1);
assert.equal(privateLabels.groups[0].tool, "mcp/custom");
assert.equal(privateLabels.groups[0].reason, "unknown");
assert.equal(privateLabels.totals.judge.unknown, 1);
assert.equal(privateLabels.totals.final.unknown, 1);
assert.equal(privateLabels.totals.overrides.unknown, 1);
assert.equal(privateLabels.summaries.unknown, 1);
assert.equal(privateLabels.classifierSchemas["nine-head"].identities[0].configuredQuant, null);
assert.equal(privateLabels.classifierSchemas["nine-head"].identities[0].configuredDevice, null);
assert.equal(privateLabels.classifierSchemas["nine-head"].identities[0].configuredThresholds, null);
assert.equal(privateLabels.classifierSchemas["nine-head"].identities[0].appliedHeads.unknown, 1);
const thresholds = aggregate([{ ...current, classifier: { ...current.classifier,
  identity: { configuredQuant: "f32", configuredThresholds: currentProbs } } }]);
assert.deepEqual(thresholds.classifierSchemas["nine-head"].identities[0].configuredThresholds, currentProbs);
assert.equal(thresholds.classifierSchemas["nine-head"].identities[0].configuredQuant, "f32");
assert.equal(thresholds.classifierSchemas["nine-head"].identities[0].configuredDevice, null);
const deviceReport = aggregate([undefined, "auto", "cpu", "cuda", "metal"].map((configuredDevice, index) => ({
  ...current, callId: `device-${index}`, classifier: { ...current.classifier,
    identity: { ...current.classifier.identity, configuredDevice, daemonIdentityVerified: true } },
})));
assert.deepEqual(deviceReport.classifierSchemas["nine-head"].identities.map(identity => identity.configuredDevice),
  [null, "auto", "cpu", "cuda", "metal"]);
assert.ok(deviceReport.classifierSchemas["nine-head"].identities.every(identity => identity.daemonIdentityVerified));
assert.match(deviceReport.note, /daemonIdentityVerified does not verify the device/);

const dir = mkdtempSync(join(tmpdir(), "activity-audit-test-"));
try {
  const file = join(dir, "reviews.jsonl");
  writeFileSync(file, [...records, current].map((record) => JSON.stringify(record)).join("\n") + "\nmalformed\n\n");
  const rotated = join(dir, "reviews.1.jsonl");
  writeFileSync(rotated, [current, positive].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const output = execFileSync(process.execPath, ["tools/audit_activity.mjs", file, file, rotated], { encoding: "utf8" });
  const cli = JSON.parse(output);
  assert.equal(cli.records, 7, "duplicate file arguments must not duplicate records");
  assert.equal(cli.duplicates, 1, "overlapping rotated logs must deduplicate by session/call");
  assert.equal(cli.malformed, 1);
  assert.equal(cli.classifierRecords, 5);
  assert.equal(cli.invalidClassifierRecords, 1);
  assert.deepEqual(cli.classifierSchemas, JSON.parse(JSON.stringify(mixed.classifierSchemas)));
  assert.doesNotMatch(output, /DO_NOT_PRINT|secret-id|current-call|private-session|\/private\/model\/path/);
  const privateDirectory = join(dir, ".local/share/pi-activity/private");
  mkdirSync(privateDirectory, { recursive: true });
  writeFileSync(join(privateDirectory, "reviews.7.jsonl"), records.map(JSON.stringify).join("\n") + "\n");
  writeFileSync(join(privateDirectory, "reviews.2.jsonl"), [current, positive].map(JSON.stringify).join("\n") + "\n");
  writeFileSync(join(privateDirectory, "reviews.jsonl"), JSON.stringify(current) + "\n");
  writeFileSync(join(privateDirectory, "reviews.invalid.jsonl"), "must not be read\n");
  const defaultReport = JSON.parse(execFileSync(process.execPath, ["tools/audit_activity.mjs"], {
    encoding: "utf8", env: { ...process.env, HOME: dir },
  }));
  assert.equal(defaultReport.records, 7);
  assert.equal(defaultReport.duplicates, 1);
  assert.equal(defaultReport.malformed, 0);
  assert.deepEqual(defaultReport.classifierSchemas, JSON.parse(JSON.stringify(mixed.classifierSchemas)));
  const legacyDirectory = join(dir, ".pi/agent/state/activity");
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(join(legacyDirectory, "reviews.jsonl"), JSON.stringify(records[0]) + "\n");
  const withLegacy = JSON.parse(execFileSync(process.execPath, ["tools/audit_activity.mjs"], {
    encoding: "utf8", env: { ...process.env, HOME: dir },
  }));
  assert.equal(withLegacy.records, 7);
  assert.equal(withLegacy.duplicates, 1, "default discovery must not read another package's legacy log directory");
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("aggregate-only activity audit tests passed");
