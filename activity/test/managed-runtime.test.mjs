// Synthetic managed-runtime wiring only. No engine, installer, provider or network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activityExtension, { loadActivityConfig } from "../index.ts";
import { ensureDefaultActivityConfig } from "../config.ts";
import { createManagedEvidenceProvider } from "../evidence-provider.ts";
import { withNativeTools } from "./nine-head-fixtures.mjs";

const root = mkdtempSync(join(tmpdir(), "activity-managed-runtime-"));
const saved = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_TASK", "PI_ACTIVITY_AUTO_MODE"].map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.PI_SUBAGENT_TASK;
delete process.env.PI_ACTIVITY_AUTO_MODE;
const path = join(root, "agent/config/activity.json");
let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error("synthetic network forbidden"); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function harness({ hasUI = true, confirm = async () => false, factory } = {}) {
  const handlers = {}, reviews = [], notifications = [];
  let prompts = 0;
  const ctx = { cwd: root, hasUI, mode: hasUI ? "rpc" : "print",
    model: { provider: "virtual", id: "registered-chat" },
    sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => "managed-runtime" },
    ui: { notify(message, level) { notifications.push({ message, level }); }, setStatus() {}, theme: { fg: (_color, text) => text },
      confirm(...args) { prompts++; return confirm(...args); } },
  };
  activityExtension({ on(name, handler) { handlers[name] = handler; }, registerFlag() {}, registerCommand() {},
    getFlag: (name) => name === "auto", getAllTools: () => withNativeTools(), appendEntry() {}, sendMessage() {}, events: { emit() {} } },
  async (...args) => { reviews.push(args); return { ok: true, allow: true, reason: "synthetic review" }; }, "native", factory);
  let id = 0;
  return { ctx, reviews, notifications, get prompts() { return prompts; },
    start: () => handlers.session_start({ reason: "startup" }, ctx),
    stop: () => handlers.session_shutdown({}, ctx),
    call: () => handlers.tool_call({ toolName: "custom", input: {}, toolCallId: `managed-${++id}` }, ctx) };
}

try {
  const first = harness();
  await first.start();
  assert.equal(first.prompts, 1, "RPC supports one download consent dialog");
  assert.equal(fetches, 0, "decline does not access the network");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { acclass: { enabled: true, variant: "q8" } });
  assert.equal(loadActivityConfig().auto.judgeModel, undefined);
  assert.notEqual((await first.call())?.block, true);
  assert.equal(first.reviews.at(-1)[1], "virtual/registered-chat", "judge uses the registered current model reference");
  first.ctx.model = { provider: "virtual", id: "changed-chat" };
  await first.call();
  assert.equal(first.reviews.at(-1)[1], "virtual/changed-chat", "current model is resolved per call");
  await first.start();
  assert.equal(first.prompts, 1, "decline is not repeated within one extension runtime");
  await first.stop();

  writeFileSync(path, '{"acclass":{"enabled":false},"auto":{"judgeModel":null}}\n');
  const before = readFileSync(path, "utf8");
  ensureDefaultActivityConfig();
  assert.equal(readFileSync(path, "utf8"), before, "exclusive creation never overwrites an existing file");
  const disabled = harness();
  await disabled.start();
  assert.equal(disabled.prompts, 0);
  assert.equal((await disabled.call())?.block, true);
  assert.equal(disabled.reviews.length, 0, "explicit null disables the current-model default");
  await disabled.stop();

  writeFileSync(path, "{}");
  const headless = harness({ hasUI: false });
  await headless.start();
  assert.equal(headless.prompts, 0);
  assert.equal(fetches, 0, "headless startup never downloads");
  await headless.stop();

  const shown = deferred(), answer = deferred();
  const cancelled = harness({ confirm: async (_title, _message, options) => {
    shown.resolve(options.signal);
    return answer.promise;
  } });
  const startup = cancelled.start();
  const signal = await shown.promise;
  await cancelled.stop();
  assert.equal(signal.aborted, true, "setup uses the session lifecycle cancellation signal");
  answer.resolve(true);
  await startup;
  assert.equal(fetches, 0, "late consent cannot start network work after shutdown");

  const variants = [];
  let wiringStops = 0;
  const injected = harness({ factory: (settings) => {
    variants.push({ ...settings });
    return { kind: "none", stop() { wiringStops++; }, async classify() {
      return { ok: false, provider: "none", kind: "unavailable", message: "synthetic no evidence", wallMs: 0,
        identity: { provider: "none", daemonIdentityVerified: false } };
    } };
  } });
  await injected.start();
  assert.equal(injected.prompts, 0, "explicit adapter injection does not run managed setup");
  await injected.call();
  writeFileSync(path, '{"acclass":{"variant":"q5"}}');
  await injected.call();
  assert.deepEqual(variants, [{ enabled: true, variant: "q8" }, { enabled: true, variant: "q5" }]);
  assert.equal(wiringStops, 1, "public variant changes replace and stop the old provider");
  await injected.stop();
  assert.equal(wiringStops, 2, "shutdown stops the selected provider");

  let verifications = 0, creates = 0, stops = 0, uses = 0;
  let selected = "q8", broken = false;
  const settings = { enabled: true, variant: "q8" };
  const config = () => ({ provider: "acclass", binary: `/synthetic/versions/${selected}/bin/acclass`,
    model: `/synthetic/versions/${selected}/model`, socket: `/synthetic/run/${selected}/ac.sock`, spawn: true });
  const managed = createManagedEvidenceProvider(settings, {
    verify: async (variant) => { verifications++; assert.equal(variant, "q8"); if (broken) throw new Error("synthetic hash failure"); return config(); },
    create: () => { creates++; return { kind: "acclass", stop() { stops++; }, async classify(_input, _cwd, _home, _kind, requestSignal) {
      uses++; assert.equal(requestSignal?.aborted ?? false, false);
      return { ok: false, provider: "acclass", kind: "unavailable", message: "synthetic no evidence", wallMs: 0,
        identity: { provider: "acclass", daemonIdentityVerified: false } };
    } }; },
  });
  await managed.classify("synthetic", root, root);
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  assert.equal((await managed.classify("synthetic", root, root, "shell", alreadyCancelled.signal)).kind, "cancelled");
  assert.equal(stops, 0, "consumer cancellation does not stop a shared verified client");
  await managed.classify("synthetic", root, root);
  assert.equal(verifications, 2, "cached daemon use still verifies all managed artifacts");
  assert.equal(creates, 1, "low-level client is cached by physical configuration");
  selected = "replacement";
  await managed.classify("synthetic", root, root);
  assert.equal(creates, 2);
  assert.equal(stops, 1, "current target change stops the old client");
  broken = true;
  const failed = await managed.classify("synthetic", root, root);
  assert.equal(failed.kind, "unavailable");
  assert.equal(uses, 3, "hash failure cannot use the cached client");
  assert.equal(stops, 2);
  managed.stop();

  const hashing = deferred();
  let cancellationCreates = 0;
  const pending = createManagedEvidenceProvider(settings, { verify: () => hashing.promise,
    create: () => { cancellationCreates++; throw new Error("cancelled verification must not create a client"); } });
  const controller = new AbortController();
  const result = pending.classify("synthetic", root, root, "shell", controller.signal);
  controller.abort();
  assert.equal((await result).kind, "cancelled");
  hashing.resolve(config());
  await Promise.resolve();
  assert.equal(cancellationCreates, 0);
  pending.stop();

  const waiting = deferred();
  const stopping = createManagedEvidenceProvider(settings, { verify: () => waiting.promise,
    create: () => { throw new Error("stopped provider must not resurrect"); } });
  const late = stopping.classify("synthetic", root, root);
  stopping.stop();
  waiting.resolve(config());
  assert.equal((await late).kind, "unavailable");
  writeFileSync(path, "{}");
  const failedSetup = harness({ confirm: async () => true });
  await failedSetup.start();
  assert.equal(fetches, 1, "network begins only after affirmative consent");
  assert.ok(failedSetup.notifications.some(({ message, level }) => level === "warning" && /use the LLM judge/.test(message)),
    "a setup failure reports a safe warning instead of failing silently");
  assert.notEqual((await failedSetup.call())?.block, true);
  assert.equal(failedSetup.reviews.length, 1, "setup failure still requires the judge");
  await failedSetup.stop();
  console.log("managed runtime tests passed (consent, single config, current judge, per-use verification, cache, cancellation, failure warning)");
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
}
