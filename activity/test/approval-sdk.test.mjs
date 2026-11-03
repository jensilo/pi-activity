// Installed Pi SDK direct and nested tool pipelines, with real approval rendering
// and key handling. All configuration, messages, tools and provider responses are
// synthetic; no real terminal, credentials, logs, model requests or workers run.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Container, getKeybindings, stripTerminalSequences, visibleWidth, TuiMainScreen } from "@earendil-works/pi-tui";
import activityExtension from "../index.ts";
import { judgeSafety } from "../judge.ts";
import { MAX_ACTION_CHARS } from "../context.ts";
import { requestApproval } from "../approval.ts";
import { assertCompleteArguments, collectApprovalEvidence, escapedEvidence } from "./approval-fixture.mjs";

const require = createRequire(import.meta.url);
const host = process.env.PI_GLOBAL ?? dirname(dirname(require.resolve("@earendil-works/pi-coding-agent")));
const load = (path) => import(pathToFileURL(join(host, "dist", path)).href);
const { InteractiveMode } = await load("modes/interactive/interactive-mode.js");
const { Theme, setThemeInstance } = await load("modes/interactive/theme/theme.js");
const theme = new Theme({ dim: 244, muted: 244, accent: 39, warning: 214, text: 255, border: 244, thinkingXhigh: 141 },
  { selectedBg: 0 }, "256color", { name: "synthetic-sdk-approval" });
setThemeInstance(theme);

const dir = mkdtempSync(join(tmpdir(), "activity-approval-sdk-"));
const savedEnv = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE", "PI_SUBAGENT_TASK"]
  .map((key) => [key, process.env[key]]));
process.env.HOME = join(dir, "home");
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.PI_ACTIVITY_AUTO_MODE;
delete process.env.PI_SUBAGENT_TASK;
mkdirSync(process.env.HOME);
mkdirSync(join(dir, "config"));

const refError = "ref.lastIndexOf is not a function";
const provider = "approval-fixture";
const model = (id) => ({ provider, id, name: "Inert approval fixture", api: "synthetic-approval-sdk", baseUrl: "",
  reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const models = [model("main"), model("judge")];
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const nullableString = Type.Union([Type.String(), Type.Null()]);
const parameters = Type.Object({ agent: Type.String(), task: Type.String(), tier: Type.String(), readOnly: Type.Boolean(),
  thinking: Type.Optional(nullableString), tasks: Type.Optional(Type.Null()), chain: Type.Optional(Type.Null()),
  agentScope: Type.Optional(nullableString), confirmProjectAgents: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  cwd: Type.Optional(nullableString), tail: Type.String(),
  payload: Type.Optional(Type.Object({ notes: Type.Array(Type.String()) })) });
function argumentsFor(tail, oversized = false) {
  return { agent: "scout", task: "Inspect only inert synthetic evidence. " + "synthetic evidence ".repeat(oversized ? 16_000 : 180),
    tier: "cheap", readOnly: true, thinking: null, tasks: null, chain: null, agentScope: null,
    confirmProjectAgents: null, cwd: null, tail, payload: { notes: ["ORIGINAL_SYNTHETIC"] } };
}
function configure({ judge = true, readOnly = false, remoteReadOnly = false } = {}) {
  writeFileSync(join(dir, "config/activity.json"), JSON.stringify({
    acclass: { enabled: false }, auto: { judgeModel: judge ? `${provider}/judge` : null },
    guards: { readOnly, remoteReadOnly }, policy: { trustedTools: ["fixture_driver"] }, display: { enabled: false },
    session: { persistModes: false, persistActivity: false }, log: { enabled: false }, reviewLog: { enabled: false },
  }));
}

let session;
let nextCalls = [];
let reviewMode = "throw";
let backendThrows = false;
let laterMutation;
let streams = 0;
const reviews = [], executions = [], admissions = [], results = [], ends = [], decisions = [];
const plans = [], prompts = [], uiErrors = [];
// Mount the real approval component through the installed host prototype. The
// real TUI routes keys; no overlay or physical terminal is created.
async function inlineCustom(factory, options, onOpen) {
  assert.notEqual(options?.overlay, true);
  const terminal = { columns: 80, rows: 24, write() {}, hideCursor() {}, showCursor() {},
    start() { assert.fail("no real terminal"); }, stop() { assert.fail("no real terminal"); } };
  const tui = new TuiMainScreen(terminal);
  const editorInputs = [];
  const savedText = "synthetic draft\nsecond synthetic line";
  let editorText = savedText;
  const editor = { render: () => ["synthetic editor"], invalidate() {}, getText: () => editorText,
    setText(text) { editorText = text; }, handleInput(data) { editorInputs.push(data); } };
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  tui.addChild(editorContainer);
  tui.setFocus(editor);
  const receiver = Object.assign(Object.create(InteractiveMode.prototype), {
    ui: tui, editor, editorContainer, keybindings: getKeybindings(),
    extensionDialogs: [], programStatus: { setBlocked() {} },
  });
  let view, complete, disposals = 0, completions = 0, keyError;
  const pending = receiver.showExtensionCustom((...args) => {
    complete = args[3];
    view = factory(...args);
    const dispose = view.dispose?.bind(view);
    view.dispose = () => { disposals++; dispose?.(); };
    return view;
  }, options);
  pending.then(() => { completions++; });
  const input = setImmediate(() => {
    try {
      assert.equal(tui.getFocusedComponent(), view, "inline approval owns keyboard focus");
      assert.equal(tui.hasOverlay(), false);
      assert.deepEqual(editorContainer.children, [view]);
      // A changed backing draft must be restored from the host's saved text.
      editor.setText("synthetic draft changed while approval is open");
      tui.renderNow();
      const rendered = view.render(80);
      assert.ok(rendered.length <= 18);
      const body = rendered.map(stripTerminalSequences).slice(2, -6);
      assert.ok(body.length > 0 && body.length <= 10, "inline evidence has at most ten rows");
      assert.ok(body.every((line) => line.startsWith(" ") && line.endsWith(" ")), "side padding is invisible");
      assert.ok(rendered.every((line) => visibleWidth(line) <= 80));
      assert.match(rendered.map(stripTerminalSequences).join("\n"), /→ Block/);
      onOpen(view, (key) => tui.handleTerminalInput(key));
    } catch (error) {
      keyError = error;
      complete("cancelled");
    }
  });
  try {
    const result = await pending;
    if (keyError) throw keyError;
    assert.equal(completions, 1);
    assert.equal(disposals, 1, "host disposes the inline component exactly once");
    assert.equal(tui.getFocusedComponent(), editor, "completion/cancellation restores editor focus");
    assert.deepEqual(editorContainer.children, [editor]);
    assert.equal(editorText, savedText, "the host restores the editor draft captured before mounting");
    assert.equal(tui.hasOverlay(), false);
    tui.handleTerminalInput("\x1b[B");
    tui.handleTerminalInput("\r");
    assert.deepEqual(editorInputs, ["\x1b[B", "\r"], "keys after completion go only to the editor");
    assert.equal(completions, 1, "stale keys cannot complete the approval again");
    return result;
  } finally {
    clearImmediate(input);
    tui.stopped = true;
    tui.cancelRenderTimer();
  }
}

const ui = {
  theme, setStatus() {}, setWidget() {}, notify() {},
  async custom(factory, options) {
    try {
      const plan = plans.shift();
      assert.ok(plan, "unexpected approval prompt");
      const result = await inlineCustom(factory, options, (view, key) => {
        assert.equal(view.page, 0, "full evidence is directly available from page one");
        assert.equal(view.selected, 0, "approval starts on Block");
        key("\x1b[B");
        assert.equal(view.selected, 1, "Down selects Allow through real TUI routing");
        const evidence = collectApprovalEvidence(view, key);
        assertCompleteArguments(evidence, plan.input);
        assert.ok(evidence.includes(`Tool call:${plan.tool} · cwd: ${escapedEvidence(dir)}`));
        assert.match(evidence, /Review:Safety review unavailable \(technical failure\)/);
        assert.match(evidence, plan.reason);
        if (plan.choice === "block") key("k");
        key("\r");
      });
      assert.equal(result, plan.choice);
      prompts.push({ choice: plan.choice, tool: plan.tool });
      return result;
    } catch (error) {
      // The gate catches UI errors, so keep an independent assertion receipt.
      uiErrors.push(error);
      throw error;
    }
  },
};

try {
  const inspection = { agent: "synthetic", thinking: null, task: "x".repeat(128),
    tail: "INSPECTION_TAIL", escapes: "\\path\n\t\x1b\u202e", frame: "│ leading and trailing │ " };
  async function inspectLifecycle(outcome) {
    const cancellation = new AbortController();
    const existingListener = () => {};
    cancellation.signal.addEventListener("abort", existingListener);
    const listenersBefore = getEventListeners(cancellation.signal, "abort").length;
    let mounts = 0;
    const custom = (factory, options) => {
      mounts++;
      return inlineCustom(factory, options, (view, key) => {
        if (outcome === "timeout") return; // Only inactivity, not a host countdown, expires it.
        const evidence = collectApprovalEvidence(view, key);
        assertCompleteArguments(evidence, inspection);
        assert.throws(() => assertCompleteArguments(evidence.replace("INSPECTION_TAIL", "MISSING_TAIL"), inspection));
        assert.ok(evidence.includes("│ leading and trailing │ "), "evidence preserves literal frames and trailing spaces");
        if (outcome === "allow") { key("j"); key("\r"); }
        else if (outcome === "block") key("\r");
        else if (outcome === "cancelled") key("\x1b");
        else if (outcome === "ctrl-c") key("\x03");
        else cancellation.abort();
      });
    };
    const context = { mode: "tui", hasUI: true, signal: cancellation.signal, ui: { custom } };
    assert.equal(await requestApproval(context, "synthetic", "synthetic", outcome === "timeout" ? 40 : 1000,
      JSON.stringify(inspection)), ["abort", "ctrl-c"].includes(outcome) ? "cancelled" : outcome);
    assert.equal(mounts, 1);
    assert.equal(getEventListeners(cancellation.signal, "abort").length, listenersBefore,
      "completion preserves the caller's pre-existing cancellation listener");
    if (outcome === "abort") {
      assert.equal(await requestApproval(context, "synthetic", "synthetic", 1000), "cancelled");
      assert.equal(mounts, 1, "pre-aborted approval does not mount over the editor");
    }
    cancellation.signal.removeEventListener("abort", existingListener);
  }
  for (const outcome of ["block", "allow", "cancelled", "ctrl-c", "timeout", "abort"]) await inspectLifecycle(outcome);
  configure();
  const emptyCredentials = { read: async () => undefined, list: async () => [],
    modify: async () => assert.fail("no credential writes"), delete: async () => assert.fail("no credential deletes") };
  const modelRuntime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider({ id: provider, name: "Memory-only synthetic provider",
    auth: { apiKey: { name: "Keyless fixture", resolve: async () => ({ auth: {}, source: "synthetic" }) } },
    getModels: () => models,
    stream: () => assert.fail("no API-specific streaming"),
    streamSimple(activeModel, _context, options) {
      streams++;
      assert.equal(activeModel.provider, provider);
      assert.equal(activeModel.id, "main", "oversized review must fail before any judge provider dispatch");
      assert.equal(options.apiKey, undefined);
      const stream = createAssistantMessageEventStream();
      const calls = nextCalls;
      nextCalls = [];
      queueMicrotask(() => {
        const message = { role: "assistant", api: activeModel.api, provider, model: activeModel.id,
          content: calls.length ? calls : [{ type: "text", text: "Synthetic turn complete." }],
          usage: structuredClone(usage), stopReason: calls.length ? "toolUse" : "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
      });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      activityExtension(pi, async (...args) => {
        reviews.push({ tool: args[2], input: structuredClone(args[3]), ref: args[1] });
        if (args[2] === "fixture_driver") return { ok: true, allow: true, reason: "Inert driver delegates individually gated calls" };
        if (reviewMode === "throw") throw new TypeError(refError);
        if (reviewMode === "unavailable") return { ok: false, reason: refError };
        if (reviewMode === "oversized") return judgeSafety(...args);
        assert.fail("unknown synthetic review mode");
      });
      pi.events.on("activity:decision", (event) => decisions.push(event));
      pi.on("tool_call", (event, ctx) => {
        assert.equal(ctx.mode, "tui");
        assert.equal(ctx.hasUI, true);
        admissions.push({ id: event.toolCallId, parent: event.parentToolCallId, tool: event.toolName });
        if (event.toolName === "fixture_driver") return;
        if (laterMutation === "root") event.input.tail = "UNAPPROVED_SYNTHETIC";
        if (laterMutation === "nested") event.input.payload.notes.push("UNAPPROVED_SYNTHETIC");
        if (laterMutation === "delete") delete event.input.task;
        if (laterMutation === "reassign") event.input = { ...event.input, tail: "UNAPPROVED_SYNTHETIC" };
      });
      pi.on("tool_result", (event) => results.push({ id: event.toolCallId, parent: event.parentToolCallId,
        tool: event.toolName, isError: event.isError, text: event.content.map((part) => part.text ?? "").join("\n") }));
      for (const name of ["subagent", "fixture_custom"]) pi.registerTool({ name, label: name,
        description: "Inert synthetic fixture; never delegates or invokes a backend service", parameters,
        async execute(id, input) {
          executions.push({ id, tool: name, input: structuredClone(input) });
          if (backendThrows) throw new TypeError(refError);
          return { content: [{ type: "text", text: "Inert fixture executed." }], details: undefined };
        },
      });
      pi.registerTool({ name: "fixture_driver", label: "Driver", description: "Synthetic nested pipeline driver",
        parameters: Type.Object({ target: Type.String(), input: parameters }),
        async execute(_id, { target, input }, _signal, _update, ctx) {
          const nested = await ctx.executeTool(target, input);
          return { ...nested.result, isError: nested.isError };
        },
      });
    }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader, settingsManager,
    sessionManager: SessionManager.inMemory(dir), modelRuntime, model: models[0], thinkingLevel: "off", noTools: true }));
  await session.bindExtensions({ mode: "tui", uiContext: ui });
  session.subscribe((event) => { if (event.type === "tool_execution_end") ends.push(event); });
  assert.deepEqual(session.getActiveToolNames().sort(), ["fixture_custom", "fixture_driver", "subagent"]);

  let serial = 0;
  async function run(route, tool, input, { choice = "allow", reason = /ref\.lastIndexOf is not a function/,
    allowed = true, reviewCount = 1, hardGuard = false } = {}) {
    const id = `synthetic-${++serial}`;
    const before = { reviews: reviews.length, executions: executions.length, admissions: admissions.length,
      results: results.length, ends: ends.length, decisions: decisions.length, prompts: prompts.length };
    if (!hardGuard) plans.push({ tool, input, choice, reason });
    nextCalls = [{ type: "toolCall", id, name: route === "direct" ? tool : "fixture_driver",
      arguments: route === "direct" ? input : { target: tool, input } }];
    await session.prompt("Exercise only the inert synthetic fixture tool.");
    await session.waitForIdle();
    if (uiErrors.length) throw uiErrors[0];
    assert.equal(plans.length, 0, "the expected approval must actually open");
    assert.equal(prompts.length - before.prompts, hardGuard ? 0 : 1);
    const newReviews = reviews.slice(before.reviews);
    const targetReviews = newReviews.filter((review) => review.tool === tool);
    assert.equal(targetReviews.length, reviewCount, "one logical target review, no post-approval second veto");
    assert.equal(newReviews.filter((review) => review.tool === "fixture_driver").length,
      hardGuard && route === "nested" ? 1 : 0, "trusted driver also needs constrained review under guards");
    const executed = executions.slice(before.executions);
    const executionAllowed = allowed && !laterMutation; // Frozen tree AND bound input property.
    assert.equal(executed.length, executionAllowed ? 1 : 0, "only unchanged human-approved arguments can execute");
    if (executionAllowed) {
      assert.equal(executed[0].tool, tool);
      assert.deepEqual(executed[0].input, input, "SDK/backend receives every original field unchanged");
    }
    for (const review of targetReviews) {
      assert.equal(review.tool, tool);
      assert.equal(review.ref, `${provider}/judge`);
      assert.deepEqual(review.input, input);
    }
    const targetEnd = ends.slice(before.ends).filter((event) => event.toolName === tool);
    assert.equal(targetEnd.length, 1, "target finishes once in the actual SDK execution pipeline");
    const targetId = targetEnd[0].toolCallId;
    if (route === "nested") {
      assert.equal(targetEnd[0].parentToolCallId, id);
      assert.match(targetId, new RegExp(`^${id}/[0-9]+$`));
    } else {
      assert.equal(targetId, id);
      assert.equal(targetEnd[0].parentToolCallId, undefined);
    }
    const admission = admissions.slice(before.admissions).filter((event) => event.tool === tool);
    // Pi stops tool_call handler propagation at a block; our later observer only sees allows.
    assert.equal(admission.length, allowed ? 1 : 0);
    const decision = decisions.slice(before.decisions).filter((event) => event.callId === targetId);
    assert.equal(decision.length, 1);
    assert.equal(decision[0].verdict, allowed ? "allow" : "block");
    assert.equal(decision[0].route, allowed ? "user-override" : "final-block");
    if (allowed) assert.equal(decision[0].reason, "auto:user-allow");
    const targetResults = results.slice(before.results).filter((event) => event.tool === tool);
    assert.equal(targetResults.length, executionAllowed ? 1 : 0, "admission blocks never become executed tool_result events");
    const failed = !executionAllowed || backendThrows;
    assert.equal(targetEnd[0].isError, failed);
    const transcriptResult = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
    assert.ok(transcriptResult);
    assert.equal(transcriptResult.isError, failed);
    if (backendThrows && allowed) {
      assert.equal(targetResults[0].text, refError, "the identical ref error is an execution failure after approval");
      assert.equal(targetResults[0].isError, true);
      assert.doesNotMatch(targetResults[0].text, /Blocked|declined|Safety review/);
    }
  }

  for (const route of ["direct", "nested"]) {
    for (const tool of ["subagent", "fixture_custom"]) {
      for (reviewMode of ["throw", "unavailable"]) {
        configure();
        const input = argumentsFor(`FULL_TAIL_${route}_${tool}_${reviewMode}`);
        assert.ok(JSON.stringify(input).length > 2000);
        await run(route, tool, input);
        // The previous Allow and stale key presses grant nothing to another tool or new arguments.
        await run(route, tool === "subagent" ? "fixture_custom" : "subagent",
          argumentsFor(`UNRELATED_NEXT_TAIL_${serial}`), { choice: "block", allowed: false });
      }
      backendThrows = true;
      await run(route, tool, argumentsFor(`BACKEND_ERROR_TAIL_${serial}`));
      backendThrows = false;
      configure({ judge: false });
      await run(route, tool, argumentsFor(`UNCONFIGURED_TAIL_${serial}`), {
        reason: /judge disabled or no current chat model available/, reviewCount: 0 });
      configure();
      reviewMode = "oversized";
      const oversized = argumentsFor(`OVERSIZED_TAIL_${serial}`, true);
      assert.ok(JSON.stringify(oversized).length > MAX_ACTION_CHARS);
      await run(route, tool, oversized, { reason: /proposed action exceeds safety review input limit/ });
    }
    configure();
    reviewMode = "unavailable";
    for (laterMutation of ["root", "nested", "delete", "reassign"]) {
      await run(route, "fixture_custom", argumentsFor(`LATER_MUTATION_${laterMutation}_${route}`));
    }
    laterMutation = undefined;
    for (const guard of ["readOnly", "remoteReadOnly"]) {
      configure({ [guard]: true });
      await run(route, "subagent", argumentsFor(`HARD_GUARD_TAIL_${guard}_${route}`), {
        allowed: false, reviewCount: 1, hardGuard: true });
    }
  }
  assert.equal(plans.length, 0);
  assert.equal(streams, serial * 2, "only the synthetic tool-call turn and follow-up run; no judge dispatch or retry");
  console.log("approval SDK tests passed: direct/nested calls, full evidence, exact one-shot approval, denial, execution errors, missing judge, real oversized review limit and hard guards");
} finally {
  if (session) {
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}
