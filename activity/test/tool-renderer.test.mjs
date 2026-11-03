// Synthetic, offline coverage: Activity owns blocks, not renderers or execution errors.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import activityExtension from "../index.ts";
import { withNativeTools } from "./nine-head-fixtures.mjs";

// Resolve the actual installed host, including its native interactive row.
const require = createRequire(import.meta.url);
const host = process.env.PI_GLOBAL ?? dirname(dirname(require.resolve("@earendil-works/pi-coding-agent")));
const hostImport = (path) => import(pathToFileURL(join(host, "dist", path)).href);
const { createAgentSession, createBashToolDefinition, createEditToolDefinition, createReadToolDefinition,
  createWriteToolDefinition, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await hostImport("index.js");
const { ToolExecutionComponent } = await hostImport("modes/interactive/components/tool-execution.js");
const { Theme, setThemeInstance } = await hostImport("modes/interactive/theme/theme.js");
const theme = new Theme({ text: 255, dim: 244, thinkingXhigh: 141, toolTitle: 255, accent: 39, muted: 244,
  error: 196, toolOutput: 250, toolDiffAdded: 46, toolDiffRemoved: 160, toolDiffContext: 245 },
{ selectedBg: 0, toolPendingBg: 17, toolSuccessBg: 22, toolErrorBg: 52 }, "256color", { name: "synthetic-native" });
setThemeInstance(theme);

const dir = mkdtempSync(join(tmpdir(), "activity-native-renderers-"));
const keys = ["HOME", "PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE", "PI_SUBAGENT_TASK", "PI_SUBAGENT_POLICY_CONTEXT_FD"];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
process.env.HOME = join(dir, "home");
process.env.PI_CODING_AGENT_DIR = dir;
for (const key of keys.slice(2)) delete process.env[key];
mkdirSync(process.env.HOME);
mkdirSync(join(dir, "config"));
writeFileSync(join(dir, "synthetic.txt"), "before\n");
writeFileSync(join(dir, "config/activity.json"), JSON.stringify({
  acclass: { enabled: false }, auto: { judgeModel: null }, display: { enabled: false },
  session: { persistModes: false, persistActivity: false }, log: { enabled: false }, reviewLog: { enabled: false },
}));
const editArgs = { path: "synthetic.txt", edits: [{ oldText: "before", newText: "after" }] };
const success = { content: [{ type: "text", text: "Synthetic replacement completed" }],
  details: { diff: "-1 before\n+1 SYNTHETIC_ACTUAL_DIFF", firstChangedLine: 1 }, isError: false };
const sessions = new Set();
let handlers;
const ctx = { cwd: dir, mode: "print", hasUI: false,
  sessionManager: { getBranch: () => [], getSessionId: () => "synthetic-renderers" },
  modelRegistry: { find: () => undefined, getAll: () => [] },
  ui: { setStatus() {}, notify() {}, theme: { fg: (_color, value) => value } } };
const rowText = (definition, result, toolName = "edit", args = editArgs) => {
  const row = new ToolExecutionComponent(toolName, "synthetic-row", args, { outputPad: 1 }, definition,
    { requestRender() {} }, dir);
  row.updateResult(result);
  if (result.isError) {
    const errorColor = theme.fg("error", "X").split("X")[0];
    assert.ok(row.render(140).join("\n").includes(errorColor), "the standard renderer uses the host's error color");
  }
  const text = () => row.render(140).map(stripTerminalSequences).join("\n");
  const collapsed = text();
  row.setExpanded(true);
  const expanded = text();
  return { collapsed, expanded };
};
try {
  // Stub methods deliberately exist and fail: guarding registration with typeof
  // must not conceal an override, nor may Activity shadow execution with a tool.
  handlers = {};
  activityExtension({
    registerToolRenderer() { assert.fail("Activity must not register a tool renderer"); },
    registerTool() { assert.fail("Activity must not register or shadow a tool"); },
    on(name, handler) { handlers[name] = handler; }, registerFlag() {}, registerCommand() {},
    getFlag: (name) => name === "read-only", getAllTools: () => withNativeTools(),
    appendEntry() {}, sendMessage() {}, events: { emit() {} },
  }, async () => assert.fail("hard read-only denial must not call a judge"), "native");
  await handlers.session_start({ reason: "startup" }, ctx);
  const blocked = await handlers.tool_call({ toolName: "edit", toolCallId: "synthetic-block", input: editArgs }, ctx);
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /^↑ Blocked — tool was not run\.\n/);
  assert.doesNotMatch(blocked.reason, /NOT EXECUTED/);
  assert.match(blocked.reason, /judge disabled or no current chat model available/, "the original unavailable-review reason remains visible");
  const refusal = { content: [{ type: "text", text: blocked.reason }], isError: true, details: undefined };

  // Ordinary execution errors are not Activity's concern. Its observational
  // hooks must leave all result blocks and structured data unchanged.
  const image = { type: "image", data: "AA==", mimeType: "image/png" };
  const cases = [
    { content: [{ type: "text", text: "Synthetic backend failure" }], isError: true },
    { content: [image, { type: "text", text: "Synthetic failure after image" }, { type: "text", text: "Extra output" }], isError: true },
    { content: [], isError: true },
    { content: [image], isError: true },
    { content: [{ type: "text", text: "Failed: host-labelled error" }], isError: true },
    { content: [{ type: "text", text: "Synthetic success" }], isError: false },
    { content: [{ type: "text", text: "Failed-looking successful output" }], isError: false },
  ];
  const events = cases.map((value, index) => ({ type: "tool_result", toolName: "read",
    toolCallId: `synthetic-result-${index}`, input: { path: "synthetic.txt" }, ...value,
    details: { synthetic: index }, structuredContent: { synthetic: [index, "preserved"] } }));
  for (const [index, event] of events.entries()) {
    const before = structuredClone(event);
    await handlers.tool_execution_start({ ...event, type: "tool_execution_start" }, ctx);
    const change = await handlers.tool_result(event, ctx);
    assert.equal(change, undefined, "Activity must not annotate execution results");
    const result = { ...event, ...change };
    assert.deepEqual(result.content, before.content);
    assert.deepEqual(result.details, before.details);
    assert.deepEqual(result.structuredContent, before.structuredContent);
    assert.equal(result.isError, before.isError);
    assert.deepEqual(event, before, "annotations must not mutate the original event");
    await handlers.tool_execution_end({ ...event, type: "tool_execution_end" }, ctx);
  }
  await handlers.session_shutdown({}, ctx);
  handlers = undefined;

  // Loader + AgentSession + ExtensionRunner, not a hand-written resolver. A fresh
  // factory is created over synthetic stored history for the resume iteration.
  const runtime = await ModelRuntime.create({ credentials: {
    read: async () => undefined, list: async () => [],
    modify: async () => assert.fail("no credential writes"), delete: async () => assert.fail("no credential deletes"),
  }, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const managers = { default: SessionManager.inMemory(dir), native: SessionManager.inMemory(dir), activity: SessionManager.inMemory(dir) };
  const custom = { name: "synthetic_custom", label: "Synthetic custom", description: "Inert fixture",
    parameters: Type.Object({}), renderShell: "default",
    renderCall: () => new Text("Synthetic custom call", 0, 0),
    renderResult: () => new Text("Synthetic custom result", 0, 0),
    execute: async () => assert.fail("rendering must never execute a tool") };
  const native = { edit: createEditToolDefinition(dir), read: createReadToolDefinition(dir),
    write: createWriteToolDefinition(dir), bash: createBashToolDefinition(dir), synthetic_custom: custom };
  for (const presentation of [undefined, "native", "activity"]) for (const resumed of [false, true]) {
    const manager = managers[presentation ?? "default"];
    const errors = [];
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.registerTool(custom); // Fixture-owned tool, not an Activity registration.
        const api = { ...pi,
          registerToolRenderer() { assert.fail("Activity must not install a resolver in the SDK"); },
          registerTool() { assert.fail("Activity must not shadow SDK tools"); },
        };
        if (presentation === undefined) activityExtension(api);
        else activityExtension(api, undefined, presentation);
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader,
      settingsManager, sessionManager: manager, modelRuntime: runtime });
    sessions.add(session);
    try {
      await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
      assert.equal(session.messages.length > 0, resumed, "resume restores only synthetic in-memory history");
      const definitions = {};
      for (const [name, expected] of Object.entries(native)) {
        const definition = session.getToolDefinition(name);
        assert.ok(definition, `installed tool ${name}`);
        const resolved = session.extensionRunner.resolveToolRenderers(name, () => definition);
        assert.equal(resolved, definition, `${name}: no renderer wrapper on ${resumed ? "resume" : "startup"}`);
        for (const key of ["renderCall", "renderResult", "renderShell"]) {
          // Bash's factory creates per-instance renderer closures; identity is
          // meaningful for shared native renderers and the fixture custom tool.
          if (name === "bash" && typeof expected[key] === "function") {
            assert.equal(typeof resolved[key], "function", `bash.${key} retains its native renderer`);
          } else {
            assert.equal(resolved[key], expected[key], `${name}.${key} retains the host/custom implementation`);
          }
        }
        definitions[name] = resolved;
      }
      // The real chained dispatcher must preserve failures and successes,
      // including their original structured content.
      for (const [index, event] of events.entries()) {
        const before = structuredClone(event);
        await session.extensionRunner.emit({ ...event, type: "tool_execution_start" });
        const result = { ...event, ...await session.extensionRunner.emitToolResult(event) };
        assert.deepEqual(result.content, before.content);
        assert.deepEqual(result.details, before.details);
        assert.deepEqual(result.structuredContent, before.structuredContent);
        assert.equal(result.isError, before.isError);
        if (index === 0) {
          const rendered = rowText(definitions.edit, result);
          for (const text of Object.values(rendered)) {
            assert.match(text, /Synthetic backend failure/);
            assert.doesNotMatch(text, /Failed|Blocked|NOT EXECUTED/);
          }
        }
        await session.extensionRunner.emit({ ...event, type: "tool_execution_end" });
      }
      for (const text of Object.values(rowText(definitions.edit, refusal))) {
        assert.match(text, /Blocked — tool was not run\./);
        assert.match(text, /judge disabled or no current chat model available/, "native row displays the original blocked reason");
      }
      const replayResult = resumed ? session.messages.at(-1) : success;
      for (const text of Object.values(rowText(definitions.edit, replayResult))) {
        assert.match(text, /SYNTHETIC_ACTUAL_DIFF/);
        assert.doesNotMatch(text, /Blocked|NOT EXECUTED|Failed/);
      }
      assert.match(rowText(definitions.synthetic_custom, success, "synthetic_custom", {}).collapsed, /Synthetic custom call[\s\S]*Synthetic custom result/);
      assert.deepEqual(errors, [], "SDK must not swallow extension assertion failures");
      if (!resumed) {
        manager.appendMessage({ role: "user", content: "Synthetic edit request", timestamp: 1 });
        manager.appendMessage({ role: "assistant", api: "synthetic", provider: "synthetic", model: "synthetic",
          content: [{ type: "toolCall", id: "synthetic-row", name: "edit", arguments: editArgs }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 });
        manager.appendMessage({ role: "toolResult", toolCallId: "synthetic-row", toolName: "edit", ...success, timestamp: 3 });
      }
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      sessions.delete(session);
    }
  }
  console.log("tool renderer removal tests passed: no registrations, native/custom startup and resume, native rows, Activity blocks and untouched execution results");
} finally {
  if (handlers?.session_shutdown) await handlers.session_shutdown({}, ctx);
  for (const session of sessions) session.dispose();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}
