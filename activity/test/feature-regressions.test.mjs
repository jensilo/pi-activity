// Offline synthetic fixtures only. No real logs, credentials or model requests.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activityExtension from "../index.ts";
import { judgeSafety } from "../judge.ts";
import { ActivityObservations, decisionObservation } from "../observations.ts";
import { OBSERVATION_ENTRY_TYPE } from "../version.ts";
import { nativeToolInfo, withNativeTools } from "./nine-head-fixtures.mjs";

const root = mkdtempSync(join(tmpdir(), "activity-feature-regressions-"));
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE", "PI_SUBAGENT_TASK"].map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = root;
delete process.env.PI_ACTIVITY_AUTO_MODE;
delete process.env.PI_SUBAGENT_TASK;
mkdirSync(join(root, "config"));
const configure = (extra = {}) => writeFileSync(join(root, "config/activity.json"), JSON.stringify({
  acclass: { enabled: false }, auto: { judgeBackend: "classifier", judgeModel: "fixture/judge" },
  log: { enabled: false }, reviewLog: { enabled: false }, ...extra,
}));
const model = { provider: "fixture", id: "judge", api: "synthetic", contextWindow: 128000 };
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
  ctx.ui.custom = ctx.ui.select = () => { prompts++; throw new Error("unexpected tool approval"); };
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
  assert.equal((await missing.call("bash", { command: "synthetic" })).decision.reason, "auto:judge-unconfigured");
  assert.equal(missing.prompts, 0);
  await missing.stop();

  configure();
  let decisionCalls = 0;
  const outage = harness(undefined, {
    findOfType: (type, provider, id) => ({ type, provider, id, api: "fixture-choice", contextWindow: 128_000 }),
    classify: async () => { decisionCalls++; throw new Error("synthetic transport disconnected"); },
  });
  await outage.start();
  const outageResult = await outage.call("catalog", {});
  assert.equal(outageResult.result?.block, true);
  assert.match(outageResult.result.reason, /Safety review unavailable/);
  assert.equal(outage.prompts, 0);
  assert.equal(outageResult.decision.route, "final-block");
  assert.equal(outageResult.decision.judge.configurationError, undefined);
  assert.ok(decisionCalls > 0);
  assert.ok(outage.events.every(({ channel }) => channel !== "herdr:blocked"));
  await outage.stop();

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
  configure({ auto: { judgeMode: "cascade", judgeBackend: "chat", judgeModel: "fixture/chat" } });
  await assert.rejects(ordinary.handlers.tool_call({ toolName: "catalog", toolCallId: "chat-cascade", input: {} }, ordinary.ctx),
    /cascade requires the classifier judgeBackend/);
  assert.equal(ordinary.events.findLast((e) => e.channel === "activity:decision").data.verdict, "block");
  assert.equal(ordinary.prompts, 0);
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

  console.log("Feature regression tests passed: fail-closed configuration, final private decisions, zero history and shutdown");
} finally {
  configure();
  for (const h of harnesses) await h.stop();
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
}
