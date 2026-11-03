// Synthetic standalone configuration, native policy and typed provider checks.
// Run with the installed Pi host's jiti in an isolated HOME.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import activityExtension, { setFixtureProvider } from "./synthetic-runtime.mjs";
import { DEFAULT_CONFIG, loadActivityConfig } from "../index.ts";
import { createEvidenceProvider } from "../evidence-provider.ts";
import { approvalFixture } from "./approval-fixture.mjs";
import { createFixtureModel, fixtureIdentity, readyResponse, wireResponse, facts, scores, withNativeTools } from "./nine-head-fixtures.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-activity-standalone-"));
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE", "PI_SUBAGENT_TASK"].map((key) => [key, process.env[key]]));
const cwd = join(root, "project");
const configPath = join(root, "config/activity.json");
const outside = "/pi-activity-synthetic-outside";
const writeConfig = (cfg) => writeFileSync(configPath, JSON.stringify(cfg));
mkdirSync(join(root, "config"));
mkdirSync(join(cwd, ".pi"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = root;
delete process.env.PI_ACTIVITY_AUTO_MODE;
delete process.env.PI_SUBAGENT_TASK;

function harness(verdict = { ok: true, allow: true, reason: "synthetic verdict" }) {
  const handlers = {}, commands = {}, reviews = [];
  let prompts = 0, setupPrompts = 0;
  const ctx = {
    cwd, mode: "tui", hasUI: true, signal: undefined,
    model: { provider: "fixture", id: "current-chat" },
    modelRegistry: { find() { throw new Error("implicit model lookup"); } },
    sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => "synthetic-standalone" },
    ui: { notify() {}, setStatus() {}, confirm() { setupPrompts++; return false; }, theme: { fg: (_color, text) => text } },
  };
  ctx.ui.custom = approvalFixture(ctx, (done) => { prompts++; done("Block"); });
  activityExtension({
    on(name, handler) { handlers[name] = handler; },
    registerFlag() {}, registerCommand(name, options) { commands[name] = options.handler; },
    getFlag: (name) => name === "auto", getAllTools: () => withNativeTools(),
    appendEntry() {}, sendMessage() {}, events: { emit() {} },
  }, async (...args) => { reviews.push(args); return verdict; }, "native");
  let id = 0;
  return { handlers, commands, ctx, reviews, get prompts() { return prompts; }, get setupPrompts() { return setupPrompts; },
    start: () => handlers.session_start({ reason: "startup" }, ctx),
    stop: () => handlers.session_shutdown({}, ctx),
    call: (toolName, input) => handlers.tool_call({ toolName, input, toolCallId: `standalone-${++id}` }, ctx) };
}

let server;
const sockets = new Set();
try {
  const example = JSON.parse(readFileSync(new URL("../../activity.example.json", import.meta.url), "utf8"));
  const schema = JSON.parse(readFileSync(new URL("../../activity.schema.json", import.meta.url), "utf8"));
  assert.equal(DEFAULT_CONFIG.acclass.enabled, true);
  assert.equal(DEFAULT_CONFIG.auto.judgeModel, undefined);
  assert.equal(DEFAULT_CONFIG.auto.summaryModel, undefined);
  assert.equal(DEFAULT_CONFIG.auto.fallbackJudgeModel, null);
  assert.deepEqual(DEFAULT_CONFIG.policy.readAllowlist, []);
  assert.deepEqual(DEFAULT_CONFIG.policy.trustedTools, []);
  assert.deepEqual(DEFAULT_CONFIG.policy.questionnaireSources, []);
  assert.equal(DEFAULT_CONFIG.log.enabled, false);
  assert.equal(DEFAULT_CONFIG.reviewLog.enabled, false);
  assert.match(DEFAULT_CONFIG.log.path, /pi-activity\/private/);
  writeConfig({});
  writeFileSync(join(cwd, ".pi/activity.json"), JSON.stringify({ auto: { judgeModel: "project/unsafe" }, policy: { trustedTools: ["custom"] } }));
  assert.equal(loadActivityConfig(cwd).auto.judgeModel, undefined, "project config cannot configure safety routes");
  for (const classifier of [null, false, true, 0, "none", [], {}, { provider: "none" },
    { enabled: true, readAllowlist: ["~/synthetic-read-root"] }, { provider: "acclass" }]) {
    writeConfig({ classifier, policy: { readAllowlist: [] } });
    assert.throws(() => loadActivityConfig(cwd), /activity\.classifier/, "any public classifier key is rejected; no legacy migration");
  }
  writeConfig({ acclass: { enabled: true, variant: "q8" } });
  assert.deepEqual(loadActivityConfig(cwd).acclass, { enabled: true, variant: "q8" });
  writeConfig({ acclass: { enabled: false } });
  assert.equal(loadActivityConfig(cwd).acclass.enabled, false);
  writeConfig({ display: { enabled: false }, history: { maxEntries: 0 }, session: { persistModes: false, persistActivity: false } });
  const cfg = loadActivityConfig(cwd);
  assert.equal(cfg.display.enabled, false);
  assert.equal(cfg.history.maxEntries, 0);
  assert.deepEqual(cfg.session, { persistModes: false, persistActivity: false });
  for (const invalid of [
    { acclass: null }, { acclass: [] }, { acclass: { enabled: "true" } },
    { acclass: { enabled: true, variant: "unknown" } },
    { acclass: { enabled: false, binary: "/synthetic/forbidden" } },
    { auto: { judgeModel: "" } }, { auto: { judgeThinking: "unknown" } },
    { policy: { readAllowlist: [null] } }, { history: { maxEntries: -1 } },
    { guards: { readOnly: "false" } },
  ]) {
    writeConfig(invalid);
    assert.throws(() => loadActivityConfig(cwd), /activity/);
  }

  writeConfig({ auto: { judgeModel: null } });
  const native = harness();
  native.ctx.mode = "rpc";
  await native.start();
  try {
    for (const [tool, input] of [
      ["read", { path: "README.md" }], ["write", { path: "new.txt", content: "synthetic" }],
      ["edit", { path: "new.txt", oldText: "a", newText: "b" }],
      ["grep", { pattern: "synthetic" }], ["find", { pattern: "*.ts" }], ["ls", {}],
    ]) assert.notEqual((await native.call(tool, input))?.block, true, `${tool} uses deterministic native policy`);
    for (const [tool, input] of [
      ["bash", { command: "printf synthetic" }], ["custom", { key: "synthetic" }],
      ["ask_user_question", { question: "Synthetic question" }],
      ["read", { path: ".env" }], ["read", { path: `${outside}/notes.txt` }],
      ["write", { path: `${outside}/notes.txt`, content: "synthetic" }], ["read", {}],
    ]) {
      const result = await native.call(tool, input);
      assert.equal(result?.block, true, `${tool} cannot use the chat model or a noninteractive override with the judge explicitly disabled`);
      assert.match(result.reason, /judge|review/i);
    }
    assert.equal(native.reviews.length, 0);
    assert.equal(native.prompts, 0);
    assert.equal(DEFAULT_CONFIG.acclass.enabled, true, "loading does not mutate defaults");
  } finally { await native.stop(); }

  writeConfig({});
  const inherited = harness();
  await inherited.start();
  try {
    assert.equal(loadActivityConfig(cwd).acclass.enabled, true);
    assert.equal(inherited.setupPrompts, 0, "injected evidence skips managed setup even when enabled by default");
    assert.notEqual((await inherited.call("bash", { command: "printf synthetic" }))?.block, true);
    assert.equal(inherited.reviews[0][1], "fixture/current-chat", "omitted judge uses ctx.model");
    assert.equal(inherited.reviews[0][12], "fixture/current-chat", "summary follows the effective current-model judge");
    inherited.ctx.model = { provider: "fixture", id: "next-chat" };
    assert.notEqual((await inherited.call("custom", {}))?.block, true);
    assert.equal(inherited.reviews[1][1], "fixture/next-chat", "current model selection is evaluated per call");
    inherited.ctx.model = undefined;
    inherited.ctx.mode = "rpc";
    assert.equal((await inherited.call("custom", {}))?.block, true, "missing current model fails closed");
    assert.equal(inherited.reviews.length, 2);
  } finally { await inherited.stop(); }

  writeConfig({ auto: { judgeModel: "fixture/judge" } });
  const reviewed = harness();
  await reviewed.start();
  try {
    assert.notEqual((await reviewed.call("bash", { command: "printf synthetic" }))?.block, true);
    assert.equal(reviewed.reviews[0][1], "fixture/judge");
    assert.equal(reviewed.reviews[0][14].judgeThinking, "off");
    assert.equal(reviewed.reviews[0][12], "fixture/judge", "summary follows explicit judge");
    assert.equal(reviewed.reviews[0][10], undefined, "there is no implicit fallback");
    writeConfig({ auto: { judgeModel: "fixture/judge:low", judgeThinking: "high",
      summaryModel: "fixture/summary", summaryThinking: "minimal",
      fallbackJudgeModel: "fixture/fallback", fallbackJudgeThinking: "medium" } });
    assert.notEqual((await reviewed.call("custom", { key: "synthetic" }))?.block, true);
    assert.equal(reviewed.reviews[1][1], "fixture/judge:low", "a colon in the model id remains exact");
    assert.equal(reviewed.reviews[1][14].judgeThinking, "high", "thinking is independent of the model id");
    assert.equal(reviewed.reviews[1][12], "fixture/summary");
    assert.equal(reviewed.reviews[1][14].summaryThinking, "minimal");
    assert.equal(reviewed.reviews[1][10], "fixture/fallback");
    assert.equal(reviewed.reviews[1][14].fallbackJudgeThinking, "medium");
    const before = reviewed.reviews.length;
    for (const guard of ["read-only", "remote-read-only"]) {
      await reviewed.commands[guard]("on", reviewed.ctx);
      assert.notEqual((await reviewed.call("bash", { command: "printf synthetic" }))?.block, true,
        "unavailable shell evidence reaches the judge under guards");
      assert.notEqual((await reviewed.call("subagent", { readOnly: true, task: "Synthetic read" }))?.block, true);
      assert.deepEqual(reviewed.reviews.at(-1)[5], { auto: true,
        readOnly: guard === "read-only", remoteReadOnly: guard === "remote-read-only" });
      if (guard === "read-only") {
        assert.equal((await reviewed.call("write", { path: "new.txt", content: "synthetic" }))?.block, true);
        assert.notEqual((await reviewed.call("read", { path: "README.md" }))?.block, true);
      }
      await reviewed.commands[guard]("off", reviewed.ctx);
    }
    assert.equal(reviewed.reviews.length, before + 5, "shell, subagent and native guard objections all reach review");
    process.env.PI_SUBAGENT_TASK = "1";
    assert.notEqual((await reviewed.call("read", { path: ".env" }))?.block, true);
    assert.equal(reviewed.reviews.length, before + 6, "a late mutable task hint cannot create an inherited-context requirement");
    assert.equal(reviewed.reviews.at(-1)[14].origin, "human", "origin stays bound to activation/session, not mutable env");
    delete process.env.PI_SUBAGENT_TASK;
    writeConfig({ policy: { trustedTools: ["explicitly_trusted"] }, auto: { judgeModel: null } });
    assert.notEqual((await reviewed.call("explicitly_trusted", {}))?.block, true);
    assert.equal((await reviewed.call("ask_user_question", {}))?.block, true);
    assert.equal(reviewed.prompts, 1, "missing-judge TUI denial opens the inline approval exactly once");
  } finally { await reviewed.stop(); }

  for (const verdict of [{ ok: true, allow: false, reason: "guard compliance not established" },
    { ok: false, reason: "judge unavailable" }]) {
    writeConfig({ auto: { judgeModel: "fixture/judge" }, policy: { trustedTools: ["subagent"] } });
    const denied = harness(verdict);
    await denied.start();
    try {
      for (const guard of ["read-only", "remote-read-only"]) {
        await denied.commands[guard]("on", denied.ctx);
        for (const [tool, input] of [["bash", { command: "printf synthetic" }],
          ["subagent", { readOnly: true, task: "Synthetic read" }]]) {
          assert.equal((await denied.call(tool, input))?.block, true, "only established compliance permits guarded effects");
          assert.deepEqual(denied.reviews.at(-1)[5], { auto: true,
            readOnly: guard === "read-only", remoteReadOnly: guard === "remote-read-only" });
        }
        await denied.commands[guard]("off", denied.ctx);
      }
      assert.equal(denied.reviews.length, 4, "trusted subagents cannot skip guard review");
      assert.equal(denied.prompts, 0, "guard denial/unavailability never asks for approval");
    } finally { await denied.stop(); }
  }

  const noProvider = createEvidenceProvider({ provider: "none", enabled: true, binary: "/not/a/discovered/binary", spawn: true });
  assert.equal(noProvider.kind, "none");
  const none = await noProvider.classify("printf synthetic", cwd, homedir());
  assert.equal(none.ok, false);
  assert.equal(none.kind, "unavailable");
  assert.equal(none.identity.daemonIdentityVerified, false);
  noProvider.stop();

  const modelDir = join(root, "model");
  mkdirSync(modelDir);
  const fixture = createFixtureModel(modelDir);
  const identity = fixtureIdentity(fixture.model, fixture.binary);
  const absent = createEvidenceProvider({ provider: "acclass", ...fixture, socket: join(root, "absent.sock") });
  try {
    const result = await absent.classify("printf synthetic", cwd, homedir());
    assert.equal(result.ok, false);
    assert.equal(result.kind, "unavailable");
    assert.match(result.message, /spawn is false/, "explicit acclass still never spawns by default");
  } finally { absent.stop(); }
  const socket = join(root, "classifier.sock");
  let response = wireResponse({ identity });
  let entered;
  let hold = false;
  server = createServer((connection) => {
    sockets.add(connection);
    connection.on("close", () => sockets.delete(connection));
    connection.on("error", () => {});
    connection.once("data", (bytes) => {
      const request = JSON.parse(bytes.toString());
      if (request.ping) connection.end(JSON.stringify(readyResponse(identity)) + "\n");
      else {
        entered?.();
        if (!hold) connection.end(JSON.stringify(response) + "\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  const providerConfig = { provider: "acclass", ...fixture, socket, requestTimeoutMs: 100, spawn: false };
  const provider = createEvidenceProvider(providerConfig);
  try {
    let result = await provider.classify("printf synthetic", cwd, homedir());
    assert.equal(result.ok, true);
    assert.deepEqual(result.preds, facts());
    assert.equal(result.inputComplete, true);
    assert.equal(result.scope.scopeComplete, true);
    assert.equal(result.tokenCount, 12);
    assert.equal(result.identity.provider, "acclass");
    assert.equal(result.identity.protocol, "acclass-daemon/1");
    assert.equal(result.identity.configuredBinary, fixture.binary);
    assert.equal(result.identity.configuredModel, fixture.model);
    assert.equal(result.identity.daemonIdentityVerified, true, "real transport verifies fixture artifact hashes");
    assert.equal(typeof result.wallMs, "number");
    const oversized = await provider.classify("x".repeat(270_000), cwd, homedir());
    assert.equal(oversized.ok, false);
    assert.match(oversized.message, /request exceeds byte limit/, "provider retains unclipped transport limits");
    response = wireResponse({ identity, input_complete: false });
    result = await provider.classify("printf synthetic", cwd, homedir());
    assert.equal(result.ok, false);
    assert.equal(result.kind, "invalid");
    response = wireResponse({ identity, token_count: 2049 });
    assert.equal((await provider.classify("printf synthetic", cwd, homedir())).kind, "invalid");
    response = wireResponse({ identity: { ...identity, binary_sha256: "wrong" } });
    result = await provider.classify("printf synthetic", cwd, homedir());
    assert.equal(result.ok, false);
    assert.equal(result.identity.daemonIdentityVerified, false);
    response = wireResponse({ identity, scope_complete: false });
    result = await provider.classify("printf synthetic", cwd, homedir());
    assert.equal(result.ok, true);
    assert.equal(result.scope.scopeComplete, false, "incomplete scope is carried, never upgraded");
    response = wireResponse({ identity });
    hold = true;
    const controller = new AbortController();
    const started = new Promise((resolve) => { entered = resolve; });
    const pending = provider.classify("printf synthetic", cwd, homedir(), "shell", controller.signal);
    await started;
    controller.abort();
    assert.equal((await pending).kind, "cancelled");
    hold = false;
    entered = undefined;
    assert.equal((await provider.classify("printf sibling", cwd, homedir())).ok, true,
      "cancelling one consumer leaves the daemon and sibling available");
  } finally { provider.stop(); }

  writeConfig({ acclass: setFixtureProvider(providerConfig), auto: { judgeModel: "fixture/judge" } });
  const classified = harness();
  await classified.start();
  try {
    response = wireResponse({ identity });
    assert.notEqual((await classified.call("custom", {}))?.block, true);
    assert.equal(classified.reviews.length, 1, "all-negative unverified action evidence still requires review");
    response = wireResponse({ identity, scope_complete: false });
    assert.notEqual((await classified.call("bash", { command: "printf synthetic" }))?.block, true);
    assert.equal(classified.reviews.length, 2, "incomplete shell scope requires the judge");
    await classified.commands["read-only"]("on", classified.ctx);
    const positive = facts({ local_state_change: true });
    response = wireResponse({ identity, preds: positive, probs: scores(positive) });
    assert.notEqual((await classified.call("custom", {}))?.block, true);
    assert.equal(classified.reviews.length, 3, "positive custom risks require authoritative guard review");
    assert.deepEqual(classified.reviews.at(-1)[5], { auto: true, readOnly: true, remoteReadOnly: false });
    response = wireResponse({ identity, input_complete: false });
    assert.notEqual((await classified.call("bash", { command: "printf synthetic" }))?.block, true);
    assert.equal(classified.reviews.length, 4, "invalid shell evidence requires review under a guard");
    await classified.commands["read-only"]("off", classified.ctx);
    response = wireResponse({ identity });
    hold = true;
    const controller = new AbortController();
    classified.ctx.signal = controller.signal;
    const started = new Promise((resolve) => { entered = resolve; });
    const pending = classified.call("custom", {});
    await started;
    controller.abort();
    const denied = await pending;
    assert.equal(denied?.block, true);
    assert.match(denied.reason, /cancelled during classification/);
    assert.equal(classified.reviews.length, 4, "cancelled work never reaches the reviewer");
    assert.equal(classified.prompts, 0);
    hold = false;
    entered = undefined;
    classified.ctx.signal = undefined;
  } finally { await classified.stop(); }

  // Keep metadata checks last so runtime coverage still runs during metadata updates.
  assert.deepEqual(example, { acclass: DEFAULT_CONFIG.acclass }, "published example contains only the brief managed settings");
  assert.deepEqual(schema.properties.classifier.not, {}, "public classifier configuration is forbidden");
  assert.equal(schema.properties.acclass.properties.enabled.default, true);
  assert.deepEqual(schema.properties.acclass.properties.variant.enum, ["q8", "q5", "fp32"]);
  assert.equal(schema.properties.auto.properties.judgeModel.default, undefined, "omission follows the current chat model");
  console.log("ok standalone defaults, explicit review routing, deterministic files, hard vetoes and typed optional classifier");
} finally {
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
}
