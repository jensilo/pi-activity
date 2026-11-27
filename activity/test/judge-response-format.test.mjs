// Offline, synthetic admission and inert execution only; no providers or runtime captures.
// Exercises the opt-in auto.judgeResponseFormat on the chat judge transport.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { judgeSafety, MAX_RETRIES } from "../judge.ts";
import activityExtension from "../index.ts";
import { withNativeTools } from "./nine-head-fixtures.mjs";

const signal = new AbortController().signal;
const modes = { auto: true, readOnly: false, remoteReadOnly: false };
const input = { command: "git push origin synthetic" };
const allow = JSON.stringify({ decision: "allow", reason: "Synthetic allow." });
const block = JSON.stringify({ decision: "block", reason: "Synthetic denial." });
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const VERDICT_SCHEMA = { type: "object",
  properties: { decision: { type: "string", enum: ["allow", "block"] }, reason: { type: "string", minLength: 1 } },
  required: ["decision", "reason"], additionalProperties: false };

/** Chat or classifier judge behind a captured transport; nothing leaves the process. */
async function judge({ format, api = "openai-completions", backend = "chat", text = allow,
  rejectFormat = false, failAll = false, judgeMode = "short",
  rejectVia = "throw", rejectStatus = 400, reportResponse = true, transientFailures = 0,
  rejectMessage = "400 Invalid request: response_format is not supported here" } = {}) {
  const model = { provider: "fixture", id: backend === "classifier" ? "decision" : "judge", api,
    contextWindow: 32_768, ...(backend === "classifier" ? { type: "classifier" } : {}) };
  const requests = [];
  let failures = failAll ? Number.POSITIVE_INFINITY : rejectFormat ? 1 : 0;
  const ctx = {
    sessionManager: { getBranch: () => [
      { type: "message", message: { role: "user", content: "Push the synthetic branch." } },
    ] },
    getSystemPrompt: () => "Synthetic system prompt.",
    modelRegistry: {
      find: (provider, id) => provider === model.provider && id === model.id && model.type === undefined ? model : undefined,
      getAll: () => [model],
      findOfType: (type, provider, id) => type === "classifier" && provider === model.provider && id === model.id ? model : undefined,
      streamSimple(selected, context, options) {
        requests.push({ id: selected.id, api: selected.api, samplingParams: options.samplingParams });
        if (requests.length <= transientFailures) {
          options.onResponse?.(new Response(null, { status: 503 }), selected);
          return { async *[Symbol.asyncIterator]() {},
            async result() { throw Object.assign(new Error("Synthetic outage"), { status: 503 }); } };
        }
        if (failures > 0) {
          failures -= 1;
          if (reportResponse) options.onResponse?.(new Response(null, { status: rejectStatus }), selected);
          const errorMessage = failAll && !options.samplingParams ? "400 Bad Request: invalid parameter top_p" : rejectMessage;
          if (rejectVia === "result") {
            // How openai-completions, openai-responses, and azure-openai-responses report a
            // rejected request: an error result, never a throw.
            const failed = { role: "assistant", provider: selected.provider, model: selected.id, api: selected.api,
              stopReason: "error", errorMessage, content: [], usage };
            return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: failed }; },
              async result() { return failed; } };
          }
          return { async *[Symbol.asyncIterator]() {},
            async result() { throw Object.assign(new Error(errorMessage), { status: rejectStatus }); } };
        }
        const message = { role: "assistant", provider: selected.provider, model: selected.id, api: selected.api,
          stopReason: "stop", content: [{ type: "text", text }], usage };
        return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; },
          async result() { return message; } };
      },
      async classify(selected, request, options) {
        requests.push({ id: selected.id, api: selected.api, classify: request, samplingParams: options.samplingParams });
        return { provider: selected.provider, model: selected.id, api: selected.api, stopReason: "stop", usage,
          answers: { verdict: { type: "choice", choice: text === block ? "block" : "allow" } } };
      },
    },
  };
  const ref = backend === "classifier" ? "fixture/decision" : "fixture/judge";
  const result = await judgeSafety(ctx, ref, "bash", input, "/fixture", modes, signal,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { judgeBackend: backend, judgeMode, ...(format ? { judgeResponseFormat: format } : {}) });
  return { requests, result };
}

for (const [format, responseFormat] of [["json_object", { type: "json_object" }],
  ["json_schema", { type: "json_schema", json_schema: { name: "safety_verdict", strict: true, schema: VERDICT_SCHEMA } }]]) {
  test(`chat judge sends ${format} as response_format and keeps judging normally`, async () => {
    const { requests, result } = await judge({ format, text: allow });
    assert.equal(result.decision, "allow", result.reason);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].samplingParams, { response_format: responseFormat });
    assert.equal(result.metrics.responseFormat, "requested");
    assert.equal(result.metrics.attempts, 1);
  });

  test(`chat judge ${format} still denies a block verdict`, async () => {
    const { requests, result } = await judge({ format, text: block });
    assert.equal(result.decision, "block");
    assert.match(result.reason, /Synthetic denial/);
    assert.equal(requests.length, 1);
  });
}

test("off and the default send no response_format", async () => {
  for (const format of [undefined, "off"]) {
    const { requests, result } = await judge({ format, text: allow });
    assert.equal(result.decision, "allow", result.reason);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].samplingParams, undefined);
    assert.equal(result.metrics.responseFormat, undefined, "nothing to report when the setting is off");
  }
});

// The Responses adapters merge samplingParams verbatim but expect text.format, so the
// Chat Completions response_format shape must never reach them.
for (const api of ["anthropic-messages", "openai-responses", "azure-openai-responses"]) {
  test(`a ${api} judge api is reported and stays a plain request`, async () => {
    const { requests, result } = await judge({ api, format: "json_schema", text: allow });
    assert.equal(result.decision, "allow", result.reason);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].samplingParams, undefined, "no response_format outside Chat Completions");
    assert.equal(result.metrics.responseFormat, "skipped-unsupported-api");
  });
}

// Chat Completions resolves an error result; status-bearing throws can also reach the judge.
for (const [label, format, fixture] of [
  ["thrown 400 with callback", "json_schema", { rejectVia: "throw", rejectStatus: 400 }],
  ["thrown 400 without callback", "json_object", { rejectVia: "throw", rejectStatus: 400, reportResponse: false }],
  ["resolved 400", "json_object", { rejectVia: "result", rejectStatus: 400 }],
  ["resolved 422", "json_object", { rejectVia: "result", rejectStatus: 422 }],
]) {
  test(`${label} format rejection gets one plain retry`, async () => {
    const { requests, result } = await judge({ format, rejectFormat: true, ...fixture });
    assert.equal(result.decision, "allow", result.reason);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].samplingParams?.response_format?.type, format);
    assert.equal(requests[1].samplingParams, undefined);
    assert.equal(result.metrics.responseFormat, "rejected-by-provider");
    assert.equal(result.metrics.retries, 1);
  });
}

test("an explicit format rejection does not exceed the shared retry budget", async () => {
  const { requests, result } = await judge({ format: "json_object", rejectFormat: true, rejectVia: "result",
    transientFailures: MAX_RETRIES });
  assert.equal(result.ok, false);
  assert.equal(result.metrics.retries, MAX_RETRIES);
  assert.equal(result.metrics.responseFormat, "rejected-by-provider");
  assert.equal(requests.length, MAX_RETRIES + 1);
  assert.ok(requests.every((r) => r.samplingParams?.response_format?.type === "json_object"), "no budget remains for a plain retry");
});

for (const rejectVia of ["throw", "result"]) {
  test(`an unrelated ${rejectVia} provider failure is not mistaken for a format rejection`, async () => {
    const { requests, result } = await judge({ format: "json_object", rejectFormat: true, rejectVia,
      rejectMessage: "400 Bad Request: invalid parameter top_p" });
    assert.notEqual(result.decision, "allow", "a review with no verdict cannot authorize");
    assert.equal(requests.length, 1, "nothing is retried when the format was not the problem");
    assert.equal(requests[0].samplingParams?.response_format?.type, "json_object");
    assert.equal(result.metrics.responseFormat, "requested", "the format was never rejected");
  });
}

test("a provider that fails both the formatted attempt and the plain retry never authorizes", async () => {
  const { requests, result } = await judge({ format: "json_object", failAll: true });
  assert.notEqual(result.decision, "allow", "a review that never produced a verdict cannot authorize");
  assert.match(result.reason, /safety review unavailable/i);
  assert.equal(result.metrics.responseFormat, "rejected-by-provider");
  assert.equal(requests.length, 2, "one formatted attempt and one plain retry; the second 400 is permanent");
  assert.equal(requests[1].samplingParams, undefined);
});

test("the classifier judge never sends constrained output", async () => {
  const { requests, result } = await judge({ backend: "classifier", api: "openai-completions",
    format: "json_object", text: allow });
  assert.equal(result.decision, "allow", result.reason);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].classify, "the classifier transport was used");
  assert.equal(requests[0].samplingParams, undefined);
  assert.equal(result.metrics.responseFormat, undefined, "the setting is chat-only");
});

// Public config through the production gate: the setting must reach the transport.
test("auto.judgeResponseFormat is wired from config to the judge request", async () => {
  const root = mkdtempSync(join(tmpdir(), "activity-response-format-gate-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  mkdirSync(join(root, "config"));
  const model = { provider: "fixture", id: "judge", api: "openai-completions", contextWindow: 32_768 };
  const requests = [];
  let beforeReply;
  const ctx = { cwd: root, hasUI: true, mode: "tui", model,
    sessionManager: { getSessionId: () => "response-format-fixture", getBranch: () => [
      { type: "message", message: { role: "user", content: "Push the synthetic branch." } } ] },
    getSystemPrompt: () => "Synthetic system prompt.",
    ui: { notify() {}, setStatus() {}, theme: { fg: (_name, value) => value },
      custom: () => { throw new Error("unexpected tool approval"); }, select: () => { throw new Error("unexpected prompt"); },
      confirm: () => { throw new Error("unexpected prompt"); } },
    modelRegistry: { find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
      getAll: () => [model], findOfType: () => undefined,
      streamSimple(selected, context, options) {
        requests.push({ id: selected.id, samplingParams: options.samplingParams });
        const message = { role: "assistant", provider: selected.provider, model: selected.id, api: selected.api,
          stopReason: "stop", content: [{ type: "text", text: allow }], usage };
        return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; },
          async result() { beforeReply?.(); return message; } };
      } },
  };
  const handlers = {};
  const configure = (auto) => writeFileSync(join(root, "config/activity.json"),
    JSON.stringify({ acclass: { enabled: false }, auto: { judgeModel: "fixture/judge", ...auto } }));
  configure({});
  activityExtension({ on(name, handler) { handlers[name] = handler; }, registerFlag() {}, registerCommand() {},
    getFlag: (name) => name === "auto", getAllTools: () => withNativeTools(), appendEntry() {}, sendMessage() {},
    events: { emit() {} } }, undefined, "native");
  try {
    await handlers.session_start({ reason: "startup" }, ctx);
    let id = 0;
    const call = () => handlers.tool_call({ toolName: "fixture_custom", input: { payload: "Complete synthetic action" },
      toolCallId: `response-format-${++id}` }, ctx);
    assert.notEqual((await call())?.block, true, "an allowed action still runs");
    assert.equal(requests.at(-1).samplingParams, undefined, "off by default");
    configure({ judgeResponseFormat: "json_object" });
    assert.notEqual((await call())?.block, true);
    assert.deepEqual(requests.at(-1).samplingParams, { response_format: { type: "json_object" } });
    configure({ judgeResponseFormat: "json_schema" });
    assert.notEqual((await call())?.block, true);
    assert.equal(requests.at(-1).samplingParams.response_format.type, "json_schema");
    assert.equal(requests.at(-1).samplingParams.response_format.json_schema.strict, true);
    assert.deepEqual(requests.at(-1).samplingParams.response_format.json_schema.schema,
      VERDICT_SCHEMA, "the schema mirrors the verdict the parser accepts");
    beforeReply = () => configure({ judgeResponseFormat: "off" });
    const stale = await call();
    assert.equal(stale?.block, true, "a format change invalidates the in-flight review");
    assert.match(stale.reason, /policy context changed during review/);
    beforeReply = undefined;
    assert.notEqual((await call())?.block, true, "a fresh review uses the updated format");
    assert.equal(requests.at(-1).samplingParams, undefined);
    configure({ judgeResponseFormat: "nonsense" });
    await assert.rejects(call(), /judgeResponseFormat must be off, json_object, or json_schema/);
  } finally {
    await handlers.session_shutdown({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { force: true, recursive: true });
  }
});
