// Synthetic observations plus the installed Pi execution pipeline. No provider calls.
import assert from "node:assert/strict";
import { runToolCall } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { ActivityObservations, latencyStats, toolCategory } from "../observations.ts";
import { HEADS } from "../policy.ts";
import { nativeToolInfo } from "./nine-head-fixtures.mjs";

let now = 1000;
const observations = new ActivityObservations({ now: () => now, judgeRequestsObserved: true, summaryRequestsObserved: true });
observations.beginTurn();
const mcp = { sourceInfo: { source: "mcp", path: "synthetic:mcp" } };
const extension = { sourceInfo: { source: "extension", path: "synthetic:extension" } };
const wrapper = { sourceInfo: { source: "builtin", path: "builtin:codemode" } };
const bash = nativeToolInfo("bash"), write = nativeToolInfo("write"), edit = nativeToolInfo("edit"), read = nativeToolInfo("read");
const event = (id, toolName = "bash", input = { command: "printf synthetic" }) => ({ toolCallId: id, toolName, input });
const totals = () => observations.view().totals;
assert.equal(toolCategory("catalog", mcp), "mcp");
assert.equal(toolCategory("catalog", extension), "other");
assert.equal(toolCategory("codemode", wrapper), "wrapper");
assert.equal(toolCategory("codemode", extension), "other");
assert.equal(toolCategory("mcp__fixture__catalog", { sourceInfo: { source: "builtin", path: "builtin:mcp" } }), "mcp", "installed built-in MCP provenance is authoritative");
assert.equal(toolCategory("bash", mcp), "mcp", "provenance wins over a colliding tool name");
for (const [id, name, info] of [["b1", "bash", bash], ["b2", "write", write], ["b3", "catalog", mcp], ["b4", "read", read], ["b5", "subagent", extension], ["b6", "codemode", wrapper]]) {
  const call = event(id, name);
  observations.executionStart(call, info);
  observations.gate(call, "block", { info, prefilter: "review" });
  observations.gate(call, "block", { info });
  observations.executionEnd({ ...call, isError: true });
  observations.toolResult({ ...call, isError: true }, info);
}
assert.deepEqual(totals(), { files: 0, sh: 0, mcp: 0, blocked: 6 }, "all final block categories counted exactly once, never execution");
const reviewAllowed = event("review-allowed");
observations.executionStart(reviewAllowed, bash);
observations.gate(reviewAllowed, "allow", { info: bash, prefilter: "review" });
assert.equal(totals().sh, 0, "admission/start do not prove execution");
assert.equal(totals().blocked, 6);
observations.toolResult({ ...reviewAllowed, isError: true, details: { exitCode: 9 } }, bash);
observations.executionEnd({ ...reviewAllowed, isError: true });
observations.toolResult({ ...reviewAllowed, isError: true }, bash);
assert.equal(totals().sh, 1, "executed shell errors count; hooks do not double-count");
const explicitWrite = event("explicit-write", "edit", { path: "/synthetic/file" });
observations.executionStart(explicitWrite, edit); observations.executionConfirmed(explicitWrite, edit);
observations.executionEnd({ ...explicitWrite, isError: false });
observations.toolResult({ ...explicitWrite, isError: false }, edit);
assert.equal(totals().files, 1, "execute-body evidence plus successful end counts once without a result hook");
const failedWrite = event("failed-write", "edit", { path: "/synthetic/file" });
observations.toolResult({ ...failedWrite, isError: true }, edit);
observations.toolResult({ ...event("write-ok", "write", { path: "/synthetic/file", content: "MUST_NOT_CAPTURE" }), isError: false }, write);
assert.equal(totals().files, 2, "only successful write/edit completion counts");
observations.toolResult({ ...event("custom", "catalog", { password: "MUST_NOT_CAPTURE" }), isError: false }, extension);
observations.toolResult({ ...event("outer", "codemode", { code: "MUST_NOT_CAPTURE" }), isError: false }, wrapper);
for (const id of ["outer/1", "outer/2", "outer/1/1"]) {
  observations.toolResult({ ...event(id, "catalog", { payload: "MUST_NOT_CAPTURE" }), parentToolCallId: "outer", isError: true }, mcp);
}
assert.equal(totals().mcp, 3, "each nested MCP execution counted, not custom tools or wrappers");
assert.ok(!JSON.stringify(observations.snapshot()).includes("MUST_NOT_CAPTURE"));
observations.executionStart(event("late-source", "catalog"));
observations.toolResult({ ...event("late-source", "catalog"), isError: false }, mcp);
assert.equal(totals().mcp, 4, "provenance discovered after execution_start supersedes a name-only guess");
const nameCollision = event("mcp-name-collision", "bash", { command: "MUST_NOT_RETAIN_MCP_COMMAND" });
observations.executionStart(nameCollision); observations.toolResult({ ...nameCollision, isError: false }, mcp);
assert.equal(observations.view().history.at(-1).preview, undefined, "late MCP provenance removes a name-only shell preview");
assert.ok(!JSON.stringify(observations.snapshot()).includes("MUST_NOT_RETAIN_MCP_COMMAND"));
for (const path of ["synthetic-private-basename.txt", "C:\\synthetic-private\\file.txt"]) {
  observations.toolResult({ ...event(`path-${path}`, "write", { path }), isError: false }, write);
  assert.ok(!observations.view().history.at(-1).preview.text.includes("synthetic-private"));
}

// runToolCall uses validation, admission and execute/after hooks from the installed runtime.
const trace = [];
const call = { type: "toolCall", id: "runtime-invalid", name: "bash", arguments: {} };
const tool = { name: "bash", description: "Inert fixture", parameters: Type.Object({ command: Type.String() }), execute: async () => {
  trace.push("execute"); throw new Error("Synthetic backend error");
} };
const run = async (tc, block = false, controller = new AbortController(), abortInGate = false) => {
  const e = { toolCallId: tc.id, toolName: tc.name, input: tc.arguments };
  // The inert runtime tool models native Bash observations, not its implementation.
  const info = nativeToolInfo(tc.name);
  // Both direct and nested host paths emit this before runToolCall / preparation.
  observations.executionStart(e, info); trace.push("start");
  const outcome = await runToolCall(tc, {
    assistantMessage: {}, context: { messages: [], tools: [tool] }, signal: controller.signal,
    beforeToolCall: () => {
      trace.push("gate"); observations.gate(e, block ? "block" : "allow", { info });
      if (abortInGate) controller.abort();
      return block ? { block: true, reason: "Synthetic policy" } : undefined;
    },
    afterToolCall: (result) => { trace.push("result"); observations.toolResult({ ...e, isError: result.isError }, info); },
  });
  observations.executionEnd({ ...e, isError: outcome.isError });
  return outcome;
};
const beforeRuntime = totals().sh;
assert.equal((await run(call)).isError, true);
assert.deepEqual(trace.splice(0), ["start"], "validation rejects before tool_call, no afterToolCall");
assert.equal(totals().sh, beforeRuntime);
assert.equal((await run({ ...call, id: "runtime-block", arguments: { command: "inert" } }, true)).isError, true);
assert.deepEqual(trace.splice(0), ["start", "gate"]);
assert.equal(totals().sh, beforeRuntime);
await run({ ...call, id: "runtime-cancel", arguments: { command: "inert" } }, false, new AbortController(), true);
assert.deepEqual(trace.splice(0), ["start", "gate"], "abort after admission never reaches execute or result");
assert.equal(totals().sh, beforeRuntime);
await run({ ...call, id: "runtime-exec", arguments: { command: "inert" } });
assert.deepEqual(trace.splice(0), ["start", "gate", "execute", "result"]);
assert.equal(totals().sh, beforeRuntime + 1, "actual thrown backend error has tool_result execution evidence");
assert.equal(observations.view().history.find((c) => c.id === "runtime-invalid").status, "unknown");

observations.userBashSubmitted("user1", "inert");
assert.equal(totals().sh, beforeRuntime + 1);
observations.userBashResult("user1", { role: "bashExecution", command: "inert", exitCode: 0, output: "DO_NOT_CAPTURE" });
assert.equal(totals().sh, beforeRuntime + 1, "a result may be extension-supplied, not local execution evidence");
observations.userBashSubmitted("user2", "inert");
observations.userBashResult("user2", { role: "userBashResult", command: "inert", exitCode: 2 }, true);
assert.equal(totals().sh, beforeRuntime + 2);
observations.userBashResult("user2", { role: "userBashResult", exitCode: 2 }, true);
assert.equal(totals().sh, beforeRuntime + 2);

const probs = Object.fromEntries(HEADS.map((h, i) => [h, i % 2 ? 0.2 : 0.8]));
const preds = Object.fromEntries(HEADS.map((h, i) => [h, i % 2 === 0]));
observations.evaluation("eval", { inputType: "shell", status: "success", probs, preds, appliedHeads: HEADS, wallMs: 12 });
observations.evaluation("eval", { inputType: "shell", status: "success", probs, preds, appliedHeads: HEADS });
observations.evaluation("eval-file", { inputType: "file", status: "success", probs, preds, appliedHeads: ["exposes_secrets"] });
observations.evaluation("eval-action", { inputType: "action", status: "failure", wallMs: 3 });
observations.evaluation("eval-disabled", { inputType: "shell", status: "disabled" });
const telemetry = observations.view().telemetry;
assert.equal(telemetry.classifier.byInput.shell.success, 1);
assert.equal(telemetry.classifier.byInput.action.failure, 1);
assert.equal(telemetry.classifier.byInput.shell.disabled, 1);
for (const head of HEADS) {
  const h = telemetry.classifier.heads[head];
  assert.equal(h.samples, 2); assert.equal(h.supportSum, 1.6);
  assert.equal(h.applied, head === "exposes_secrets" ? 2 : 1);
}
observations.judgeStarted("judge", now + 15000);
observations.judgeStarted("judge", now + 15000);
observations.judgeRequest("judge"); observations.judgeRetry("judge", now + 20000);
observations.judgeRequest("judge", true);
now += 500;
observations.judgeFinished("judge", "deny"); observations.judgeFinished("judge", "deny");
observations.summaryRequest();
for (const status of ["generated", "cached", "shared", "restored", "failed", "unused"]) observations.summary(status, 1);
observations.approval("allow", false); observations.approval("allow", true); observations.approval("block", true);
const t = observations.view().telemetry;
assert.equal(t.judge.started, 1); assert.equal(t.judge.requests, 2); assert.equal(t.judge.retries, 1);
assert.equal(t.judge.fallbacks, 1); assert.equal(t.judge.outcomes.deny, 1); assert.equal(t.judge.wallMs, 500);
assert.equal(t.summaries.requests, 1); assert.equal(t.summaries.cached, 1); assert.equal(t.summaries.shared, 1);
assert.equal(t.approvals.choices.allow, 2); assert.equal(t.approvals.effectiveOverrides, 1);
const scope = observations.scope();
observations.executionStart(event("pending"), bash); observations.judgeStarted("unfinished");
observations.endTurn();
observations.toolResult({ ...event("late"), isError: false }, bash, scope);
assert.equal(observations.view().history.find((c) => c.id === "pending").status, "interrupted");
assert.ok(!observations.view().history.some((c) => c.id === "late"));
assert.equal(observations.view().telemetry.judge.outcomes.interrupted, 1);
const all = observations.view().totals;
observations.beginTurn();
assert.deepEqual(observations.view().selected.counts, { files: 0, sh: 0, mcp: 0, blocked: 0 });
assert.deepEqual(observations.view().totals, all);
// Latency samples are bounded independently of lifetime counts and sums.
const measured = new ActivityObservations({ now: () => now }); measured.beginTurn();
for (let n = 1; n <= 40; n++) {
  measured.evaluation(`latency-${n}`, { inputType: "shell", status: "success", inferenceMs: n, wallMs: n * 2 });
  measured.judgeStarted(`review-${n}`); measured.judgeFinished(`review-${n}`, "allow", n * 3);
  measured.gate(event(`gate-${n}`), "allow", { info: bash, gateMs: n * 4, route: "local-allow" });
}
const mt = measured.view().telemetry;
assert.deepEqual(latencyStats(mt.classifier.inference), { count: 40, sampleCount: 32, meanMs: 20.5, medianMs: 24.5, p95Ms: 39 });
assert.deepEqual(latencyStats(mt.classifier.endToEnd), { count: 40, sampleCount: 32, meanMs: 41, medianMs: 49, p95Ms: 78 });
assert.deepEqual(latencyStats(mt.judge.latency), { count: 40, sampleCount: 32, meanMs: 61.5, medianMs: 73.5, p95Ms: 117 });
assert.deepEqual(latencyStats(mt.gate), { count: 40, sampleCount: 32, meanMs: 82, medianMs: 98, p95Ms: 156 });
assert.deepEqual(latencyStats(), { count: 0, sampleCount: 0 });
measured.evaluation("invalid-ms", { inputType: "file", status: "failure", inferenceMs: NaN, wallMs: -1 });
measured.summary("generated"); measured.summary("cached", 3); measured.summary("failed", 9);
assert.equal(measured.view().telemetry.classifier.inference.count, 40);
assert.equal(measured.view().telemetry.summaries.latency.count, 1, "no invented zero measurements or cache generation latencies");
measured.judgeStarted("interrupted-latency"); measured.endTurn();
assert.equal(measured.view().telemetry.judge.latency.count, 40, "partial reviews do not become completed latency samples");

// Positive-label probability means are not means of negative-label predictions.
const heads = new ActivityObservations();
for (let n = 0; n < 4; n++) heads.evaluation(`head-${n}`, {
  inputType: "action", status: "success",
  probs: Object.fromEntries(HEADS.map((h) => [h, [0.8, 0.4, 0.6, 0.2][n]])),
  preds: Object.fromEntries(HEADS.map((h) => [h, n % 2 === 0])),
  appliedHeads: n < 2 ? HEADS : [],
});
for (const h of Object.values(heads.view().telemetry.classifier.heads)) {
  assert.equal(h.samples, 4); assert.equal(h.positive, 2);
  assert.ok(Math.abs(h.probabilitySum - 1.4) < 1e-9);
  assert.ok(Math.abs(h.positiveProbabilitySum / h.positiveProbabilitySamples - 0.7) < 1e-9);
  assert.equal(h.applied, 2); assert.equal(h.appliedPositive, 1);
  assert.equal(h.appliedPositiveProbabilitySum, 0.8);
  assert.ok(Math.abs(h.appliedSupportSum - 1.4) < 1e-9);
}

// Gate time and submission time cannot be called execution duration.
const durations = new ActivityObservations({ now: () => now }); durations.beginTurn();
const unknownDuration = event("unknown-duration"); now = 1000;
durations.executionStart(unknownDuration, bash); now = 1200;
durations.gate(unknownDuration, "allow", { info: bash, route: "judge-allow", gateMs: 200, reviewMs: 150 }); now = 1300;
durations.toolResult({ ...unknownDuration, isError: false }, bash);
let receipt = durations.view().history.at(-1);
assert.equal(receipt.durationMs, undefined); assert.equal(receipt.submissionDurationMs, 300);
assert.equal(receipt.gateMs, 200); assert.equal(receipt.reviewMs, 150); assert.equal(receipt.route, "judge-allow");
const knownDuration = event("known-duration"); durations.executionStart(knownDuration, bash); now = 1400;
durations.gate(knownDuration, "allow", { info: bash, route: "user-override" }); now = 1500;
durations.executionConfirmed(knownDuration, bash); now = 1570;
durations.toolResult({ ...knownDuration, isError: false }, bash);
receipt = durations.view().history.at(-1);
assert.equal(receipt.durationMs, 70); assert.equal(receipt.submissionDurationMs, 270);
durations.toolResult({ ...event("host-duration"), isError: false }, bash, durations.scope(), { durationMs: 45 });
assert.equal(durations.view().history.at(-1).durationMs, 45);
durations.executionStart(event("validation-duration"), bash); now += 10;
durations.executionEnd({ ...event("validation-duration"), isError: true });
assert.equal(durations.view().history.at(-1).durationMs, undefined);
assert.equal(durations.view().history.at(-1).executionConfirmed, false);
assert.equal(durations.view().telemetry.activity.errors, 1, "reported validation error is not execution evidence");

// Pi supplies execute duration on the end hook, after the result hook has completed the call.
const lateDurations = new ActivityObservations({ now: () => now }); lateDurations.beginTurn();
for (const [id, isError, durationMs] of [["host-end-ok", false, 45], ["host-end-error", true, 12], ["host-end-zero", false, 0]]) {
  const call = event(id);
  lateDurations.executionStart(call, bash); now += 200;
  lateDurations.toolResult({ ...call, isError }, bash);
  const before = lateDurations.view();
  lateDurations.executionEnd({ ...call, isError }, lateDurations.scope(), { durationMs });
  const after = lateDurations.view(), receipt = after.history.at(-1);
  assert.equal(receipt.durationMs, durationMs);
  assert.equal(receipt.submissionDurationMs, 200, "late timing does not extend submission-to-result time");
  assert.equal(receipt.status, isError ? "error" : "ok");
  assert.deepEqual(after.totals, before.totals);
  assert.deepEqual(after.telemetry, before.telemetry, "timing enrichment does not count errors or execution twice");
  lateDurations.executionEnd({ ...call, isError }, lateDurations.scope(), { durationMs });
  assert.deepEqual(lateDurations.view(), after, "duplicate end receipts are idempotent");
}
for (const durationMs of [undefined, NaN, Infinity, -1]) {
  const call = event(`invalid-end-${String(durationMs)}`);
  lateDurations.toolResult({ ...call, isError: false }, bash);
  lateDurations.executionEnd({ ...call, isError: false }, lateDurations.scope(), { durationMs });
  assert.equal(lateDurations.view().history.at(-1).durationMs, undefined, "absent/invalid timing stays unknown");
}
const blockedDuration = event("blocked-end-duration");
lateDurations.gate(blockedDuration, "block", { info: bash });
lateDurations.executionEnd({ ...blockedDuration, isError: true }, lateDurations.scope(), { durationMs: 30 });
assert.equal(lateDurations.view().history.at(-1).durationMs, undefined);
const validationDuration = event("validation-end-duration");
lateDurations.executionStart(validationDuration, bash);
lateDurations.executionEnd({ ...validationDuration, isError: true }, lateDurations.scope(), { durationMs: 30 });
assert.equal(lateDurations.view().history.at(-1).durationMs, undefined, "duration alone does not establish execution");
const staleScope = lateDurations.scope();
lateDurations.beginTurn();
const reusedDuration = event("host-end-ok");
lateDurations.toolResult({ ...reusedDuration, isError: false }, bash);
lateDurations.executionEnd({ ...reusedDuration, isError: false }, staleScope, { durationMs: 999 });
assert.equal(lateDurations.view().history.at(-1).durationMs, undefined, "stale scope cannot enrich a reused call ID");
lateDurations.executionEnd({ ...reusedDuration, isError: false }, lateDurations.scope(), { durationMs: 7 });
assert.equal(lateDurations.view().history.at(-1).durationMs, 7);
const restoredDurations = new ActivityObservations();
restoredDurations.restore([{ type: "custom", customType: "activity-observations", data: lateDurations.snapshot() }]);
assert.equal(restoredDurations.view().history.at(-1).durationMs, 7, "host duration survives snapshot restore");
const restoredBefore = restoredDurations.view();
restoredDurations.executionEnd({ ...reusedDuration, isError: false }, restoredDurations.scope(), { durationMs: 999 });
assert.deepEqual(restoredDurations.view(), restoredBefore, "restore cannot accept an old invocation's timing");
const evictedDurations = new ActivityObservations({ maxHistory: 0 }); evictedDurations.beginTurn();
evictedDurations.toolResult({ ...event("evicted-duration"), isError: false }, bash);
const evictedBefore = evictedDurations.view();
evictedDurations.executionEnd({ ...event("evicted-duration"), isError: false }, evictedDurations.scope(), { durationMs: 5 });
assert.deepEqual(evictedDurations.view(), evictedBefore, "late timing cannot recreate evicted history");

// Final blocks and reported errors survive eviction for all tool categories.
const retained = new ActivityObservations({ maxHistory: 1 }); retained.beginTurn();
const categories = [["bash", bash, "sh"], ["write", write, "files"], ["catalog", mcp, "mcp"], ["read", read, "other"], ["codemode", wrapper, "wrapper"]];
for (const [tool, info, category] of categories) {
  const blocked = event(`retained-block-${category}`, tool);
  retained.gate(blocked, "block", { info, reason: "judge-deny" });
  retained.toolResult({ ...event(`retained-error-${category}`, tool), isError: true }, info);
  retained.gate(blocked, "block", { info, reason: "judge-deny" });
  retained.toolResult({ ...blocked, isError: true }, info);
}
const rt = retained.view().telemetry.activity;
assert.equal(retained.view().totals.blocked, 5); assert.equal(rt.errors, 5);
assert.deepEqual(rt.blocksByCategory, { files: 1, sh: 1, mcp: 1, other: 1, wrapper: 1 });
assert.deepEqual(rt.errorsByCategory, rt.blocksByCategory); assert.equal(rt.blocksByReason["judge-deny"], 5);
assert.equal(retained.view().history.length, 1);
retained.gate(event("unsafe-reason"), "block", { info: bash, reason: "SYNTHETIC_BUSINESS_LABEL" });
assert.equal(retained.view().telemetry.activity.blocksByReason.unknown, 1);
assert.ok(!JSON.stringify(retained.snapshot()).includes("SYNTHETIC_BUSINESS_LABEL"));

// Models and requests record only real invocation receipts. Prompts are separate.
const models = new ActivityObservations({ judgeModel: "fixture/judge", summaryModel: "fixture/summary" });
models.judgeStarted("models"); models.judgeRetry("models");
assert.equal(models.view().telemetry.judge.requests, 0);
models.judgeRequest("models", false, models.scope(), { model: "fixture/actual-judge" });
models.judgeRequest("models", true, models.scope(), { model: "fixture/fallback-judge" });
models.summaryRequest(models.scope(), { model: "fixture/actual-summary" });
models.approvalPrompt(); models.approvalPrompt(); models.approval("allow", true, models.scope(), { wallMs: 12 });
models.summary("restored");
const mod = models.view().telemetry;
assert.equal(mod.judge.requestsKnown, false); assert.equal(mod.judge.requests, 2);
assert.equal(mod.judge.models.configured, "fixture/judge");
assert.deepEqual(mod.judge.models.actual, { "fixture/actual-judge": 1, "fixture/fallback-judge": 1 });
assert.equal(mod.summaries.models.configured, "fixture/summary");
assert.deepEqual(mod.summaries.models.actual, { "fixture/actual-summary": 1 });
assert.equal(mod.approvals.prompts, 2); assert.equal(mod.approvals.choices.allow, 1); assert.equal(mod.approvals.effectiveOverrides, 1);
assert.equal(mod.approvals.latency.count, 1); assert.equal(mod.summaries.restored, 1);
models.setModels({ judge: "fixture/new-judge" });
assert.equal(models.view().telemetry.judge.models.configured, "fixture/new-judge");
models.executionStart(event("signals", "catalog"), { sourceInfo: { source: "mcp", server: "fixture-server", path: "MUST_NOT_RETAIN_SOURCE_PATH" }, namespace: { name: "mcp__fixture_server" } });
models.evaluation("signals-evaluation", { toolCallId: "signals", inputType: "action", status: "success", probs, preds, appliedHeads: [HEADS[0]] });
models.gate(event("signals", "catalog"), "allow", { route: "judge-allow" });
const signalCall = models.view().history.at(-1);
assert.equal(signalCall.source, "mcp"); assert.equal(signalCall.server, "fixture-server"); assert.equal(signalCall.namespace, "mcp__fixture_server");
assert.deepEqual(signalCall.signals, { probs, preds, appliedHeads: [HEADS[0]] });
assert.ok(!JSON.stringify(models.snapshot()).includes("MUST_NOT_RETAIN_SOURCE_PATH"));
const modelBounds = new ActivityObservations(); modelBounds.judgeStarted("bounded-models");
for (let n = 0; n < 12; n++) modelBounds.judgeRequest("bounded-models", false, modelBounds.scope(), { model: `fixture/model-${n}` });
assert.equal(modelBounds.view().telemetry.judge.requests, 12); assert.equal(Object.keys(modelBounds.view().telemetry.judge.models.actual).length, 8);
assert.equal(modelBounds.view().telemetry.judge.models.omitted, 4);
console.log("observations tests passed: execution evidence, persistent errors/blocks, independent heads, bounded latency, model receipts and prompts");
