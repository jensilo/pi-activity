import assert from "node:assert/strict";
import { clearSafetySummaries, judgeSafety } from "../judge.ts";
import { RollingUserSummary } from "../summary.ts";

const signal = new AbortController().signal;
const modes = { auto: true, readOnly: false, remoteReadOnly: false };
const models = ["review:high", "summary:off", "fallback:max"].map((id) => ({ provider: "fixture", id, contextWindow: 128000 }));
const summaryText = "# User Message Summary\n## Context\nSynthetic task\n## Intent\nImplement changes\n## Allowed\nTask-scoped writes\n## Forbidden\nNo deployment\n## Guardrails\nPreserve unrelated changes";
const response = (model, text, stopReason = "stop", errorMessage) => ({ role: "assistant", provider: model.provider,
  model: model.id, api: "fixture", content: [{ type: "text", text }], stopReason, errorMessage,
  usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } });
let session = 0;
const context = (users = 6) => {
  const id = `thinking-${++session}`;
  return {
  sessionManager: { getSessionId: () => id, getBranch: () => Array.from({ length: users }, (_, i) => ({
    type: "message", id: `user-${i}`, message: { role: "user", content: `Synthetic task input ${i}` },
  })) },
  modelRegistry: { getAll: () => models,
    find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    getApiKeyAndHeaders: () => { throw new Error("auth belongs to native registry dispatch"); } },
  };
};

// Exercise independent and inherited effort through real summary/judge/fallback code.
for (const options of [
  { judgeThinking: "high", summaryThinking: "minimal", fallbackJudgeThinking: "medium" },
  { judgeThinking: "max" },
  { judgeThinking: "low", summaryThinking: "off", fallbackJudgeThinking: "off" },
  {},
]) {
  clearSafetySummaries();
  const calls = [];
  const complete = async (model, prompt, callOptions) => {
    calls.push([model.id, callOptions.reasoning]);
    if (prompt.systemPrompt.startsWith("Condense")) return response(model, summaryText);
    if (model.id === "review:high") return response(model, "", "error", "maximum context length exceeded");
    return response(model, '{"decision":"allow","reason":"synthetic scoped action"}');
  };
  const verdict = await judgeSafety(context(), "fixture/review:high", "bash", { command: "synthetic candidate" },
    "/synthetic", modes, signal, undefined, undefined, complete, "fixture/fallback:max", undefined,
    "fixture/summary:off", undefined, options);
  const reasoning = (level) => level === "off" ? undefined : level;
  const judge = options.judgeThinking ?? "off";
  assert.equal(verdict.allow, true, verdict.reason);
  assert.equal(verdict.metrics.fallbackUsed, true);
  assert.deepEqual(calls, [
    ["summary:off", reasoning(options.summaryThinking ?? judge)],
    ["review:high", reasoning(judge)],
    ["fallback:max", reasoning(options.fallbackJudgeThinking ?? judge)],
  ], "model-id colons never override independent or inherited effort");
}

// Defaults use the selected judge model and effort, not the current chat model.
clearSafetySummaries();
const followed = [];
const verdict = await judgeSafety(context(), "fixture/review:high", "bash", {}, "/synthetic", modes, signal,
  undefined, undefined, async (model, prompt, options) => {
    followed.push([model.id, options.reasoning]);
    return response(model, prompt.systemPrompt.startsWith("Condense") ? summaryText : '{"decision":"allow","reason":"synthetic"}');
  }, undefined, undefined, undefined, undefined, { judgeThinking: "low" });
assert.equal(verdict.allow, true);
assert.deepEqual(followed, [["review:high", "low"], ["review:high", "low"]]);

// A legacy-looking reference cannot silently dispatch to an existing unsuffixed model.
let calls = 0;
const missing = await judgeSafety(context(0), "fixture/review:high:off", "bash", {}, "/synthetic", modes, signal,
  undefined, undefined, async () => { calls++; throw new Error("must not dispatch"); });
assert.equal(missing.ok, false);
assert.equal(missing.metrics.configurationError, "judge-model-unavailable");
assert.equal(missing.metrics.providerRequests, 0);
assert.equal(calls, 0);

// Independent summary API also accepts exact bare colon IDs with separate effort.
for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
  const prepared = await new RollingUserSummary().prepare(context(), "summary:off", signal,
    async (model, _prompt, options) => {
      assert.equal(model.id, "summary:off");
      assert.equal(options.reasoning, thinking === "off" ? undefined : thinking);
      return response(model, summaryText);
    }, undefined, undefined, { thinking });
  assert.equal(prepared.metrics.status, "generated");
}
clearSafetySummaries();
console.log("separate model/thinking tests passed (literal colon IDs, independent effort, inheritance, fallback and fail-closed lookup)");
