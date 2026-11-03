// Synthetic lifecycle coverage: completed summaries outlive turns, not branches.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import activityExtension from "../index.ts";
import { judgeSafety } from "../judge.ts";
import { OBSERVATION_ENTRY_TYPE } from "../version.ts";

const root = mkdtempSync(join(tmpdir(), "activity-summary-turns-"));
const env = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_SUBAGENT_TASK", "PI_ACTIVITY_AUTO_MODE"].map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = root;
delete process.env.PI_SUBAGENT_TASK;
delete process.env.PI_ACTIVITY_AUTO_MODE;
mkdirSync(join(root, "config"));
writeFileSync(join(root, "config/activity.json"), JSON.stringify({ auto: { judgeModel: "fixture/judge", summaryModel: "fixture/summary" } }));
const manager = SessionManager.create(root, join(root, "sessions"));
const user = (i) => manager.appendMessage({ role: "user", content: `Synthetic permission ${i} ${"a".repeat(40000)}`, timestamp: i });
for (let i = 0; i < 6; i++) user(i);
const text = "# User Message Summary\n## Context\nSynthetic context\n## Intent\nFixture testing\n## Allowed\nSynthetic reads\n## Forbidden\nNone stated\n## Guardrails\nNone stated";
let requests = 0, callId = 0;
const prompts = [];
const complete = async (model, context) => {
  if (model.id === "summary") { requests++; prompts.push(context.messages[0].content[0].text); }
  return { role: "assistant", api: "fixture", provider: "fixture", model: model.id, stopReason: "stop", timestamp: 1,
    content: [{ type: "text", text: model.id === "summary" ? text : '{"decision":"allow","reason":"synthetic safe"}' }],
    usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
};
function harness() {
  const handlers = {};
  const pi = { registerFlag() {}, registerCommand() {}, on(name, handler) { handlers[name] = handler; },
    getFlag: (name) => name === "auto", getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin", path: "builtin:bash" } }],
    appendEntry(type, data) { manager.appendCustomEntry(type, structuredClone(data)); }, sendMessage() {}, events: { emit() {} } };
  const ctx = { cwd: root, mode: "print", hasUI: false, sessionManager: manager,
    modelRegistry: { find: (provider, id) => ({ provider, id, api: "fixture", contextWindow: 128000 }) } };
  activityExtension(pi, (...args) => { args[9] = complete; return judgeSafety(...args); }, "native");
  return { handlers, ctx };
}
async function turn(h) {
  await h.handlers.before_agent_start({}, h.ctx);
  const event = { toolCallId: `summary-turn-${++callId}`, toolName: "bash", input: { command: "printf synthetic" } };
  assert.equal((await h.handlers.tool_call(event, h.ctx))?.block, undefined);
  await h.handlers.tool_result({ ...event, isError: false }, h.ctx);
  await h.handlers.agent_settled({}, h.ctx);
}
let h = harness();
try {
  await h.handlers.session_start({ reason: "startup" }, h.ctx);
  await turn(h);
  assert.equal(requests, 1);
  user(6);
  await turn(h);
  assert.equal(requests, 1, "an unchanged covered prefix must survive the next turn");
  await h.handlers.session_shutdown({}, h.ctx);
  h = harness();
  await h.handlers.session_start({ reason: "reload" }, h.ctx);
  await turn(h);
  assert.equal(requests, 1, "restored summaries must survive before_agent_start");
  const telemetry = manager.getBranch().findLast((entry) => entry.customType === OBSERVATION_ENTRY_TYPE).data.telemetry;
  assert.equal(telemetry.summaries.restored, 1);
  assert.equal(telemetry.summaries.cached, 2);
  for (let i = 7; i < 11; i++) user(i);
  await turn(h);
  assert.equal(requests, 2, "incremental refresh must retain the prior completed prefix");
  assert.match(prompts[1], /Previous generated summary/);
  assert.ok(prompts[1].length < 384000);
  console.log("Summary turn lifecycle passed: consecutive turns, reload and incremental prefix reuse");
} finally {
  await h.handlers.session_shutdown({}, h.ctx);
  for (const [key, value] of Object.entries(env)) value === undefined ? delete process.env[key] : process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
}
