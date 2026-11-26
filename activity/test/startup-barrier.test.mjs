// Synthetic startup faults only. No native tool, provider, installer or network execution.
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import activityExtension from "../index.ts";
import { POLICY_CONTEXT_EVENT } from "../delegation.ts";
import { withNativeTools } from "./nine-head-fixtures.mjs";

const root = mkdtempSync(join(tmpdir(), "activity-startup-barrier-"));
const saved = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_TASK", "PI_ACTIVITY_AUTO_MODE"].map((key) => [key, process.env[key]]));
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.PI_SUBAGENT_TASK;
process.env.PI_ACTIVITY_AUTO_MODE = "off";
const configDir = join(root, "agent/config");
const configPath = join(configDir, "activity.json");
mkdirSync(configDir, { recursive: true });
const configure = (overrides = {}) => writeFileSync(configPath, JSON.stringify({ acclass: { enabled: false },
  auto: { judgeBackend: "classifier", judgeMode: "short", judgeModel: "synthetic/judge" }, ...overrides }), { mode: 0o600 });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const initializing = /initialization is incomplete/;

function harness({ cwd = root, flags = {}, branch = [], supplier } = {}) {
  const handlers = {}, notifications = [], reviews = [];
  const ctx = { cwd, hasUI: false, mode: "print",
    sessionManager: { getBranch: () => branch, getSessionId: () => "startup-barrier" },
    ui: { notify(message, level) { notifications.push({ message, level }); }, setStatus() {},
      theme: { fg: (_color, text) => text } },
  };
  const pi = { on(name, handler) { handlers[name] = handler; }, registerFlag() {}, registerCommand() {},
    getFlag: (name) => flags[name] ?? false, getAllTools: () => withNativeTools(), appendEntry() {}, sendMessage() {},
    events: { emit(name, request) { if (name === POLICY_CONTEXT_EVENT) supplier?.(request); } } };
  activityExtension(pi, async (...args) => { reviews.push(args); return { ok: true, allow: true, reason: "synthetic allow" }; },
    "native", () => ({ kind: "none", stop() {}, async classify() { throw new Error("unexpected classifier use"); } }));
  let id = 0;
  return { ctx, pi, notifications, reviews,
    start: () => handlers.session_start({ reason: "startup" }, ctx),
    stop: () => handlers.session_shutdown({}, ctx),
    call: (toolName, input, nested = false) => handlers.tool_call({ toolName, input,
      toolCallId: `startup-${++id}`, ...(nested ? { parentToolCallId: "synthetic-parent" } : {}) }, ctx),
  };
}

async function assertMutationsBlocked(h, expectedReason) {
  for (const nested of [false, true]) {
    for (const [tool, input] of [["write", { path: "widget.ts", content: "synthetic" }],
      ["edit", { path: "widget.ts", oldText: "before", newText: "after" }]]) {
      const result = await h.call(tool, input, nested);
      assert.equal(result?.block, true, `${tool} must be blocked (nested: ${nested})`);
      if (expectedReason) assert.match(result.reason, expectedReason);
    }
  }
}

// Keep one mock per export: jiti can cache the imported function between cases.
let creationFault;
const faults = ["mkdirSync", "writeFileSync"].map((operation) => {
  const original = fs[operation];
  return mock.method(fs, operation, (target, ...args) => {
    if (creationFault?.operation === operation && target === (operation === "mkdirSync" ? configDir : configPath)) {
      creationFault.attempts++;
      if (creationFault.code === "ENOSPC") original(target, "", args[1]); // Opened, but no bytes written.
      throw Object.assign(new Error("synthetic config creation failure"), { code: creationFault.code });
    }
    return original(target, ...args);
  });
});
syncBuiltinESMExports();

try {
  // Launch through a symlink, but bind the independent supplier to the real workspace.
  const workspace = join(root, "workspace");
  const workspaceAlias = join(root, "workspace-link");
  mkdirSync(workspace);
  symlinkSync("workspace", workspaceAlias);
  const canonicalCwd = realpathSync(workspace);
  // Fault injection works under both root and unprivileged test runners.
  for (const operation of ["mkdirSync", "writeFileSync"]) for (const code of ["EACCES", "EROFS"]) {
    rmSync(configPath, { force: true });
    creationFault = { operation, code, attempts: 0 };
    const inherited = deferred();
    let requestedCwd;
    const h = harness({ cwd: workspaceAlias, flags: { "read-only": true }, supplier: (request) => {
      requestedCwd = request.cwd;
      request.respond(inherited.promise);
    } });
    try {
      const starting = h.start();
      assert.equal(requestedCwd, canonicalCwd, "the policy request uses the real workspace path");
      await assertMutationsBlocked(h, initializing);
      assert.match((await h.call("read", { path: "widget.ts" })).reason, initializing);
      inherited.resolve({ context: { version: 1, task: "Inspect synthetic widget", cwd: canonicalCwd,
        sources: [{ role: "assignment", text: "Inspect synthetic widget" }],
        restrictions: { readOnly: false, remoteReadOnly: true } } });
      await starting;
      assert.equal(existsSync(configPath), false, "failed creation leaves the config absent");
      const read = await h.call("read", { path: "widget.ts" });
      assert.notEqual(read?.block, true, read?.reason ?? "completed startup releases the barrier");
      await assertMutationsBlocked(h);
      const fault = creationFault;
      creationFault = undefined;
      configure();
      creationFault = fault;
      const reviewCount = h.reviews.length;
      const custom = await h.call("custom", {});
      assert.notEqual(custom?.block, true, custom?.reason);
      assert.equal(h.reviews.length, reviewCount + 1, "custom tool reached the injected judge");
      const review = h.reviews.at(-1);
      assert.equal(review[1], "synthetic/judge");
      assert.deepEqual(review[5], { auto: false, readOnly: true, remoteReadOnly: true },
        "startup flags and inherited restrictions survive failed config creation with auto OFF");
      rmSync(configPath);
      await h.start();
      assert.equal(creationFault.attempts, 2, `${operation} ${code} was injected on each startup`);
      assert.equal(h.notifications.length, 1, "config creation warns only once per runtime");
      assert.equal(h.notifications[0].level, "warning");
      assert.match(h.notifications[0].message, /built-in defaults/);
    } finally {
      creationFault = undefined;
      await h.stop();
    }
  }

  // A failed write can leave an invalid file. Never ignore or remove invalid config.
  rmSync(configPath, { force: true });
  creationFault = { operation: "writeFileSync", code: "ENOSPC", attempts: 0 };
  const partial = harness({ flags: { "read-only": true } });
  try {
    await assert.rejects(partial.start(), /Invalid extension config JSON/);
    assert.equal(creationFault.attempts, 1);
    assert.equal(fs.readFileSync(configPath, "utf8"), "");
    creationFault = undefined;
    configure();
    await assertMutationsBlocked(partial, initializing);
    assert.match((await partial.call("read", { path: "widget.ts" })).reason, initializing);
  } finally {
    creationFault = undefined;
    await partial.stop();
  }

  // These failures used to occur after the inherited-context barrier was cleared.
  for (const phase of ["config", "restore", "flags"]) {
    configure();
    const h = harness({ flags: { "read-only": true } });
    const getBranch = h.ctx.sessionManager.getBranch;
    const getFlag = h.pi.getFlag;
    if (phase === "config") configure({ policy: { trustedTools: null } });
    if (phase === "restore") h.ctx.sessionManager.getBranch = () => { throw new Error("synthetic restore failure"); };
    if (phase === "flags") h.pi.getFlag = (name) => {
      if (name === "read-only") throw new Error("synthetic flags failure");
      return getFlag(name);
    };
    await assert.rejects(h.start(), phase === "config" ? /activity\.policy\.trustedTools/ : /synthetic .* failure/);
    configure();
    h.ctx.sessionManager.getBranch = getBranch;
    h.pi.getFlag = getFlag;
    await assertMutationsBlocked(h, initializing);
    assert.match((await h.call("read", { path: "widget.ts" })).reason, initializing,
      "fixing the failing dependency alone must not open admission");
    assert.equal(h.reviews.length, 0, "incomplete initialization cannot ask the judge to waive the barrier");
    await h.start();
    await assertMutationsBlocked(h);
    assert.notEqual((await h.call("read", { path: "widget.ts" }))?.block, true, "a complete startup can recover");
    await h.stop();
  }

  configure();
  const restored = harness({ branch: [{ type: "custom", customType: "activity-state",
    data: { readOnly: true, auto: false } }] });
  const starting = restored.start();
  // The first dispatch observes the barrier synchronously; after yielding, startup may finish.
  assert.match((await restored.call("read", { path: "widget.ts" })).reason, initializing);
  await starting;
  await assertMutationsBlocked(restored);
  assert.notEqual((await restored.call("read", { path: "widget.ts" }))?.block, true);
  await restored.stop();
  console.log("startup barrier tests passed (config creation EACCES/EROFS, inherited/restored guards, startup faults, recovery)");
} finally {
  for (const fault of faults) fault.mock.restore();
  syncBuiltinESMExports();
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
}
