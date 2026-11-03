// Offline, synthetic admission and inert execution only; no providers or runtime captures.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activityExtension, { setFixtureProvider } from "./synthetic-runtime.mjs";
import { judgeSafety } from "../judge.ts";
import { Classifier } from "../classifier.ts";
import { ActivityObservations } from "../observations.ts";
import { classification, facts, createFixtureProvider, withNativeTools } from "./nine-head-fixtures.mjs";
import { syntheticLauncher } from "./delegation-fixture.mjs";
import { approvalFixture } from "./approval-fixture.mjs";

const root = mkdtempSync(join(tmpdir(), "activity-judge-last-"));
const cwd = join(root, "project");
const agent = join(root, "agent");
mkdirSync(cwd);
mkdirSync(join(agent, "config"), { recursive: true });
const provider = createFixtureProvider(root);
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE", "PI_SUBAGENT_TASK"].map((key) => [key, process.env[key]]));
const original = Classifier.prototype.classify;
const originalApproval = ActivityObservations.prototype.approval;
let approvalEvents = [];
ActivityObservations.prototype.approval = function (outcome, effective, ...args) {
  approvalEvents.push({ outcome, effective });
  return originalApproval.call(this, outcome, effective, ...args);
};
process.env.PI_CODING_AGENT_DIR = agent;
delete process.env.PI_ACTIVITY_AUTO_MODE;
delete process.env.PI_SUBAGENT_TASK;
const yes = { ok: true, allow: true, decision: "allow", reason: "synthetic compliant effects" };
const no = { ok: true, allow: false, decision: "block", reason: "synthetic policy objection" };
let id = 0, cases = 0;
let classify;
Classifier.prototype.classify = async (...args) => classify(...args);

async function harness(options = {}) {
  const approvals = approvalEvents = [];
  const guards = { readOnly: false, remoteReadOnly: false, ...options.guards };
  const launcher = options.delegated ? syntheticLauncher(cwd, "Inspect synthetic source", [
    { role: "user", text: "Inspect the synthetic fixture only. No publication." },
  ], options.inherited ?? { readOnly: false, remoteReadOnly: false }) : undefined;
  writeFileSync(join(agent, "config", "activity.json"), JSON.stringify({ acclass: setFixtureProvider(provider),
    auto: { judgeModel: options.missingJudge ? null : "fixture/judge" }, guards,
    log: { enabled: false }, reviewLog: { enabled: false }, session: { persistActivity: false } }));
  const handlers = {}, commands = {}, reviews = [];
  const branch = [{ type: "message", id: "user", message: { role: "user", content: "Inspect synthetic source" } }];
  let session = "judge-last", system = "Do not publish.", prompts = 0, executed = 0;
  const controller = new AbortController();
  const ctx = { cwd, mode: options.mode ?? "print", hasUI: options.mode === "tui", signal: controller.signal,
    getSystemPrompt: () => system,
    sessionManager: { getSessionId: () => session, getBranch: () => branch, getEntries: () => branch },
    ui: { notify() {}, setStatus() {}, theme: { fg: (_name, text) => text } } };
  ctx.ui.custom = approvalFixture(ctx, (done) => { prompts++; done("Allow"); });
  classify = options.classify ?? ((_text, _cwd, _home, kind) => classification(kind === "action" ? facts() : facts({ exposes_secrets: true, local_state_change: true })));
  activityExtension({
    on(name, handler) { handlers[name] = handler; }, registerFlag() {},
    registerCommand(name, definition) { commands[name] = definition.handler; },
    getFlag: (name) => name === "auto" && options.auto !== false,
    getAllTools: () => withNativeTools(options.tools), appendEntry() {}, sendMessage() {},
    events: { emit(name, value) { launcher?.emit(name, value); } },
  }, async (...args) => { reviews.push(args); return options.review ? options.review(...args) : yes; }, "native");
  await handlers.session_start({ reason: "startup" }, ctx);
  return { ctx, handlers, commands, reviews, branch, controller, approvals,
    setSession(value) { session = value; }, setSystem(value) { system = value; },
    get prompts() { return prompts; }, get executed() { return executed; },
    event(tool = "read", input = { path: "source.py" }, nested = false) {
      return { toolName: tool, input, toolCallId: `judge-last-${++id}`, ...(nested ? { parentToolCallId: "outer" } : {}) };
    },
    async call(event) { const result = await handlers.tool_call(event, ctx); if (!result?.block) executed++; return result; },
    async close() { await handlers.session_shutdown({}, ctx); launcher?.close(); },
  };
}
async function check(options, run) { const h = await harness(options); try { await run(h); cases++; } finally { await h.close(); } }
const blocked = (result) => assert.equal(result?.block, true, result?.reason);
const allowed = (result) => assert.notEqual(result?.block, true, result?.reason);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const safeContinuation = "\nContinue with a safe alternative that resolves this reason, or other unblocked work; prefer progress when the user is away. Do not bypass guards or retry unchanged. Ask only when no safe path remains.";
const assertRefusal = (reason) => {
  assert.match(reason, /^↑ Blocked — tool was not run\.\n/);
  assert.ok(reason.endsWith(safeContinuation), "every refusal preserves safe-progress guidance");
};
try {
  for (const delegated of [false, true]) for (const auto of [false, true]) {
    for (const guards of [{}, { readOnly: true }, { remoteReadOnly: true }, { readOnly: true, remoteReadOnly: true }]) {
      for (const nested of [false, true]) await check({ delegated, auto, guards }, async (h) => {
        allowed(await h.call(h.event("read", { path: "source.py" }, nested)));
        assert.equal(h.reviews.length, auto ? 1 : 0, "auto OFF does not reactivate secret-path/prediction policy under guards");
        if (auto) {
          const opts = h.reviews[0][14];
          assert.equal(opts.evidence.nativeEffects.local_state_change, false);
          assert.equal(opts.evidence.nativeEffects.exposes_secrets, undefined);
          assert.deepEqual(opts.evidence.predictions, { local_state_change: true, exposes_secrets: true });
          assert.equal(!!opts.delegatedContext, delegated);
        }
      });
    }
  }
  // Use the production prompt builder, not only an injected final verdict. A
  // false mutation prediction must not replace native read facts under inherited
  // guards. A bad semantic denial still fails closed; never retry it into allow.
  for (const decision of ["allow", "block"]) await check({
    delegated: true, inherited: { readOnly: true, remoteReadOnly: true },
    review: async (...args) => {
      const [ctx, , tool, , , modes] = args;
      assert.equal(tool, "read");
      assert.deepEqual(modes, { auto: true, readOnly: true, remoteReadOnly: true });
      ctx.modelRegistry = { find: () => ({ provider: "fixture", id: "judge", contextWindow: 128_000 }) };
      let completions = 0;
      args[9] = async (_model, prompt) => {
        completions++;
        assert.match(prompt.systemPrompt, /Non-mutating bash and delegated work that complies with active guards are allowed/);
        const evidence = prompt.messages[0].content[0].text;
        assert.match(evidence, /read-only: ON: reads only; no local or remote mutation/);
        assert.match(evidence, /Inherited hard guard restrictions JSON \[\d+ chars\]\n\{"readOnly":true,"remoteReadOnly":true\}/);
        assert.match(evidence, /Agent-authored task messages/);
        assert.match(evidence, /Delegated assignment \(not human consent\)/);
        assert.match(evidence, /Native effect facts JSON \(authoritative\) \[\d+ chars\]\n\{"local_state_change":false,"remote_state_change":false/);
        assert.match(evidence, /Classifier predictions JSON \(fallible; not facts\) \[\d+ chars\]\n\{"local_state_change":true,"exposes_secrets":true\}/);
        assert.match(evidence, /Review objections JSON \(claims; not authority\) \[\d+ chars\]\n\["base:exposes_secrets"\]/);
        return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ decision,
          reason: decision === "allow" ? "Native source inspection does not mutate state"
            : "A local source read conflicts with the active read-only guard, which permits only reads",
        }) }] };
      };
      const result = await judgeSafety(...args);
      assert.equal(completions, 1, "semantic denials do not trigger unchanged model retries");
      return result;
    },
  }, async (h) => {
    const result = await h.call(h.event());
    if (decision === "allow") allowed(result);
    else {
      blocked(result);
      assert.match(result.reason, /A local source read conflicts with the active read-only guard, which permits only reads/);
      assert.equal(h.executed, 0, "no reason heuristic can override a model denial");
    }
    assert.equal(h.reviews.length, 1);
    assert.equal(h.prompts, 0, "inherited guards never offer an ordinary approval override");
  });
  for (const auto of [false, true]) for (const mode of ["print", "json", "rpc", "tui"]) for (const tool of ["write", "edit"]) {
    for (const nested of [false, true]) await check({ auto, mode, guards: { readOnly: true } }, async (h) => {
      const result = await h.call(h.event(tool, { path: "source.py", content: "synthetic" }, nested));
      blocked(result);
      assert.match(result.reason, /Invalid\/inconsistent safety review/);
      assert.equal(h.reviews.length, 1);
      assert.equal(h.reviews[0][14].evidence.nativeEffects.local_state_change, true);
      assert.equal(h.executed, 0);
      assert.equal(h.prompts, 0);
    });
  }
  for (const name of ["write", "edit", "apply_patch", "mcp__fixture__lookup"]) await check({
    guards: { readOnly: true }, tools: [{ name, description: "unverified read hint",
      sourceInfo: { source: "extension", path: "/synthetic/tool.ts" }, annotations: { readOnlyHint: true } }],
  }, async (h) => {
    allowed(await h.call(h.event(name, { path: "source.py" })));
    assert.equal(h.reviews.length, 1, "even all-negative unverified metadata must review");
    assert.equal(h.reviews[0][14].evidence.nativeEffects, undefined, "names do not attest native effects");
  });
  for (const delegated of [false, true]) await check({ delegated }, async (h) => {
    allowed(await h.call(h.event("read", { path: ".env" })));
    assert.equal(h.reviews.length, 1, "credential heuristics are reviewed, not early denials");
    assert.match(h.reviews[0][14].evidence.objections.join(" "), /Credential-path heuristic/);
    assert.equal(h.reviews[0][14].evidence.nativeEffects.exposes_secrets, undefined);
  });
  for (const mutate of [
    (h, event) => { event.input.path = "changed.py"; },
    (h, event) => { event.input = { path: "source.py" }; },
    (h, event) => { event.toolName = "write"; },
    (h, event) => { event.parentToolCallId = "different"; },
    (h) => { h.ctx.cwd = root; },
    (h) => h.setSession("replacement"),
    (h) => h.setSystem("New explicit restriction"),
    (h) => h.branch.push({ type: "message", message: { role: "user", content: "Stop; permission revoked." } }),
    (h) => h.controller.abort(),
  ]) for (const verdict of [yes, no]) {
    const started = deferred(), finished = deferred();
    await check({ mode: "tui", review: () => { started.resolve(); return finished.promise; } }, async (h) => {
      const event = h.event(); const pending = h.call(event);
      await started.promise; mutate(h, event); finished.resolve(verdict);
      blocked(await pending); assert.equal(h.executed, 0); assert.equal(h.prompts, 0);
    });
  }
  await check({}, async (h) => {
    const event = h.event("read", { path: "source.py", extra: { value: 1 } });
    allowed(await h.call(event));
    assert.throws(() => { event.input.extra.value = 2; }, TypeError);
    assert.throws(() => { event.input = { path: "changed" }; }, TypeError);
  });
  for (const review of [
    () => ({ ok: false, technicalStop: "delegated-context", reason: "synthetic invalid context" }),
    () => ({ ok: false, technicalStop: "invalid-review", reason: "synthetic invalid guard claim" }),
    () => ({ ok: false, reason: "synthetic invalid config", metrics: { configurationError: "judge-model-unavailable" } }),
  ]) await check({ mode: "tui", review }, async (h) => {
    const result = await h.call(h.event()); blocked(result);
    assert.match(result.reason, /Safety review unavailable \(technical failure\): synthetic invalid/);
    assert.doesNotMatch(result.reason, /declined by user|user blocked|do not retry unchanged/);
    assert.equal(h.prompts, 0);
  });
  await check({ mode: "tui", missingJudge: true }, async (h) => {
    allowed(await h.call(h.event())); assert.equal(h.prompts, 1, "human exact-call approval remains outside guards");
  });
  await check({ mode: "tui", missingJudge: true, guards: { readOnly: true } }, async (h) => {
    blocked(await h.call(h.event())); assert.equal(h.prompts, 0);
  });
  await check({ delegated: true, auto: false, inherited: { readOnly: true, remoteReadOnly: true } }, async (h) => {
    await h.commands["read-only"]("off", h.ctx); await h.commands["remote-read-only"]("off", h.ctx);
    blocked(await h.call(h.event("write", { path: "source.py" })));
    assert.deepEqual(h.reviews[0][5], { auto: false, readOnly: true, remoteReadOnly: true });
    h.setSession("tampered-session");
    blocked(await h.call(h.event())); assert.equal(h.reviews.length, 1, "stale session binding stops before review");
  });
  await check({ mode: "tui" }, async (h) => {
    const event = h.event("read", { path: "source.py", hidden: undefined });
    await assert.rejects(h.call(event), /non-JSON/); assert.equal(h.prompts, 0); assert.equal(h.reviews.length, 0);
  });
  const reason = "Read ACCESS.md before opening the protected fixture";
  let immediateRefusal;
  await check({ mode: "tui", review: async () => ({ ok: true, allow: false, decision: "block", reason }) }, async (h) => {
    const result = await h.call(h.event()); blocked(result);
    immediateRefusal = result.reason;
    assert.equal(immediateRefusal, `↑ Blocked — tool was not run.\n🛡️ Blocked (llm): ${reason}.${safeContinuation}`);
    assert.equal(h.prompts, 0);
    assert.deepEqual(h.approvals, []);
  });
  for (const decision of ["block", "ask_user"]) {
    for (const mode of ["tui", "print"]) for (const guards of [{}, { readOnly: true }, { remoteReadOnly: true }]) {
      await check({ mode, guards, review: async () => ({ ok: true, allow: false, decision, reason }) }, async (h) => {
        const result = await h.call(h.event());
        const eligible = decision === "ask_user" && mode === "tui" && !Object.values(guards).some(Boolean);
        assert.equal(h.prompts, eligible ? 1 : 0, "block never opens UI; ask_user never overrides a guard");
        if (eligible) allowed(result);
        else {
          blocked(result); assert.ok(result.reason.includes(reason));
          assertRefusal(result.reason);
          assert.doesNotMatch(result.reason, /read-only off|be cautious|can't do it/);
        }
      });
    }
  }
  for (const outcome of ["block", "cancelled", "timeout", "unavailable", "abort", "stale", "guard"]) {
    await check({ mode: "tui", review: async () => ({ ok: true, allow: false, decision: "ask_user", reason }) }, async (h) => {
      h.ctx.ui.custom = outcome === "unavailable" ? async () => { throw new Error("synthetic unavailable UI"); }
        : approvalFixture(h.ctx, async (done, view) => {
          assert.match(view.render(80).join("\n"), /30s idle/, "UI keeps its 30-second inactivity window");
          if (outcome === "abort") h.controller.abort();
          if (outcome === "stale") h.setSystem("Changed explicit rule");
          if (outcome === "guard") await h.commands["read-only"]("on", h.ctx);
          done(outcome === "stale" || outcome === "guard" ? "Allow" : outcome === "block" ? "Block" : outcome === "abort" ? "cancelled" : outcome);
        });
      const result = await h.call(h.event()); blocked(result);
      assert.equal(h.executed, 0);
      assert.ok(result.reason.includes(reason), `${outcome} preserves original judge reason`);
      if (outcome === "block") {
        assert.match(result.reason, /action declined by user; do not retry unchanged/);
        assert.notEqual(result.reason, immediateRefusal, "explicit denial remains distinct from an unavailable approval");
      } else {
        assert.doesNotMatch(result.reason, /declined by user|user blocked|do not retry unchanged/);
      }
      if (outcome === "timeout") {
        assert.equal(result.reason, immediateRefusal, "timeout is exactly the same refusal as immediate block");
        assert.doesNotMatch(result.reason, /timeout|timed out|30 seconds|approval prompt|human.*declined/i);
      }
      if (outcome === "cancelled") assert.match(result.reason, /approval cancelled/);
      if (outcome === "unavailable") assert.match(result.reason, /no interactive approval available/);
      if (outcome === "abort") assert.match(result.reason, /turn cancelled/);
      if (outcome === "stale") assert.match(result.reason, /Tool arguments or policy context changed during review; this call cannot execute/);
      if (outcome === "guard") assert.match(result.reason, /safety mode changed/);
      if (outcome !== "stale") assert.deepEqual(h.approvals, [{
        outcome: outcome === "abort" ? "cancelled" : outcome === "guard" ? "allow" : outcome, effective: false,
      }], "telemetry retains the actual approval outcome, not human denial");
      assertRefusal(result.reason);
    });
  }
  // Permission status must not hide invalidation; an actual Block must also
  // survive the diagnostic replacement (even if the judge already forbids retry).
  for (const outcome of ["block", "timeout"]) for (const invalidation of ["stale", "guard"]) {
    const originalReason = `${reason}; do not retry unchanged`;
    await check({ mode: "tui", review: async () => ({ ok: true, allow: false, decision: "ask_user", reason: originalReason }) }, async (h) => {
      h.ctx.ui.custom = approvalFixture(h.ctx, async (done) => {
        if (invalidation === "stale") h.setSystem("Changed explicit rule");
        else await h.commands["read-only"]("on", h.ctx);
        done(outcome === "block" ? "Block" : "timeout");
      });
      const result = await h.call(h.event()); blocked(result);
      assert.ok(result.reason.includes(originalReason));
      assert.match(result.reason, invalidation === "stale" ? /Tool arguments or policy context changed/ : /safety mode changed/);
      if (outcome === "block") assert.match(result.reason, /action declined by user; do not retry unchanged/);
      else assert.doesNotMatch(result.reason, /declined by user|user blocked|timeout|timed out|30 seconds/i);
      assert.equal(h.executed, 0);
    });
  }
  for (const mode of ["print", "rpc", "json", "tui"]) await check({ mode,
    review: async () => ({ ok: true, allow: false, decision: "ask_user", reason }),
  }, async (h) => {
    h.ctx.hasUI = false;
    const result = await h.call(h.event()); blocked(result);
    assert.ok(result.reason.includes(reason));
    assert.match(result.reason, /no interactive approval available/);
    assert.doesNotMatch(result.reason, /declined by user|user blocked|do not retry unchanged/);
    assert.equal(h.prompts, 0);
    assert.deepEqual(h.approvals, []);
  });
  // Independent nested admissions overlap; cancelling one cannot stop its sibling.
  const bothStarted = deferred(), finishSibling = deferred(); let concurrent = 0;
  await check({ review: async (_ctx, _ref, _tool, input, _cwd, _modes, signal) => {
    if (++concurrent === 2) bothStarted.resolve();
    if (input.path === "cancel.py") {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return { ok: false, reason: "cancelled" };
    }
    await finishSibling.promise; assert.equal(signal.aborted, false); return yes;
  } }, async (h) => {
    const cancel = new AbortController();
    const a = h.handlers.tool_call(h.event("read", { path: "cancel.py" }, true), { ...h.ctx, signal: cancel.signal });
    const b = h.call(h.event("read", { path: "sibling.py" }, true));
    let timer;
    try {
      await Promise.race([bothStarted.promise, new Promise((_r, reject) => {
        timer = setTimeout(() => reject(new Error("independent reviews were serialized")), 1000);
      })]);
      cancel.abort(); blocked(await a); finishSibling.resolve(); allowed(await b);
      assert.equal(concurrent, 2);
    } finally { clearTimeout(timer); cancel.abort(); finishSibling.resolve(); await Promise.all([a, b]); }
  });
  console.log(`judge-last routing, provenance and identity tests passed (${cases} cases)`);
} finally {
  Classifier.prototype.classify = original;
  ActivityObservations.prototype.approval = originalApproval;
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
}
