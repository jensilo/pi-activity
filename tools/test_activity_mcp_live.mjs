#!/usr/bin/env node
// Opt-in, offline-provider integration. Only our inert stdio server executes.
// node tools/test_activity_mcp_live.mjs --live
// PI_GLOBAL selects the installed Pi package. ACCLASS_TEST_EXTENSION_ROOT,
// ACCLASS_TEST_BINARY and ACCLASS_TEST_MODEL match the other live test scripts.
// The reviewer is deterministic, not evidence of live LLM safety accuracy.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const wireTools = [
  { name: "read", description: "Returns inert stored catalog data. Metadata is unverified, not a backend attestation.",
    inputSchema: { type: "object", properties: { key: { type: "string" }, payload: { type: "object",
      properties: { text: { type: "string" }, enabled: { type: "boolean" }, extra: { type: "null" },
        options: { type: "array", items: { type: "string" } } },
      required: ["text", "enabled", "extra", "options"], additionalProperties: false } },
      required: ["key", "payload"], additionalProperties: false, "x-public-extension": { kept: true } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  // Deliberately conflicting, unverified hints must not suppress positive risk signals.
  { name: "remove", description: "Deletes existing remote production records through a nonlocal API, disrupting availability. This metadata is unverified.",
    inputSchema: { type: "object", properties: { operation: { type: "string", const: "delete" },
      endpoint: { type: "string" }, id: { type: "string" },
      options: { type: "object", properties: { inert: { type: "boolean" } }, required: ["inert"], additionalProperties: false } },
      required: ["operation", "endpoint", "id", "options"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];

// Minimal real MCP stdio peer. No shell commands, file reads, removals, or network
// operations are implemented. The only writes are its own test audit counters.
async function serveInert() {
  const root = process.env.ACCLASS_MCP_SERVER_ROOT;
  assert.ok(root && existsSync(join(root, "server-owner")), "private test server root required");
  const state = { pid: process.pid, initialized: 0, listed: 0, calls: [] };
  const save = () => writeFileSync(join(root, "server-state.json"), JSON.stringify(state), { mode: 0o600 });
  save();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result;
    let error;
    switch (request.method) {
      case "initialize":
        state.initialized++;
        result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: "acclass-inert", version: "1" }, instructions: "Synthetic catalog server" };
        break;
      case "ping": result = {}; break;
      case "tools/list": state.listed++; result = { tools: wireTools }; break;
      case "tools/call":
        if (!wireTools.some((tool) => tool.name === request.params.name)) {
          error = { code: -32602, message: "unknown inert tool" };
          break;
        }
        state.calls.push({ name: request.params.name, arguments: request.params.arguments });
        result = { content: [{ type: "text", text: "inert fixture result" }] };
        break;
      default: error = { code: -32601, message: "unsupported fixture method" };
    }
    save();
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }) }) + "\n");
  }
}

// Only fixed categories leave the process, including on failure. Runtime data
// below is synthetic, but SDK diagnostics can still include private host paths.
let check = "preflight";
const report = (aggregate) => process.stdout.write(JSON.stringify(aggregate) + "\n");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--inert-server") {
  await serveInert();
} else if (!args.length || (args.length === 1 && args[0] === "--help")) {
  console.log("Skipped: real Q8 MCP integration requires explicit --live. No SDK, auth, provider, classifier, or server loaded.\nUsage: node tools/test_activity_mcp_live.mjs --live\nOverrides: PI_GLOBAL, ACCLASS_TEST_EXTENSION_ROOT, ACCLASS_TEST_BINARY, ACCLASS_TEST_MODEL");
} else if (args.length === 1 && args[0] === "--live") {
  console.log = console.warn = console.error = () => {};
  try { await runLive(); }
  catch (error) {
    const label = String(error?.message ?? "").split("\n")[0];
    const failure = error?.code === "ERR_ASSERTION" && /^[a-z0-9-]{1,100}$/.test(label)
      ? label : String(error?.code ?? error?.name ?? "unknown").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 100);
    report({ passed: false, check, failure });
    process.exitCode = 1;
  }
} else {
  report({ passed: false, check: "arguments", failure: "unsupported-argument" });
  process.exitCode = 2;
}

function outsideWorktree(path) {
  let cursor = realpathSync(path);
  while (true) {
    assert.ok(!existsSync(join(cursor, ".git")), "temporary-directory-must-be-outside-git");
    if (dirname(cursor) === cursor) return;
    cursor = dirname(cursor);
  }
}

async function runLive() {
  const originalHome = homedir();
  const expand = (path) => resolve(path === "~" ? originalHome : path.startsWith("~/") ? join(originalHome, path.slice(2)) : path);
  const extensionRoot = expand(process.env.ACCLASS_TEST_EXTENSION_ROOT ?? fileURLToPath(new URL("..", import.meta.url)));
  const binary = expand(process.env.ACCLASS_TEST_BINARY ?? "~/.acclass/bin/acclass");
  const model = expand(process.env.ACCLASS_TEST_MODEL ?? "~/.acclass/model");
  const require = createRequire(import.meta.url);
  let hostEntry;
  if (process.env.PI_GLOBAL) hostEntry = join(expand(process.env.PI_GLOBAL), "dist/index.js");
  else {
    try { hostEntry = require.resolve("@earendil-works/pi-coding-agent"); }
    catch { hostEntry = resolve(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js"); }
  }
  assert.ok(existsSync(hostEntry), "installed Pi required; set PI_GLOBAL (no installs performed)");
  const hostRequire = createRequire(hostEntry);
  const { createJiti } = await import(pathToFileURL(hostRequire.resolve("jiti")).href);
  const hostJiti = createJiti(hostEntry);
  const aiEntry = hostJiti.esmResolve("@earendil-works/pi-ai");
  const jiti = createJiti(import.meta.url, { alias: {
    "@earendil-works/pi-coding-agent": hostEntry,
    "@earendil-works/pi-tui": fileURLToPath(hostJiti.esmResolve("@earendil-works/pi-tui")),
    "@earendil-works/pi-ai/compat": fileURLToPath(hostJiti.esmResolve("@earendil-works/pi-ai/compat")),
    "@earendil-works/pi-ai": fileURLToPath(aiEntry),
  } });
  // Check BEFORE creating runtime files. TMPDIR may point inside a worktree.
  const base = realpathSync(tmpdir());
  outsideWorktree(base);
  const dir = mkdtempSync(join(base, "ac-mcp-"));
  const home = join(dir, "home");
  const agentDir = join(home, ".pi/agent");
  const cwd = join(dir, "project");
  const reviewLog = join(dir, "reviews.jsonl");
  const envKeys = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE", "PI_SUBAGENT_TASK",
    "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY"];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  mkdirSync(join(agentDir, "config"), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(dir, "server-owner"), "inert test only", { mode: 0o600 });
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {}, autoEnableCodemode: false }), { mode: 0o600 });
  const providerConfig = { provider: "acclass", binary, model, socket: join(dir, "classifier.sock"), quant: "q8", spawn: true,
    startTimeoutMs: 120_000, requestTimeoutMs: 60_000 };
  writeFileSync(join(agentDir, "config/activity.json"), JSON.stringify({
    policy: { trustedTools: ["acclass_mcp_driver"], questionnaireSources: [] },
    auto: { judgeModel: "fixture/judge" },
    acclass: { enabled: false },
    log: { enabled: false }, reviewLog: { enabled: true, path: reviewLog, maxBytes: 2_097_152 },
  }), { mode: 0o600 });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_TELEMETRY = "0";
  delete process.env.PI_ACTIVITY_AUTO_MODE;
  delete process.env.PI_SUBAGENT_TASK;
  let session;
  let shutdownEmitted = false;
  let aggregate;
  let Classifier;
  let originalClassify;
  let ReviewLogger;
  let originalLogTelemetry;
  let loggerMethodOwned = false;
  let reviewRecords = 0;
  let extensionErrors = 0;
  const reviewLoggers = new Set();
  const instances = new Set();
  const children = new Set();
  const observations = [];
  const nestedStarts = [];
  const reviews = [];
  const outcomes = [];
  let reviewerOutcome = "allow";
  let providerRequests = 0;
  const serverState = () => JSON.parse(readFileSync(join(dir, "server-state.json"), "utf8"));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
  try {
    check = "isolated-config";
    const { createAgentSession, createMcpExtension, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } =
      await import(pathToFileURL(hostEntry).href);
    assert.equal(getAgentDir(), agentDir, "host-must-use-isolated-agent-directory");
    const { Type } = await import(hostJiti.esmResolve("typebox"));
    ({ Classifier } = await jiti.import(pathToFileURL(join(extensionRoot, "activity/classifier.ts")).href));
    const { default: activityExtension, loadActivityConfig } = await jiti.import(pathToFileURL(join(extensionRoot, "activity/index.ts")).href);
    const { createEvidenceProvider } = await jiti.import(pathToFileURL(join(extensionRoot, "activity/evidence-provider.ts")).href);
    const cfg = loadActivityConfig(cwd);
    assert.equal(cfg.reviewLog.enabled, true, "synthetic-review-log-must-be-enabled");
    assert.equal(cfg.reviewLog.path, reviewLog, "synthetic-review-log-path-must-match");
    assert.equal(cfg.redaction.literalsFile, null, "private-redaction-dictionary-must-not-be-discovered");
    ({ ReviewLogger } = await jiti.import(pathToFileURL(join(extensionRoot, "activity/logger.ts")).href));
    originalLogTelemetry = ReviewLogger.prototype.logTelemetry;
    loggerMethodOwned = Object.hasOwn(ReviewLogger.prototype, "logTelemetry");
    ReviewLogger.prototype.logTelemetry = function (...input) {
      reviewLoggers.add(this);
      reviewRecords++;
      return originalLogTelemetry.apply(this, input); // Observe, never replace production serialization.
    };
    check = "q8-contract";
    const { HEADS, hardGuardDecision } = await jiti.import(pathToFileURL(join(extensionRoot, "activity/policy.ts")).href);
    const contract = JSON.parse(readFileSync(join(model, "model_contract.json"), "utf8"));
    assert.equal(contract.schema, "acclass-vnext-model/1");
    assert.deepEqual(contract.heads, HEADS);
    assert.equal(contract.context_limit_inclusive, 2048);
    const loadingMode = existsSync(join(model, "model.gguf")) ? "gguf" : "q8-runtime";
    if (loadingMode === "gguf") {
      assert.equal(contract.quantization, "Q8_0", "real Q8 GGUF bundle required");
      assert.equal(contract.dtype, "mixed-Q8_0/F32");
      const { createHash } = await import("node:crypto");
      const { createReadStream } = await import("node:fs");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(join(model, "model.gguf"))) hash.update(chunk);
      assert.equal(hash.digest("hex"), contract.model_gguf_sha256, "Q8 bundle must match its contract");
    }
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    check = "sdk-bind";
    originalClassify = Classifier.prototype.classify;
    Classifier.prototype.classify = async function (...input) {
      instances.add(this);
      const result = await originalClassify.apply(this, input);
      if (this.child) children.add(this.child);
      observations.push({ input, result });
      return result; // Observe production inference; never replace or edit its result.
    };
    let target;
    let requestedInput;
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [createMcpExtension({ startupWaitMs: 10_000 }), (pi) => {
        activityExtension(pi, async (...input) => {
          reviews.push(input);
          return { ok: reviewerOutcome !== "unavailable", allow: reviewerOutcome === "allow", reason: "deterministic inert integration reviewer" };
        }, undefined, (_settings) => createEvidenceProvider(providerConfig));
        pi.on("before_provider_request", () => { providerRequests++; throw new Error("provider requests forbidden in this test"); });
        pi.registerMcpServer("acclass_inert", { command: process.execPath,
          args: [fileURLToPath(import.meta.url), "--inert-server"], cwd,
          env: { HOME: home, PI_CODING_AGENT_DIR: agentDir, ACCLASS_MCP_SERVER_ROOT: dir },
          exposure: "direct", description: "Synthetic catalog server", timeout: 5 });
        pi.registerTool({ name: "acclass_mcp_driver", label: "Inert driver", description: "Calls only our synthetic test MCP tool",
          parameters: Type.Object({}), async execute(_id, _input, _signal, _update, ctx) {
            const nested = await ctx.executeTool(target, requestedInput);
            return { ...nested.result, isError: nested.isError };
          } });
      }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const sessionManager = SessionManager.inMemory(cwd);
    const inertModel = { provider: "fixture", id: "fixture", name: "Inert fixture", api: "openai-completions",
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 };
    sessionManager.appendMessage({ role: "assistant", api: inertModel.api, provider: "fixture", model: "fixture",
      content: [{ type: "toolCall", id: "mcp-parent", name: "acclass_mcp_driver", arguments: {} }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
      refreshOnCreate: false, allowModelNetwork: false });
    ({ session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager,
      noTools: true, model: inertModel, modelRuntime }));
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") nestedStarts.push(event);
    });
    await session.bindExtensions({ mode: "print", onError: () => { extensionErrors++; } });
    const names = wireTools.map((tool) => `mcp__acclass_inert__${tool.name}`);
    const deadline = Date.now() + 10_000;
    while (!names.every((name) => session.getAllTools().some((tool) => tool.name === name)) && Date.now() < deadline) await sleep(25);
    const allTools = session.getAllTools();
    assert.deepEqual(allTools.filter((tool) => tool.name.startsWith("mcp__")).map((tool) => tool.name).sort(), [...names].sort(),
      "only our two real tools/list registrations must appear within 10 seconds");
    for (const wire of wireTools) {
      const actual = allTools.find((tool) => tool.name === `mcp__acclass_inert__${wire.name}`);
      assert.deepEqual(JSON.parse(JSON.stringify(actual.parameters)), wire.inputSchema);
      assert.deepEqual(actual.annotations, wire.annotations);
      assert.equal(actual.description, wire.description);
      assert.equal(actual.exposure, "direct");
      assert.equal(actual.namespace.name, "mcp__acclass_inert");
    }
    assert.equal(serverState().initialized, 1);
    assert.ok(serverState().listed >= 1, "real MCP tools/list required");
    const driver = session.agent.state.tools.find((tool) => tool.name === "acclass_mcp_driver");
    assert.ok(driver);
    const guard = async (name, value) => {
      const command = session.extensionRunner.getCommand(name);
      assert.ok(command, `production ${name} command required`);
      await command.handler(value, session.extensionRunner.createCommandContext());
    };
    const readInput = { key: ["computed", "42"].join("-"), payload: { text: "full evaluated Unicode ☃",
      enabled: false, extra: null, options: ["inert", "complete"] } };
    const removeInput = { operation: "delete", endpoint: "https://records.example/production", id: "computed-42", options: { inert: true } };
    async function runCase(id, operation, guards, guardSignal, outcome = "allow") {
      check = id;
      reviewerOutcome = outcome;
      const blocked = outcome !== "allow";
      target = `mcp__acclass_inert__${operation}`;
      requestedInput = structuredClone(operation === "read" ? readInput : removeInput);
      const info = session.getAllTools().find((tool) => tool.name === target);
      const before = { classifier: observations.length, reviewer: reviews.length, backend: serverState().calls.length,
        nested: nestedStarts.length };
      const result = await driver.execute("mcp-parent", {}, new AbortController().signal);
      assert.equal(nestedStarts.length, before.nested + 1, `${id}: actual nested runtime execution event`);
      assert.equal(nestedStarts.at(-1).parentToolCallId, "mcp-parent");
      assert.equal(nestedStarts.at(-1).toolName, target);
      assert.deepEqual(nestedStarts.at(-1).args, requestedInput);
      assert.equal(observations.length, before.classifier + 1, `${id}: actual production classifier invoked exactly once`);
      const observed = observations.at(-1);
      assert.equal(observed.input[3], "action");
      assert.equal(observed.input[1], cwd);
      assert.equal(observed.input[2], home);
      const fullInput = JSON.parse(observed.input[0]);
      assert.equal(fullInput.representation, "runtime-action-evidence-json/1");
      assert.equal(fullInput.tool_name, target);
      assert.deepEqual(fullInput.evaluated_arguments, requestedInput);
      assert.deepEqual(fullInput.tool_metadata, JSON.parse(JSON.stringify({ description: info.description,
        parameters: info.parameters, namespace: info.namespace, annotations: info.annotations, exposure: info.exposure })));
      assert.deepEqual(fullInput.evidence_status, { backend_behavior: "unverified", effect_coverage: "incomplete",
        metadata_trust: "unverified", prediction_eligibility: "positive-risk-signals-only" });
      assert.ok(!("backend_contract" in fullInput));
      assert.equal(observed.result.ok, true, `${id}: complete real inference required: ${observed.result.message ?? ""}`);
      assert.deepEqual(Object.keys(observed.result.preds).sort(), [...HEADS].sort());
      assert.equal(observed.result.inputComplete, true);
      assert.ok(observed.result.tokenCount > 0 && observed.result.tokenCount <= 2048);
      assert.equal(!!hardGuardDecision(observed.result.preds, guards), guardSignal, `${id}: real positive predictions must exercise the guard`);
      if (operation === "read") assert.deepEqual(HEADS.filter((head) => observed.result.preds[head]), [], "all-negative real read still requires review");
      if (guards.remoteReadOnly) assert.equal(observed.result.preds.remote_state_change, true, "real remove predicts remote mutation");
      assert.equal(result.isError === true, blocked, `${id}: actual runtime follows reviewer outcome`);
      assert.equal(reviews.length - before.reviewer, 1, "positive guard signals still require review");
      assert.equal(serverState().calls.length - before.backend, blocked ? 0 : 1);
      assert.deepEqual(reviews.at(-1)[3], requestedInput);
      assert.equal(reviews.at(-1)[2], target);
      assert.equal(reviews.at(-1)[4], cwd);
      assert.deepEqual(reviews.at(-1)[5], { auto: true, ...guards }, "actual guard modes reach reviewer unchanged");
      assert.deepEqual(reviews.at(-1)[11].parameters, info.parameters, "actual registered schema reaches reviewer unchanged");
      if (!blocked) assert.deepEqual(serverState().calls.at(-1), { name: operation, arguments: requestedInput });
      outcomes.push({ id, tool: target, preds: observed.result.preds, outcome, guardSignal, blocked,
        backend: blocked ? 0 : 1, backendTotal: serverState().calls.length });
    }
    await runCase("ordinary-read", "read", { readOnly: false, remoteReadOnly: false }, false);
    await runCase("ordinary-remove", "remove", { readOnly: false, remoteReadOnly: false }, false);
    await guard("read-only", "on");
    for (const outcome of ["allow", "deny", "unavailable"]) {
      await runCase(`read-only-remove-${outcome}`, "remove", { readOnly: true, remoteReadOnly: false }, true, outcome);
    }
    await guard("read-only", "off");
    await guard("remote-read-only", "on");
    for (const outcome of ["allow", "deny", "unavailable"]) {
      await runCase(`remote-read-only-remove-${outcome}`, "remove", { readOnly: false, remoteReadOnly: true }, true, outcome);
    }
    assert.equal(providerRequests, 0);
    assert.equal(instances.size, 1, "single production-owned supervised classifier");
    assert.equal(children.size, 1, "isolated classifier daemon spawned by production Classifier");
    check = "synthetic-review-log-flush";
    // emit() constructs and supplies the real ExtensionContext itself.
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    shutdownEmitted = true;
    assert.equal(extensionErrors, 0, "extension-runtime-errors-must-be-zero");
    assert.equal(reviewRecords, outcomes.length, "all-decisions-must-reach-production-logger");
    assert.equal(reviewLoggers.size, 1, "single-production-review-logger");
    assert.equal([...reviewLoggers][0].droppedRecords, 0, "production-review-logger-must-not-drop-records");
    assert.ok(existsSync(reviewLog), "synthetic-review-log-missing-after-flush");
    const traces = readFileSync(reviewLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => names.includes(row.tool));
    assert.equal(traces.length, outcomes.length);
    for (const [index, outcome] of outcomes.entries()) {
      const trace = traces[index];
      assert.equal(trace.tool, outcome.tool);
      assert.deepEqual(trace.classifier.preds, outcome.preds);
      assert.deepEqual(trace.classifier.appliedHeads, HEADS.filter((head) => outcome.preds[head]));
      assert.equal(trace.actionEvidence.classification, "complete");
      assert.equal(trace.prefilter.verdict, "block", "unverified actions cannot fast-allow");
      assert.equal(trace.final.decision, outcome.blocked ? "judge-block" : "judge-allow");
      assert.equal(trace.judge?.outcome, outcome.outcome);
      assert.equal(trace.prompt, null, "guard and print-mode reviews never offer approvals");
      assert.match(trace.classifier.identity.configuredModel, /^\[redacted:path(?::[^\]]+)?\]$/,
        "private model path must be scrubbed in persisted telemetry");
      assert.equal(trace.classifier.identity.configuredQuant, "q8");
      assert.equal(trace.classifier.identity.provider, "acclass");
      assert.equal(trace.classifier.identity.daemonIdentityVerified, true);
      assert.equal(trace.logDroppedRecords, 0);
    }
    aggregate = { passed: true, extensionMode: extensionRoot === sourceRoot ? "source" : "explicit-package",
      loadingMode, quant: "q8", classified: observations.length, reviewed: reviews.length,
      guardSignalReviews: outcomes.filter((outcome) => outcome.guardSignal).length,
      judgeBlocks: outcomes.filter((outcome) => outcome.blocked).length, backendExecuted: serverState().calls.length,
      providerRequests, reviewLogRecords: traces.length, reviewLogDropped: [...reviewLoggers][0].droppedRecords, extensionErrors };
  } finally {
    try {
      if (session) {
        if (!shutdownEmitted) await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    } finally {
      for (const instance of instances) {
        if (instance.child) children.add(instance.child);
        instance.stop();
      }
      for (const child of children) {
        const deadline = Date.now() + 3000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(25);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await Promise.race([new Promise((done) => child.once("exit", done)), sleep(1000)]);
        }
      }
      if (existsSync(join(dir, "server-state.json"))) {
        const { pid } = serverState();
        const deadline = Date.now() + 3000;
        while (alive(pid) && Date.now() < deadline) await sleep(25);
        if (alive(pid)) { process.kill(pid, "SIGTERM"); await sleep(100); }
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
      if (originalClassify) Classifier.prototype.classify = originalClassify;
      if (originalLogTelemetry) {
        if (loggerMethodOwned) ReviewLogger.prototype.logTelemetry = originalLogTelemetry;
        else delete ReviewLogger.prototype.logTelemetry;
      }
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
  report(aggregate);
}
