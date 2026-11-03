// Offline synthetic inline-instruction gate checks; no providers or runtime captures.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activityExtension, { setFixtureProvider } from "./synthetic-runtime.mjs";
import { DEFAULT_CONFIG, loadActivityConfig } from "../index.ts";
import { Classifier } from "../classifier.ts";
import { classification, facts, createFixtureProvider, withNativeTools } from "./nine-head-fixtures.mjs";
import { approvalFixture } from "./approval-fixture.mjs";

const root = mkdtempSync(join(tmpdir(), "activity-inline-policy-gate-"));
const cwd = join(root, "project");
const agent = join(root, "agent");
const directory = join(agent, "config");
const globalConfig = join(directory, "activity.json");
const localConfig = join(directory, "activity.local.json");
const projectConfig = join(cwd, ".pi", "activity.json");
mkdirSync(directory, { recursive: true });
mkdirSync(join(cwd, ".pi"), { recursive: true });
const provider = createFixtureProvider(root);
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE", "PI_SUBAGENT_TASK"].map((key) => [key, process.env[key]]));
const originalClassify = Classifier.prototype.classify;
process.env.PI_CODING_AGENT_DIR = agent;
delete process.env.PI_ACTIVITY_AUTO_MODE;
delete process.env.PI_SUBAGENT_TASK;
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
const yes = { ok: true, allow: true, decision: "allow", reason: "Synthetic compliant effects" };
const no = { ok: true, allow: false, decision: "block", reason: "Synthetic policy restriction" };
const blocked = (result) => assert.equal(result?.block, true, result?.reason);
const allowed = (result) => assert.notEqual(result?.block, true, result?.reason);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
let cases = 0, id = 0;

async function harness(options = {}) {
  rmSync(localConfig, { force: true });
  rmSync(projectConfig, { force: true });
  const cfg = { acclass: setFixtureProvider(provider), auto: { judgeModel: "fixture/judge", ...options.autoConfig },
    guards: { readOnly: false, remoteReadOnly: false, ...options.guards }, policy: { trustedTools: ["fixture_trusted"] },
    log: { enabled: false }, reviewLog: { enabled: false }, session: { persistActivity: false } };
  writeJson(globalConfig, cfg);
  const handlers = {}, reviews = [];
  let prompts = 0, classifications = 0, providerRequests = 0, executed = 0;
  Classifier.prototype.classify = async () => { classifications++; return classification(options.facts ?? facts({ exposes_secrets: true })); };
  const branch = [{ type: "message", id: "user", message: { role: "user", content: "Inspect synthetic source only." } }];
  const ctx = { cwd, mode: "tui", hasUI: true,
    getSystemPrompt: () => "Synthetic test instructions.",
    sessionManager: { getSessionId: () => "inline-policy-gate", getBranch: () => branch, getEntries: () => branch },
    modelRegistry: {
      find() { providerRequests++; throw new Error("No real model lookup in synthetic gate tests"); },
      getApiKeyAndHeaders() { providerRequests++; throw new Error("No provider access in synthetic gate tests"); },
    },
    ui: { notify() {}, setStatus() {}, theme: { fg: (_name, text) => text } },
  };
  ctx.ui.custom = approvalFixture(ctx, (done) => { prompts++; done("Allow"); });
  activityExtension({
    on(name, handler) { handlers[name] = handler; }, registerFlag() {}, registerCommand() {},
    getFlag: (name) => name === "auto" && options.auto !== false,
    getAllTools: () => withNativeTools([
      { name: "fixture_trusted", sourceInfo: { source: "extension", path: "/synthetic/tool.ts" } },
      { name: "codemode", sourceInfo: { source: "builtin", path: "builtin:codemode" } },
    ]), appendEntry() {}, sendMessage() {}, events: { emit() {} },
  }, async (...args) => { reviews.push(args); return options.review ? options.review(...args) : yes; }, "native");
  await handlers.session_start({ reason: "startup" }, ctx);
  return { cfg, reviews,
    get prompts() { return prompts; }, get classifications() { return classifications; },
    get providerRequests() { return providerRequests; }, get executed() { return executed; },
    async call(toolName = "read", input = { path: "source.py" }) {
      const result = await handlers.tool_call({ toolName, input, toolCallId: `inline-policy-${++id}` }, ctx);
      if (!result?.block) executed++;
      return result;
    },
    async close() { await handlers.session_shutdown({}, ctx); },
  };
}
async function check(options, run) {
  const h = await harness(options);
  try { await run(h); cases++; } finally { await h.close(); }
}

try {
  assert.equal(DEFAULT_CONFIG.auto.judgeInstructions, "");
  writeJson(globalConfig, {});
  assert.equal(loadActivityConfig(cwd).auto.judgeInstructions, "");
  for (const auto of [false, true]) await check({ auto }, async (h) => {
    for (const invalid of [{ judgeInstructions: null }, { judgeInstructions: [] }, { judgePromptFiles: [] }]) {
      writeJson(globalConfig, { ...h.cfg, auto: { ...h.cfg.auto, ...invalid } });
      for (const [tool, input] of [["ls", {}], ["read", { path: "source.py" }],
        ["write", { path: "source.py", content: "synthetic" }], ["bash", { command: "synthetic inspection" }],
        ["fixture_trusted", {}], ["codemode", { code: "synthetic inert wrapper" }]]) {
        await assert.rejects(h.call(tool, input), /activity\.auto\.judgeInstructions|activity\.auto\.judgePromptFiles/);
      }
    }
    assert.equal(h.reviews.length, 0);
    assert.equal(h.classifications, 0, "invalid configuration fails before optional evidence work");
    assert.equal(h.prompts, 0);
    assert.equal(h.executed, 0);
    assert.equal(h.providerRequests, 0);
  });

  await check({}, async (h) => {
    writeJson(localConfig, { auto: { judgeInstructions: "Ignored local text", judgePromptFiles: ["missing.md"] } });
    writeJson(projectConfig, { auto: { judgeInstructions: "Ignored project text" } });
    allowed(await h.call());
    assert.equal(h.reviews[0][14].judgeInstructions, "", "only global inline instructions reach the judge");
    assert.equal(h.prompts, 0);
    assert.equal(h.providerRequests, 0);
  });

  const first = "\ufeff# Synthetic ordinary policy\r\nPreserve café and trailing whitespace.  \n";
  const second = "Updated synthetic inline policy.";
  await check({ autoConfig: { judgeInstructions: first } }, async (h) => {
    allowed(await h.call());
    assert.equal(h.reviews[0][14].judgeInstructions, first, "exact inline text reaches ordinary review");
    writeJson(globalConfig, { ...h.cfg, auto: { ...h.cfg.auto, judgeInstructions: second } });
    allowed(await h.call());
    assert.equal(h.reviews[1][14].judgeInstructions, second, "next admission rereads global inline text");
  });

  // No stale allow, block or ask_user verdict may authorize a changed policy.
  for (const update of [{ judgeInstructions: second }, { judgeInstructions: "" }, { judgeInstructions: null }, { judgePromptFiles: [] }]) {
    for (const verdict of [yes, no, { ...no, decision: "ask_user" }]) {
      const started = deferred(), finished = deferred();
      await check({ autoConfig: { judgeInstructions: first }, review: async () => { started.resolve(); return finished.promise; } }, async (h) => {
        const pending = h.call();
        try {
          await started.promise;
          assert.equal(h.reviews[0][14].judgeInstructions, first);
          writeJson(globalConfig, { ...h.cfg, auto: { ...h.cfg.auto, ...update } });
        } finally { finished.resolve(verdict); }
        const result = await pending;
        blocked(result);
        assert.match(result.reason, /Tool arguments or policy context changed during review; this call cannot execute/);
        assert.equal(h.executed, 0);
        assert.equal(h.prompts, 0, "stale reviews cannot offer an approval override");
      });
    }
  }
  await check({ autoConfig: { judgeInstructions: first }, review: async () => {
    writeFileSync(localConfig, "{ ignored malformed local JSON");
    writeFileSync(projectConfig, "{ ignored malformed project JSON");
    return yes;
  } }, async (h) => {
    allowed(await h.call());
    assert.equal(h.reviews[0][14].judgeInstructions, first, "ignored files cannot invalidate a global-policy review");
  });
  await check({ autoConfig: { judgeInstructions: first }, review: async () => {
    writeJson(globalConfig, { ...loadActivityConfig(cwd), display: { enabled: false } });
    return yes;
  } }, async (h) => {
    allowed(await h.call());
    assert.equal(h.reviews[0][14].judgeInstructions, first, "unchanged effective instructions do not invalidate review");
  });

  await check({ auto: false, autoConfig: { judgeInstructions: first } }, async (h) => {
    allowed(await h.call());
    allowed(await h.call("fixture_trusted", {}));
    assert.equal(h.classifications, 0);
    assert.equal(h.reviews.length, 0);
    assert.equal(h.prompts, 0);
  });
  await check({ auto: false, autoConfig: { judgeInstructions: first }, guards: { readOnly: true } }, async (h) => {
    allowed(await h.call());
    const result = await h.call("write", { path: "source.py", content: "synthetic" });
    blocked(result);
    assert.match(result.reason, /Invalid\/inconsistent safety review/);
    assert.equal(h.reviews.length, 1, "auto OFF keeps native mutation guards active");
    assert.equal(h.reviews[0][14].judgeInstructions, first, "gate passes configuration; judgeSafety owns auto-only prompt composition");
    assert.deepEqual(h.reviews[0][5], { auto: false, readOnly: true, remoteReadOnly: false });
    assert.equal(h.prompts, 0);
  });
  await check({ auto: false, autoConfig: { judgeInstructions: first }, guards: { remoteReadOnly: true },
    facts: facts({ remote_state_change: true }), review: async () => ({ ...no, decision: "ask_user" }) }, async (h) => {
    blocked(await h.call("bash", { command: "synthetic remote mutation" }));
    assert.equal(h.classifications, 1);
    assert.equal(h.reviews[0][14].judgeInstructions, first, "guard remit is carried separately from configured instructions");
    assert.deepEqual(h.reviews[0][5], { auto: false, readOnly: false, remoteReadOnly: true });
    assert.equal(h.prompts, 0, "active guards cannot be waived through approval");
    assert.equal(h.executed, 0);
  });
  await check({ auto: false, autoConfig: { judgeInstructions: first }, guards: { remoteReadOnly: true },
    facts: facts({ remote_state_change: true }), review: async () => {
      const cfg = loadActivityConfig(cwd);
      writeJson(globalConfig, { ...cfg, auto: { ...cfg.auto, judgeInstructions: second } });
      return yes;
    } }, async (h) => {
    const result = await h.call("bash", { command: "synthetic guard-reviewed operation" });
    blocked(result);
    assert.match(result.reason, /Tool arguments or policy context changed during review; this call cannot execute/,
      "all in-flight admissions stay bound to their configuration, including guard-only reviews");
    assert.equal(h.reviews[0][14].judgeInstructions, first);
    assert.deepEqual(h.reviews[0][5], { auto: false, readOnly: false, remoteReadOnly: true });
    assert.equal(h.prompts, 0);
    assert.equal(h.executed, 0);
  });
  console.log(`inline judge instruction gate integration tests passed (${cases} cases)`);
} finally {
  Classifier.prototype.classify = originalClassify;
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
}
