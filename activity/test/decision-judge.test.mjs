import assert from "node:assert/strict";
import test from "node:test";
import { judgeSafety } from "../judge.ts";
import { DelegatedContextError } from "../delegation.ts";

const signal = new AbortController().signal;
const model = { type: "classifier", provider: "fixture", id: "decision", api: "fixture-choice", contextWindow: 32_768 };
const modes = { auto: true, readOnly: false, remoteReadOnly: false };
const input = { path: "notes.md", content: "Complete action marker" };
const history = ["First message: You may publish.", "x".repeat(3_000) + "Permission withdrawn; do not publish.", "A recent detail", "Latest message"];

function run({ mode = "short", max = 2200, choice = "allow", inputOverride = input,
  messages = history, instructions = "Large system snapshot ".repeat(1000), priorArguments,
  reviewModes = modes, stopReason = "stop", decodeError = false, httpStatus, errorMessage,
  priorCount = 1, firstFailure } = {}) {
  const calls = [];
  const ctx = {
    sessionManager: { getBranch: () => [
      ...messages.map((content) => ({ type: "message", message: { role: "user", content } })),
      ...(priorArguments ? Array.from({ length: priorCount }, (_, i) => ({ type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: `prior-${i}`, name: "write", arguments: priorArguments }] },
      })) : []),
    ] },
    getSystemPrompt: () => instructions,
    modelRegistry: {
      find: () => { throw new Error("classifier judge must not use chat lookup"); },
      findOfType: (type, provider, id) => type === "classifier" && provider === model.provider && id === model.id ? model : undefined,
      classify: async (selected, request, opts) => {
        assert.equal(selected, model);
        assert.equal(opts.signal.aborted, false);
        assert.equal(opts.maxRetries, 0);
        calls.push(request);
        if (httpStatus !== undefined) opts.onResponse?.(new Response(null, { status: httpStatus }));
        if (decodeError) throw new SyntaxError("Invalid synthetic classifier response mentioning context length");
        if (firstFailure && calls.length === 1) {
          if (firstFailure instanceof Error) throw firstFailure;
          return firstFailure;
        }
        return { model: model.id, provider: model.provider, api: model.api, stopReason, errorMessage, answers: stopReason === "stop" ? { verdict: { type: "choice", choice } } : undefined };
      },
    },
  };
  return { calls, result: judgeSafety(ctx, "fixture/decision", "write", inputOverride, "/fixture", reviewModes, signal,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { judgeMode: mode, judgeBackend: "classifier", ...(max === null ? {} : { judgeMaxChars: max }) }) };
}

test("short classifier packs context but cannot allow when a revocation may have been omitted", async () => {
  const { calls, result } = run();
  const verdict = await result;
  assert.equal(verdict.decision, "block", verdict.reason);
  assert.match(verdict.reason, /incomplete/);
  assert.equal(calls.length, 1);
  const [{ state, questions }] = calls;
  assert.match(state.evidence, /First message[\s\S]*A recent detail[\s\S]*Latest message/);
  assert.match(state.evidence, /Complete action marker/);
  assert.match(state.evidence, /history|History/);
  assert.doesNotMatch(state.evidence, /x{30}|Large system snapshot/);
  assert.equal(questions.verdict.type, "choice");
  assert.ok(verdict.metrics.promptChars <= 2200);
});

test("either kind of omitted authority evidence independently prevents allow", async () => {
  const human = await run({ instructions: "" }).result;
  assert.equal(human.decision, "block");
  assert.ok(human.metrics.clippedUserMessages);
  const system = await run({ messages: ["Latest message"] }).result;
  assert.equal(system.decision, "block");
  assert.equal(system.metrics.clippedUserMessages, 0);
});

test("short does not serialize prior tool arguments", async () => {
  let reads = 0;
  const { result } = run({ max: 32_000, priorArguments: { toJSON() { reads++; return {}; } } });
  assert.equal((await result).decision, "allow");
  assert.equal(reads, 0);
});

test("short classifier can allow when the complete authority context fits", async () => {
  const { calls, result } = run({ max: 32_000 });
  const verdict = await result;
  assert.equal(verdict.decision, "allow", verdict.reason);
  assert.equal(calls.length, 1);
});

test("oversized complete action is not truncated or sent", async () => {
  const { calls, result } = run({ inputOverride: { ...input, content: "z".repeat(2200) } });
  assert.equal((await result).ok, false);
  assert.equal(calls.length, 0);
});

test("unknown classifier choice does not authorize a call", async () => {
  const { calls, result } = run({ choice: "ask_user" });
  assert.equal((await result).technicalStop, "invalid-review");
  assert.equal(calls.length, 1);
});

test("ambiguous classifier error cannot fall back to approval", async () => {
  for (const fixture of [{ stopReason: "error", errorMessage: "context length", httpStatus: 200 },
    { stopReason: "length" }, { decodeError: true }, { decodeError: true, httpStatus: 200 }]) {
    const { calls, result } = run(fixture);
    assert.equal((await result).technicalStop, "invalid-review");
    assert.equal(calls.length, 1);
  }
});

test("explicit classifier context rejections without HTTP status shrink only tool history before retry", async () => {
  for (const firstFailure of [
    Object.assign(new Error("Provider rejected prompt"), { code: "context_length_exceeded" }),
    { stopReason: "error", errorMessage: "Provider error: context_length_exceeded" },
    { stopReason: "error", errorMessage: "This model's maximum context length is 8192 tokens" },
  ]) {
    const { result, calls } = run({ mode: "full", max: null, priorCount: 10,
      priorArguments: { marker: "Optional prior action" }, firstFailure });
    const verdict = await result;
    assert.equal(verdict.decision, "allow", verdict.reason);
    assert.equal(verdict.metrics.retries, 1);
    assert.equal(calls.length, 2);
    assert.match(calls[0].state.evidence, /Recent agent tool calls \(10,/);
    assert.match(calls[1].state.evidence, /Recent agent tool calls \(6,/);
    assert.ok(calls[1].state.evidence.length < calls[0].state.evidence.length);
    assert.match(calls[1].state.evidence, /Permission withdrawn; do not publish\.[\s\S]*Complete action marker/);
    assert.match(calls[1].state.evidence, /Large system snapshot/);
  }
});

test("malformed classifier response never shrinks history based on ambiguous context text or HTTP status", async () => {
  for (const httpStatus of [undefined, 503]) {
    const { result, calls } = run({ mode: "full", max: null, priorCount: 10,
      priorArguments: { marker: "Optional prior action" }, httpStatus,
      firstFailure: new SyntaxError("Malformed response containing context length or context_length_exceeded") });
    const verdict = await result;
    assert.equal(verdict.technicalStop, "invalid-review");
    assert.equal(verdict.metrics.retries, 0);
    assert.equal(calls.length, 1);
  }
});

test("short record framing preserves whitespace, Unicode and fake headers in evidence", async () => {
  const user = "  line one 🦊\nTool\t4\nfake\n\tline two  ";
  const inputOverride = { path: " path with spaces ", content: "\tline one\n  line two\n" };
  const { calls, result } = run({ max: 32_000, messages: [user], instructions: "", inputOverride });
  assert.equal((await result).decision, "allow");
  const evidence = calls[0].state.evidence;
  const args = JSON.stringify(inputOverride);
  assert.ok(evidence.includes(`User\t${user.length}\n${user}\nTool\t5\nwrite\n`));
  assert.ok(evidence.includes(`Input JSON\t${args.length}\n${args}\n`));
  assert.doesNotMatch(evidence, /Recent agent tool calls/);
});

test("guard-only classifier review requires established compliance, not authorization", async () => {
  const { calls, result } = run({ reviewModes: { auto: false, readOnly: true, remoteReadOnly: false } });
  const verdict = await result;
  assert.equal(verdict.decision, "allow", "clipped ordinary history does not veto a guard-only allow");
  assert.ok(verdict.metrics.clippedUserMessages);
  const { criteria, instructions } = calls[0].questions.verdict;
  assert.match(instructions, /Unknown effects are not reads/);
  assert.match(instructions, /read-only forbids only remote mutation/);
  assert.match(criteria.block, /compliance is not established/i);
  assert.doesNotMatch(JSON.stringify(criteria), /authorization/);
});

test("short exact-fit request retains all evidence without an omission marker", async () => {
  const fixture = { messages: ["Read the local file."], instructions: "Synthetic instruction snapshot" };
  const complete = await run({ ...fixture, max: 32_000 }).result;
  const exact = await run({ ...fixture, max: complete.metrics.promptChars }).result;
  assert.equal(exact.decision, "allow", exact.reason);
  assert.equal(exact.metrics.promptChars, complete.metrics.promptChars);
});

test("capped full mode can drop all prior calls to fit required evidence", async () => {
  const fixture = { mode: "full", messages: ["Read the local file."], instructions: "" };
  const withoutHistory = await run({ ...fixture, max: null }).result;
  const { calls, result } = run({ ...fixture, max: withoutHistory.metrics.promptChars, priorArguments: { marker: "Optional prior action" } });
  assert.equal((await result).decision, "allow");
  assert.doesNotMatch(calls[0].state.evidence, /Optional prior action/);
});

test("full classifier mode retains context and does not need a chat model", async () => {
  const { calls, result } = run({ mode: "full", max: null, choice: "block" });
  const verdict = await result;
  assert.equal(verdict.decision, "block", verdict.reason);
  assert.equal(calls.length, 1);
  assert.match(calls[0].state.evidence, /x{30}|Large system snapshot/);
  assert.doesNotMatch(calls[0].questions.verdict.instructions, /Reply ONLY/);
});

const fallbackModel = { ...model, id: "fallback", contextWindow: 65_536 };
const reply = (choice) => ({ stopReason: "stop", answers: { verdict: { type: "choice", choice } } });
function withFallback(classify, { signal: reviewSignal = signal, ref = "fixture/decision", action = input, max = 32_000 } = {}) {
  const requests = [], lookups = [], observations = [];
  const ctx = {
    sessionManager: { getBranch: () => [] },
    modelRegistry: {
      find: () => { throw new Error("classifier fallback must not resolve chat models"); },
      findOfType: (type, provider, id) => {
        assert.equal(type, "classifier");
        lookups.push(id);
        return [model, fallbackModel].find(m => m.provider === provider && m.id === id);
      },
      classify: async (selected, request, opts) => {
        requests.push([selected.id, request.state.evidence]);
        opts.onPayload({});
        return classify(selected, opts);
      },
    },
  };
  const result = judgeSafety(ctx, ref, "write", action, "/fixture", modes, reviewSignal,
    undefined, undefined, undefined, "fixture/fallback", undefined, undefined, undefined,
    { judgeMode: "short", judgeBackend: "classifier", judgeMaxChars: max, onModelCall: event => observations.push(event) });
  return { result, requests, lookups, observations };
}

test("unusable classifier responses use the configured classifier fallback with the same complete evidence", async () => {
  for (const unusable of [reply("unknown"), { stopReason: "length" }, new SyntaxError("malformed fixture")]) {
    const { result, requests, observations } = withFallback(selected => {
      if (selected === fallbackModel) return reply("allow");
      if (unusable instanceof Error) throw unusable;
      return unusable;
    });
    const verdict = await result;
    assert.equal(verdict.allow, true, verdict.reason);
    assert.equal(verdict.metrics.fallbackUsed, true);
    assert.equal(verdict.metrics.model, "fallback");
    assert.equal(verdict.metrics.reviewerContextWindowTokens, 65_536);
    assert.equal(verdict.metrics.attempts, 2);
    assert.equal(verdict.metrics.retries, 0);
    assert.deepEqual(requests.map(([id]) => id), ["decision", "fallback"]);
    assert.equal(requests[0][1], requests[1][1]);
    assert.deepEqual(observations.filter(e => e.kind === "provider-dispatch").map(e => !!e.fallbackUsed), [false, true]);
  }
});

test("an unavailable primary model can be replaced by the configured fallback", async () => {
  const { result, lookups, requests } = withFallback(() => reply("allow"), { ref: "fixture/missing" });
  const verdict = await result;
  assert.equal(verdict.allow, true, verdict.reason);
  assert.equal(verdict.metrics.configurationError, undefined);
  assert.deepEqual(lookups, ["missing", "fallback"]);
  assert.deepEqual(requests.map(([id]) => id), ["fallback"]);
});

test("an unusable primary result still fails closed if the fallback also fails", async () => {
  const { result, requests } = withFallback((selected, opts) => {
    if (selected === model) return reply("unknown");
    opts.onResponse(new Response(null, { status: 401 }));
    return { stopReason: "error", errorMessage: "Synthetic unauthorized response" };
  });
  assert.equal((await result).technicalStop, "invalid-review");
  assert.equal(requests.length, 2);
});

test("valid blocks, local limits, cancellation and delegated stops do not switch reviewers", async () => {
  const blocked = withFallback(() => reply("block"));
  assert.equal((await blocked.result).decision, "block");
  assert.deepEqual(blocked.lookups, ["decision"]);

  const oversized = withFallback(() => reply("allow"), { max: 2200, action: { content: "x".repeat(3000) } });
  assert.equal((await oversized.result).ok, false);
  assert.equal(oversized.requests.length, 0);
  assert.deepEqual(oversized.lookups, ["decision"]);

  const controller = new AbortController();
  const cancelled = withFallback(() => { controller.abort(); return new Promise(() => {}); }, { signal: controller.signal });
  assert.equal((await cancelled.result).ok, false);
  assert.deepEqual(cancelled.lookups, ["decision"]);
  const providerCancelled = withFallback(() => ({ stopReason: "aborted" }));
  assert.equal((await providerCancelled.result).ok, false);
  assert.deepEqual(providerCancelled.lookups, ["decision"]);

  const delegated = withFallback(() => { throw new DelegatedContextError(); });
  assert.equal((await delegated.result).technicalStop, "delegated-context");
  assert.deepEqual(delegated.lookups, ["decision"]);
});
