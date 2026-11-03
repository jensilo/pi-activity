import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { judgeSafety } from "../judge.ts";
import { RollingUserSummary, SUMMARY_ENTRY_TYPE, SUMMARY_FORMAT_VERSION, SUMMARY_PROMPT_VERSION, SUMMARY_CACHE_LIMIT } from "../summary.ts";

const live = new AbortController().signal;
const AUTO = { auto: true, readOnly: false, remoteReadOnly: false };
const summaryText = "# User Message Summary\n## Context\nSynthetic task\n## Intent\nImplement changes\n## Allowed\nPublish reviewed source to origin after tests\n## Forbidden\nDo not publish raw fixture inputs\n## Guardrails\nPreserve unrelated changes";
const usage = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const physical = { provider: "fixture-native", id: "review", name: "Synthetic reviewer", api: "synthetic-native",
  baseUrl: "", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const message = (text, stopReason = "stop", errorMessage) => ({ role: "assistant", provider: physical.provider,
  model: physical.id, api: physical.api, content: [{ type: "text", text }], stopReason, errorMessage, usage, timestamp: Date.now() });
let responseNumber = 0;
let routing = "working";
let expectedThinking = "low";
let rejectContext = false;
const dispatched = [];
const emptyCredentials = { read: async () => undefined, list: async () => [],
  modify: async (_provider, fn) => fn(undefined), delete: async () => {} };
const runtime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath: null,
  allowModelNetwork: false, refreshOnCreate: false });
const registry = new ModelRegistry(runtime);
registry.registerProvider({ id: physical.provider, name: "Offline synthetic provider",
  auth: { apiKey: { name: "Keyless fixture", resolve: async () => ({ auth: {}, source: "synthetic" }) } },
  getModels: () => [physical],
  stream: () => { throw new Error("API-specific path must not be used"); },
  streamSimple(model, context, options) {
    dispatched.push({ model, context, options });
    assert.equal(model.api, physical.api);
    assert.equal(options.apiKey, undefined, "keyless providers need no artificial key");
    assert.equal(options.maxRetries, 0);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      await options.onPayload?.({ synthetic: true }, model);
      await options.onResponse?.({ status: 200, headers: {} }, model);
      const isSummary = context.messages[0]?.role === "system" && context.messages[0].content.startsWith("Condense");
      const response = rejectContext && !isSummary
        ? message("", "error", "maximum context length exceeded")
        : !isSummary && ++responseNumber === 1 ? message("", "error", "503 service unavailable")
        : message(isSummary ? summaryText : '{"decision":"allow","reason":"synthetic scoped action"}');
      stream.push({ type: "start", partial: response });
      stream.push({ type: "done", reason: "stop", message: response });
      stream.end(response);
    });
    return stream;
  },
});
await registry.refresh({ allowNetwork: false, providers: [physical.provider] });
registry.registerVirtualModel({ provider: "tiers", id: "cheap", name: "Synthetic tier", thinkingLevels: ["off", "low", "high", "max"],
  route(request) {
    assert.equal(request.reason, "direct", "nested reviews are direct requests, including our logical retries");
    assert.equal(request.thinkingLevel, expectedThinking);
    if (routing === "failure") throw new Error("Synthetic routing failure");
    if (routing === "transient") throw new Error("503 service unavailable during synthetic routing");
    if (routing === "virtual") return { model: registry.find("tiers", "cheap"), thinkingLevel: "low" };
    return { model: registry.find(physical.provider, physical.id), thinkingLevel: "low" };
  },
});
await registry.refresh({ allowNetwork: false });
assert.equal(runtime.hasConfiguredAuth(physical.provider), true, "synthetic keyless provider is available");
registry.getApiKeyAndHeaders = () => { throw new Error("activity must not pre-resolve auth"); };
const manager = SessionManager.inMemory("/synthetic");
const ctx = { model: { provider: "irrelevant-chat", id: "expensive" }, modelRegistry: registry, sessionManager: manager };
const observations = [];
const verdict = await judgeSafety(ctx, "tiers/cheap", "bash", { command: "git push" }, "/synthetic", AUTO, live,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  { judgeThinking: "low", onModelCall: (event) => observations.push(event) });
assert.equal(verdict.allow, true, verdict.reason);
assert.equal(dispatched.length, 2);
assert.equal(dispatched[0].options.reasoning, "low");
assert.equal(verdict.metrics.provider, physical.provider);
assert.equal(verdict.metrics.model, physical.id);
assert.equal(verdict.metrics.attempts, 2);
assert.equal(verdict.metrics.providerRequests, 2, "response and stream-start must not double count");
assert.equal(verdict.metrics.providerDispatches, 2);
assert.deepEqual(observations.filter((event) => event.kind === "provider-request").map((event) => [event.provider, event.model]),
  [[physical.provider, physical.id], [physical.provider, physical.id]]);
assert.equal(observations.filter((event) => event.kind === "retry").length, 1);

for (const kind of ["failure", "virtual", "transient"]) {
  routing = kind;
  const before = dispatched.length;
  const events = [];
  const failed = await judgeSafety(ctx, "tiers/cheap", "bash", {}, "/synthetic", AUTO, live,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { judgeThinking: "low", onModelCall: (event) => events.push(event) });
  assert.equal(failed.ok, false);
  assert.equal(dispatched.length, before);
  assert.equal(failed.metrics.providerRequests, 0, "routing failure has zero real requests");
  assert.equal(failed.metrics.providerDispatches, 0);
  assert.equal(failed.metrics.attempts, kind === "transient" ? 6 : 1);
  assert.equal(failed.metrics.provider, undefined, "virtual selection is not a generating provider");
  assert.equal(events.filter((event) => event.kind === "provider-request").length, 0);
}
routing = "working";
for (const observer of [
  (event) => { if (event.response) event.response.usage.input = 999999; throw new Error("synthetic observer failure"); },
  async () => { throw new Error("synthetic async observer failure"); },
]) {
  const reviewed = await judgeSafety(ctx, "tiers/cheap", "bash", {}, "/synthetic", AUTO, live,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, { judgeThinking: "low", onModelCall: observer });
  assert.equal(reviewed.allow, true, "observations must not change verdicts");
  assert.equal(reviewed.metrics.inputTokens, usage.input, "observed usage is detached from the response");
}

// Virtual max is router input, not an activity-owned policy default.
for (const thinking of ["off", "high", "max"]) {
  expectedThinking = thinking;
  const before = dispatched.length;
  const reviewed = await judgeSafety(ctx, "tiers/cheap", "bash", {}, "/synthetic", AUTO, live,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, { judgeThinking: thinking });
  assert.equal(reviewed.allow, true, reviewed.reason);
  assert.equal(dispatched.length, before + 1);
  assert.equal(dispatched.at(-1).options.reasoning, "low", "router alone chooses physical effort");
}
expectedThinking = "low";

// The same virtual ID can select a larger physical reviewer at another effort.
const larger = { ...physical, provider: "fixture-larger", id: "large", contextWindow: 256000 };
const escalationRoutes = [];
registry.registerProvider({ id: larger.provider, name: "Synthetic larger reviewer",
  auth: { apiKey: { name: "Keyless larger fixture", resolve: async () => ({ auth: {}, source: "synthetic" }) } },
  getModels: () => [larger],
  stream: () => { throw new Error("API-specific path must not be used"); },
  streamSimple(model, _context, options) {
    assert.equal(options.reasoning, "high");
    const stream = createAssistantMessageEventStream();
    const output = { ...message('{"decision":"allow","reason":"synthetic larger review"}'), provider: model.provider, model: model.id };
    queueMicrotask(async () => {
      await options.onPayload?.({ synthetic: true }, model);
      await options.onResponse?.({ status: 200, headers: {} }, model);
      stream.push({ type: "start", partial: output });
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end(output);
    });
    return stream;
  },
});
registry.registerVirtualModel({ provider: "fixture-router", id: "escalate", name: "Synthetic effort escalation", thinkingLevels: ["off", "high"],
  route(request) {
    escalationRoutes.push(request.thinkingLevel);
    return { model: registry.find(request.thinkingLevel === "high" ? larger.provider : physical.provider,
      request.thinkingLevel === "high" ? larger.id : physical.id), thinkingLevel: request.thinkingLevel };
  },
});
await registry.refresh({ allowNetwork: false });
rejectContext = true;
const escalated = await judgeSafety(ctx, "fixture-router/escalate", "bash", {}, "/synthetic", AUTO, live,
  undefined, undefined, undefined, "fixture-router/escalate", undefined, undefined, undefined,
  { judgeThinking: "off", fallbackJudgeThinking: "high" });
rejectContext = false;
assert.equal(escalated.allow, true, escalated.reason);
assert.equal(escalated.metrics.fallbackUsed, true);
assert.equal(escalated.metrics.provider, larger.provider);
assert.equal(escalated.metrics.model, larger.id);
assert.deepEqual(escalationRoutes, ["off", "high"], "thinking-only fallback must dispatch the same virtual model at the new effort");

// Persist actual public custom entries, then reopen the synthetic session file.
const root = mkdtempSync(join(tmpdir(), "activity-summary-restart-"));
try {
  const session = SessionManager.create(root, root);
  const userIds = [];
  for (let i = 0; i < 6; i++) userIds.push(session.appendMessage({ role: "user", content: `Synthetic source ${i}`, timestamp: Date.now() }));
  session.appendMessage(message("Synthetic main response"));
  let context = { ...ctx, sessionManager: session };
  const cache = new RollingUserSummary();
  const snapshots = [];
  const persist = (customType, data) => { snapshots.push(data); session.appendCustomEntry(customType, data); };
  const generated = await cache.prepare(context, "tiers/cheap", live, undefined, undefined, undefined, { thinking: "low", persist });
  assert.equal(generated.metrics.status, "generated");
  assert.equal(generated.metrics.provider, physical.provider);
  assert.equal(generated.summary.text, summaryText, "operational wording is retained exactly");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].version, SUMMARY_FORMAT_VERSION);
  assert.equal(snapshots[0].promptVersion, SUMMARY_PROMPT_VERSION);
  assert.ok(snapshots[0].records.length <= SUMMARY_CACHE_LIMIT);
  assert.equal(session.buildSessionContext().messages.some((msg) => JSON.stringify(msg).includes(summaryText)), false,
    "custom cache entries are outside model context");
  const oldLeaf = session.getLeafId();
  const restarted = new RollingUserSummary();
  const reopened = SessionManager.open(session.getSessionFile());
  context = { ...ctx, sessionManager: reopened };
  restarted.restore(context);
  const before = dispatched.length;
  const cached = await restarted.prepare(context, "unregistered/model", live, undefined, undefined, undefined, { thinking: "high" });
  assert.equal(cached.metrics.status, "cached", "different model needs no resolution when summary is reusable");
  assert.equal(cached.metrics.model, physical.id, "cached metadata names the generator, not new selection");
  assert.equal(dispatched.length, before);
  reopened.appendMessage({ role: "user", content: "Do not push after all", timestamp: Date.now() });
  const later = await restarted.prepare(context, "tiers/cheap", live, undefined, undefined, undefined, { thinking: "low" });
  assert.equal(later.metrics.status, "cached");
  const prompts = [];
  await judgeSafety(context, "tiers/cheap", "bash", { command: "git push" }, root, { ...AUTO, readOnly: true }, live,
    undefined, undefined, async (_model, prompt) => { prompts.push(prompt); return message('{"decision":"block","reason":"read-only is active"}'); },
    undefined, undefined, undefined, undefined, { judgeThinking: "low", persistSummary: (type, data) => reopened.appendCustomEntry(type, data) });
  assert.match(prompts.at(-1).messages[0].content[0].text, /Do not push after all/);
  assert.match(prompts.at(-1).messages[0].content[0].text, /read-only: ON: reads only/);

  // Every-entry scanning would wrongly restore an abandoned summary here.
  reopened.branch(userIds[3]);
  restarted.restore(context);
  reopened.appendMessage({ role: "user", content: "Different branch scope", timestamp: Date.now() });
  reopened.appendMessage({ role: "user", content: "Proceed", timestamp: Date.now() });
  assert.equal((await restarted.prepare(context, "tiers/cheap", live, undefined, undefined, undefined, { thinking: "low" })).metrics.status, "generated");
  reopened.branch(oldLeaf);
  restarted.restore(context);
  assert.equal((await restarted.prepare(context, "unregistered/model", live)).metrics.status, "cached");

  for (const promptVersion of [SUMMARY_PROMPT_VERSION - 1, SUMMARY_PROMPT_VERSION + 1]) {
    reopened.appendCustomEntry(SUMMARY_ENTRY_TYPE, { ...snapshots[0], promptVersion });
    restarted.restore(context);
    assert.equal((await restarted.prepare(context, "tiers/cheap", live, undefined, undefined, undefined, { thinking: "low" })).metrics.status, "generated",
      "older and newer prompt versions invalidate persisted entries");
  }

  const pendingCache = new RollingUserSummary();
  let release;
  let persisted = 0;
  const pending = pendingCache.prepare(context, "tiers/cheap", live,
    async () => { await new Promise((done) => { release = done; }); return message(summaryText); },
    undefined, undefined, { thinking: "low", persist: () => { persisted++; } });
  await new Promise((done) => setTimeout(done, 0));
  pendingCache.clear();
  release();
  assert.equal((await pending).metrics.status, "failed");
  assert.equal(persisted, 0, "interrupted pending summaries are never persisted or revived");
  const restoredPending = new RollingUserSummary();
  restoredPending.restore(context);
  assert.equal(persisted, 0);
  console.log("offline real registry routing and branch-local summary persistence tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
