import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activityExtension, { setFixtureProvider } from "./synthetic-runtime.mjs";
import { judgeSafety } from "../judge.ts";
import { Classifier } from "../classifier.ts";
import { aggregate } from "../../tools/audit_activity.mjs";
import { classification, createFixtureProvider, withNativeTools } from "./nine-head-fixtures.mjs";

const dir = mkdtempSync(join(tmpdir(), "activity-summary-gate-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldAuto = process.env.PI_ACTIVITY_AUTO_MODE;
const oldDelegatedTask = process.env.PI_SUBAGENT_TASK;
const originalClassify = Classifier.prototype.classify;
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.PI_ACTIVITY_AUTO_MODE;
delete process.env.PI_SUBAGENT_TASK; // Reviewer cancellation, not delegated-secret blocking.
mkdirSync(join(dir, "config"));
const logPath = join(dir, "reviews.jsonl");
writeFileSync(join(dir, "config/activity.json"), JSON.stringify({
  acclass: setFixtureProvider(createFixtureProvider(dir)),
  auto: { judgeModel: "test/judge", summaryModel: "test/summary" },
  log: { enabled: false }, reviewLog: { enabled: true, path: logPath, maxBytes: 1000000 },
}));
// The shell stub predicts an ordinary local read; .env uses the path backstop.
Classifier.prototype.classify = async () => classification();
const summary = "# User Message Summary\n## Context\nProject\n## Intent\nRead fixture\n## Allowed\nFixture reads\n## Forbidden\nNone stated\n## Guardrails\nNone stated";
let paidSummaries = 0;
let approvals = 0;
const branches = new Map();

async function cancelCase(callId, session, phase) {
  const controller = new AbortController();
  let ready;
  const reached = new Promise((resolve) => { ready = resolve; });
  const branch = branches.get(session) ?? Array.from({ length: 6 }, (_, i) => ({ type: "message", id: `user-${i}`,
    message: { role: "user", content: [{ type: "text", text: `fixture request ${i}` }] } }));
  branches.set(session, branch);
  const handlers = {};
  const pi = { registerFlag() {}, registerCommand() {},
    appendEntry(customType, data) { branch.push({ type: "custom", id: `receipt-${branch.length}`, customType, data }); },
    sendMessage() {}, getAllTools: () => withNativeTools(),
    getFlag: (name) => name === "auto", on(name, handler) { handlers[name] = handler; }, events: { emit() {} } };
  const ctx = { cwd: dir, mode: "print", hasUI: false, signal: controller.signal, model: { provider: "test" },
    sessionManager: { getEntries: () => branch, getSessionId: () => session, getBranch: () => branch },
    modelRegistry: { find: (provider, id) => ({ provider, id, contextWindow: 128000 }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake" }) },
    ui: { notify() {}, setStatus() {}, theme: { fg: (_name, value) => value }, select() { approvals++; throw new Error("unexpected approval"); } } };
  activityExtension(pi, (...args) => {
    args[9] = async (model) => {
      if (model.id === "summary") {
        paidSummaries++;
        if (phase === "during-summary") { ready(); return new Promise(() => {}); }
        return { stopReason: "stop", content: [{ type: "text", text: summary }],
          usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.001 } } };
      }
      ready();
      return new Promise(() => {}); // Reviewer deliberately ignores cancellation.
    };
    return judgeSafety(...args);
  }, "native");
  await handlers.session_start({ reason: "startup" }, ctx);
  try {
    const pending = handlers.tool_call({ toolName: "read", toolCallId: callId, input: { path: ".env" } }, ctx);
    let timer;
    try { await Promise.race([reached, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("summary/reviewer did not start")), 2000);
    })]); } finally { clearTimeout(timer); }
    const start = Date.now();
    controller.abort();
    assert.equal((await pending)?.block, true);
    assert.ok(Date.now() - start < 1000, "telemetry must not extend the gate's cancellation deadline");
  } finally { await handlers.session_shutdown(); }
  const row = readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse).find((entry) => entry.callId === callId);
  assert.equal(row.judge.outcome, "cancelled");
  assert.equal(row.final.verdict, "block");
  return row;
}

try {
  const completed = await cancelCase("completed-summary", "known-cost", "during-review");
  assert.equal(completed.summary.status, "generated");
  assert.equal(completed.summary.attempted, true);
  assert.equal(completed.summary.coveredMessages, 5);
  assert.equal(completed.summary.costTotalUsd, 0.001, "completed summary cost survives a cancelled reviewer");
  assert.equal(completed.summary.totalTokens, 30);
  const cached = await cancelCase("cached-summary", "known-cost", "during-review");
  assert.equal(cached.summary.status, "cached");
  assert.equal(cached.summary.costTotalUsd, undefined, "cached summary must not charge its owner again");
  const cancelled = await cancelCase("cancelled-summary", "unknown-cost", "during-summary");
  assert.equal(cancelled.summary.status, "failed");
  assert.equal(cancelled.summary.attempted, true, "started summarizer call survives cancellation as unknown cost");
  assert.equal(cancelled.summary.costTotalUsd, undefined);
  assert.equal(paidSummaries, 2);
  assert.equal(approvals, 0);
  const audit = aggregate([completed, cached, cancelled]);
  assert.equal(audit.classifierRecords, 3, "audit must accept emitted nine-head telemetry");
  assert.equal(audit.invalidClassifierRecords, 0);
  assert.equal(audit.classifierSchemas["nine-head"].records, 3);
  assert.equal(audit.costs.summary.totalKnownUsd, 0.001);
  assert.equal(audit.costs.summary.knownCalls, 1);
  assert.equal(audit.costs.summary.unknownCalls, 1);
  console.log("summary gate cancellation telemetry tests passed");
} finally {
  Classifier.prototype.classify = originalClassify;
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldAuto === undefined) delete process.env.PI_ACTIVITY_AUTO_MODE; else process.env.PI_ACTIVITY_AUTO_MODE = oldAuto;
  if (oldDelegatedTask === undefined) delete process.env.PI_SUBAGENT_TASK; else process.env.PI_SUBAGENT_TASK = oldDelegatedTask;
  rmSync(dir, { recursive: true, force: true });
}
