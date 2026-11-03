// Offline synthetic fixtures only. No real logs, credentials or model requests.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import activityExtension from "../index.ts";
import { judgeSafety } from "../judge.ts";
import { ActivityObservations, decisionObservation } from "../observations.ts";
import { OBSERVATION_ENTRY_TYPE } from "../version.ts";
import { nativeToolInfo, withNativeTools } from "./nine-head-fixtures.mjs";
import { approvalFixture, assertCompleteArguments, collectApprovalEvidence, escapedEvidence } from "./approval-fixture.mjs";

const root = mkdtempSync(join(tmpdir(), "activity-feature-regressions-"));
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE", "PI_SUBAGENT_TASK"].map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = root;
delete process.env.PI_ACTIVITY_AUTO_MODE;
delete process.env.PI_SUBAGENT_TASK;
mkdirSync(join(root, "config"));
const configure = (extra = {}) => writeFileSync(join(root, "config/activity.json"), JSON.stringify({
  acclass: { enabled: false }, auto: { judgeModel: "fixture/judge" },
  log: { enabled: false }, reviewLog: { enabled: false }, ...extra,
}));
const model = { provider: "fixture", id: "judge", api: "synthetic", contextWindow: 128000 };
const response = (text, physical = model, stopReason = "stop", errorMessage) => ({
  role: "assistant", provider: physical.provider, model: physical.id, api: physical.api,
  content: [{ type: "text", text }], stopReason, errorMessage, timestamp: 1,
  usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const modes = { auto: true, readOnly: false, remoteReadOnly: false };
const live = new AbortController().signal;
const harnesses = [];
function harness(review, registry = { find: () => model, getAll: () => [model] }) {
  const handlers = {}, commands = {}, entries = [], events = [], statuses = [];
  let prompts = 0, next = 0, observer;
  const pi = {
    registerFlag() {}, on(name, handler) { handlers[name] = handler; },
    registerCommand(name, command) { commands[name] = command.handler; },
    getFlag: (name) => name === "auto", getAllTools: () => withNativeTools([
      { name: "catalog", sourceInfo: { source: "mcp", path: "synthetic:mcp" } },
      { name: "codemode", sourceInfo: { source: "builtin", path: "builtin:codemode" } },
    ]),
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
    sendMessage() {}, events: { emit(channel, data) {
      if (channel === "activity:policy-context:request") return; // callback protocol, not serializable telemetry
      events.push({ channel, data: structuredClone(data) }); observer?.(channel, data);
    } },
  };
  const ctx = { cwd: root, mode: "tui", hasUI: true, modelRegistry: registry,
    sessionManager: { getSessionId: () => "feature-fixture", getBranch: () => entries },
    ui: { theme: { fg: (_color, text) => text }, notify() {},
      setStatus(key, text) { statuses.push({ key, text }); } },
  };
  ctx.ui.custom = approvalFixture(ctx, (done) => { prompts++; done("Allow"); });
  activityExtension(pi, review, "native");
  const h = { handlers, commands, ctx, statuses, events, entries, get prompts() { return prompts; },
    observer(value) { observer = value; },
    start: () => handlers.session_start({ reason: "startup" }, ctx),
    stop: () => handlers.session_shutdown({}, ctx),
    async call(toolName, input, extra = {}) {
      const event = { toolName, input, toolCallId: `feature-${++next}`, ...extra };
      const before = events.filter((e) => e.channel === "activity:decision").length;
      const result = await handlers.tool_call(event, ctx);
      const decisions = events.filter((e) => e.channel === "activity:decision");
      assert.equal(decisions.length, before + 1, "each gate broadcasts exactly one final decision");
      assert.equal(decisions.at(-1).data.verdict, result?.block ? "block" : "allow");
      return { result, event, decision: decisions.at(-1).data };
    },
    latest: () => entries.findLast((entry) => entry.customType === OBSERVATION_ENTRY_TYPE)?.data,
  };
  harnesses.push(h);
  return h;
}
try {
  configure();
  for (const ref of ["missing/model", "judge", " /model "]) {
    const registry = { find: () => undefined, getAll: () => ref === "judge" ? [model, { ...model, provider: "duplicate" }] : [] };
    const result = await judgeSafety({ modelRegistry: registry, sessionManager: { getBranch: () => [] } }, ref,
      "bash", { command: "synthetic" }, root, modes, live);
    assert.equal(result.ok, false);
    assert.equal(result.metrics.configurationError, "judge-model-unavailable");
    assert.equal(result.metrics.providerRequests, 0);
    assert.match(result.reason, /activity\.auto\.judgeModel/);
    assert.match(result.reason, /registered provider\/model/);
  }
  const invalid = harness(undefined, { find: () => undefined, getAll: () => [] });
  await invalid.start();
  const blocked = await invalid.call("catalog", { payload: "DO_NOT_BROADCAST_ARGUMENT" });
  assert.equal(blocked.result?.block, true);
  assert.equal(invalid.prompts, 0, "invalid configured model is a technical stop, not an overridable policy objection");
  assert.equal(blocked.decision.reason, "auto:judge-configuration");
  assert.equal(blocked.decision.judge.configurationError, "judge-model-unavailable");
  assert.equal(blocked.decision.judge.providerRequests, 0);
  await invalid.stop();

  configure({ auto: { judgeModel: null } });
  const missing = harness();
  await missing.start();
  assert.equal((await missing.call("bash", { command: "synthetic" })).decision.reason, "auto:user-allow");
  assert.equal(missing.prompts, 1);
  await missing.stop();

  configure();
  const outage = harness((...args) => {
    args[9] = async () => { throw new Error("synthetic transport disconnected"); };
    return judgeSafety(...args);
  });
  await outage.start();
  const outageResult = await outage.call("catalog", {});
  assert.equal(outageResult.result?.block, undefined, "transport failures retain ordinary TUI approval policy");
  assert.equal(outage.prompts, 1);
  assert.equal(outageResult.decision.route, "user-override");
  assert.equal(outageResult.decision.judge.configurationError, undefined);
  assert.equal(outageResult.decision.judge.providerRequests, 1);
  await outage.stop();

  const fullReason = ` synthetic denial ${"full reason ".repeat(30)} FINAL_REASON_TAIL `;
  const detailed = harness(async () => ({ ok: true, allow: false, decision: "ask_user", reason: fullReason }));
  await detailed.start();
  const detailedInput = { payload: "x".repeat(2_100), thinking: null,
    tail: "FINAL_ARGUMENT_TAIL", escapes: "\\path\n\t\x1b\u202e", frame: "│ leading and trailing │ " };
  let inspected = false;
  detailed.ctx.ui.custom = approvalFixture(detailed.ctx, (done, view) => {
    assert.equal(view.page, 0, "evidence is visible from the first page without a details menu");
    assert.equal(view.selected, 0, "Block is the default");
    view.handleInput("j");
    const evidence = collectApprovalEvidence(view);
    assertCompleteArguments(evidence, detailedInput);
    assert.ok(evidence.includes(`Tool call:catalog · cwd: ${escapedEvidence(root)}`));
    assert.ok(evidence.includes(`Review:${escapedEvidence(fullReason)}`));
    inspected = true;
    done("Allow");
  });
  assert.equal((await detailed.call("catalog", detailedInput)).decision.reason, "auto:user-allow");
  assert.equal(inspected, true, "full details are inspected before the exact-call approval");
  await detailed.stop();

  const mutated = harness(async () => ({ ok: true, allow: false, decision: "ask_user", reason: "synthetic denial" }));
  await mutated.start();
  const changingInput = { operation: "first" };
  mutated.ctx.ui.custom = approvalFixture(mutated.ctx, (done) => {
    changingInput.operation = "different";
    done("Allow");
  });
  const staleApproval = await mutated.call("catalog", changingInput);
  assert.equal(staleApproval.result.block, true, "an approval is bound to the arguments shown");
  assert.match(staleApproval.result.reason, /arguments or policy context changed during review/);
  await mutated.stop();

  let deny = false;
  const ordinary = harness(async () => ({ ok: true, allow: !deny, reason: "DO_NOT_BROADCAST_RAW_REASON" }));
  await ordinary.start();
  const native = await ordinary.call("write", { path: "fixture.txt", content: "DO_NOT_BROADCAST_CONTENT" });
  assert.equal(native.decision.category, "files");
  assert.equal(native.decision.route, "local-allow");
  assert.equal(native.decision.version, 1);
  assert.equal(typeof native.decision.packageVersion, "string");
  assert.deepEqual(native.decision.modes, modes);
  const reviewed = await ordinary.call("catalog", { payload: "DO_NOT_BROADCAST_ARGUMENT" }, { parentToolCallId: "outer" });
  assert.equal(reviewed.decision.category, "mcp");
  assert.equal(reviewed.decision.route, "judge-allow");
  const wrapper = await ordinary.call("codemode", { code: "DO_NOT_BROADCAST_CODE" });
  assert.equal(wrapper.decision.category, "wrapper");
  assert.equal(wrapper.decision.reason, "base:codemode-tools-gated");
  await ordinary.commands["read-only"]("on", ordinary.ctx);
  const nativeConflict = await ordinary.call("write", { path: "fixture.txt" });
  assert.equal(nativeConflict.decision.reason, "auto:judge");
  assert.match(nativeConflict.result.reason, /Invalid\/inconsistent safety review/);
  assert.ok(ordinary.events.some((event) => event.channel === "activity:state" && event.data.readOnly));
  await ordinary.commands["read-only"]("off", ordinary.ctx);
  const malformed = await ordinary.call("catalog", { invalid: undefined });
  assert.equal(malformed.decision.reason, "auto:invalid-action-evidence");
  assert.equal(malformed.result.block, true);
  deny = true;
  ordinary.ctx.mode = "print";
  assert.equal((await ordinary.call("catalog", {})).decision.route, "final-block");
  const serialized = JSON.stringify(ordinary.events.filter((e) => e.channel === "activity:decision"));
  assert.ok(!serialized.includes("DO_NOT_BROADCAST"));
  assert.ok(!/"(?:input|args|output|explanation|authority)"/.test(serialized));

  configure({ display: { enabled: "invalid" } });
  const beforeError = ordinary.events.filter((e) => e.channel === "activity:decision").length;
  await assert.rejects(ordinary.handlers.tool_call({ toolName: "write", toolCallId: "broken-config", input: {} }, ordinary.ctx), /display\/session/);
  const failedEvents = ordinary.events.filter((e) => e.channel === "activity:decision");
  assert.equal(failedEvents.length, beforeError + 1);
  assert.equal(failedEvents.at(-1).data.reason, "auto:gate-failure");
  configure();
  const originalGate = ActivityObservations.prototype.gate;
  ActivityObservations.prototype.gate = () => { throw new Error("synthetic observation failure"); };
  ordinary.observer(() => { throw new Error("synthetic bus failure"); });
  try { assert.equal((await ordinary.call("write", { path: "safe.txt" })).result?.block, undefined); }
  finally { ActivityObservations.prototype.gate = originalGate; ordinary.observer(undefined); }
  await ordinary.stop();
  assert.equal(ordinary.statuses.findLast(({ key }) => key === "activity")?.text, undefined, "shutdown suppresses later footer restoration");

  const projected = decisionObservation({ toolCallId: "projected", toolName: "bash", input: { command: "DO_NOT_BROADCAST" } }, modes, {
    verdict: "block", route: "final-block", reason: "DO_NOT_BROADCAST_REASON",
    classifier: { inputType: "shell", status: "success", wallMs: 12, inferenceMs: 3,
      probs: { local_state_change: 0.8, exposes_secrets: 2, arbitrary: 0.5 },
      preds: { local_state_change: true }, appliedHeads: ["local_state_change", "arbitrary"], output: "DO_NOT_BROADCAST" },
    judge: { providerRequests: 2, providerDispatches: 3, attempts: 2, retries: 1, wallMs: 20, reason: "DO_NOT_BROADCAST" },
  }, nativeToolInfo("bash"));
  assert.equal(projected.reason, "unknown");
  assert.deepEqual(projected.classifier.probs, { local_state_change: 0.8 });
  assert.deepEqual(projected.classifier.appliedHeads, ["local_state_change"]);
  assert.equal(projected.classifier.inferenceMs, 3);
  assert.equal(projected.judge.providerRequests, 2);
  assert.ok(!JSON.stringify(projected).includes("DO_NOT_BROADCAST"));

  configure();
  let release;
  const cancelling = harness(async () => new Promise((resolve) => { release = resolve; }));
  await cancelling.start();
  const pending = cancelling.call("catalog", {});
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  await cancelling.stop();
  const cancelled = await pending;
  assert.equal(cancelled.decision.verdict, "block");
  assert.equal(cancelled.decision.reason, "auto:cancelled");
  release({ ok: true, allow: true, reason: "late synthetic verdict" });
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(cancelling.events.filter((event) => event.channel === "activity:decision").length, 1);
  assert.equal(cancelling.statuses.findLast(({ key }) => key === "activity")?.text, undefined);

  // Zero retained histories still support pending execution accounting and persisted totals.
  configure({ history: { maxEntries: 0 } });
  const zero = harness();
  await zero.start();
  const file = await zero.call("write", { path: "fixture.txt", content: "synthetic" });
  await zero.handlers.tool_result({ ...file.event, isError: false }, zero.ctx);
  await zero.call("catalog", { invalid: undefined });
  assert.deepEqual(zero.latest().totals, { files: 1, sh: 0, mcp: 0, blocked: 1 });
  assert.deepEqual(zero.latest().history, []);
  const emptyHistory = new ActivityObservations({ maxHistory: 0 });
  emptyHistory.restore(zero.entries);
  assert.deepEqual(emptyHistory.view().history, []);
  assert.equal(emptyHistory.view().totals.files, 1);
  await zero.stop();

  // Real installed registry: a virtual fallback reports a physical generating identity.
  const credentials = { read: async () => undefined, list: async () => [], modify: async (_provider, fn) => fn(undefined), delete: async () => {} };
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  const physical = (id) => ({ provider: "fixture-physical", id, name: id, api: "synthetic-fallback", baseUrl: "", reasoning: false,
    input: ["text"], contextWindow: id === "small" ? 16000 : 128000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  registry.registerProvider({ id: "fixture-physical", name: "Synthetic keyless provider",
    auth: { apiKey: { name: "Offline fixture", resolve: async () => ({ auth: {}, source: "synthetic" }) } },
    getModels: () => [physical("small"), physical("large")], stream() { throw new Error("unexpected API-specific path"); },
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        await options.onPayload?.({ synthetic: true }, model);
        await options.onResponse?.({ status: 200, headers: {} }, model);
        const result = model.id === "small" ? response("", model, "error", "maximum context length exceeded")
          : response('{"decision":"allow","reason":"synthetic scoped action"}', model);
        stream.push({ type: "start", partial: result });
        stream.push(result.stopReason === "error" ? { type: "error", reason: "error", error: result } : { type: "done", reason: "stop", message: result });
        stream.end(result);
      });
      return stream;
    },
  });
  await registry.refresh({ allowNetwork: false, providers: ["fixture-physical"] });
  for (const id of ["primary", "fallback"]) registry.registerVirtualModel({ provider: "fixture-tiers", id, name: id,
    route: () => ({ model: registry.find("fixture-physical", id === "primary" ? "small" : "large"), thinkingLevel: "off" }) });
  await registry.refresh({ allowNetwork: false });
  configure({ auto: { judgeModel: "fixture-tiers/primary", fallbackJudgeModel: "fixture-tiers/fallback" } });
  const fallback = harness(undefined, registry);
  await fallback.start();
  const routed = await fallback.call("catalog", {});
  assert.equal(routed.result?.block, undefined);
  assert.equal(routed.decision.judge.fallbackUsed, true);
  assert.equal(routed.decision.judge.providerRequests, 2);
  assert.equal(fallback.latest().telemetry.judge.fallbacks, 1, "physical fallback receipt is counted despite not matching the virtual alias");
  assert.equal(fallback.latest().telemetry.judge.models.actual["fixture-physical/large"], 1);
  assert.ok(fallback.statuses.some(({ key, text }) => key === "activity-judge" && text?.includes("s elapsed")));
  await fallback.stop();
  console.log("Feature regression tests passed: fail-closed configuration, final private decisions, zero history, virtual fallback and shutdown");
} finally {
  configure();
  for (const h of harnesses) await h.stop();
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
}
