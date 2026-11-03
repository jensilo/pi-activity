// Real client/socket/startup tests. No model, provider, or candidate execution.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activityExtension, { setFixtureProvider } from "./synthetic-runtime.mjs";
import { createFixtureModel, readyResponse, wireResponse, withNativeTools } from "./nine-head-fixtures.mjs";
import { actionSchema } from "./typebox-fixtures.mjs";

const dir = mkdtempSync(join(tmpdir(), "ac-cancel-"));
const savedEnv = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE"].map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.PI_ACTIVITY_AUTO_MODE;
mkdirSync(join(dir, "config"));

async function waitFor(predicate) {
  for (let i = 0; i < 300 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), "fixture did not reach expected classifier phase");
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("cancellation failed to release pending classifier gate within 300ms")), 300);
    })]);
  } finally { clearTimeout(timer); }
}

try {
  for (const phase of ["cold-startup", "stalled-request"]) {
    const fixtureDir = join(dir, phase);
    mkdirSync(fixtureDir);
    const { model } = createFixtureModel(fixtureDir);
    const binary = join(fixtureDir, "daemon");
    const socket = join(fixtureDir, "daemon.sock");
    const pidFile = join(fixtureDir, "pid");
    const enteredFile = join(fixtureDir, "entered");
    writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const hash = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
const files = ['config.json', 'tokenizer.json', 'thresholds.json', 'heads.json', 'model_contract.json', 'model.safetensors'];
const identity = { protocol: 'acclass-daemon/1', loading_mode: 'q8-runtime',
  artifacts: Object.fromEntries(files.map(name => [name, hash(fs.readFileSync(require('node:path').join(${JSON.stringify(model)}, name)))])),
  binary_sha256: hash(fs.readFileSync(__filename)) };
const ready = { ...${JSON.stringify(readyResponse())}, identity };
const response = { ...${JSON.stringify(wireResponse())}, identity };
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const server = net.createServer(c => {
  c.on('error', () => {});
  c.once('data', bytes => {
    const request = JSON.parse(bytes);
    if (request.ping) { c.end(JSON.stringify(ready) + '\\n'); return; }
    const first = !fs.existsSync(${JSON.stringify(enteredFile)});
    fs.writeFileSync(${JSON.stringify(enteredFile)}, 'entered');
    if (${JSON.stringify(phase)} === 'stalled-request' && first) return;
    c.end(JSON.stringify(response) + '\\n');
  });
});
setTimeout(() => server.listen(${JSON.stringify(socket)}), ${phase === "cold-startup" ? 800 : 0});
`, { mode: 0o700 });
    writeFileSync(join(dir, "config/activity.json"), JSON.stringify({
      auto: { judgeModel: "fixture/judge" },
      acclass: setFixtureProvider({ provider: "acclass", enabled: true, binary, model, socket, quant: "q8", spawn: true,
        startTimeoutMs: 3000, requestTimeoutMs: 1000 }),
      log: { enabled: false }, reviewLog: { enabled: false },
    }));
    const handlers = {};
    const reviews = [];
    const statuses = [];
    let approvals = 0;
    let backendCalls = 0;
    const pi = {
      registerFlag() {}, registerCommand() {}, on(name, handler) { handlers[name] = handler; },
      getFlag: (name) => name === "auto",
      getAllTools: () => withNativeTools([{ name: "custom_action", description: "Inert lookup", parameters: actionSchema() }]),
      appendEntry() {}, sendMessage() {}, events: { emit() {} },
    };
    activityExtension(pi, async (...args) => {
      reviews.push(args);
      return { ok: true, allow: true, reason: "fixture reviewer" };
    }, "native");
    const ctx = {
      cwd: fixtureDir, mode: "tui", hasUI: true,
      sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => phase },
      ui: { notify() {}, theme: { fg: (_color, text) => text },
        setStatus(...args) { statuses.push(args); },
        async select() { approvals++; throw new Error("unexpected UI approval"); } },
    };
    const controller = new AbortController();
    const execute = async (toolCallId, signal) => {
      const result = await handlers.tool_call({ toolName: "custom_action", toolCallId, input: { key: "catalog" } },
        { ...ctx, signal });
      if (!result?.block) backendCalls++;
      return result;
    };
    await handlers.session_start({ reason: "startup" }, ctx);
    let pid;
    try {
      const pending = execute("cancelled", controller.signal);
      await waitFor(() => existsSync(phase === "cold-startup" ? pidFile : enteredFile));
      pid = Number(readFileSync(pidFile, "utf8"));
      const uiBefore = statuses.length;
      const start = performance.now();
      controller.abort();
      const denied = await promptly(pending);
      const cancellationMs = Math.round(performance.now() - start);
      assert.equal(denied?.block, true);
      assert.match(denied.reason, /cancelled during classification/);
      assert.equal(reviews.length, 0);
      assert.equal(approvals, 0);
      assert.equal(backendCalls, 0);
      assert.equal(statuses.length, uiBefore + 1, "only the final blocked observation may update UI after cancellation");
      assert.ok(alive(pid), "cancelling a gate must not stop its shared daemon");
      assert.notEqual((await execute("sibling", new AbortController().signal))?.block, true,
        "a sibling gate can use the same daemon after cancellation");
      assert.equal(reviews.length, 1);
      assert.equal(backendCalls, 1, "only the uncancelled sibling can execute");
      const uiAfterSibling = statuses.length;
      if (phase === "stalled-request") await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(statuses.length, uiAfterSibling, "late cancelled classifier work cannot update UI");
      assert.equal(reviews.length, 1, "late completion/timeout cannot review cancelled work");
      assert.equal(backendCalls, 1);
      console.log(`  ok ${phase}: prompt denial, no review/backend or late UI, shared daemon/sibling preserved (${cancellationMs}ms cancellation)`);
    } finally {
      await handlers.session_shutdown({ reason: "quit" });
      if (pid) await waitFor(() => !alive(pid));
    }
  }
  console.log("classification cancellation tests passed (real cold startup and stalled socket request)");
} finally {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}
