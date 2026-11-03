// Real installed Pi SDK; keyless synthetic provider, isolated settings, no network.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import activityExtension from "../index.ts";

const dir = mkdtempSync(join(tmpdir(), "activity-blocked-sdk-"));
const overrides = { HOME: join(dir, "home"), PI_CODING_AGENT_DIR: dir,
  PI_ACTIVITY_AUTO_MODE: undefined, PI_SUBAGENT_TASK: undefined, PI_SUBAGENT_POLICY_CONTEXT_FD: undefined,
  PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
const savedEnv = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
for (const [key, value] of Object.entries(overrides)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
mkdirSync(process.env.HOME);
mkdirSync(join(dir, "config"));
writeFileSync(join(dir, "config/activity.json"), JSON.stringify({
  acclass: { enabled: false }, auto: { judgeModel: null }, guards: { readOnly: true },
  session: { persistModes: true, persistActivity: false },
  log: { enabled: false }, reviewLog: { enabled: false },
}));
const target = join(dir, "synthetic.txt");
const original = "synthetic first\nsynthetic second\n";
writeFileSync(target, original);
const calls = ["first", "second"].map((word) => ({ type: "toolCall", id: `blocked-edit-${word}`, name: "edit",
  arguments: { path: target, oldText: `synthetic ${word}`, newText: `changed ${word}` } }));
const notice = "Blocked — tool was not run.";
// Hard read-only requires a compliant review. An explicitly disabled judge fails
// closed without dispatching a review request or reading credentials.
const originalReason = "Safety review unavailable (technical failure): judge disabled or no current chat model available. Set auto.judgeModel to provider/model, or omit it to use the current chat model.";
const guidance = "Continue with a safe alternative that resolves this reason, or other unblocked work; prefer progress when the user is away. Do not bypass guards or retry unchanged. Ask only when no safe path remains.";
const provider = "blocked-message-sdk-fixture";
const model = { provider, id: "main", name: "Synthetic blocked message fixture", api: "synthetic-blocked-sdk", baseUrl: "",
  reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const sessions = new Set();
const text = (message) => typeof message.content === "string" ? message.content
  : message.content.map((part) => part.text ?? "").join("\n");
const blockedEntries = (manager) => manager.getBranch().filter((entry) =>
  entry.type === "custom_message" && entry.customType === "activity-blocked");

async function fixture(style, manager) {
  const requests = [], sent = [], errors = [], renderers = [];
  let pendingCalls = [];
  const runtime = await ModelRuntime.create({ credentials: {
    read: async () => undefined, list: async () => [],
    modify: async () => assert.fail("no credential writes"), delete: async () => assert.fail("no credential deletes"),
  }, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider({ id: provider, name: "Offline synthetic blocked provider",
    auth: { apiKey: { name: "Keyless fixture", resolve: async () => ({ auth: {}, source: "synthetic" }) } },
    getModels: () => [model], stream: () => assert.fail("no external or API-specific streaming"),
    streamSimple(activeModel, context, options) {
      assert.equal(activeModel.provider, provider);
      assert.equal(activeModel.id, "main", "no judge provider requests");
      assert.equal(options.apiKey, undefined);
      requests.push(structuredClone(context));
      const content = pendingCalls.length ? pendingCalls : [{ type: "text", text: "Synthetic safe follow-up." }];
      pendingCalls = [];
      const message = { role: "assistant", api: model.api, provider, model: model.id, content,
        usage: structuredClone(usage), stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
      });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      // Observe registration and delivery while retaining the actual SDK paths.
      const registerMessageRenderer = pi.registerMessageRenderer.bind(pi);
      pi.registerMessageRenderer = (type, renderer) => {
        renderers.push(type);
        return registerMessageRenderer(type, renderer);
      };
      const sendMessage = pi.sendMessage.bind(pi);
      pi.sendMessage = (message, options) => {
        sent.push(structuredClone({ message, options }));
        return sendMessage(message, options);
      };
      const review = async () => assert.fail("hard read-only edit must not invoke a judge");
      if (style === undefined) activityExtension(pi, review);
      else activityExtension(pi, review, style);
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(renderers, style === "native" ? [] : ["activity-blocked"],
    "default and explicit Activity modes register their custom renderer on startup and resume");
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader,
    settingsManager, sessionManager: manager, modelRuntime: runtime, model, thinkingLevel: "off" });
  sessions.add(session);
  await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error),
    uiContext: { setWidget() {}, setStatus() {}, notify() {} } });
  return { session, requests, sent, async prompt(toolCalls = []) {
    pendingCalls = structuredClone(toolCalls);
    await session.prompt("Synthetic blocked edit regression.");
    await session.waitForIdle();
    assert.deepEqual(errors, [], "extension errors must not be swallowed");
    assert.equal(readFileSync(target, "utf8"), original, "blocked real edit tools never mutate the fixture");
  } };
}
async function close(session) {
  try { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); }
  finally { session.dispose(); sessions.delete(session); }
}
function assertContext(request, style, fullReasons) {
  const messages = request.messages;
  const results = messages.filter((message) => message.role === "toolResult");
  assert.deepEqual(results.map((message) => message.toolCallId), calls.map((call) => call.id));
  const assistantCalls = messages.filter((message) => message.role === "assistant")
    .flatMap((message) => message.content.filter((part) => part.type === "toolCall"));
  assert.deepEqual(assistantCalls, calls, "both original call identities and arguments reach the continuation");
  for (const result of results) {
    assert.equal(result.toolName, "edit");
    assert.equal(result.isError, true);
    assert.equal(text(result), style === "activity" ? notice : fullReasons[results.indexOf(result)]);
  }
  if (style === "activity") {
    const lastResult = Math.max(...results.map((result) => messages.indexOf(result)));
    const notes = messages.filter((message) => calls.some((call) => text(message).includes(`Tool call: edit (${call.id}).`)));
    assert.equal(notes.length, 2, "one model-visible Activity message per blocked call");
    for (const [index, call] of calls.entries()) {
      const matching = notes.filter((message) => text(message).includes(`Tool call: edit (${call.id}).`));
      assert.equal(matching.length, 1);
      assert.equal(matching[0].role, "user", "SDK converts custom messages into model-visible context");
      assert.equal(text(matching[0]), `${fullReasons[index]}\nTool call: edit (${call.id}).`);
      assert.ok(messages.indexOf(matching[0]) > lastResult, "Activity context arrives AFTER all tool results");
    }
  }
}

try {
  // Build the expected full reason independently of the selected presentation.
  const fullReasons = calls.map(() => `↑ ${notice}\n🛡️ Blocked (llm): ${originalReason}\n${guidance}`);
  // Omit the third argument for the release default; both explicit modes remain covered.
  for (const style of [undefined, "activity", "native"]) {
    const label = style ?? "default-activity";
    const presentation = style ?? "activity";
    const manager = SessionManager.create(dir, join(dir, `sessions-${label}`));
    const f = await fixture(style, manager);
    await f.prompt(calls);
    assert.equal(f.requests.length, 2, "two blocked calls cause exactly one provider follow-up, not a message-triggered turn");
    assert.equal(f.requests[0].messages.some((message) => message.role === "toolResult"), false);
    const entries = blockedEntries(manager);
    if (presentation === "native") {
      const reasons = f.requests[1].messages.filter((message) => message.role === "toolResult").map(text);
      assert.equal(reasons.length, 2);
      for (const reason of reasons) {
        assert.ok(reason.startsWith(`↑ ${notice}\n`));
        assert.ok(reason.includes(originalReason), "full original failure reason is retained");
        assert.ok(reason.includes(guidance), "full recovery guidance remains inline");
      }
      assert.deepEqual(reasons, fullReasons);
      assert.deepEqual(entries, [], "native mode persists no Activity block messages");
      assert.equal(f.sent.filter(({ message }) => message.customType === "activity-blocked").length, 0);
    } else {
      assert.equal(entries.length, 2);
      assert.deepEqual(entries.map((entry) => entry.details), calls.map((call) => ({ toolName: "edit", toolCallId: call.id })));
      assert.ok(entries.every((entry) => entry.display === true));
      const blocks = f.sent.filter(({ message }) => message.customType === "activity-blocked");
      assert.equal(blocks.length, 2);
      for (const [index, block] of blocks.entries()) {
        assert.equal(block.message.content, entries[index].content);
        assert.equal(block.message.display, true);
        assert.deepEqual(block.options, { triggerTurn: false });
      }
    }
    assertContext(f.requests[1], presentation, fullReasons);
    const persisted = structuredClone(entries);
    const path = manager.getSessionFile();
    assert.ok(path);
    await close(f.session);
    const resumedManager = SessionManager.open(path, join(dir, `sessions-${label}`));
    const resumed = await fixture(style, resumedManager);
    await resumed.prompt();
    assert.equal(resumed.requests.length, 1, "resume needs no extra Activity-only provider turn");
    assertContext(resumed.requests[0], presentation, fullReasons);
    assert.deepEqual(blockedEntries(resumedManager), persisted, "resume preserves block messages without duplicates");
    assert.equal(resumed.sent.filter(({ message }) => message.customType === "activity-blocked").length, 0,
      "resume replays persisted context without sending new block messages");
    await close(resumed.session);
    console.log(`PASS blocked-message SDK ${label}: two blocked edits, provider continuation, persisted resume`);
  }
} finally {
  for (const session of sessions) await close(session);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}
