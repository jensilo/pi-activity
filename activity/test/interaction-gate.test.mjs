import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activityExtension from "../index.ts";
import { withNativeTools } from "./nine-head-fixtures.mjs";
import { collectUserMessages, TOOL_OUTCOME_TYPE } from "../interactions.ts";
import { reviewContext } from "../context.ts";
import { migrationInput, migrationQuestion, migrationAnswer } from "./permission-fixtures.mjs";

// Real extension hooks and recorder, stub reviewer; no tool or provider runs.
const dir = mkdtempSync(join(tmpdir(), "activity-human-gate-"));
const oldDir = process.env.PI_CODING_AGENT_DIR;
const oldTask = process.env.PI_SUBAGENT_TASK;
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.PI_SUBAGENT_TASK;
const source = join(dir, "question.ts");
writeFileSync(source, "// trusted synthetic questionnaire implementation\n");
mkdirSync(join(dir, "config"));
writeFileSync(join(dir, "config/activity.json"), JSON.stringify({
  acclass: { enabled: false }, auto: { judgeModel: "fixture/judge" },
  policy: { trustedTools: ["ask_user_question"], questionnaireSources: [source] }, log: { enabled: false }, reviewLog: { enabled: false },
}));
const branch = [{ type: "message", id: "user-install", message: { role: "user", content: "Install the extension, preserving safety protection" } }];
const handlers = {};
const info = { name: "ask_user_question", sourceInfo: { path: source, scope: "user", source: "local", origin: "top-level" } };
const pi = { registerFlag() {}, registerCommand() {}, sendMessage() {}, events: { emit() {} }, getAllTools: () => withNativeTools([info]),
  getFlag: (name) => name === "auto", on(name, handler) { handlers[name] = handler; },
  appendEntry(customType, data) { branch.push({ type: "custom", id: `entry-${branch.length}`, customType, data }); } };
const ctx = { cwd: dir, mode: "print", hasUI: false, sessionManager: { getSessionId: () => "interaction-gate-fixture", getBranch: () => branch, getEntries: () => branch },
  ui: { notify() {}, setStatus() {}, theme: { fg: (_color, text) => text } } };
const addCall = (e) => branch.push({ type: "message", id: `call-${branch.length}`, message: { role: "assistant", content: [
  { type: "toolCall", id: e.toolCallId, name: e.toolName, arguments: e.input },
] } });
let allow = false;
const contexts = [];
activityExtension(pi, async (context, _ref, tool, input) => {
  contexts.push(reviewContext(context, tool, input, dir, 128000).text);
  return { ok: true, allow, reason: allow ? "authorized synthetic candidate" : "stubbed denial" };
}, "native");
try {
  await handlers.session_start({ reason: "startup" }, ctx);
  const before = { toolName: "bash", toolCallId: "before-approval", input: migrationInput };
  addCall(before);
  assert.equal((await handlers.tool_call(before, ctx))?.block, true);
  const blocked = branch.find((e) => e.customType === TOOL_OUTCOME_TYPE && e.data.callId === before.toolCallId);
  assert.equal(blocked.data.outcome, "blocked", "all denial returns record non-execution");
  const question = { toolName: "ask_user_question", toolCallId: "approval", input: { questions: [migrationQuestion] } };
  addCall(question);
  assert.notEqual((await handlers.tool_call(question, ctx))?.block, true);
  await handlers.tool_result({ ...question, isError: false, details: migrationAnswer("Preserve the installed guard") }, ctx);
  assert.equal(collectUserMessages(ctx).length, 2);
  assert.equal(collectUserMessages(ctx)[1].kind, "questionnaire");
  allow = true;
  const retry = { ...before, toolCallId: "approved-retry" };
  addCall(retry);
  assert.notEqual((await handlers.tool_call(retry, ctx))?.block, true);
  const text = contexts.at(-1);
  assert.ok(text.includes("Migrate the old symlink"));
  assert.ok(text.includes("Preserve the installed guard"));
  assert.ok(text.includes("Blocked by the activity gate before execution; no action was performed"));
  await handlers.tool_result({ ...retry, isError: true, details: { exitCode: 1 } }, ctx);
  assert.match(reviewContext(ctx, "bash", {}, dir, 128000).text, /Failed; partial effects may exist/);
  await handlers.session_shutdown();

  // Recreate the extension as on reload; branch-local evidence is retained.
  activityExtension(pi, async () => ({ ok: true, allow: true, reason: "stub" }), "native");
  await handlers.session_start({ reason: "reload" }, ctx);
  assert.equal(collectUserMessages(ctx).length, 2);
  assert.ok(reviewContext(ctx, "bash", {}, dir, 128000).text.includes("Blocked by the activity gate before execution"));
  const navigation = { ...question, toolCallId: "pending-navigation" };
  addCall(navigation);
  await handlers.tool_call(navigation, ctx);
  await handlers.session_tree({ type: "session_tree" }, ctx);
  await handlers.tool_result({ ...navigation, isError: false, details: migrationAnswer("This must not leak into another branch") }, ctx);
  assert.equal(collectUserMessages(ctx).length, 2, "branch navigation invalidates pending submissions even with a shared prefix");
  await handlers.session_shutdown();
  console.log("questionnaire and execution-status gate integration tests passed");
} finally {
  await handlers.session_shutdown?.();
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldTask === undefined) delete process.env.PI_SUBAGENT_TASK; else process.env.PI_SUBAGENT_TASK = oldTask;
  rmSync(dir, { recursive: true, force: true });
}
