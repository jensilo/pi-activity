import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ActivityObservations, latencyStats } from "../observations.ts";
import { OBSERVATION_ENTRY_TYPE } from "../version.ts";
import { nativeToolInfo } from "./nine-head-fixtures.mjs";

const root = mkdtempSync(join(tmpdir(), "activity-observation-fixture-"));
const zero = { files: 0, sh: 0, mcp: 0, blocked: 0 };
const bash = nativeToolInfo("bash"), write = nativeToolInfo("write"), read = nativeToolInfo("read");
const makeEvent = (id, name = "bash") => ({ toolCallId: id, toolName: name, input: { command: "printf synthetic", path: "/synthetic/file" } });
const adapter = (manager) => ({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) });
try {
  const manager = SessionManager.inMemory(root);
  const observations = new ActivityObservations({ now: () => 1000 });
  observations.restore(manager.getBranch()); observations.beginTurn();
  observations.toolResult({ ...makeEvent("a"), isError: false }, bash);
  assert.equal(observations.persist(adapter(manager)), true);
  const ancestor = manager.getLeafId();
  observations.beginTurn();
  observations.toolResult({ ...makeEvent("b", "write"), isError: false }, write);
  observations.gate(makeEvent("blocked", "read"), "block", { info: read });
  observations.persist(adapter(manager));
  assert.deepEqual(observations.view().totals, { files: 1, sh: 1, mcp: 0, blocked: 1 });
  manager.branch(ancestor);
  const staleScope = observations.scope();
  observations.restore(manager.getBranch());
  assert.deepEqual(observations.view().totals, { files: 0, sh: 1, mcp: 0, blocked: 0 }, "abandoned branch must not affect totals");
  observations.toolResult({ ...makeEvent("stale"), isError: false }, bash, staleScope);
  assert.equal(observations.view().totals.sh, 1);
  observations.beginTurn();
  observations.executionStart(makeEvent("pending"), bash); observations.admitted(makeEvent("pending"), bash);
  observations.judgeStarted("pending-review", 16000);
  observations.persist(adapter(manager));
  const restarted = new ActivityObservations(); restarted.restore(manager.getBranch());
  assert.equal(restarted.view().history.find((c) => c.id === "pending").status, "interrupted");
  assert.equal(restarted.view().telemetry.judge.outcomes.interrupted, 1);
  assert.equal(restarted.view().telemetry.judge.outcomes.unavailable, 0, "restart does not invent model outcomes");
  assert.equal(restarted.view().totals.sh, 1); assert.equal(restarted.view().active, false); assert.equal(restarted.view().liveJudges.length, 0);
  assert.equal(restarted.view().selected.id, observations.view().selected.id);
  assert.equal(restarted.persist(adapter(manager)), true);
  const again = new ActivityObservations(); again.restore(manager.getBranch());
  assert.equal(again.view().telemetry.judge.outcomes.interrupted, 1, "persisted interruption does not multiply on reload");
  observations.restore([]); assert.deepEqual(observations.view().totals, zero); assert.equal(observations.view().coverage, "complete");
  observations.restore([{ type: "message", message: { role: "user", content: "OLD_PROMPT_NOT_CAPTURED" } }]);
  assert.equal(observations.view().coverage, "incomplete");
  assert.ok(!JSON.stringify(observations.snapshot()).includes("OLD_PROMPT_NOT_CAPTURED"));
  assert.equal(observations.persist({ appendEntry: () => { throw new Error("Synthetic persistence failure"); } }), false);

  // Direct, unserialized snapshot round trips must work for absent previews too.
  for (const [name, info] of [["catalog", { sourceInfo: { source: "mcp" } }], ["read", read], ["codemode", { sourceInfo: { source: "builtin", path: "builtin:codemode" } }], ["bash", bash]]) {
    const source = new ActivityObservations(); source.beginTurn();
    source.toolResult({ toolCallId: "no-preview", toolName: name, isError: false }, info);
    const snapshot = source.snapshot();
    assert.equal(Object.hasOwn(snapshot.history[0], "preview"), false);
    for (const data of [snapshot, JSON.parse(JSON.stringify(snapshot))]) {
      const dest = new ActivityObservations(); dest.restore([{ type: "custom", customType: OBSERVATION_ENTRY_TYPE, data }]);
      assert.deepEqual(dest.view().totals, source.view().totals);
      assert.equal(dest.view().history.length, 1);
    }
  }
  const capable = new ActivityObservations({ judgeRequestsObserved: true, summaryRequestsObserved: true });
  capable.judgeStarted("j"); capable.judgeRequest("j"); capable.judgeFinished("j", "allow"); capable.summaryRequest();
  const downgraded = new ActivityObservations(); downgraded.restore([{ type: "custom", customType: OBSERVATION_ENTRY_TYPE, data: capable.snapshot() }]);
  assert.equal(downgraded.view().telemetry.judge.requestsKnown, false);
  assert.equal(downgraded.view().telemetry.summaries.requestsKnown, false);
  assert.equal(downgraded.view().selected.telemetry.judge.requestsKnown, false);
  assert.equal(downgraded.view().selected.telemetry.summaries.requestsKnown, false);

  // Real SessionManager JSONL reopening, outside any worktree, synthetic messages only.
  const disk = SessionManager.create(root, join(root, "sessions"));
  disk.appendMessage({ role: "user", content: "Synthetic prompt", timestamp: 1000 });
  disk.appendMessage({ role: "assistant", content: [{ type: "text", text: "Synthetic reply" }], api: "openai-completions", provider: "fixture", model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1000 });
  const diskObservations = new ActivityObservations(); diskObservations.restore(disk.getBranch());
  diskObservations.beginTurn(); diskObservations.toolResult({ ...makeEvent("disk-executed"), isError: true }, bash); diskObservations.endTurn();
  diskObservations.persist(adapter(disk));
  const reopened = SessionManager.open(disk.getSessionFile());
  const processRestart = new ActivityObservations(); processRestart.restore(reopened.getBranch());
  assert.equal(processRestart.view().totals.sh, 1); assert.equal(processRestart.view().coverage, "incomplete");
  assert.ok(!reopened.buildSessionContext().messages.some((m) => m.customType === OBSERVATION_ENTRY_TYPE), "custom snapshots are outside model context");

  const bounded = new ActivityObservations({ maxHistory: 3, maxTurns: 2, previewChars: 400 });
  for (let i = 0; i < 500; i++) {
    bounded.beginTurn(); bounded.toolResult({ ...makeEvent(`limit-${i}`), isError: false }, bash); bounded.endTurn();
  }
  const small = bounded.snapshot();
  assert.equal(small.totals.sh, 500); assert.equal(small.history.length, 3); assert.equal(small.turns.length, 2); assert.equal(small.omitted, 497);
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 65536);
  const heavy = new ActivityObservations(); heavy.beginTurn();
  for (let i = 0; i < 256; i++) {
    const e = { ...makeEvent(`heavy-${i}`), input: { command: "界".repeat(400) } };
    heavy.gate(e, "allow", { info: bash, explanation: "界".repeat(400) }); heavy.toolResult({ ...e, isError: false }, bash);
  }
  const heavySnapshot = heavy.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(heavySnapshot)) <= 65536);
  assert.ok(heavySnapshot.omitted > 0); assert.equal(heavySnapshot.totals.sh, 256);

  // Snapshot decoding allowlists data and re-scrubs sanctioned display text.
  const malicious = structuredClone(small);
  malicious.userPrompt = "RAW_PROMPT"; malicious.operationalSummary = "RAW_SUMMARY";
  malicious.history[0].input = { token: "RAW_ARGS" };
  malicious.history[0].explanation = { text: "token=SYNTHETIC_CREDENTIAL", omittedChars: 0 };
  const restored = new ActivityObservations();
  restored.restore([{ type: "custom", customType: OBSERVATION_ENTRY_TYPE, data: malicious }]);
  const safe = JSON.stringify(restored.snapshot());
  for (const text of ["RAW_PROMPT", "RAW_SUMMARY", "RAW_ARGS", "SYNTHETIC_CREDENTIAL"]) assert.ok(!safe.includes(text));
  const invalid = structuredClone(small); invalid.totals.sh = -1;
  restored.restore([{ type: "custom", customType: OBSERVATION_ENTRY_TYPE, data: small }, { type: "custom", customType: OBSERVATION_ENTRY_TYPE, data: invalid }]);
  assert.equal(restored.view().totals.sh, 500, "invalid newest checkpoint falls back to known branch checkpoint");
  assert.equal(restored.view().coverage, "incomplete", "fallback must disclose rejected newer accounting");
  restored.restore([{ type: "custom", customType: OBSERVATION_ENTRY_TYPE, data: { version: 99 } }]);
  assert.deepEqual(restored.view().totals, zero); assert.equal(restored.view().coverage, "incomplete");
  restored.restore([{ type: "custom", customType: OBSERVATION_ENTRY_TYPE, data: small }, { type: "message" }]);
  assert.equal(restored.view().coverage, "incomplete", "uncheckpointed finalized messages create a coverage gap");
  const accessor = Object.defineProperty({}, "version", { get() { throw new Error("Accessor must not run"); }, enumerable: true });
  restored.restore([{ type: "custom", customType: OBSERVATION_ENTRY_TYPE, data: accessor }]);
  assert.deepEqual(restored.view().totals, zero);

  // Aggregate telemetry survives tiny retained history and process restarts.
  const aggregate = new ActivityObservations({ maxHistory: 3, now: () => 1000, judgeRequestsObserved: true, summaryRequestsObserved: true,
    judgeModel: "fixture/judge", summaryModel: "fixture/summary" }); aggregate.beginTurn();
  const categoryFixtures = [["write", write], ["bash", bash], ["catalog", { sourceInfo: { source: "mcp", server: "fixture-server" } }], ["read", read], ["codemode", { sourceInfo: { source: "builtin", path: "builtin:codemode" } }]];
  for (let n = 1; n <= 40; n++) {
    const [name, info] = categoryFixtures[n % 5];
    aggregate.toolResult({ ...makeEvent(`aggregate-error-${n}`, name), isError: true }, info);
    aggregate.gate(makeEvent(`aggregate-block-${n}`, name), "block", { info, route: "final-block", reason: n % 2 ? "judge-deny" : "read-only" });
    aggregate.evaluation(`aggregate-eval-${n}`, { inputType: "shell", status: "success", inferenceMs: n, wallMs: n * 2,
      probs: { outbound: n % 2 ? 0.8 : 0.4 }, preds: { outbound: n % 2 === 1 }, appliedHeads: ["outbound"] });
    aggregate.judgeStarted(`aggregate-judge-${n}`);
    aggregate.judgeRequest(`aggregate-judge-${n}`, false, aggregate.scope(), { model: n % 2 ? "fixture/actual" : "fixture/fallback" });
    aggregate.judgeFinished(`aggregate-judge-${n}`, "deny", n * 3);
    aggregate.summaryRequest(aggregate.scope(), { model: "fixture/actual-summary" }); aggregate.summary("generated", n * 4);
  }
  aggregate.summary("restored"); aggregate.approvalPrompt(); aggregate.approval("allow", true);
  const metadataEvent = makeEvent("aggregate-metadata", "catalog"), metadata = { sourceInfo: { source: "mcp", server: "fixture-server", path: "DO_NOT_RETAIN_SOURCE_PATH" }, namespace: { name: "mcp__fixture_server" } };
  aggregate.gate(metadataEvent, "allow", { info: metadata, route: "user-override", gateMs: 50, reviewMs: 40,
    signals: { probs: { outbound: 0.8, unknown: "DO_NOT_RETAIN_SIGNAL" }, preds: { outbound: true }, appliedHeads: ["outbound", "unknown"] } });
  aggregate.toolResult({ ...metadataEvent, isError: false }, metadata, aggregate.scope(), { durationMs: 10 }); aggregate.endTurn();
  const aggregateSnapshot = aggregate.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(aggregateSnapshot)) <= 65536);
  const aggregateRestart = new ActivityObservations({ judgeRequestsObserved: true, summaryRequestsObserved: true });
  aggregateRestart.restore([{ type: "custom", customType: OBSERVATION_ENTRY_TYPE, data: JSON.parse(JSON.stringify(aggregateSnapshot)) }]);
  const recovered = aggregateRestart.view();
  assert.deepEqual(recovered.telemetry, aggregate.view().telemetry);
  assert.equal(recovered.telemetry.activity.errors, 40); assert.equal(recovered.totals.blocked, 40);
  assert.deepEqual(recovered.telemetry.activity.blocksByCategory, { files: 8, sh: 8, mcp: 8, other: 8, wrapper: 8 });
  assert.deepEqual(recovered.telemetry.activity.errorsByCategory, recovered.telemetry.activity.blocksByCategory);
  assert.deepEqual(recovered.telemetry.activity.blocksByReason, { "judge-deny": 20, "read-only": 20 });
  assert.deepEqual(latencyStats(recovered.telemetry.classifier.inference), { count: 40, sampleCount: 32, meanMs: 20.5, medianMs: 24.5, p95Ms: 39 });
  assert.equal(recovered.history.at(-1).route, "user-override"); assert.equal(recovered.history.at(-1).gateMs, 50);
  assert.equal(recovered.history.at(-1).reviewMs, 40); assert.equal(recovered.history.at(-1).durationMs, 10);
  assert.equal(recovered.history.at(-1).source, "mcp"); assert.equal(recovered.history.at(-1).server, "fixture-server");
  assert.equal(recovered.history.at(-1).namespace, "mcp__fixture_server");
  assert.deepEqual(recovered.history.at(-1).signals, { probs: { outbound: 0.8 }, preds: { outbound: true }, appliedHeads: ["outbound"] });
  assert.equal(recovered.telemetry.approvals.prompts, 1); assert.equal(recovered.telemetry.summaries.restored, 1);
  for (const text of ["DO_NOT_RETAIN_SIGNAL", "DO_NOT_RETAIN_SOURCE_PATH"]) assert.ok(!JSON.stringify(recovered).includes(text));

  // New telemetry is optional when reading earlier checkpoints. Missing metrics
  // become unknown/incomplete, not retroactively fabricated from retained history.
  const legacy = structuredClone(aggregateSnapshot);
  for (const t of [legacy.telemetry, ...legacy.turns.map((turn) => turn.telemetry)]) {
    delete t.activity; delete t.gate;
    delete t.classifier.inference; delete t.classifier.endToEnd;
    for (const h of Object.values(t.classifier.heads)) for (const field of ["positiveProbabilitySum", "positiveProbabilitySamples", "appliedPositive", "appliedProbabilitySum", "appliedPositiveProbabilitySum", "appliedLabelSamples"]) delete h[field];
    for (const key of ["judge", "summaries", "approvals"]) { delete t[key].latency; delete t[key].models; }
    delete t.approvals.prompts;
  }
  for (const h of legacy.history) { delete h.submissionDurationMs; delete h.executionStartedAt; }
  const legacyRestart = new ActivityObservations({ judgeRequestsObserved: true, summaryRequestsObserved: true });
  legacyRestart.restore([{ type: "custom", customType: OBSERVATION_ENTRY_TYPE, data: legacy }]);
  assert.deepEqual(legacyRestart.view().totals, aggregate.view().totals);
  assert.equal(legacyRestart.view().coverage, "incomplete");
  assert.equal(legacyRestart.view().telemetry.classifier.heads.outbound.positiveProbabilitySum, undefined);
  assert.equal(legacyRestart.view().history.at(-1).durationMs, undefined, "legacy submission duration is never relabeled execution time");
  assert.equal(legacyRestart.view().telemetry.judge.requestsKnown, false);
  legacyRestart.evaluation("legacy-new-event", { inputType: "shell", status: "success", probs: { outbound: 0.9 }, preds: { outbound: true }, appliedHeads: ["outbound"] });
  const partial = legacyRestart.view().telemetry.classifier.heads.outbound;
  assert.equal(partial.applied, 41); assert.equal(partial.appliedLabelSamples, 1); assert.equal(partial.appliedPositive, 1);
  assert.equal(partial.positiveProbabilitySamples, 1); assert.equal(partial.probabilitySum, 0.9);
  const partialRestart = new ActivityObservations(); partialRestart.restore([{ type: "custom", customType: OBSERVATION_ENTRY_TYPE, data: legacyRestart.snapshot() }]);
  assert.equal(partialRestart.view().telemetry.classifier.heads.outbound.appliedLabelSamples, 1);

  for (const mutate of [
    (data) => { data.telemetry.classifier.inference.samples = Array(33).fill(1); },
    (data) => { data.telemetry.judge.models.actual = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`fixture/model-${i}`, 1])); },
    (data) => { data.telemetry.activity.blocksByReason = { "SYNTHETIC_PRIVATE_REASON": 1 }; },
  ]) {
    const corrupt = structuredClone(aggregateSnapshot); mutate(corrupt);
    const destination = new ActivityObservations(); destination.restore([{ type: "custom", customType: OBSERVATION_ENTRY_TYPE, data: corrupt }]);
    assert.deepEqual(destination.view().totals, zero); assert.equal(destination.view().coverage, "incomplete");
  }

  // Saturate all turn telemetry and identifiers. Dropping history/old turns must
  // not discard aggregate counts; every checkpoint remains within 64 KiB.
  const pressure = new ActivityObservations({ judgeRequestsObserved: true, summaryRequestsObserved: true });
  for (let turn = 0; turn < 16; turn++) {
    pressure.beginTurn();
    for (let n = 0; n < 32; n++) {
      pressure.evaluation(`pressure-${turn}-${n}`, { inputType: "shell", status: "success", inferenceMs: n + 0.123456789, wallMs: n + 100.987654321 });
      pressure.judgeStarted(`pressure-judge-${turn}-${n}`); pressure.judgeRequest(`pressure-judge-${turn}-${n}`, false, pressure.scope(), { model: `fixture/${"m".repeat(100)}-${n % 8}` });
      pressure.judgeFinished(`pressure-judge-${turn}-${n}`, "deny", n + 200.123456789);
      pressure.summaryRequest(pressure.scope(), { model: `fixture/${"s".repeat(100)}-${n % 8}` }); pressure.summary("generated", n + 300.123456789);
      pressure.gate({ ...makeEvent(`pressure-block-${turn}-${n}`), input: { command: "界".repeat(400) } }, "block", { info: bash, reason: "auto:judge", explanation: "界".repeat(400), gateMs: n + 400.123456789 });
      pressure.approvalPrompt(); pressure.approval("block", false, pressure.scope(), { wallMs: n + 500.123456789 });
    }
    pressure.endTurn();
  }
  const pressureSnapshot = pressure.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(pressureSnapshot)) <= 65536);
  assert.equal(pressureSnapshot.telemetry.classifier.inference.count, 512);
  assert.equal(pressureSnapshot.telemetry.judge.requests, 512); assert.equal(pressureSnapshot.totals.blocked, 512);
  const pressureRestart = new ActivityObservations({ judgeRequestsObserved: true, summaryRequestsObserved: true });
  pressureRestart.restore([{ type: "custom", customType: OBSERVATION_ENTRY_TYPE, data: pressureSnapshot }]);
  assert.equal(pressureRestart.view().totals.blocked, 512); assert.equal(pressureRestart.view().telemetry.judge.latency.count, 512);

  // Loaded version stays fixed when a separate synthetic package changes on disk.
  const packageRoot = join(root, "version-fixture"); mkdirSync(join(packageRoot, "activity"), { recursive: true });
  copyFileSync(new URL("../version.ts", import.meta.url), join(packageRoot, "activity/version.ts"));
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ type: "module", version: "1.2.3" }));
  const jiti = createJiti(import.meta.url, { moduleCache: true });
  const loaded = await jiti.import(join(packageRoot, "activity/version.ts"));
  assert.equal(loaded.ACTIVITY_VERSION, "1.2.3");
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ type: "module", version: "9.9.9" }));
  assert.equal(loaded.ACTIVITY_VERSION, "1.2.3");
  assert.equal((await jiti.import(join(packageRoot, "activity/version.ts"))).ACTIVITY_VERSION, "1.2.3");
  console.log("persistence tests passed: branch-local restore, real JSONL restart, interrupted work, bounded private snapshots and loaded version");
} finally { rmSync(root, { recursive: true, force: true }); }
