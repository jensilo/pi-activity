// Synthetic extension wiring plus the installed Pi admission/execute pipeline.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runToolCall } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { visibleWidth } from "@earendil-works/pi-tui";
import activityExtension, { setFixtureProvider } from "./synthetic-runtime.mjs";
import { ActivityObservations } from "../observations.ts";
import { Classifier } from "../classifier.ts";
import { OBSERVATION_ENTRY_TYPE } from "../version.ts";
import { classification, withNativeTools } from "./nine-head-fixtures.mjs";
import { approvalFixture } from "./approval-fixture.mjs";

const dir = mkdtempSync(join(tmpdir(), "activity-ui-accounting-"));
const oldDir = process.env.PI_CODING_AGENT_DIR;
const oldAuto = process.env.PI_ACTIVITY_AUTO_MODE;
const oldTask = process.env.PI_SUBAGENT_TASK;
const classify = Classifier.prototype.classify;
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.PI_ACTIVITY_AUTO_MODE;
delete process.env.PI_SUBAGENT_TASK;
mkdirSync(join(dir, "config"));
writeFileSync(join(dir, "config/activity.json"), JSON.stringify({
  acclass: setFixtureProvider({ provider: "acclass", binary: "/synthetic/acclass", model: "/synthetic/model", socket: join(dir, "fake.sock"), spawn: false }),
  auto: { judgeModel: "configured/router", summaryModel: "configured/summary" },
  history: { maxEntries: 12 }, log: { enabled: false }, reviewLog: { enabled: false },
}));
Classifier.prototype.classify = async () => classification(undefined, { ms: 3 });
const handlers = {}, commands = {}, entries = [], statuses = [], notifications = [];
const tools = withNativeTools([
  { name: "catalog", sourceInfo: { source: "mcp", path: "synthetic:mcp", server: "fixture" } },
  { name: "codemode", sourceInfo: { source: "builtin", path: "builtin:codemode" } },
  { name: "custom", sourceInfo: { source: "extension", path: "synthetic:custom" } },
]);
const pi = {
  registerFlag() {}, registerCommand(name, options) { commands[name] = options.handler; },
  on(name, handler) { handlers[name] = handler; }, getFlag: (name) => name === "auto",
  getAllTools: () => tools, appendEntry(customType, data) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
  sendMessage() {}, events: { emit() {} },
};
const ctx = {
  cwd: dir, mode: "tui", hasUI: true,
  sessionManager: { getBranch: () => entries, getEntries() { throw new Error("must restore selected branch only"); }, getSessionId: () => "synthetic-ui" },
  ui: { theme: { fg: (_color, text) => text }, notify(text) { notifications.push(text); },
    setStatus(key, text) { statuses.push({ key, text }); } },
};
let verdict = true, reviewCalls = 0;
let reviewImpl = async (...args) => {
  reviewCalls++;
  args[7]?.({ retry: 1, cause: "transient error" });
  args[13]?.({ status: "failed", coveredMessages: 0, wallMs: 0 });
  args[14]?.onModelCall?.({ operation: "summary", kind: "provider-request", attempt: 1, provider: "physical", model: "summary", evidence: "injected" });
  args[13]?.({ status: "generated", coveredMessages: 5, wallMs: 7 });
  args[13]?.({ status: "generated", coveredMessages: 5, wallMs: 8 });
  args[14]?.onModelCall?.({ operation: "judge", kind: "provider-request", attempt: 1, provider: "physical", model: "judge", evidence: "injected" });
  return { ok: true, allow: verdict, decision: verdict ? "allow" : "ask_user", reason: verdict ? "synthetic safe" : "synthetic denied" };
};
activityExtension(pi, (...args) => reviewImpl(...args), "native");
const snapshot = () => entries.findLast((entry) => entry.customType === OBSERVATION_ENTRY_TYPE)?.data;
let next = 0;
const event = (name = "bash", input = { command: "printf synthetic" }, extra = {}) => ({ toolName: name, toolCallId: `fixture-${++next}`, input, ...extra });
const gate = async (e) => { await handlers.tool_execution_start({ ...e, args: e.input }, ctx); return handlers.tool_call(e, ctx); };
const finish = async (e, isError = false, durationMs) => {
  await handlers.tool_result({ ...e, isError, details: { exitCode: isError ? 3 : 0 } }, ctx);
  await handlers.tool_execution_end({ ...e, isError, durationMs }, ctx);
};
try {
  await handlers.session_start({ reason: "startup" }, ctx);
  await handlers.before_agent_start({}, ctx);
  assert.ok(commands["mcp-history"]);
  const shell = event();
  assert.equal((await gate(shell))?.block, undefined);
  assert.equal(snapshot().totals.sh, 0, "execution_start/admission is not execution evidence");
  await finish(shell, true, 45);
  assert.equal(snapshot().totals.sh, 1, "executed errors count as shell executions");
  assert.equal(snapshot().history.at(-1).durationMs, 45, "end-hook timing enriches the completed direct call");
  const afterShell = snapshot();
  await finish(shell, true, 999);
  assert.deepEqual(snapshot(), afterShell, "result/end duplicates neither recount nor change timing");
  const file = event("write", { path: "synthetic.txt", content: "NEVER_CAPTURE_CONTENT" });
  await gate(file); await finish(file);
  const failed = event("edit", { path: "synthetic.txt" });
  await gate(failed); await finish(failed, true);
  assert.equal(snapshot().totals.files, 1);
  const custom = event("custom", { password: "NEVER_CAPTURE_ARGUMENTS" });
  await gate(custom); await finish(custom);
  for (const extra of [{}, { parentToolCallId: "outer" }, { parentToolCallId: "outer/1" }]) {
    const mcp = event("catalog", { payload: "NEVER_CAPTURE_MCP" }, extra);
    await gate(mcp); await finish(mcp, true, 12);
    assert.equal(snapshot().history.at(-1).durationMs, 12, "direct and nested MCP timing use the same result/end order");
    assert.equal(snapshot().history.at(-1).nested, !!extra.parentToolCallId);
  }
  const wrapper = event("codemode", { code: "NEVER_CAPTURE_CODE" });
  const beforeWrapper = reviewCalls;
  await gate(wrapper); await finish(wrapper);
  assert.equal(reviewCalls, beforeWrapper, "only proven built-in wrapper is exempt");
  assert.equal(snapshot().totals.mcp, 3, "direct and nested MCP, not custom/wrapper executions");
  assert.equal(snapshot().telemetry.summaries.generated, reviewCalls, "cumulative summary callbacks count once per review");
  assert.equal(snapshot().telemetry.summaries.failed, 0);
  assert.equal(snapshot().telemetry.judge.started, reviewCalls);
  assert.equal(snapshot().telemetry.judge.requests, reviewCalls);
  assert.equal(snapshot().telemetry.judge.requestsKnown, false, "provider evidence is not a universal wire counter");
  assert.equal(snapshot().telemetry.judge.models.actual["physical/judge"], reviewCalls);
  assert.equal(snapshot().telemetry.classifier.heads.exposes_secrets.applied, 1, "only successful classified shell policy applies all heads");
  assert.equal(snapshot().telemetry.classifier.inference.sumMs, 3 * (reviewCalls + 1), "inference timing is distinct from provider wall time");
  assert.equal(snapshot().telemetry.classifier.endToEnd.count, reviewCalls + 1);
  const liveStatus = statuses.findLast(({ key, text }) => key === "activity-judge" && text)?.text;
  assert.match(liveStatus, /^🛡️ · files:.*⚖️ judge \d+s elapsed · \d+s left/);
  assert.equal((liveStatus.match(/s elapsed/g) ?? []).length, 1, "elapsed appears only once");
  assert.equal(snapshot().guardWaitPending, 0, "the final gate checkpoint closes waiting before execution");
  assert.ok(snapshot().telemetry.guardWait.wallMs > 0);
  assert.equal(snapshot().telemetry.guardWait.coverage, "complete");
  assert.ok(statuses.some(({ key, text }) => key === "activity-judge" && /retry 1\/5/.test(text ?? "")));

  verdict = false;
  ctx.mode = "print";
  const denied = event("catalog", {});
  assert.equal((await gate(denied))?.block, true);
  await handlers.tool_execution_end({ ...denied, isError: true, durationMs: 99 }, ctx);
  await handlers.tool_result({ ...denied, isError: true }, ctx);
  assert.equal(snapshot().history.at(-1).durationMs, undefined, "blocked calls cannot acquire execution timing");
  assert.equal(snapshot().totals.blocked, 1);
  assert.equal(snapshot().totals.mcp, 3, "blocked tool never counts as executed");
  const invalid = event("catalog", { invalid: undefined });
  assert.equal((await gate(invalid))?.block, true);
  await commands["read-only"]("on", ctx);
  assert.equal((await gate(event("write", { path: "x" })))?.block, true);
  const beforeDelegation = reviewCalls;
  assert.equal((await gate(event("subagent", { task: "synthetic" })))?.block, true);
  assert.equal(reviewCalls, beforeDelegation + 1, "guarded delegation blocks on judge denial, not a blanket veto");
  await commands["read-only"]("off", ctx);
  assert.equal(snapshot().totals.blocked, 4, "invalid evidence, hard file guard and judge-denied delegation all counted");

  ctx.mode = "tui";
  ctx.ui.custom = approvalFixture(ctx, (done) => done("Allow"));
  const override = event("catalog", {});
  assert.equal((await gate(override))?.block, undefined);
  await finish(override);
  assert.equal(snapshot().telemetry.approvals.prompts, 1);
  assert.equal(snapshot().telemetry.approvals.choices.allow, 1);
  assert.equal(snapshot().telemetry.approvals.effectiveOverrides, 1);
  ctx.ui.custom = approvalFixture(ctx, async (done) => { await commands["read-only"]("on", ctx); done("Allow"); });
  assert.equal((await gate(event("catalog", {})))?.block, true);
  assert.equal(snapshot().telemetry.approvals.choices.allow, 2);
  assert.equal(snapshot().telemetry.approvals.effectiveOverrides, 1, "choice is not an override when a guard changes");
  await commands["read-only"]("off", ctx);

  // Real installed pipeline: validation, block and abort do not enter afterToolCall.
  const inert = { name: "bash", description: "Synthetic inert tool", parameters: Type.Object({ command: Type.String() }),
    execute: async () => { throw new Error("synthetic execution error"); } };
  const runtimeTrace = [];
  const realRun = async (input, block = false, abort = false) => {
    const e = event("bash", input), controller = new AbortController();
    await handlers.tool_execution_start({ ...e, args: input }, ctx);
    const result = await runToolCall({ type: "toolCall", id: e.toolCallId, name: "bash", arguments: input }, {
      assistantMessage: {}, context: { messages: [], tools: [inert] }, signal: controller.signal,
      beforeToolCall: async () => { runtimeTrace.push("gate"); const decision = await handlers.tool_call(e, ctx);
        if (abort) controller.abort(); return block ? { block: true, reason: "another extension" } : decision; },
      afterToolCall: async (outcome) => { runtimeTrace.push("result"); await handlers.tool_result({ ...e, isError: outcome.isError }, ctx); },
    });
    await handlers.tool_execution_end({ ...e, isError: result.isError, durationMs: result.durationMs }, ctx);
    const receipt = snapshot().history.at(-1);
    assert.equal(receipt.durationMs, result.durationMs, "installed host execute timing reaches the persisted observation");
    assert.equal(typeof receipt.durationMs, runtimeTrace.includes("result") ? "number" : "undefined");
  };
  const beforeReal = snapshot().totals.sh;
  await realRun({}); assert.deepEqual(runtimeTrace.splice(0), []);
  await realRun({ command: "inert" }, true); assert.deepEqual(runtimeTrace.splice(0), ["gate"]);
  await realRun({ command: "inert" }, false, true); assert.deepEqual(runtimeTrace.splice(0), ["gate"]);
  await realRun({ command: "inert" }); assert.deepEqual(runtimeTrace.splice(0), ["gate", "result"]);
  assert.equal(snapshot().totals.sh, beforeReal + 1);
  await handlers.user_bash({ command: "export API_KEY=synthetic_user_secret_123" }, ctx);
  assert.equal(snapshot().totals.sh, beforeReal + 1, "submission does not prove execution");
  entries.push({ type: "message", id: "bash-receipt", message: { role: "bashExecution", command: "export API_KEY=synthetic_user_secret_123", output: "NEVER_CAPTURE_OUTPUT", exitCode: 0 } });
  await handlers.message_end({}, ctx);
  await handlers.agent_settled({}, ctx);
  assert.equal(snapshot().totals.sh, beforeReal + 1, "receipts without provenance do not fabricate executed counts");
  assert.ok(!JSON.stringify(snapshot()).includes("NEVER_CAPTURE"));
  assert.ok(!JSON.stringify(snapshot()).includes("synthetic_user_secret_123"));

  delete ctx.ui.custom; // Exercise the panel's notification fallback separately.
  await commands.activity("details", ctx);
  assert.match(notifications.at(-1), /Nine independent heads/);
  assert.match(notifications.at(-1), /≥\d+ observed/);
  await commands["bash-history"]("complete", ctx);
  assert.match(notifications.at(-1), /omitted/);
  let themeCalls = 0, renders = 0;
  const openedTabs = [];
  ctx.ui.custom = async (factory, options) => {
    const tui = { terminal: { rows: 24, columns: 180 }, requestRender() { renders++; } };
    const component = factory(tui, { fg(_color, text) { themeCalls++; return text; } }, {}, () => {});
    assert.equal(options.overlay, true);
    assert.equal(options.overlayOptions.maxHeight, "80%");
    assert.equal(options.overlayOptions.width, 110);
    assert.equal(options.overlayOptions.margin, undefined, "no impossible fixed margins on tiny terminals");
    openedTabs.push(component.tab);
    for (const width of [1, 8, 24, 80, 160]) {
      component.invalidate();
      assert.ok(component.render(width).every((line) => visibleWidth(line) <= width), `custom dashboard fits width ${width}`);
    }
    component.handleInput("\u001b[B");
    component.handleInput("\r");
  };
  await commands.activity("details", ctx);
  await commands["mcp-history"]("complete", ctx);
  assert.deepEqual(openedTabs, ["diagnostics", "history"]);
  assert.ok(themeCalls > 0 && renders > 0, "themed responsive panels use the host component path");
  delete ctx.ui.custom;
  const footer = statuses.findLast(({ key, text }) => key === "activity" && text)?.text;
  assert.match(footer, /^🛡️ · files:\d+\(\d+\) sh:\d+\(\d+\) MCP:\d+\(\d+\) blk:\d+\(\d+\)$/);
  assert.ok(!footer.includes("auto"));

  // UI and observational failures must not change an otherwise native allow.
  const originalGate = ActivityObservations.prototype.gate;
  ActivityObservations.prototype.gate = () => { throw new Error("synthetic observer failure"); };
  const setStatus = ctx.ui.setStatus;
  ctx.ui.setStatus = () => { throw new Error("synthetic UI failure"); };
  try { assert.equal((await gate(event("write", { path: "safe.txt" })))?.block, undefined); }
  finally { ActivityObservations.prototype.gate = originalGate; ctx.ui.setStatus = setStatus; }

  await handlers.before_agent_start({}, ctx);
  const releases = [];
  reviewImpl = async () => new Promise((resolve) => { releases.push(resolve); });
  const pending = gate(event("catalog", {}));
  const sibling = gate(event("catalog", {}));
  while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(statuses.some(({ key, text }) => key === "activity-judge" && text?.includes("×2")), "live review status exposes concurrency");
  assert.equal(snapshot().guardWaitPending, 2, "parallel admission handlers have independent waiting tokens");
  const widgets = [];
  ctx.ui.setWidget = (key, factory, options) => { widgets.push({ key, factory, options }); };
  await commands.activity("", ctx);
  const statusWidget = widgets.at(-1);
  assert.equal(statusWidget.key, "activity-status");
  assert.equal(statusWidget.options.placement, "belowEditor");
  const widget = statusWidget.factory({}, ctx.ui.theme);
  for (const width of [0, 1, 24, 80, 110, 180]) assert.ok(widget.render(width).every((line) => visibleWidth(line) <= width));
  const row = widget.render(180)[0];
  assert.match(row, /^🛡️ · files:.*⚖️ judge \d+s elapsed · \d+s left.*×2/);
  assert.equal(visibleWidth(row), 180, "the dedicated activity row retains right alignment, unlike sanitized status text");
  assert.equal((row.match(/s elapsed/g) ?? []).length, 1);
  assert.equal(statuses.findLast(({ key }) => key === "activity")?.text, undefined, "widget path clears only activity-owned status lines");
  assert.equal(statuses.findLast(({ key }) => key === "activity-judge")?.text, undefined);
  await handlers.session_tree({}, ctx);
  assert.ok(!widgets.at(-1).factory({}, ctx.ui.theme).render(180)[0].includes("judge"), "tree clears the live judge row");
  assert.equal((await pending)?.block, true, "tree cancels pending review rather than permitting stale verdicts");
  assert.equal((await sibling)?.block, true);
  for (const release of releases) release({ ok: true, allow: true, reason: "late synthetic allow" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(statuses.findLast(({ key }) => key === "activity-judge")?.text, undefined);
  releases.length = 0;
  const quitting = gate(event("catalog", {}));
  while (!releases.length) await new Promise((resolve) => setTimeout(resolve, 1));
  await handlers.session_shutdown({}, ctx);
  assert.equal(widgets.at(-1).factory, undefined, "shutdown removes only the activity widget");
  assert.equal((await quitting)?.block, true, "shutdown cancels pending deadlines immediately");
  assert.equal(statuses.findLast(({ key }) => key === "activity-judge")?.text, undefined);
  assert.equal(statuses.findLast(({ key }) => key === "activity")?.text, undefined);
  releases[0]({ ok: true, allow: true, reason: "late shutdown allow" });
  assert.ok(visibleWidth(footer) > 0);
  console.log("UI/accounting integration tests passed");
} finally {
  await handlers.session_shutdown({}, ctx);
  Classifier.prototype.classify = classify;
  for (const [key, value] of [["PI_CODING_AGENT_DIR", oldDir], ["PI_ACTIVITY_AUTO_MODE", oldAuto], ["PI_SUBAGENT_TASK", oldTask]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}
