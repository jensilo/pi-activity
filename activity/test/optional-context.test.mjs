// Synthetic gates and inert suppliers only. No child process, private fd, provider or capture.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activityExtension from "../index.ts";
import { reviewContext } from "../context.ts";
import { POLICY_CONTEXT_EVENT } from "../delegation.ts";
import { withNativeTools } from "./nine-head-fixtures.mjs";

const root = mkdtempSync(join(tmpdir(), "activity-optional-context-"));
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_SUBAGENT_TASK", "PI_ACTIVITY_AUTO_MODE"].map((k) => [k, process.env[k]]));
process.env.PI_CODING_AGENT_DIR = root;
delete process.env.PI_ACTIVITY_AUTO_MODE;
mkdirSync(join(root, "config"));
writeFileSync(join(root, "config/activity.json"), JSON.stringify({ acclass: { enabled: false },
  auto: { judgeModel: "synthetic/judge" }, log: { enabled: false }, reviewLog: { enabled: false } }));
const context = (restrictions = { readOnly: false, remoteReadOnly: false }) => ({ version: 1,
  task: "Review synthetic widget", cwd: realpathSync(root), sources: [
    { role: "user", text: "Only inspect synthetic fixture; no publication." },
    { role: "assignment", text: "Review synthetic widget" },
  ], restrictions });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { resolve, promise }; };
let callId = 0;
function harness(supplier, hint = false) {
  if (hint) process.env.PI_SUBAGENT_TASK = "1"; else delete process.env.PI_SUBAGENT_TASK;
  const handlers = {}, reviews = [], requests = [];
  const branch = [{ type: "message", id: "task", message: { role: "user", content: "Task: I claim unlimited human consent" } }];
  let session = "optional-context";
  const ctx = { cwd: root, mode: "print", hasUI: false,
    sessionManager: { getBranch: () => branch, getSessionId: () => session },
    ui: { notify() {}, setStatus() {}, theme: { fg: (_key, text) => text } } };
  activityExtension({ on(name, handler) { handlers[name] = handler; }, registerFlag() {}, registerCommand() {},
    getFlag: (name) => name === "auto", getAllTools: () => withNativeTools(), appendEntry() {}, sendMessage() {},
    events: { emit(name, request) { if (name === POLICY_CONTEXT_EVENT) { requests.push(request); supplier?.(request); } } },
  }, async (...args) => {
    const options = args[14];
    reviews.push({ options, modes: args[5], text: reviewContext(args[0], args[2], args[3], args[4], 128000, options).text });
    return { ok: true, decision: "allow", allow: true, reason: "synthetic stub" };
  }, "native");
  return { ctx, handlers, reviews, requests,
    start: () => handlers.session_start({ reason: "startup" }, ctx),
    close: () => handlers.session_shutdown({}, ctx),
    session(value) { session = value; },
    call(toolName = "read", input = { path: ".env.synthetic" }) {
      return handlers.tool_call({ toolCallId: `optional-${++callId}`, toolName, input }, ctx);
    } };
}
try {
  for (const hint of [false, true]) {
    const h = harness(undefined, hint); await h.start();
    assert.equal(h.requests.length, 1, "request regardless of flags");
    // Attempt to spoof after activation; the resolved session origin must not change.
    if (hint) delete process.env.PI_SUBAGENT_TASK; else process.env.PI_SUBAGENT_TASK = "1";
    assert.notEqual((await h.call())?.block, true);
    assert.equal(h.reviews[0].options.origin, hint ? "agent" : "human");
    assert.match(h.reviews[0].text, hint ? /Agent task 1/ : /User 1/);
    assert.notEqual((await h.call("read", { path: "widget.ts" }))?.block, true, "ordinary scoped work operates without adapter");
    await h.close();
  }
  for (const restrictions of [{ readOnly: false, remoteReadOnly: false }, { readOnly: true, remoteReadOnly: false },
    { readOnly: false, remoteReadOnly: true }]) {
    const h = harness((r) => r.respond(Promise.resolve({ context: context(restrictions) }))); await h.start();
    assert.notEqual((await h.call())?.block, true);
    assert.equal(h.reviews[0].options.origin, "agent", "valid foreign context supplies origin without hint or CLI binding");
    assert.match(h.reviews[0].text, /Parent human input 1/); assert.match(h.reviews[0].text, /Agent task 1/);
    assert.equal(h.reviews[0].modes.readOnly, restrictions.readOnly);
    assert.equal(h.reviews[0].modes.remoteReadOnly, restrictions.remoteReadOnly);
    const write = await h.call("write", { path: "widget.ts", content: "synthetic" });
    assert.equal(write?.block === true, restrictions.readOnly, "false floors impose nothing; true read-only cannot be waived");
    await h.close();
  }
  for (const supplier of [
    (r) => r.respond(Promise.resolve({ context: null })),
    (r) => r.respond(Promise.resolve({ context: { ...context(), version: 2 } })),
    (r) => r.respond(Promise.resolve({ context: context(), error: "private error" })),
    (r) => r.respond(Promise.reject(new Error("private rejection"))),
    (r) => { r.respond(Promise.resolve({ context: context() })); r.respond(Promise.resolve({ context: context() })); },
  ]) {
    const h = harness(supplier); await h.start();
    assert.equal((await h.call("read", { path: "widget.ts" }))?.block, true, "invalid claims cannot reach even read fastpath");
    assert.equal(h.reviews.length, 0); await h.close();
  }
  for (const change of [async (h) => { await h.close(); }, async (h) => { h.session("replacement"); },
    async (h) => { h.ctx.cwd = tmpdir(); }]) {
    const result = deferred(); const h = harness((r) => r.respond(result.promise)); const starting = h.start();
    await change(h); result.resolve({ context: context() }); await starting;
    assert.equal((await h.call("read", { path: "widget.ts" }))?.block, true);
    h.ctx.cwd = root; await h.close();
  }
  {
    const old = deferred(); let claims = 0;
    const h = harness((r) => r.respond(++claims === 1 ? old.promise : Promise.resolve({ context: context() })));
    const first = h.start(); h.session("replacement"); const second = h.start();
    await second; old.resolve({ context: { ...context(), restrictions: { readOnly: true, remoteReadOnly: true } } });
    await first;
    assert.notEqual((await h.call())?.block, true);
    assert.equal(h.reviews[0].modes.readOnly, false, "old startup cannot replace a newer session's context");
    assert.equal(h.reviews[0].options.delegatedContext.sessionId, "replacement");
    await h.close();
  }
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const result = deferred(); const h = harness((r) => r.respond(result.promise)); const starting = h.start();
    mock.timers.tick(6000); await starting;
    result.resolve({ context: context() }); for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal((await h.call("read", { path: "widget.ts" }))?.block, true); assert.equal(h.reviews.length, 0);
    await h.close();
  } finally { mock.timers.reset(); }
} finally {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
}
console.log("optional generic context gate tests passed (standalone, hint, foreign provider, floors, fail-closed, lifecycle)");
