// Synthetic admission only: no candidate tool executes and no provider is contacted.
import assert from "node:assert/strict";
import { syntheticLauncher } from "./delegation-fixture.mjs";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activityExtension, { setFixtureProvider } from "./synthetic-runtime.mjs";
import { Classifier } from "../classifier.ts";
import { classification, createFixtureProvider, facts, withNativeTools } from "./nine-head-fixtures.mjs";

const dir = mkdtempSync(join(tmpdir(), "activity-native-read-routing-"));
const cwd = join(dir, "project");
const agentDir = join(dir, "agent");
mkdirSync(cwd);
mkdirSync(join(agentDir, "config"), { recursive: true });
writeFileSync(join(cwd, "module.py"), "def add(a, b):\n    return a + b\n");
writeFileSync(join(cwd, "auth.json"), "{}\n");
symlinkSync(join(cwd, "auth.json"), join(cwd, "alias.py"));
symlinkSync(join(cwd, "module.py"), join(cwd, ".env"));
const provider = createFixtureProvider(dir);
const savedEnv = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE", "PI_SUBAGENT_TASK"]
  .map((key) => [key, process.env[key]]));
const originalClassify = Classifier.prototype.classify;
process.env.PI_CODING_AGENT_DIR = agentDir;
const launcher = syntheticLauncher(cwd);
let classifierCalls = 0;
let predicted = facts({ exposes_secrets: true, local_state_change: true, remote_state_change: true,
  outbound: true, egress: true, destructive: true, delegated_execution: true,
  host_control_change: true, fetched_or_generated_execution: true });
Classifier.prototype.classify = async () => { classifierCalls++; return classification(predicted); };
let callId = 0;

async function harness({ auto, readOnly = false, remoteReadOnly = false, global = false, judge = true }) {
  if (auto) delete process.env.PI_ACTIVITY_AUTO_MODE;
  else process.env.PI_ACTIVITY_AUTO_MODE = "off";
  classifierCalls = 0;
  writeFileSync(join(agentDir, "config", "activity.json"), JSON.stringify({
    acclass: setFixtureProvider(provider), auto: { judgeModel: judge ? "fixture/reviewer" : null },
    guards: { readOnly: global && readOnly, remoteReadOnly: global && remoteReadOnly },
  }));
  const handlers = {};
  const commands = {};
  const reviews = [];
  let allow = true;
  const ctx = { cwd, mode: "print", hasUI: false,
    sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => "native-read-routing" },
    ui: { notify() {}, setStatus() {}, theme: { fg: (_name, value) => value } } };
  activityExtension({
    on(name, handler) { handlers[name] = handler; },
    registerCommand(name, options) { commands[name] = options.handler; }, registerFlag() {},
    getFlag(name) { return name === "auto" || (!global && (name === "read-only" ? readOnly : remoteReadOnly)); },
    getAllTools: () => withNativeTools(), appendEntry() {}, sendMessage() {}, events: { emit: launcher.emit },
  }, async (...args) => {
    reviews.push(args);
    assert.deepEqual(args[5], { auto, readOnly, remoteReadOnly });
    return { ok: true, allow, reason: "synthetic contextual verdict" };
  }, "native");
  await handlers.session_start({ reason: "startup" }, ctx);
  return {
    reviews,
    deny() { allow = false; },
    call(toolName, input) { return handlers.tool_call({ toolName, input, toolCallId: `native-routing-${++callId}` }, ctx); },
    toggle(name, value) { return commands[name](value, ctx); },
    close() { return handlers.session_shutdown({ reason: "quit" }); },
  };
}
const allowed = (result) => assert.notEqual(result?.block, true, result?.reason);
const blocked = (result) => assert.equal(result?.block, true);

try {
  // Parent auto OFF is inherited independently of CLI guards or global floors.
  for (const global of [false, true]) {
    for (const guards of [{ readOnly: true }, { remoteReadOnly: true }, { readOnly: true, remoteReadOnly: true }]) {
      const h = await harness({ auto: false, global, judge: false, ...guards });
      try {
        if (global) {
          await h.toggle("read-only", "off");
          await h.toggle("remote-read-only", "off");
        }
        allowed(await h.call("read", { path: "module.py" }));
        allowed(await h.call("grep", { pattern: "add", path: cwd }));
        assert.equal(classifierCalls, 0, "native reads need no fallible auto evidence with auto OFF");
        assert.equal(h.reviews.length, 0, "ordinary auto safety cannot deny a deterministic non-mutating read");
        for (const tool of ["write", "edit", "multi_edit", "apply_patch"]) {
          const result = await h.call(tool, { path: "module.py", content: "not executed" });
          if (guards.readOnly) {
            blocked(result);
            assert.match(result.reason, /judge disabled or no current chat model available/);
          } else if (tool === "write" || tool === "edit") {
            allowed(result); // Remote-only guard permits known local effects with auto OFF.
          } else blocked(result); // Unverified custom effects still require a judge.
        }
        blocked(await h.call("bash", { command: "synthetic remote mutation" }));
        blocked(await h.call("custom_action", { operation: "unknown" }));
        assert.equal(h.reviews.length, 0, "missing judge cannot waive unknown/remote guard conflicts");
      } finally { await h.close(); }
    }
  }

  const h = await harness({ auto: true, readOnly: true, remoteReadOnly: true });
  try {
    allowed(await h.call("read", { path: "module.py" }));
    assert.equal(classifierCalls, 1);
    assert.equal(h.reviews.length, 1, "positive secret prediction gets contextual review in a child");
    assert.equal(h.reviews[0][2], "read");
    assert.deepEqual(h.reviews[0][3], { path: "module.py" });
    h.deny();
    blocked(await h.call("read", { path: "module.py" }));
    assert.equal(h.reviews.length, 2, "contextual denial is still enforced");
    predicted = facts();
    for (const path of ["auth.json", "alias.py", ".env"]) {
      const result = await h.call("read", { path });
      blocked(result);
      assert.match(result.reason, /synthetic contextual verdict/);
    }
    assert.equal(h.reviews.length, 5, "lexical and canonical credential objections reach contextual review");
    for (const tool of ["write", "edit", "multi_edit", "apply_patch"]) {
      blocked(await h.call(tool, { path: "module.py", content: "not executed" }));
    }
    assert.equal(h.reviews.length, 9, "all native/custom write objections reach review");
  } finally { await h.close(); }

  predicted = facts({ exposes_secrets: true });
  const noJudge = await harness({ auto: true, readOnly: true, judge: false });
  try {
    const result = await noJudge.call("read", { path: "module.py" });
    blocked(result);
    assert.match(result.reason, /judge disabled or no current chat model available/);
    assert.doesNotMatch(result.reason, /known secret-bearing material/);
  } finally { await noJudge.close(); }
  console.log("native read prediction/auto/guard routing tests passed");
} finally {
  Classifier.prototype.classify = originalClassify;
  launcher.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}
