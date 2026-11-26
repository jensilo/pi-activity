// Gate integration test: drives the real extension factory and its tool_call
// handler with a stub Pi API, against the live local classifier.
//
//   node <jiti> test/gate.test.mjs

import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import activityExtension, { setFixtureProvider } from "./synthetic-runtime.mjs";
import { withNativeTools } from "./nine-head-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
if (!process.env.ACCLASS_TEST_MODEL) {
  console.log("pending live gate checks: set ACCLASS_TEST_MODEL to a trained nine-head model");
  process.exit(0);
}
const agentDir = mkdtempSync(join(tmpdir(), "activity-gate-"));
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "config"), { recursive: true });
writeFileSync(join(agentDir, "config", "activity.json"), JSON.stringify({
  auto: { judgeModel: "fixture/unavailable" },
  policy: { trustedTools: ["ask_user_question"] },
  acclass: setFixtureProvider({
    provider: "acclass",
    spawn: true,
    binary: process.env.ACCLASS_TEST_BINARY ?? join(homedir(), ".acclass/bin/acclass"),
    socket: join(agentDir, "acclass.sock"),
    model: process.env.ACCLASS_TEST_MODEL,
    startTimeoutMs: 20000,
    requestTimeoutMs: 3000,
  }),
  log: { enabled: true, mode: "full", path: join(agentDir, "commands.jsonl") },
  reviewLog: { enabled: true, path: join(agentDir, "reviews.jsonl") },
}));

const handlers = {};
const commands = {};
const statusEvents = [];
const pi = {
  registerFlag() {},
  registerCommand(name, options) { commands[name] = options.handler; },
  registerShortcut() {},
  registerTool() {},
  on(name, handler) { handlers[name] = handler; },
  getFlag(name) { return name === "auto"; }, getAllTools() { return withNativeTools(); },
  appendEntry() {},
  sendMessage() {},
  sendUserMessage() {},
  events: { emit() {} },
};

const ctx = {
  cwd: repo,
  hasUI: false,
  mode: "print",
  signal: undefined,
  sessionManager: {
    getEntries: () => [],
    getBranch: () => [],
    getSessionId: () => "gate-test",
  },
  ui: {
    notify() {},
    setStatus(key, text) { statusEvents.push({ key, text }); },
    theme: { fg: (_c, text) => text },
  },
  modelRegistry: {
    find: () => undefined,
    getAll: () => [],
    getApiKeyAndHeaders: async () => ({ ok: false, error: "no model in stub" }),
  },
};

activityExtension(pi, undefined, "native");
assert.equal(typeof commands["remote-read-only"], "function");
assert.equal(typeof handlers.session_start, "function");
assert.equal(typeof handlers.tool_call, "function");
assert.equal(typeof handlers.session_shutdown, "function");

await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);

let failures = 0;
async function gate(command, label) {
  return handlers.tool_call({ toolName: "bash", toolCallId: label, input: { command } }, ctx);
}
async function expectBlock(command, label) {
  try {
    const res = await gate(command, label);
    assert.equal(res?.block, true, `expected block for: ${command}`);
    console.log(`  ok  blocked: ${command}  (${res.reason})`);
  } catch (err) { failures++; console.error(`FAIL  block ${command}: ${err.message}`); }
}
async function expectAllow(command, label) {
  try {
    const res = await gate(command, label);
    assert.notEqual(res?.block, true, `expected allow for: ${command} (got ${res?.reason})`);
    console.log(`  ok  allowed: ${command}`);
  } catch (err) { failures++; console.error(`FAIL  allow ${command}: ${err.message}`); }
}

console.log("# gate (live classifier)");
await expectAllow("git status", "1");
await expectAllow("ls -la", "2");
await expectBlock("rm -rf /", "3");
await expectBlock("cat ~/.ssh/id_rsa", "4");
await expectBlock("cat ~/.pi/agent/auth.json", "5");
// No model credentials in this stub: a candidate must fail closed without a judge.
await expectBlock("git push", "6");

try {
  const res = await handlers.tool_call({ toolName: "write", toolCallId: "7", input: { path: join(homedir(), "outside.txt") } }, ctx);
  assert.equal(res?.block, true, "expected write outside cwd to block");
  console.log("  ok  blocked: write outside cwd");
} catch (err) { failures++; console.error(`FAIL  write outside cwd: ${err.message}`); }

try {
  const res = await handlers.tool_call({ toolName: "read", toolCallId: "8", input: { path: join(repo, "README.md") } }, ctx);
  assert.notEqual(res?.block, true, "expected read inside cwd to allow");
  console.log("  ok  allowed: read inside cwd");
} catch (err) { failures++; console.error(`FAIL  read inside cwd: ${err.message}`); }

let broadGrepBlocked;
try {
  const broad = await handlers.tool_call({ toolName: "grep", toolCallId: "8b", input: { path: repo, glob: "**/auth.json", pattern: "." } }, ctx);
  broadGrepBlocked = broad?.block === true;
  const knownSecret = await handlers.tool_call({ toolName: "grep", toolCallId: "8c", input: { path: join(repo, ".env"), pattern: "." } }, ctx);
  assert.equal(knownSecret?.block, true, "known secret paths retain the backstop regardless of the classifier prediction");
  const res = await handlers.tool_call({ toolName: "write", toolCallId: "9", input: { path: join(repo, "scratch.txt"), content: "safe" } }, ctx);
  assert.notEqual(res?.block, true, "a write inside cwd needs no review");
  const custom = await handlers.tool_call({ toolName: "deploy", toolCallId: "10", input: { target: "production" } }, ctx);
  assert.equal(custom?.block, true, "custom tools fail closed when the reviewer is unavailable");
  console.log("  ok  in-project writes fast-path; custom tools require reviewer");
  let prompts = 0;
  ctx.hasUI = true;
  ctx.mode = "tui";
  ctx.ui.custom = () => { prompts++; throw new Error("unexpected tool approval"); };
  assert.equal((await gate("git push", "11"))?.block, true, "an unavailable decision classifier blocks even in TUI");
  const outsideWrite = await handlers.tool_call({ toolName: "write", toolCallId: "11b",
    input: { path: join(homedir(), "outside.txt"), content: "x".repeat(256_000) } }, ctx);
  assert.equal(outsideWrite?.block, true, "review failure cannot manually approve an out-of-project write");
  assert.equal(prompts, 0);
  await commands["remote-read-only"]("on", ctx);
  const beforeGuard = prompts;
  assert.equal((await gate("git push", "13"))?.block, true, "remote-read-only cannot be overridden");
  assert.equal(prompts, beforeGuard, "hard guard must never prompt");
  assert.equal((await handlers.tool_call({ toolName: "subagent", toolCallId: "14", input: { agent: "worker", task: "deploy" } }, ctx))?.block, true);
  await commands["remote-read-only"]("off", ctx);
  await commands["read-only"]("on", ctx);
  assert.equal((await handlers.tool_call({ toolName: "write", toolCallId: "15", input: { path: join(repo, "a") } }, ctx))?.block, true);
  assert.equal(prompts, beforeGuard, "read-only file write cannot be overridden");
  ctx.mode = "rpc";
  await commands["read-only"]("off", ctx);
  assert.equal((await gate("git push", "16"))?.block, true, "RPC must decline without prompting");
  assert.equal(prompts, beforeGuard, "RPC must never prompt");
  console.log("  ok  no-prompt TUI, hard modes, and RPC behavior");
} catch (err) { failures++; console.error(`FAIL  extended gates: ${err.message}`); }

await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" });

// Classifier guard signals reach the judge with authoritative active modes.
const hardHandlers = {};
const hardCommands = {};
let hardReviews = 0;
activityExtension({
  ...pi,
  on(name, handler) { hardHandlers[name] = handler; },
  registerCommand(name, options) { hardCommands[name] = options.handler; },
}, async (_ctx, _ref, _tool, _input, _cwd, modes) => {
  hardReviews++;
  assert.ok(modes.readOnly || modes.remoteReadOnly, "guard review receives active authoritative modes");
  return { ok: true, allow: true, reason: "stub establishes compliance" };
}, "native");
await hardHandlers.session_start({ type: "session_start", reason: "startup" }, ctx);
ctx.mode = "tui";
ctx.hasUI = true;
ctx.ui.custom = async () => { throw new Error("hard mode must not prompt"); };
try {
  await hardCommands["read-only"]("on", ctx);
  const mutating = await hardHandlers.tool_call({ toolName: "bash", toolCallId: "hard-1", input: { command: "touch ./new.txt" } }, ctx);
  assert.notEqual(mutating?.block, true, "judge may establish compliance despite a classifier guard signal");
  await hardCommands["read-only"]("off", ctx);
  await hardCommands["remote-read-only"]("on", ctx);
  const remote = await hardHandlers.tool_call({ toolName: "bash", toolCallId: "hard-2", input: { command: "git push" } }, ctx);
  assert.notEqual(remote?.block, true, "classifier remote signal requires judge review, not a final veto");
  const custom = await hardHandlers.tool_call({ toolName: "subagent", toolCallId: "hard-3", input: { agent: "worker", task: "deploy" } }, ctx);
  assert.notEqual(custom?.block, true, "subagent delegation is decided by guard-aware review");
  assert.equal(hardReviews, 3, "shell signals and delegation all require review");
  await hardCommands["remote-read-only"]("off", ctx);
  await hardCommands["read-only"]("on", ctx);
  const remoteRead = await hardHandlers.tool_call({ toolName: "bash", toolCallId: "hard-4", input: { command: "curl -s https://example.com" } }, ctx);
  assert.notEqual(remoteRead?.block, true, "read-only may fetch remote data without local mutation");
  console.log("  ok  classifier guard signals and delegation reach authoritative review");
} catch (err) { failures++; console.error(`FAIL  hard-mode verdicts: ${err.message}`); }
await hardHandlers.session_shutdown({ type: "session_shutdown", reason: "quit" });

// Retry events update progress and explain why the review is taking longer.
const retryHandlers = {};
activityExtension({ ...pi, on(name, handler) { retryHandlers[name] = handler; } },
  async (_ctx, _ref, _tool, _input, _cwd, _modes, _signal, onRetry) => {
    onRetry({ retry: 1, cause: "timeout" });
    return { ok: true, allow: true, reason: "safe", metrics: { attempts: 2, retries: 1 } };
  }, "native");
await retryHandlers.session_start({ type: "session_start", reason: "startup" }, ctx);
try {
  const before = statusEvents.length;
  const result = await retryHandlers.tool_call({ toolName: "write", toolCallId: "retry-1",
    input: { path: join(homedir(), "outside.txt"), content: "safe" } }, ctx);
  assert.notEqual(result?.block, true);
  const statuses = statusEvents.slice(before).filter(({ key }) => key === "activity-judge");
  assert.match(statuses[0]?.text ?? "", /judge .*s elapsed/i);
  assert.match(statuses.find(({ text }) => text?.includes("retry 1/5"))?.text ?? "", /retry 1\/5 \(timeout\)/);
  assert.equal(statuses.at(-1)?.text, undefined);
} catch (err) { failures++; console.error(`FAIL  retry status: ${err.message}`); }
await retryHandlers.session_shutdown({ type: "session_shutdown", reason: "quit" });

const cancelledHandlers = {};
let finishLateReview;
activityExtension({ ...pi, on(name, handler) { cancelledHandlers[name] = handler; } },
  async () => new Promise((resolve) => { finishLateReview = resolve; }), "native");
await cancelledHandlers.session_start({ type: "session_start", reason: "startup" }, ctx);
const turnController = new AbortController();
ctx.signal = turnController.signal;
try {
  const pending = cancelledHandlers.tool_call({ toolName: "write", toolCallId: "late-allow",
    input: { path: join(homedir(), "outside.txt"), content: "safe" } }, ctx);
  for (let i = 0; i < 100 && !finishLateReview; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(typeof finishLateReview, "function");
  turnController.abort();
  const result = await pending;
  finishLateReview({ ok: true, allow: true, reason: "late allow" });
  assert.equal(result?.block, true, "turn cancellation must block a later judge allow");
  assert.equal(statusEvents.filter(({ key }) => key === "activity-judge").at(-1)?.text, undefined);
} catch (err) { failures++; console.error(`FAIL  late judge allow after cancellation: ${err.message}`); }
finally { ctx.signal = undefined; await cancelledHandlers.session_shutdown({ type: "session_shutdown", reason: "quit" }); }

// An unavailable classifier requires authoritative guard review.
const configPath = join(agentDir, "config", "activity.json");
const testConfig = JSON.parse(readFileSync(configPath, "utf8"));
testConfig.acclass = setFixtureProvider({ provider: "none" });
testConfig.log.mode = "redacted";
writeFileSync(configPath, JSON.stringify(testConfig));
let judgeCalls = 0;
const offlineHandlers = {};
const offlineCommands = {};
activityExtension({
  ...pi,
  on(name, handler) { offlineHandlers[name] = handler; },
  registerCommand(name, options) { offlineCommands[name] = options.handler; },
}, async () => { judgeCalls++; return { ok: true, allow: true, reason: "stub allow" }; }, "native");
await offlineHandlers.session_start({ type: "session_start", reason: "startup" }, ctx);
try {
  await offlineCommands["read-only"]("on", ctx);
  const result = await offlineHandlers.tool_call({ toolName: "bash", toolCallId: "offline-1", input: { command: "touch ./new.txt" } }, ctx);
  assert.notEqual(result?.block, true);
  await offlineCommands["read-only"]("off", ctx);
  await offlineCommands["remote-read-only"]("on", ctx);
  const remote = await offlineHandlers.tool_call({ toolName: "bash", toolCallId: "offline-2", input: { command: "git push" } }, ctx);
  assert.notEqual(remote?.block, true);
  assert.equal(judgeCalls, 2, "unavailable shell classification routes to the configured guard-aware judge");
  console.log("  ok  unavailable classifier routes to guard-aware review");
} catch (err) { failures++; console.error(`FAIL  classifier unavailable under hard modes: ${err.message}`); }
await offlineHandlers.session_shutdown({ type: "session_shutdown", reason: "quit" });
try {
  const rows = readFileSync(join(agentDir, "commands.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const last = rows.at(-1);
  assert.equal(last?.cmd, "[redacted]");
  assert.match(last?.cwd ?? "", /^\[redacted:path/);
  assert.equal(Object.hasOwn(last, "reviewReason"), false);
  assert.equal(last?.action, null);
  assert.equal(last?.captureStatus, "metadata-only");
  assert.deepEqual(last?.paths, { inside: [], outside: [] });
  console.log("  ok  redacted command log omits review explanations and paths");
} catch (err) { failures++; console.error(`FAIL  command log redaction: ${err.message}`); }
try {
  const diagnostics = readFileSync(join(agentDir, "reviews.jsonl"), "utf8");
  const entries = diagnostics.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(entries.some((entry) => entry.judge?.outcome === "unavailable"));
  const broadGrep = entries.find((entry) => entry.callId === "8b");
  assert.equal(broadGrepBlocked, broadGrep.classifier.preds.exposes_secrets,
    "directory grep follows the secret prediction, not a blanket directory rule");
  assert.ok(entries.every((entry) => entry.prompt === null), "new review logs never contain an approval outcome");
  assert.ok(entries.some((entry) => entry.prefilter?.reason === "base:remote-review"));
  assert.ok(entries.some((entry) => entry.callId === "offline-2" && entry.judge?.outcome === "allow"));
  assert.doesNotMatch(diagnostics, /proposed-write-content|scratch\.txt|git push/);
  console.log("  ok  review metadata is logged without tool arguments");
} catch (err) { failures++; console.error(`FAIL  review diagnostics: ${err.message}`); }
if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
rmSync(agentDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
