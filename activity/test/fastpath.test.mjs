import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import activityExtension from "../index.ts";
import { withNativeTools } from "./nine-head-fixtures.mjs";
import { approvalFixture } from "./approval-fixture.mjs";

const agentDir = mkdtempSync(join(tmpdir(), "activity-fastpath-agent-"));
const cwd = mkdtempSync(join(tmpdir(), "activity-fastpath-project-"));
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "config"), { recursive: true });
writeFileSync(join(agentDir, "config", "activity.json"), JSON.stringify({
  acclass: { enabled: false }, auto: { judgeModel: "fixture/judge" }, log: { enabled: false }, reviewLog: { enabled: false },
}));

const handlers = {};
const commands = {};
let reviews = 0;
const pi = {
  registerFlag() {}, registerCommand(name, options) { commands[name] = options.handler; },
  on(name, handler) { handlers[name] = handler; },
  getFlag(name) { return name === "auto"; }, getAllTools() { return withNativeTools(); }, appendEntry() {}, sendMessage() {},
  events: { emit() {} },
};
const ctx = {
  cwd, hasUI: false, mode: "print",
  sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => "fastpath" },
  ui: { notify() {}, setStatus() {}, theme: { fg: (_name, text) => text } },
};
activityExtension(pi, async (_ctx, _ref, tool, _input, _cwd, modes) => {
  reviews++;
  return { ok: true, allow: !(tool === "deploy" && modes.remoteReadOnly), reason: "stub action review" };
}, "native");
const action = (toolName, input) => handlers.tool_call({ toolName, toolCallId: `call-${Date.now()}-${Math.random()}`, input }, ctx);
try {
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  assert.notEqual((await action("write", { path: join(cwd, "a.txt"), content: "x".repeat(260_000) }))?.block, true);
  assert.notEqual((await action("edit", { path: join(cwd, "a.txt"), edits: [] }))?.block, true);
  assert.notEqual((await action("deploy", { target: "production" }))?.block, true);
  assert.equal(reviews, 1, "in-scope edits fast-path but custom tools require review");
  assert.notEqual((await action("write", { path: join(homedir(), "outside-project.txt"), content: "small" }))?.block, true);
  assert.equal(reviews, 2, "out-of-scope writes still need review");
  const dangling = join(cwd, "dangling");
  symlinkSync(join(homedir(), "acclass-fastpath-nonexistent.txt"), dangling);
  assert.notEqual((await action("write", { path: dangling, content: "small" }))?.block, true);
  assert.equal(reviews, 3, "a dangling symlink targeting home must not bypass review");
  await commands["read-only"]("on", ctx);
  assert.equal((await action("write", { path: join(cwd, "a.txt") }))?.block, true);
  await commands["read-only"]("off", ctx);
  await commands["remote-read-only"]("on", ctx);
  assert.equal((await action("deploy", { target: "production" }))?.block, true);
  await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" });

  let reviewDecision = "block";
  activityExtension(pi, async (_ctx, _ref, _tool, _input, _cwd, modes) => {
    assert.deepEqual(modes, { auto: true, readOnly: false, remoteReadOnly: false });
    return { ok: true, allow: false, decision: reviewDecision, reason: "Safety review declined." };
  }, "native");
  ctx.hasUI = true;
  ctx.mode = "tui";
  ctx.ui.custom = approvalFixture(ctx, (done) => done("timeout"));
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  const immediate = await action("write", { path: join(homedir(), "outside-project.txt"), content: "small" });
  assert.equal(immediate?.block, true);
  reviewDecision = "ask_user";
  const timeout = await action("write", { path: join(homedir(), "outside-project.txt"), content: "small" });
  assert.equal(timeout?.block, true);
  assert.equal(timeout.reason, immediate.reason, "timeout is unavailable approval, not a different semantic refusal");
  assert.doesNotMatch(timeout.reason, /timeout|timed out|30 seconds|declined by user|do not retry unchanged/i);
  assert.doesNotMatch(timeout.reason, /\.\s*;/);
  await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" });
  console.log("activity fast-path tests passed");
} finally {
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
