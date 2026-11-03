// Pure policy tests use explicit operation facts, never inferred legacy labels.
import assert from "node:assert/strict";
import { actionDecision, positiveRiskSignals, baseDecision, decide, filePrimitives, hardGuardDecision, HEADS } from "../policy.ts";
import { facts, NINE_HEADS } from "./nine-head-fixtures.mjs";

assert.deepEqual(HEADS, NINE_HEADS);
const opts = { cwd: "/fictional-project", home: "/fictional-home", readAllowlist: ["/fictional-home/allowed"] };
const noGuards = { readOnly: false, remoteReadOnly: false };
const report = (scope = ["cwd"], outside = []) => ({ scope, paths: { inside: [], outside } });
let checked = 0;
function check(label, values, scope, reason, verdict = "block") {
  const result = baseDecision(facts(values), report(scope), opts);
  assert.deepEqual(result, { verdict, reason, guard: "auto" }, label);
  checked++;
}

check("ordinary local read", {}, ["none"], "base:local-read", "allow");
check("download without a local write", { outbound: true }, ["none"], "base:outbound", "allow");
check("fetch into project", { outbound: true, local_state_change: true }, ["cwd"], "base:mutation-in-cwd", "allow");
check("edit in temp", { local_state_change: true }, ["tmp"], "base:mutation-in-cwd", "allow");
check("project deletion", { local_state_change: true, destructive: true }, ["cwd"], "base:destructive-in-cwd", "allow");
check("unknown write target", { local_state_change: true }, ["none"], "base:mutation-no-scope");
check("mixed write targets", { local_state_change: true }, ["cwd", "home"], "base:mutation-outside-cwd");
check("unknown delete target", { destructive: true }, ["none"], "base:destructive-no-scope");
check("outside delete target", { destructive: true }, ["system"], "base:destructive-outside-cwd");
check("git push changes remote state", { outbound: true, remote_state_change: true, egress: true }, ["cwd"], "base:remote-review");
check("upload without mutation", { outbound: true, egress: true }, ["cwd"], "base:egress-review");
check("local distinct worker", { delegated_execution: true }, ["cwd"], "base:delegated-execution-review");
check("remote distinct worker", { outbound: true, delegated_execution: true }, ["cwd"], "base:delegated-execution-review");
check("host configuration", { local_state_change: true, host_control_change: true }, ["cwd"], "base:host-control-review");
check("fetched script execution", { outbound: true, fetched_or_generated_execution: true }, ["cwd"], "base:generated-execution-review");
check("generated script execution", { fetched_or_generated_execution: true }, ["tmp"], "base:generated-execution-review");
check("secret exposure does not need networking", { exposes_secrets: true }, ["cwd"], "base:exposes_secrets");
check("all effects retain secret precedence", Object.fromEntries(NINE_HEADS.map((head) => [head, true])), ["cwd"], "base:exposes_secrets");

for (const [values, reason] of [
  [{ host_control_change: true, delegated_execution: true, destructive: true }, "base:host-control-review"],
  [{ delegated_execution: true, fetched_or_generated_execution: true, destructive: true }, "base:delegated-execution-review"],
  [{ fetched_or_generated_execution: true, remote_state_change: true, destructive: true }, "base:generated-execution-review"],
  [{ remote_state_change: true, destructive: true }, "base:remote-review"],
  [{ egress: true, destructive: true }, "base:egress-review"],
]) check("project scope cannot authorize an independent review-worthy effect", values, ["cwd"], reason);

const privateRead = report(["home"], ["/fictional-home/allowed/config.json"]);
assert.equal(baseDecision(facts(), privateRead, opts).verdict, "allow");
assert.equal(baseDecision(facts({ exposes_secrets: true }), privateRead, opts).reason, "base:exposes_secrets");
assert.equal(baseDecision(facts(), report(["home"]), opts).reason, "base:read-unresolved-scope");
assert.equal(baseDecision(facts(), report(["home"], ["/fictional-home/allowed-neighbor/file"]), opts).reason, "base:read-outside-allowlist");

// A complete-looking allowlisted subset cannot authorize omitted or unresolved paths.
const firstTwelve = Array.from({ length: 12 }, (_, i) => `/fictional-home/allowed/${i}`);
for (const [label, incomplete] of [
  ["thirteenth home path omitted after twelve allowlisted paths", report(["home"], firstTwelve)],
  ["thirteenth other path omitted after twelve allowlisted paths", report(["home", "other"], firstTwelve)],
  ["resolved allowlisted home path plus unresolved home suffix", report(["home"], ["/fictional-home/allowed/config.json", "/fictional-home/allowed"])],
  ["resolved allowlisted home path plus unresolved other path", report(["home", "other"], ["/fictional-home/allowed/config.json"])],
  ["resolved allowlisted home path plus unresolved system suffix", report(["home", "system"], ["/fictional-home/allowed/config.json", "/etc"])],
]) {
  // Each subset used to fast-allow. The explicit engine inventory flag vetoes it.
  assert.equal(baseDecision(facts(), incomplete, opts).verdict, "allow", label);
  assert.deepEqual(baseDecision(facts(), { ...incomplete, scopeComplete: false }, opts),
    { verdict: "block", reason: "base:scope-incomplete", guard: "auto" }, label);
  assert.equal(baseDecision(facts(), { ...incomplete, scopeComplete: true }, opts).verdict, "allow", label);
  checked++;
}
for (const values of [{}, { outbound: true }, { local_state_change: true }, { destructive: true }]) {
  assert.equal(baseDecision(facts(values), { ...report(["cwd"]), scopeComplete: false }, opts).reason,
    "base:scope-incomplete", "incomplete inventory prevents every fast-allow route");
  checked++;
}
assert.equal(baseDecision(facts({ exposes_secrets: true }), { ...privateRead, scopeComplete: false }, opts).reason,
  "base:exposes_secrets", "independent review reasons retain their precedence");
assert.equal(decide(facts({ local_state_change: true }), { ...report(), scopeComplete: false },
  { ...opts, guards: { readOnly: true, remoteReadOnly: false } }).reason, "read-only", "hard guards still take precedence");

// Hard guards are explicit fact constraints, not the inverse of a read-only label.
const readOnlyVeto = new Set(["local_state_change", "egress", "remote_state_change", "delegated_execution", "destructive", "host_control_change", "fetched_or_generated_execution"]);
for (const head of NINE_HEADS) {
  const p = facts({ [head]: true });
  const guarded = hardGuardDecision(p, { readOnly: true, remoteReadOnly: false });
  assert.deepEqual(guarded, readOnlyVeto.has(head) ? { verdict: "block", reason: "read-only", guard: "read-only" } : undefined, head);
  const remote = hardGuardDecision(p, { readOnly: false, remoteReadOnly: true });
  assert.deepEqual(remote, head === "remote_state_change" ? { verdict: "block", reason: "remote-read-only", guard: "remote-read-only" } : undefined, head);
  assert.equal(hardGuardDecision(p, noGuards), undefined);
  checked++;
}
const remoteWorker = facts({ outbound: true, delegated_execution: true });
assert.equal(hardGuardDecision(remoteWorker, { readOnly: false, remoteReadOnly: true }).reason, "remote-read-only");
assert.equal(hardGuardDecision(remoteWorker, { readOnly: true, remoteReadOnly: true }).reason, "read-only");
assert.equal(decide(facts({ local_state_change: true }), report(), { ...opts, guards: { readOnly: true, remoteReadOnly: false } }).guard, "read-only");
assert.equal(decide(facts({ delegated_execution: true }), report(), { ...opts, guards: { readOnly: false, remoteReadOnly: true } }).reason, "base:delegated-execution-review",
  "local worker is not a remote hard violation but still requires base review");
assert.equal(decide(facts({ host_control_change: true }), report(), { ...opts, guards: { readOnly: true, remoteReadOnly: false } }).reason, "read-only",
  "host control cannot be overridden even if the mutation prediction is inconsistent");

for (const tool of ["read", "grep", "find", "ls"]) {
  assert.deepEqual(filePrimitives(tool, "/fictional-project/source.ts"), facts(), tool);
  assert.deepEqual(filePrimitives(tool, "/fictional-project/.env"), facts({ exposes_secrets: true }), tool);
}
for (const tool of ["write", "edit", "multi_edit", "apply_patch"]) {
  assert.deepEqual(filePrimitives(tool, "/fictional-project/source.ts"), facts({ local_state_change: true, destructive: true }), tool);
  assert.equal(decide(filePrimitives(tool, "/fictional-project/source.ts"), report(), { ...opts, guards: noGuards }).verdict, "allow");
}
assert.deepEqual(filePrimitives("unknown-tool", undefined), facts({ local_state_change: true }), "unknown file tool fails closed as mutating");
assert.deepEqual(positiveRiskSignals(facts()), {}, "negative predictions are unknown, not false-filled policy facts");
for (const guards of [noGuards, { readOnly: true, remoteReadOnly: false }, { readOnly: false, remoteReadOnly: true }]) {
  assert.deepEqual(actionDecision({}, guards), { verdict: "block", guard: "auto", reason: "auto:action-review" },
    "every unverified call requires review, even under all-negative predictions");
  for (const head of HEADS) {
    const signals = positiveRiskSignals(facts({ [head]: true }));
    assert.deepEqual(signals, { [head]: true });
    const guard = hardGuardDecision(signals, guards);
    assert.deepEqual(actionDecision(signals, guards), guard ?? { verdict: "block", guard: "auto", reason: `auto:action-risk:${head}` });
    checked++;
  }
}
assert.equal(actionDecision({ outbound: true, delegated_execution: true }, { readOnly: false, remoteReadOnly: true }).guard,
  "remote-read-only", "combined positive signals still enforce the remote delegation veto");
console.log(`nine-head policy tests passed (${checked} fact/guard cases plus scope and file synthesis)`);
