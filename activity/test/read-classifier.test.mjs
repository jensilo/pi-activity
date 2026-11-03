import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import activityExtension, { setFixtureProvider } from "./synthetic-runtime.mjs";
import { Classifier } from "../classifier.ts";
import { fileClassifierCommand } from "../read-classifier.ts";
import { selectedLabelSupport, configuredClassifierIdentity } from "../telemetry.ts";
import { classification as response, createFixtureModel, createFixtureProvider, facts, NINE_HEADS, readyResponse, wireResponse, withNativeTools } from "./nine-head-fixtures.mjs";

assert.equal(fileClassifierCommand("read", {}, "/repo/a'b $(touch evil)"), "cat -- '/repo/a'\\''b $(touch evil)'");
assert.equal(fileClassifierCommand("grep", { pattern: "-p' $(evil)", glob: "**/*.t's", ignoreCase: true, literal: true, context: 2 }, "/repo"),
  "rg --json --line-number --color=never --hidden --ignore-case --fixed-strings --glob '**/*.t'\\''s' --context 2 -- '-p'\\'' $(evil)' '/repo'");
assert.throws(() => fileClassifierCommand("grep", {}, "/repo"), /pattern/);
const preds = facts(); // An ordinary file read has no state-change/network effects.
const probs = Object.fromEntries(NINE_HEADS.map((head) => [head, head === "local_state_change" ? 0.75 : 0.125]));
const support = selectedLabelSupport(probs, preds);
assert.equal(support.byHead.local_state_change, 0.25, "selected-label support follows the actual thresholded label, not 0.5");
assert.equal(support.byHead.exposes_secrets, 0.875);
assert.equal(support.min, 0.25);
assert.equal(support.spread, 0.625);
assert.equal(selectedLabelSupport({ ...probs, outbound: NaN }, preds), undefined);
assert.equal(selectedLabelSupport({ ...probs, outbound: 1.1 }, preds), undefined);

const dir = realpathSync(mkdtempSync(join(tmpdir(), "activity-read-classifier-")));
const cwd = join(dir, "project");
const agentDir = join(dir, "agent");
const model = join(dir, "model");
for (const path of [cwd, join(agentDir, "config"), model]) mkdirSync(path, { recursive: true });
writeFileSync(join(model, "thresholds.json"), JSON.stringify(probs));
assert.deepEqual(configuredClassifierIdentity({ model, quant: "q8" }).configuredThresholds, probs);
assert.equal(configuredClassifierIdentity({ model, quant: "q8" }).daemonIdentityVerified, false);
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldAuto = process.env.PI_ACTIVITY_AUTO_MODE;
const oldDelegatedTask = process.env.PI_SUBAGENT_TASK;
const originalClassify = Classifier.prototype.classify;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_ACTIVITY_AUTO_MODE;
delete process.env.PI_SUBAGENT_TASK; // These are ordinary-session review cases.
const configPath = join(agentDir, "config", "activity.json");
const commandLog = join(dir, "commands.jsonl");
const reviewLog = join(dir, "reviews.jsonl");
writeFileSync(configPath, JSON.stringify({ acclass: setFixtureProvider({ ...createFixtureProvider(dir), model }), auto: { judgeModel: "fixture/judge" },
  log: { enabled: true, path: commandLog, mode: "full" },
  reviewLog: { enabled: true, path: reviewLog, maxBytes: 1000000 } }));
const handlers = {};
const commands = {};
const pi = { on(name, handler) { handlers[name] = handler; },
  registerCommand(name, options) { commands[name] = options.handler; }, registerFlag() {},
  getFlag: (name) => name === "auto", getAllTools: () => withNativeTools(), appendEntry() {}, sendMessage() {}, events: { emit() {} } };
const ctx = { cwd, mode: "print", hasUI: false,
  sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => "read-classifier-test" },
  ui: { notify() {}, setStatus() {}, theme: { fg: (_name, value) => value } } };
let classification = { ...preds };
let failure = false;
const inputs = [];
Classifier.prototype.classify = async (command, receivedCwd, home) => {
  inputs.push(command);
  assert.equal(receivedCwd, cwd);
  assert.equal(home, homedir());
  if (failure) return { ok: false, kind: "unavailable", message: "stub unavailable" };
  // Other shell head predictions are deliberately inconsistent with file effects.
  return response(classification, { probs, ms: 7,
    scope: ["other"], paths: { inside: [], outside: ["/classifier/wrong-scope"] } });
};
let reviews = 0;
let allow = true;
activityExtension(pi, async () => { reviews++; return { ok: true, allow, reason: "stub prediction",
  metrics: { costTotalUsd: 0.001, totalTokens: 9 } }; }, "native");
let id = 0;
const action = async (toolName, input) => handlers.tool_call({ toolName, input, toolCallId: `read-${++id}` }, ctx);
try {
  await handlers.session_start({ reason: "startup" }, ctx);
  assert.notEqual((await action("read", { path: "source.ts" }))?.block, true);
  assert.equal(reviews, 0);
  assert.equal(inputs.at(-1), `cat -- '${join(cwd, "source.ts")}'`);
  classification = facts({ local_state_change: true, outbound: true, remote_state_change: true,
    egress: true, destructive: true, delegated_execution: true, host_control_change: true,
    fetched_or_generated_execution: true });
  await commands["read-only"]("on", ctx);
  await commands["remote-read-only"]("on", ctx);
  assert.notEqual((await action("read", { path: "source.ts" }))?.block, true,
    "only secret prediction affects file gating, not synthetic shell effects or scope");
  assert.notEqual((await action("grep", { pattern: "TODO" }))?.block, true);
  assert.equal(inputs.at(-1), `rg --json --line-number --color=never --hidden -- 'TODO' '${cwd}'`);
  assert.equal(reviews, 0, "ordinary directory grep no longer gets blanket review");
  classification = { ...preds, exposes_secrets: true };
  assert.notEqual((await action("grep", { pattern: "token", glob: "**/*.ts", ignoreCase: true }))?.block, true);
  assert.equal(reviews, 1, "classifier secret prediction requests review");
  assert.match(inputs.at(-1), /--hidden --ignore-case --glob '\*\*\/\*\.ts'/);
  classification = { ...preds };
  assert.notEqual((await action("read", { path: ".env" }))?.block, true);
  assert.equal(reviews, 2, "known secret path overrides a negative classifier prediction");
  symlinkSync(join(cwd, ".env"), join(cwd, "innocent.txt"));
  assert.notEqual((await action("read", { path: "innocent.txt" }))?.block, true);
  assert.equal(reviews, 3, "symlink secret target retains backstop");
  failure = true;
  allow = false;
  assert.equal((await action("grep", { pattern: "TODO", path: cwd }))?.block, true);
  assert.equal(reviews, 4, "failure requests review even under file read guards");
  assert.equal((await action("read", { path: "source.ts" }))?.block, true);
  assert.equal(reviews, 5);
  failure = false;
  allow = true;
  const before = inputs.length;
  assert.notEqual((await action("find", { path: cwd, pattern: "*.ts" }))?.block, true);
  assert.notEqual((await action("ls", { path: cwd }))?.block, true);
  assert.equal(inputs.length, before, "other file tools stay unchanged");
  assert.notEqual((await action("read", { path: "source.ts" }))?.block, true);
  assert.equal(reviews, 5, "low support must not trigger extra review");
  await handlers.session_shutdown();
  const records = readFileSync(reviewLog, "utf8").trim().split("\n").map(JSON.parse);
  const first = records.find((record) => record.callId === "read-1");
  assert.deepEqual(first.classifier.probs, probs);
  assert.deepEqual(first.classifier.preds, preds);
  assert.deepEqual(first.classifier.appliedHeads, ["exposes_secrets"]);
  assert.equal(first.classifier.support.min, 0.25);
  assert.equal(first.prefilter.verdict, "allow");
  const secret = records.find((record) => record.callId === "read-4");
  assert.equal(secret.prefilter.verdict, "block");
  assert.equal(secret.prefilter.reason, "base:exposes_secrets");
  assert.equal(secret.judge.outcome, "allow");
  assert.equal(secret.final.verdict, "allow");
  assert.equal(secret.judge.costTotalUsd, 0.001);
  assert.equal(records.find((record) => record.callId === "read-7").classifier, null);
  const logged = readFileSync(commandLog, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(logged.find((record) => record.callId === first.callId).probs.local_state_change, 0.75);
  assert.equal(logged.find((record) => record.callId === secret.callId).judgeOutcome, "allow");
  const socket = join(dir, "scores.sock");
  let wireProbs = probs;
  const fixtureConfig = createFixtureModel(dir);
  const server = createServer((connection) => connection.once("data", (bytes) => {
    connection.end(JSON.stringify(JSON.parse(bytes).ping === true ? readyResponse() : wireResponse({ preds, probs: wireProbs })) + "\n");
  }));
  await new Promise((resolve) => server.listen(socket, resolve));
  try {
    const client = new Classifier({ enabled: true, ...fixtureConfig, socket, spawn: false, requestTimeoutMs: 1000 });
    assert.equal((await originalClassify.call(client, "true", cwd, homedir())).ok, true);
    for (const invalid of [undefined, null, -0.1, 1.1]) {
      wireProbs = { ...probs, outbound: invalid };
      assert.equal((await originalClassify.call(client, "true", cwd, homedir())).ok, false,
        "malformed/missing scores must fail rather than be fabricated as zero");
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
  console.log("read/grep classifier and observational telemetry tests passed");
} finally {
  Classifier.prototype.classify = originalClassify;
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldAuto === undefined) delete process.env.PI_ACTIVITY_AUTO_MODE; else process.env.PI_ACTIVITY_AUTO_MODE = oldAuto;
  if (oldDelegatedTask === undefined) delete process.env.PI_SUBAGENT_TASK; else process.env.PI_SUBAGENT_TASK = oldDelegatedTask;
  rmSync(dir, { recursive: true, force: true });
}
