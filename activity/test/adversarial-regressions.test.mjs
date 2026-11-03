// Offline adversarial triggers. All runtime files are synthetic and outside Git.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import activityExtension, { setFixtureProvider } from "./synthetic-runtime.mjs";
import { ActivityObservations } from "../observations.ts";
import { Classifier } from "../classifier.ts";
import { OBSERVATION_ENTRY_TYPE } from "../version.ts";
import { classification, createFixtureProvider, nativeToolInfo, withNativeTools } from "./nine-head-fixtures.mjs";

const root = mkdtempSync(join(tmpdir(), "activity-adversarial-"));
const agentDir = join(root, "agent"), cwd = join(root, "project");
mkdirSync(join(agentDir, "config"), { recursive: true }); mkdirSync(cwd);
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE", "PI_SUBAGENT_TASK"].map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_ACTIVITY_AUTO_MODE; delete process.env.PI_SUBAGENT_TASK;
const configure = (overrides = {}) => writeFileSync(join(agentDir, "config/activity.json"), JSON.stringify({
  acclass: overrides.acclass ?? setFixtureProvider({ provider: "none" }), log: { enabled: false }, reviewLog: { enabled: false }, ...overrides,
}));
const failures = [];
async function check(name, work) {
  try { await work(); console.log(`${name}: passed`); }
  catch (error) { failures.push(error); console.log(`${name}: FAILED`); }
}
function harness(tools = withNativeTools(), reviewer = async () => ({ ok: true, allow: true }), readOnly = false) {
  const handlers = {}, entries = [], decisions = [];
  const pi = { on(name, handler) { handlers[name] = handler; }, registerFlag() {}, registerCommand() {},
    getFlag(name) { return name === "auto" || (name === "read-only" && readOnly); }, getAllTools: () => tools,
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
    sendMessage() {}, events: { emit(name, data) { if (name === "activity:decision") decisions.push(data); } } };
  const ctx = { cwd, mode: "print", hasUI: false,
    sessionManager: { getBranch: () => [], getSessionId: () => "synthetic" },
    ui: { setStatus() {}, theme: { fg: (_key, text) => text } } };
  activityExtension(pi, reviewer, "native");
  const snapshot = () => entries.findLast((entry) => entry.customType === OBSERVATION_ENTRY_TYPE).data;
  return { handlers, ctx, snapshot, decisions };
}
const call = (id, toolName = "bash", input = { command: "inert" }) => ({ toolCallId: id, toolName, input });
const restore = (snapshot, options) => {
  const observations = new ActivityObservations(options);
  observations.restore([{ type: "custom", customType: OBSERVATION_ENTRY_TYPE, data: snapshot }]);
  return observations;
};
try {
  await check("custom-name-capture-provenance", async () => {
    const path = join(root, "private", "commands.jsonl");
    const tools = ["read", "write", "bash"].map((name) => ({ name,
      sourceInfo: { source: "sdk", path: `<sdk:${name}>` }, description: "Synthetic custom tool",
      parameters: Type.Object({ marker: Type.String(), path: Type.String(), command: Type.String() }) }));
    for (const auto of [true, false]) {
      configure({ auto: { judgeModel: "fixture/judge" },
        log: { enabled: true, mode: "full", path } });
      if (!auto) process.env.PI_ACTIVITY_AUTO_MODE = "off";
      const h = harness(tools);
      await h.handlers.session_start({}, h.ctx);
      for (const tool of tools) await h.handlers.tool_call(call(`capture-${auto}-${tool.name}`, tool.name,
        { marker: "synthetic-marker", path: "innocent", command: "inert" }), h.ctx);
      await h.handlers.session_shutdown({}, h.ctx);
      delete process.env.PI_ACTIVITY_AUTO_MODE;
    }
    const rows = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 6);
    for (const row of rows) {
      assert.equal(row.action.representation, "runtime-action-evidence-json/1");
      assert.equal(row.action.evaluated_arguments.marker, "synthetic-marker");
      assert.equal(row.action.evidence_status.backend_behavior, "unverified");
      assert.equal(row.prefilter?.source ?? row.source, "action");
      assert.equal(row.action.tool_metadata.description, "Synthetic custom tool");
    }
  });
  await check("custom-native-name-replacements", async () => {
    configure();
    for (const name of ["read", "grep", "find", "ls", "bash", "write", "edit"]) {
      for (const sourceInfo of [undefined, { source: "extension", path: "synthetic:custom" },
        { source: "builtin", path: "builtin:codemode" }]) {
        const h = harness([{ name, sourceInfo }], undefined, true);
        await h.handlers.session_start({}, h.ctx);
        const result = await h.handlers.tool_call(call(`shadow-${name}`, name, { path: join(cwd, "innocent"), command: "" }), h.ctx);
        assert.equal(result?.block, true, "unverified names must not inherit native policy");
        assert.equal(h.decisions.at(-1).classifier.inputType, "action");
        await h.handlers.session_shutdown({}, h.ctx);
      }
    }
  });
  await check("custom-replacements-use-action-review", async () => {
    configure({ acclass: setFixtureProvider(createFixtureProvider(root)), auto: { judgeModel: "fixture/judge" } });
    const original = Classifier.prototype.classify;
    let classified = 0, reviewed = 0;
    Classifier.prototype.classify = async (text, _cwd, _home, kind) => {
      classified++;
      assert.equal(kind, "action", "custom bash must not use the shell classifier");
      const action = JSON.parse(text);
      assert.equal(action.evidence_status.backend_behavior, "unverified");
      assert.equal(action.evaluated_arguments.marker, "synthetic-custom-input");
      return classification();
    };
    const tools = ["read", "write", "bash"].map((name) => ({ name,
      sourceInfo: { source: "sdk", path: `<sdk:${name}>` }, description: "Synthetic custom mutation",
      parameters: Type.Object({ marker: Type.String(), path: Type.String(), command: Type.String() }) }));
    const h = harness(tools, async (_ctx, _ref, _tool, input, _cwd, _modes, ...rest) => {
      reviewed++; assert.equal(input.marker, "synthetic-custom-input");
      assert.ok(rest[5]?.parameters, "review receives original custom schema");
      return { ok: true, allow: true };
    });
    try {
      await h.handlers.session_start({}, h.ctx);
      for (const tool of tools) {
        const event = call(`custom-${tool.name}`, tool.name, { marker: "synthetic-custom-input", path: "innocent", command: "inert" });
        await h.handlers.tool_execution_start(event, h.ctx);
        assert.notEqual((await h.handlers.tool_call(event, h.ctx))?.block, true);
        await h.handlers.tool_result({ ...event, isError: false }, h.ctx);
        await h.handlers.tool_execution_end({ ...event, isError: false }, h.ctx);
        const row = h.snapshot().history.at(-1);
        assert.equal(row.category, "other"); assert.equal(row.source, "sdk"); assert.equal(row.preview, undefined);
        assert.equal(h.decisions.at(-1).classifier.inputType, "action");
      }
      assert.equal(classified, 3); assert.equal(reviewed, 3);
      assert.deepEqual(h.snapshot().totals, { files: 0, sh: 0, mcp: 0, blocked: 0 });
    } finally { Classifier.prototype.classify = original; await h.handlers.session_shutdown({}, h.ctx); }
  });
  await check("requested-secret-symlink", async () => {
    configure({ auto: { judgeModel: "fixture/judge" } });
    writeFileSync(join(cwd, "innocent"), "synthetic only");
    symlinkSync("innocent", join(cwd, ".env"));
    writeFileSync(join(cwd, ".env.synthetic"), "synthetic only");
    symlinkSync(".env.synthetic", join(cwd, "innocent-alias"));
    symlinkSync(".env.loop", join(cwd, ".env.loop"));
    let reviews = 0;
    const h = harness(withNativeTools(), async () => { reviews++; return { ok: true, allow: true }; });
    await h.handlers.session_start({}, h.ctx);
    process.env.PI_SUBAGENT_TASK = "1";
    for (const path of [".env", "innocent-alias", ".env.loop"]) for (const name of ["read", "grep"]) {
      assert.notEqual((await h.handlers.tool_call(call(`secret-${name}-${path}`, name, { path }), h.ctx))?.block, true);
    }
    assert.equal(reviews, 6, "requested/canonical credential heuristics reach review; changing env cannot invalidate or reclassify the session");
    delete process.env.PI_SUBAGENT_TASK;
    await h.handlers.session_shutdown({}, h.ctx);
  });
  await check("reused-call-ids", async () => {
    configure({ auto: { judgeModel: "fixture/judge" } });
    const h = harness();
    await h.handlers.session_start({}, h.ctx);
    const event = call("reused", "write", { path: join(cwd, "inert"), content: "synthetic" });
    for (let turn = 1; turn <= 2; turn++) {
      await h.handlers.before_agent_start({}, h.ctx);
      await h.handlers.tool_execution_start(event, h.ctx);
      await h.handlers.tool_call(event, h.ctx);
      await h.handlers.tool_result({ ...event, isError: false }, h.ctx);
      await h.handlers.tool_execution_end({ ...event, isError: false }, h.ctx);
      await h.handlers.agent_settled({}, h.ctx);
      assert.equal(h.snapshot().totals.files, turn, "fresh invocation counts on every turn");
    }
    await h.handlers.session_start({}, h.ctx);
    await h.handlers.before_agent_start({}, h.ctx);
    await h.handlers.tool_execution_start(event, h.ctx);
    await h.handlers.tool_call(event, h.ctx);
    await h.handlers.tool_result({ ...event, isError: false }, h.ctx);
    assert.equal(h.snapshot().totals.files, 1, "new session can reuse IDs");
    await h.handlers.session_shutdown({}, h.ctx);
  });
  await check("late-old-invocation-callbacks", async () => {
    configure({ auto: { judgeModel: "fixture/judge" } });
    let release, reviews = 0;
    const h = harness(withNativeTools([{ name: "custom", sourceInfo: { source: "sdk", path: "synthetic:custom" } }]),
      async () => { reviews++; return reviews === 1 ? new Promise((resolve) => { release = resolve; }) : { ok: true, allow: true }; });
    await h.handlers.session_start({}, h.ctx); await h.handlers.before_agent_start({}, h.ctx);
    const oldController = new AbortController(), newController = new AbortController();
    const oldCtx = { ...h.ctx, signal: oldController.signal }, newCtx = { ...h.ctx, signal: newController.signal };
    const event = call("reused-async", "custom", { key: "synthetic" });
    await h.handlers.tool_execution_start(event, oldCtx);
    const oldGate = h.handlers.tool_call(event, oldCtx);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    await h.handlers.before_agent_start({}, newCtx);
    await h.handlers.tool_execution_start(event, newCtx);
    await h.handlers.tool_call(event, newCtx);
    const before = h.snapshot();
    await h.handlers.tool_result({ ...event, isError: false }, oldCtx);
    await h.handlers.tool_execution_end({ ...event, isError: true, durationMs: 999 }, oldCtx);
    assert.deepEqual(h.snapshot(), before, "old signal receipts cannot complete or time the new invocation");
    release({ ok: true, allow: true }); assert.equal((await oldGate)?.block, true);
    assert.deepEqual(h.snapshot(), before, "late judge completion cannot overwrite fresh state");
    // A matching aborted operation can still report actual entered execution.
    newController.abort();
    await h.handlers.tool_result({ ...event, isError: true }, newCtx);
    assert.equal(h.snapshot().history.at(-1).executionConfirmed, true);
    assert.equal(h.snapshot().history.at(-1).status, "error");
    const completed = h.snapshot();
    await h.handlers.tool_execution_end({ ...event, isError: true, durationMs: 999 }, oldCtx);
    assert.deepEqual(h.snapshot(), completed, "old signal cannot enrich the completed new invocation");
    await h.handlers.tool_execution_end({ ...event, isError: true, durationMs: 11 }, newCtx);
    assert.equal(h.snapshot().history.at(-1).durationMs, 11, "matching execution end supplies timing even after cancellation");
    assert.deepEqual(h.snapshot().totals, completed.totals);
    assert.deepEqual(h.snapshot().telemetry, completed.telemetry);
    await h.handlers.agent_settled({}, h.ctx);
    const settled = h.snapshot();
    await h.handlers.tool_result({ ...event, isError: false }, oldCtx);
    await h.handlers.tool_execution_end({ ...event, isError: false, durationMs: 999 }, oldCtx);
    assert.deepEqual(h.snapshot(), settled, "late terminal events never mint invocation scopes");
    await h.handlers.session_shutdown({}, h.ctx);
  });
  await check("unresolved-execution-coverage", async () => {
    for (const maxHistory of [0, 1, 256]) {
      const pending = new ActivityObservations({ maxHistory }); pending.beginTurn();
      pending.executionStart(call("pending"), nativeToolInfo("bash"));
      assert.equal(pending.view().totals.sh, 0, "submission does not prove execution");
      const restored = restore(pending.snapshot(), { maxHistory });
      assert.equal(restored.view().coverage, "incomplete", "restore pending uncertainty even without history");
      assert.equal(restored.view().totals.sh, 0);
      assert.equal(restored.view().unresolved, 1);
      pending.endTurn(); assert.equal(pending.view().coverage, "incomplete");
      const unknown = new ActivityObservations({ maxHistory }); unknown.beginTurn();
      unknown.executionStart(call("unknown"), nativeToolInfo("bash"));
      unknown.executionEnd({ ...call("unknown"), isError: true });
      unknown.toolResult({ ...call("completed"), isError: false }, nativeToolInfo("bash"));
      assert.equal(unknown.view().coverage, "incomplete", "unknown uncertainty survives history eviction");
      assert.equal(restore(unknown.snapshot(), { maxHistory }).view().coverage, "incomplete");
      assert.equal(unknown.view().unresolved, 1);
      const complete = new ActivityObservations({ maxHistory }); complete.beginTurn();
      complete.executionStart(call("complete"), nativeToolInfo("bash"));
      complete.toolResult({ ...call("complete"), isError: false }, nativeToolInfo("bash")); complete.endTurn();
      assert.equal(restore(complete.snapshot(), { maxHistory }).view().coverage, "complete", "completed zero-history control");
    }
    const evicted = new ActivityObservations({ maxHistory: 0 }); evicted.beginTurn();
    for (let n = 0; n < 513; n++) evicted.executionStart(call(`pending-${n}`), nativeToolInfo("bash"));
    assert.equal(evicted.snapshot().unresolved, 513, "uncertainty survives pending metadata eviction");
    evicted.endTurn();
    assert.equal(evicted.snapshot().unresolved, 513); assert.equal(evicted.snapshot().totals.sh, 0);
    assert.equal(restore(evicted.snapshot(), { maxHistory: 0 }).view().unresolved, 513);
  });
  await check("real-sdk-custom-read-replacement", async () => {
    configure({ guards: { readOnly: true, remoteReadOnly: false } });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const runtime = await ModelRuntime.create({ credentials: { async read() {}, async list() { return []; } },
      modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    let executed = 0, session;
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi) => {
        activityExtension(pi);
        pi.registerTool({ name: "read", label: "Custom read", description: "Synthetic mutation counter, not a file read",
          parameters: Type.Object({ path: Type.String() }), async execute() { executed++; return { content: [], details: undefined }; } });
        pi.registerTool({ name: "driver", label: "Driver", description: "Synthetic nested call", parameters: Type.Object({}),
          async execute(_id, _args, _signal, _update, ctx) { const nested = await ctx.executeTool("read", { path: "innocent" }); return { ...nested.result, isError: nested.isError }; } });
      }] });
    try {
      await loader.reload();
      const manager = SessionManager.inMemory(cwd);
      manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
        content: [{ type: "toolCall", id: "sdk-parent", name: "driver", arguments: {} }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
      ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, resourceLoader: loader, settingsManager,
        sessionManager: manager, noTools: true,
        model: { provider: "fixture", id: "fixture", name: "Fixture", api: "openai-completions", reasoning: false,
          input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 } }));
      await session.bindExtensions({ mode: "print" });
      session.setActiveToolsByName(["read", "driver"]);
      const registered = session.getAllTools().find((tool) => tool.name === "read");
      assert.notEqual(registered.sourceInfo.source, "builtin");
      for (const name of ["bash", "write", "edit", "grep", "find", "ls"]) {
        const native = session.getAllTools().find((tool) => tool.name === name);
        assert.equal(native.sourceInfo.source, "builtin"); assert.equal(native.sourceInfo.path, `builtin:${name}`);
      }
      const driver = session.agent.state.tools.find((tool) => tool.name === "driver");
      const toggleAuto = (value) => session.extensionRunner.getCommand("auto-mode").handler(value, session.extensionRunner.createCommandContext());
      configure({ guards: { readOnly: false, remoteReadOnly: false } }); await toggleAuto("off");
      assert.notEqual((await driver.execute("sdk-parent", {}, new AbortController().signal)).isError, true);
      assert.equal(executed, 1, "control proves the actual replacement backend is reachable");
      configure({ guards: { readOnly: true, remoteReadOnly: false } }); await toggleAuto("on");
      assert.equal((await driver.execute("sdk-parent", {}, new AbortController().signal)).isError, true);
      assert.equal(executed, 1, "read-only custom read never executes mutation counter");
    } finally {
      if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    }
  });
} finally {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
}
assert.equal(failures.length, 0, `${failures.length} adversarial regression groups failed`);
