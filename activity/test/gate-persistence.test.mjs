// Synthetic session files only, outside the worktree. Real SessionManager reload/tree.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import activityExtension from "../index.ts";
import { withNativeTools } from "./nine-head-fixtures.mjs";
import { judgeSafety } from "../judge.ts";
import { SUMMARY_ENTRY_TYPE } from "../summary.ts";
import { OBSERVATION_ENTRY_TYPE } from "../version.ts";

const dir = mkdtempSync(join(tmpdir(), "activity-gate-persistence-"));
const oldDir = process.env.PI_CODING_AGENT_DIR, oldAuto = process.env.PI_ACTIVITY_AUTO_MODE, oldTask = process.env.PI_SUBAGENT_TASK;
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.PI_ACTIVITY_AUTO_MODE;
delete process.env.PI_SUBAGENT_TASK;
mkdirSync(join(dir, "config"));
const configPath = join(dir, "config/activity.json");
const configure = (extra = {}) => writeFileSync(configPath, JSON.stringify({
  acclass: { enabled: false }, auto: { judgeModel: "test/judge", summaryModel: "test/summary" },
  log: { enabled: false }, reviewLog: { enabled: false }, ...extra,
}));
configure();
let summaryRequests = 0;
const summary = "# User Message Summary\n## Context\nSynthetic project\n## Intent\nFixture work\n## Allowed\nSynthetic reads\n## Forbidden\nNone stated\n## Guardrails\nNone stated";
const response = (text, model) => ({ role: "assistant", api: "synthetic", provider: "test", model,
  stopReason: "stop", content: [{ type: "text", text }], timestamp: 1,
  usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });
const complete = async (model) => {
  if (model.id === "summary") { summaryRequests++; return response(summary, "summary"); }
  return response('{"decision":"allow","reason":"synthetic safe"}', "judge");
};
let id = 0;
const model = (provider, name) => ({ provider, id: name, api: "synthetic", contextWindow: 128000 });
const manager = SessionManager.create(dir, join(dir, "sessions"));
for (let i = 0; i < 6; i++) manager.appendMessage({ role: "user", content: `synthetic fixture request ${i}`, timestamp: i });
let active = manager;
function harness(review = (...args) => { args[9] = complete; return judgeSafety(...args); }) {
  const handlers = {}, commands = {}, statuses = [];
  const pi = {
    registerFlag() {}, on(name, handler) { handlers[name] = handler; }, registerCommand(name, command) { commands[name] = command.handler; },
    getFlag: (name) => name === "auto", getAllTools: () => withNativeTools(),
    appendEntry(type, data) { active.appendCustomEntry(type, structuredClone(data)); }, sendMessage() {}, events: { emit() {} },
  };
  const ctx = { cwd: dir, mode: "print", hasUI: true,
    sessionManager: {
      getBranch: () => active.getBranch(), getSessionId: () => active.getSessionId(),
      getEntries() { throw new Error("abandoned branches must not seed state"); },
    }, modelRegistry: { find: model, getAll: () => [model("test", "judge"), model("test", "summary")] },
    ui: { theme: { fg: (_color, text) => text }, setStatus(key, text) { statuses.push({ key, text }); }, notify() {} },
  };
  activityExtension(pi, review, "native");
  return { handlers, commands, ctx, statuses };
}
const latest = () => active.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === OBSERVATION_ENTRY_TYPE)?.data;
const event = (tool, input) => ({ toolName: tool, toolCallId: `persist-${++id}`, input });
async function run(h, tool, input, error = false, durationMs) {
  const e = event(tool, input);
  await h.handlers.tool_execution_start({ ...e, args: input }, h.ctx);
  const decision = await h.handlers.tool_call(e, h.ctx);
  if (!decision?.block) await h.handlers.tool_result({ ...e, isError: error }, h.ctx);
  await h.handlers.tool_execution_end({ ...e, isError: !!decision?.block || error, durationMs }, h.ctx);
  return decision;
}
let h = harness();
try {
  await h.handlers.session_start({ reason: "startup" }, h.ctx);
  await h.handlers.before_agent_start({}, h.ctx);
  await run(h, "write", { path: "fixture.txt", content: "DO_NOT_PERSIST_CONTENT" });
  await run(h, "bash", { command: "printf fixture; export API_KEY=synthetic_secret_123" }, false, 45);
  assert.equal(summaryRequests, 1);
  assert.ok(active.getBranch().some((entry) => entry.customType === SUMMARY_ENTRY_TYPE), "validated summary cache is persisted through the judge hook");
  assert.equal(latest().totals.files, 1); assert.equal(latest().totals.sh, 1);
  assert.ok(!JSON.stringify(latest()).includes("DO_NOT_PERSIST_CONTENT"), "observation checkpoints never contain write content");
  assert.ok(!JSON.stringify(latest()).includes("synthetic_secret_123"), "persisted previews redact credential values");
  const bashHistory = latest().history.find((call) => call.category === "sh");
  assert.match(bashHistory.preview.text, /printf fixture/);
  assert.match(bashHistory.explanation.text, /synthetic safe/, "sanitized verdict explanations survive reload");
  assert.equal(bashHistory.durationMs, 45, "host execution duration is persisted after the result hook");
  await h.handlers.agent_settled({}, h.ctx);
  await h.commands["read-only"]("on", h.ctx);
  const guardedLeaf = active.getLeafId();
  await h.commands["read-only"]("off", h.ctx);
  await run(h, "write", { path: "abandoned.txt", content: "synthetic" });
  assert.equal(latest().totals.files, 2);
  const abandonedLeaf = active.getLeafId();
  await h.handlers.session_shutdown({}, h.ctx);

  // Real reload from a synthetic JSONL file, selecting the earlier guard branch.
  active = SessionManager.open(manager.getSessionFile());
  active.branch(guardedLeaf);
  h = harness();
  await h.handlers.session_start({ reason: "resume" }, h.ctx);
  assert.match(h.statuses.findLast(({ key }) => key === "activity").text, /🛡️ 🔏/);
  assert.equal((await run(h, "write", { path: "blocked.txt" }))?.block, true, "abandoned guard-off entry cannot override selected branch");
  assert.equal(latest().totals.files, 1);
  assert.equal(latest().totals.blocked, 1);
  await h.commands["read-only"]("off", h.ctx);
  await run(h, "bash", { command: "synthetic reload receipt" });
  assert.equal(summaryRequests, 1, "reload restores exact-source cache instead of paying for a new summary");
  assert.equal(latest().telemetry.summaries.cached, 2, "guard-conflicting native call and shell call both use review cache");
  assert.equal(latest().telemetry.summaries.restored, 1);
  assert.match(latest().history.find((call) => call.id === bashHistory.id).explanation.text, /synthetic safe/);
  assert.equal(latest().history.find((call) => call.id === bashHistory.id).durationMs, 45, "execution duration survives a real session reload");

  // Tree navigation restores both observation totals and guards, not all file entries.
  active.branch(abandonedLeaf);
  await h.handlers.session_tree({}, h.ctx);
  await run(h, "write", { path: "branch.txt" });
  assert.equal(latest().totals.files, 3);
  assert.equal(latest().totals.blocked, 0);
  active.branch(guardedLeaf);
  await h.handlers.session_tree({}, h.ctx);
  assert.equal((await run(h, "write", { path: "branch-blocked.txt" }))?.block, true);
  assert.equal(latest().totals.files, 1);
  assert.equal(latest().totals.blocked, 1);

  // Invalid configuration keeps Pi's fail-closed exception semantics and is still observed.
  writeFileSync(configPath, JSON.stringify({ display: { enabled: "invalid" } }));
  const broken = event("write", { path: "invalid.txt" });
  await h.handlers.tool_execution_start({ ...broken, args: broken.input }, h.ctx);
  await assert.rejects(h.handlers.tool_call(broken, h.ctx), /display\/session/);
  configure();
  await h.handlers.tool_execution_end({ ...broken, isError: true }, h.ctx);
  assert.equal(latest().totals.blocked, 2, "gate/config exceptions count once");

  // Persistence options independently disable mode/activity writes and restores.
  configure({ session: { persistModes: false, persistActivity: false }, display: { enabled: false } });
  const persistedEntries = () => active.getEntries().filter((entry) => entry.type === "custom" &&
    ["activity-state", OBSERVATION_ENTRY_TYPE, SUMMARY_ENTRY_TYPE].includes(entry.customType)).length;
  const countBefore = persistedEntries();
  await h.handlers.session_start({ reason: "reload" }, h.ctx);
  await h.commands["read-only"]("on", h.ctx);
  assert.equal((await run(h, "write", { path: "not-persisted.txt" }))?.block, true);
  await h.handlers.agent_settled({}, h.ctx);
  assert.equal(persistedEntries(), countBefore, "disabled persistence appends neither modes nor activity");
  assert.equal(h.statuses.findLast(({ key }) => key === "activity").text, undefined);
  await h.handlers.session_start({ reason: "reload" }, h.ctx);
  assert.equal((await run(h, "write", { path: "modes-not-restored.txt" }))?.block, undefined);
  assert.equal(persistedEntries(), countBefore);

  // A genuinely new empty session resets all cumulative totals.
  configure();
  active = SessionManager.inMemory(dir);
  await h.handlers.session_start({ reason: "new" }, h.ctx);
  await run(h, "write", { path: "fresh.txt" });
  assert.deepEqual(latest().totals, { files: 1, sh: 0, mcp: 0, blocked: 0 });
  assert.equal(latest().telemetry.judge.started, 0);
  console.log("Gate persistence tests passed: real reload/tree, summaries, flags, exceptions and reset");
} finally {
  await h.handlers.session_shutdown({}, h.ctx);
  for (const [key, value] of [["PI_CODING_AGENT_DIR", oldDir], ["PI_ACTIVITY_AUTO_MODE", oldAuto], ["PI_SUBAGENT_TASK", oldTask]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}
