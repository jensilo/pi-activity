// Public config and production tool gate; only the model transports are synthetic.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import activityExtension from "../index.ts";
import { withNativeTools } from "./nine-head-fixtures.mjs";

const model = (id) => ({ id, provider: "fixture", api: "synthetic", contextWindow: 32_768 });
const chat = [model("current"), model("legacy:version"), model("fallback")];
const classifiers = ["decision", "decision-fallback"].map((id) => ({ ...model(id), type: "classifier" }));
const allow = JSON.stringify({ decision: "allow", reason: "Synthetic allow." });
const block = JSON.stringify({ decision: "block", reason: "Synthetic denial." });

async function withGate(auto, check, { responses = {}, guards } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "activity-judge-backend-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  mkdirSync(join(cwd, "config"));
  const configure = (settings) => writeFileSync(join(cwd, "config/activity.json"), JSON.stringify({
    acclass: { enabled: false }, auto: settings, guards,
  }));
  configure(auto);
  const calls = [], handlers = {};
  let prompts = 0, id = 0;
  const prompt = () => { prompts++; throw new Error("unexpected tool approval"); };
  const ctx = { cwd, hasUI: true, mode: "tui", model: chat[0],
    sessionManager: { getSessionId: () => "judge-backend-fixture", getBranch: () => [] },
    ui: { notify() {}, setStatus() {}, theme: { fg: (_name, value) => value }, custom: prompt, select: prompt, confirm: prompt },
    modelRegistry: {
      find: (provider, id) => chat.find((m) => m.provider === provider && m.id === id),
      getAll: () => chat,
      findOfType: (type, provider, id) => classifiers.find((m) => m.type === type && m.provider === provider && m.id === id),
      streamSimple(selected, context, options) {
        calls.push({ backend: "chat", id: selected.id, reasoning: options.reasoning, context });
        const body = selected.id in responses ? responses[selected.id] : allow;
        const message = { role: "assistant", provider: selected.provider, model: selected.id, api: selected.api,
          stopReason: "stop", content: [{ type: "text", text: body }] };
        return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; }, async result() { return message; } };
      },
      async classify(selected, context) {
        calls.push({ backend: "classifier", id: selected.id, context });
        return { provider: selected.provider, model: selected.id, api: selected.api, stopReason: "stop",
          answers: { verdict: { type: "choice", choice: responses[selected.id] ?? "allow", confidence: 0.9 } } };
      },
    },
  };
  activityExtension({
    on(name, handler) { handlers[name] = handler; }, registerFlag() {}, registerCommand() {},
    getFlag: (name) => name === "auto", getAllTools: () => withNativeTools(), appendEntry() {}, sendMessage() {}, events: { emit() {} },
  }, undefined, "native");
  try {
    await handlers.session_start({ reason: "startup" }, ctx);
    const call = (toolName = "fixture_custom", input = { payload: "Complete synthetic action" }) =>
      handlers.tool_call({ toolName, input, toolCallId: `judge-backend-${++id}` }, ctx);
    await check({ calls, call, ctx, configure });
    assert.equal(prompts, 0);
  } finally {
    await handlers.session_shutdown({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(cwd, { force: true, recursive: true });
  }
}

for (const judgeMode of [undefined, "short"]) {
  test(`${judgeMode ?? "full"} public config supports explicit chat, legacy chat refs, current chat, and disable`, async () => {
    const config = { judgeMode, judgeThinking: "low" };
    await withGate(config, async ({ calls, call, configure, ctx }) => {
      assert.notEqual((await call())?.block, true);
      configure({ ...config, judgeModel: "legacy:version" });
      assert.notEqual((await call())?.block, true);
      configure({ ...config, judgeBackend: "chat", judgeModel: "fixture/legacy:version" });
      assert.notEqual((await call())?.block, true);
      configure({ ...config, judgeModel: null, fallbackJudgeModel: "fixture/fallback" });
      assert.equal((await call())?.block, true);
      configure(config);
      ctx.model = undefined;
      assert.equal((await call())?.block, true);
      assert.deepEqual(calls.map(({ backend, id, reasoning }) => [backend, id, reasoning]), [
        ["chat", "current", "low"], ["chat", "legacy:version", "low"], ["chat", "legacy:version", "low"],
      ]);
      for (const { context } of calls) {
        assert.match(context.messages[0].content[0].text, /Complete synthetic action/);
        assert.equal(context.tools, undefined);
        assert.match(context.systemPrompt, judgeMode === "short" ? /Prior tool calls may be absent/ : /Ordinary review policy/);
      }
    });
  });
}

test("chat fallback handles technical failure without overriding a valid denial or crossing to classifiers", async () => {
  const config = { judgeMode: "short", judgeModel: "fixture/legacy:version", fallbackJudgeModel: "fixture/fallback",
    judgeThinking: "low", fallbackJudgeThinking: "high" };
  await withGate(config, async ({ calls, call, configure }) => {
    assert.notEqual((await call())?.block, true);
    configure({ ...config, fallbackJudgeModel: "fixture/decision" });
    assert.equal((await call())?.block, true, "a classifier reference is not usable as a chat fallback");
    assert.deepEqual(calls.map(({ backend, id, reasoning }) => [backend, id, reasoning]), [
      ["chat", "legacy:version", "low"], ["chat", "fallback", "high"], ["chat", "legacy:version", "low"],
    ]);
  }, { responses: { "legacy:version": "malformed synthetic verdict" } });
  await withGate(config, async ({ calls, call }) => {
    assert.match((await call()).reason, /Synthetic denial/);
    assert.deepEqual(calls.map(({ id }) => id), ["legacy:version"]);
  }, { responses: { "legacy:version": block } });
});

test("cascade defaults to classifier and a configured classifier fallback cannot resolve a chat model", async () => {
  await withGate({ judgeMode: "cascade", judgeModel: "fixture/decision", judgeThinking: "high" }, async ({ calls, call, configure }) => {
    assert.notEqual((await call())?.block, true);
    assert.equal(calls[0].context.questions.verdict.type, "choice");
    configure({ judgeBackend: "classifier", judgeMode: "short", judgeModel: "fixture/missing", fallbackJudgeModel: "fixture/decision-fallback" });
    assert.notEqual((await call())?.block, true, "a registered classifier can serve as an explicit fallback");
    configure({ judgeBackend: "classifier", judgeModel: "fixture/missing", fallbackJudgeModel: "fixture/current" });
    assert.equal((await call())?.block, true);
    configure({ judgeMode: "cascade" });
    assert.equal((await call())?.block, true, "classifier mode does not use the current chat model when omitted");
    assert.deepEqual(calls.map(({ backend, id }) => [backend, id]), [["classifier", "decision"], ["classifier", "decision-fallback"]]);
  });
});

test("an in-flight verdict is stale if the selected current chat model changes", async () => {
  await withGate({ judgeMode: "short" }, async ({ calls, call, ctx }) => {
    const streamSimple = ctx.modelRegistry.streamSimple;
    ctx.modelRegistry.streamSimple = (...args) => {
      ctx.model = chat[1];
      return streamSimple(...args);
    };
    assert.match((await call()).reason, /policy context changed during review/);
    assert.deepEqual(calls.map(({ id }) => id), ["current"]);
  });
});

test("chat cannot waive a hard guard", async () => {
  await withGate({ judgeMode: "short" }, async ({ calls, call }) => {
    assert.match((await call("write", { path: "fixture.txt", content: "synthetic" })).reason, /Invalid\/inconsistent safety review/);
    assert.equal(calls.length, 1);
  }, { guards: { readOnly: true } });
});
