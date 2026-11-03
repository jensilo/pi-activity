#!/usr/bin/env node
// Source-only offline validation. No installs, real captures, credentials or providers.
// node tools/test_standalone_sdk.mjs --help
// node tools/test_standalone_sdk.mjs --fixture
// PI_GLOBAL may select an already installed Pi package. Nothing else is discovered.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// A real inert stdio peer. Tool names are not implementations of file reads or
// remote mutation. Its only writes are fixed-category fixture counters.
const wireTools = ["read", "error", "remove"].map((name) => ({
  name, description: name === "remove" ? "Synthetic mutation candidate; backend is inert" : "Synthetic catalog fixture",
  inputSchema: { type: "object", properties: { key: { type: "string" }, payload: { type: "object",
    properties: { text: { type: "string" }, enabled: { type: "boolean" }, extra: { type: "null" } },
    required: ["text", "enabled", "extra"], additionalProperties: false } },
    required: ["key", "payload"], additionalProperties: false },
  // Hints are intentionally unverified; the reviewer decides using full input.
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}));

const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const help = "Usage: node tools/test_standalone_sdk.mjs --fixture\nOffline synthetic SDK/registry, native shell/file, stdio MCP, evaluated codemode and JSONL restoration checks.\nNo arguments or --help loads no SDK and starts no processes. PI_GLOBAL selects an installed Pi package.\nOnly fixed-category aggregate counts are printed; all synthetic runtime files are removed.";
if (!args.length || (args.length === 1 && args[0] === "--help")) {
  console.log(help);
} else if (args.length === 1 && args[0] === "--fixture") {
  runIsolated();
} else if (args.length === 1 && args[0] === "--fixture-worker") {
  await runFixture();
} else if (args.length === 1 && args[0] === "--inert-server") {
  await serveInert();
} else {
  process.stderr.write("Only --help or --fixture is supported.\n");
  process.exitCode = 2;
}

function outsideWorktree(path) {
  let cursor = realpathSync(path);
  while (true) {
    assert.ok(!existsSync(join(cursor, ".git")), "temporary directory must be outside every Git worktree");
    if (dirname(cursor) === cursor) return;
    cursor = dirname(cursor);
  }
}

function runIsolated() {
  // Check the parent BEFORE making any runtime files, including ignored files.
  const base = realpathSync(tmpdir());
  outsideWorktree(base);
  const root = mkdtempSync(join(base, "pi-activity-sdk-"));
  try {
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(root, "fixture-owner"), "synthetic standalone SDK fixture", { mode: 0o600 });
    const require = createRequire(import.meta.url);
    let entry;
    if (process.env.PI_GLOBAL) entry = join(resolve(process.env.PI_GLOBAL), "dist/index.js");
    else {
      try { entry = require.resolve("@earendil-works/pi-coding-agent"); }
      catch { entry = resolve(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js"); }
    }
    assert.ok(existsSync(entry), "installed Pi required; set PI_GLOBAL (no installs performed)");
    // Do not inherit credential variables, shell hooks, NODE_OPTIONS, Pi sessions,
    // MCP records, logs, discovery paths, classifier settings or provider endpoints.
    const result = spawnSync(process.execPath, [script, "--fixture-worker"], {
      cwd: root, timeout: 90_000, encoding: "utf8", maxBuffer: 64 * 1024,
      env: { HOME: home, USERPROFILE: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        TMPDIR: root, PI_CODING_AGENT_DIR: join(home, ".pi/agent"), PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_SDK_FIXTURE_ROOT: root,
        PI_SDK_FIXTURE_HOST: entry },
    });
    // Never forward child diagnostic text, which can include tool arguments.
    const lines = (result.stdout ?? "").trim().split("\n");
    let aggregate;
    try { aggregate = JSON.parse(lines.at(-1)); } catch { /* fixed failure below */ }
    const valid = aggregate && Object.values(aggregate).every((value) => typeof value === "boolean" ||
      (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
      (typeof value === "string" && /^[a-z0-9-]{1,100}$/.test(value)));
    if (valid) process.stdout.write(JSON.stringify(aggregate) + "\n");
    else process.stdout.write(JSON.stringify({ passed: false, check: "worker-failed-or-timeout" }) + "\n");
    process.exitCode = result.status === 0 && valid && aggregate.passed ? 0 : 1;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function fixtureRoot() {
  const root = process.env.PI_SDK_FIXTURE_ROOT;
  assert.ok(root && existsSync(join(root, "fixture-owner")), "isolated fixture owner required");
  outsideWorktree(root);
  assert.equal(process.env.HOME, join(root, "home"), "isolated HOME required");
  return root;
}

async function serveInert() {
  const root = fixtureRoot();
  const counters = { initialized: 0, listed: 0, read: 0, error: 0, remove: 0, evaluated: 0 };
  const save = () => writeFileSync(join(root, "mcp-counts.json"), JSON.stringify(counters), { mode: 0o600 });
  save();
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result, error;
    switch (request.method) {
      case "initialize":
        counters.initialized++;
        result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: "standalone-fixture", version: "1" } };
        break;
      case "ping": result = {}; break;
      case "tools/list": counters.listed++; result = { tools: wireTools }; break;
      case "tools/call": {
        const { name, arguments: input } = request.params;
        if (!wireTools.some((tool) => tool.name === name)) { error = { code: -32602, message: "Unknown fixture tool" }; break; }
        counters[name]++;
        // Verify the actual transport received complete, evaluated nested input.
        if (input.key === "computed-42" && input.payload.text === "evaluated fixture ☃" &&
          input.payload.enabled === false && input.payload.extra === null) counters.evaluated++;
        result = { content: [{ type: "text", text: "inert fixture" }], isError: name === "error" };
        break;
      }
      default: error = { code: -32601, message: "Unsupported fixture method" };
    }
    save();
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }) }) + "\n");
  }
}

async function runFixture() {
  let check = "fixture-start";
  let session;
  let unsubscribe;
  let wireAttempts = 0;
  let credentialReads = 0;
  let report;
  // Runtime diagnostics are never forwarded. Assertions below use fixed labels.
  console.log = console.warn = console.error = () => {};
  const root = fixtureRoot();
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = join(root, "project");
  mkdirSync(cwd);
  mkdirSync(join(agentDir, "config"), { recursive: true });
  const denyWire = () => { wireAttempts++; throw new Error("network-forbidden"); };
  globalThis.fetch = denyWire;
  const net = (await import("node:net")).default;
  const http = (await import("node:http")).default;
  const https = (await import("node:https")).default;
  net.Socket.prototype.connect = denyWire;
  http.request = http.get = https.request = https.get = denyWire;
  syncBuiltinESMExports();
  const configPath = join(agentDir, "config/activity.json");
  let configuredJudge = "sdk-fixture/review";
  const expectedGuards = { readOnly: false, remoteReadOnly: false };
  const configure = () => writeFileSync(configPath, JSON.stringify({
    acclass: { enabled: false }, auto: { judgeModel: configuredJudge }, policy: { trustedTools: ["subagent"] },
    history: { maxEntries: 100 }, log: { enabled: false }, reviewLog: { enabled: false },
  }), { mode: 0o600 });
  configure();
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {}, autoEnableCodemode: false }), { mode: 0o600 });
  const hostEntry = process.env.PI_SDK_FIXTURE_HOST;
  let fakeStreams = 0, routes = 0, reviews = 0, evaluatedReviews = 0, customExecutions = 0;
  let admissions = 0, payloadHooks = 0, responseHooks = 0, providerEvents = 0;
  let extensionErrors = 0, summaryStreams = 0, judgeStreams = 0;
  let subscriptions = 0, starts = 0, ends = 0, resultHooks = 0;
  let cancellation;
  let nextCalls = [];
  const rawEvents = []; // Synthetic only, never printed, never written to the worktree.
  try {
    check = "host-import";
    const hostRequire = createRequire(hostEntry);
    const { createJiti } = await import(pathToFileURL(hostRequire.resolve("jiti")).href);
    const hostJiti = createJiti(hostEntry);
    const aiEntry = hostJiti.esmResolve("@earendil-works/pi-ai");
    const jiti = createJiti(import.meta.url, { alias: {
      "@earendil-works/pi-coding-agent": hostEntry,
      "@earendil-works/pi-ai": fileURLToPath(aiEntry),
      "@earendil-works/pi-tui": fileURLToPath(hostJiti.esmResolve("@earendil-works/pi-tui")),
      "@earendil-works/pi-ai/compat": fileURLToPath(hostJiti.esmResolve("@earendil-works/pi-ai/compat")),
    } });
    const { createAgentSession, createCodemodeExtension, createMcpExtension, DefaultResourceLoader,
      ModelRuntime, ModelRegistry, SessionManager, SettingsManager } = await import(pathToFileURL(hostEntry).href);
    const { createAssistantMessageEventStream } = await import(aiEntry);
    const { Type } = await import(hostJiti.esmResolve("typebox"));
    check = "activity-import";
    // Inject the offline provider even if managed setup becomes enabled in defaults.
    const activityExtension = await jiti.import(new URL("../activity/test/synthetic-runtime.mjs", import.meta.url).href, { default: true });
    const { OBSERVATION_ENTRY_TYPE } = await jiti.import(new URL("../activity/version.ts", import.meta.url).href);
    const { RollingUserSummary, SUMMARY_ENTRY_TYPE } = await jiti.import(new URL("../activity/summary.ts", import.meta.url).href);
    const { judgeSafety } = await jiti.import(new URL("../activity/judge.ts", import.meta.url).href);

    check = "registry-create";
    // This is the real ModelRuntime and real ModelRegistry, not a fake registry.
    // The credential store is injected and contains no credentials, even on refresh.
    const emptyCredentials = {
      async read() { credentialReads++; return undefined; }, async list() { return []; },
      async modify() { throw new Error("credential-write-forbidden"); }, async delete() { throw new Error("credential-write-forbidden"); },
    };
    const modelRuntime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false });
    const registry = new ModelRegistry(modelRuntime);
    const physical = (id) => ({ provider: "sdk-fixture", id, name: "Offline fixture", api: "sdk-fixture-native",
      baseUrl: "", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const models = ["main", "review", "summary"].map(physical);
    const usage = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const summaryText = "# User Message Summary\n## Context\nSynthetic SDK fixture\n## Intent\nValidate offline wiring\n## Allowed\nOnly inert fixtures\n## Forbidden\nReal providers and credentials\n## Guardrails\nKeep synthetic state outside Git";
    registry.registerProvider({ id: "sdk-fixture", name: "Keyless offline fixture",
      auth: { apiKey: { name: "Keyless fixture", resolve: async () => ({ auth: {}, source: "synthetic" }) } },
      getModels: () => models,
      stream: () => { throw new Error("native-simple-stream-required"); },
      streamSimple(model, context, options) {
        assert.equal(model.provider, "sdk-fixture", "only-fixture-provider");
        assert.equal(options.apiKey, undefined, "no-artificial-key");
        assert.ok(++fakeStreams <= 50, "bounded-fake-streams");
        const stream = createAssistantMessageEventStream();
        queueMicrotask(async () => {
          const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
            content: [], usage: structuredClone(usage), stopReason: "pending", timestamp: Date.now() };
          try {
            // All request hooks are real SDK callbacks. These are not wire requests.
            await options.onPayload?.({ synthetic: true }, model);
            await options.onResponse?.({ status: 200, headers: {} }, model);
            await options.onProviderStreamEvent?.({ synthetic: true }, model);
            stream.push({ type: "start", partial: message });
            if (model.id === "main" && nextCalls.length) {
              const calls = nextCalls;
              nextCalls = [];
              for (const call of calls) {
                const contentIndex = message.content.length;
                message.content.push({ type: "toolCall", id: call.id, name: call.name, arguments: {} });
                stream.push({ type: "toolcall_start", contentIndex, partial: message });
                const delta = JSON.stringify(call.arguments);
                stream.push({ type: "toolcall_delta", contentIndex, delta, partial: message });
                message.content[contentIndex].arguments = call.arguments;
                stream.push({ type: "toolcall_end", contentIndex, toolCall: message.content[contentIndex], partial: message });
              }
              message.stopReason = "toolUse";
            } else {
              if (model.id === "summary") summaryStreams++;
              if (model.id === "review") judgeStreams++;
              const text = model.id === "summary" ? summaryText : model.id === "review"
                ? '{"decision":"allow","reason":"deterministic fixture review"}' : "Fixture complete";
              message.content.push({ type: "text", text: "" });
              stream.push({ type: "text_start", contentIndex: 0, partial: message });
              message.content[0].text = text;
              stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
              stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
              message.stopReason = "stop";
            }
            stream.push({ type: "done", reason: message.stopReason, message });
            stream.end(message);
          } catch {
            message.stopReason = "error"; message.errorMessage = "fixture-stream-failed";
            stream.push({ type: "error", reason: "error", error: message }); stream.end(message);
          }
        });
        return stream;
      },
    });
    await registry.refresh({ allowNetwork: false, providers: ["sdk-fixture"] });
    modelRuntime.registerVirtualModel({ provider: "sdk-router", id: "main", name: "Offline route", thinkingLevels: ["off"],
      route(request) {
        routes++;
        assert.ok(["user", "continuation"].includes(request.reason), "main-route-reason");
        return { model: registry.find("sdk-fixture", "main"), thinkingLevel: "off", state: { fixture: true } };
      } });
    let routingFails = false;
    modelRuntime.registerVirtualModel({ provider: "sdk-router", id: "review", name: "Offline review route", thinkingLevels: ["off"],
      route(request) {
        assert.equal(request.reason, "direct", "review-route-reason");
        if (routingFails) throw new Error("fixture-route-refused");
        return { model: registry.find("sdk-fixture", "review"), thinkingLevel: "off" };
      } });
    await registry.refresh({ allowNetwork: false, providers: ["sdk-fixture", "sdk-router"] });
    assert.ok(registry.find("sdk-router", "main"), "real-virtual-selection");

    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false },
      cacheWarming: "off", defaultTools: ["read", "bash", "write", "edit", "codemode"], shellPath: "/bin/bash" });
    const payload = { text: "evaluated fixture ☃", enabled: false, extra: null };
    const input = { key: "computed-42", payload };
    const custom = (name) => ({ name, label: name, description: "Synthetic inert candidate", parameters: Type.Object({ key: Type.String() }),
      async execute() { customExecutions++; return { content: [{ type: "text", text: "inert" }], details: undefined }; } });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: ["builtin:codemode", "builtin:mcp"],
      extensionFactories: [
        { name: "codemode", builtin: true, factory: createCodemodeExtension({ mode: "on", models: false }) },
        { name: "mcp", builtin: true, factory: createMcpExtension({ startupWaitMs: 5000 }) },
        (pi) => {
          activityExtension(pi, async (_ctx, ref, tool, candidate, actualCwd, modes) => {
            reviews++;
            assert.equal(ref, "sdk-fixture/review", "explicit-review-selection");
            assert.equal(actualCwd, cwd, "review-cwd");
            assert.deepEqual(modes, { auto: true, ...expectedGuards }, "authoritative-review-modes");
            if (candidate.command === "printf fixture-unavailable") return { ok: false, reason: "synthetic reviewer unavailable" };
            if (tool.startsWith("mcp__")) {
              assert.deepEqual(candidate, input, "full-evaluated-review-input");
              evaluatedReviews++;
            }
            // Deliberately contradictory native allow: the gate must reject it under read-only.
            return { ok: true, allow: (tool === "write" && modes.readOnly) || tool === "bash" || tool.endsWith("__read") || tool.endsWith("__error"),
              reason: "deterministic fixture verdict" };
          });
          pi.registerMcpServer("sdk_fixture", { command: process.execPath, args: [script, "--inert-server"], cwd,
            env: { PI_SDK_FIXTURE_ROOT: root, HOME: join(root, "home"), PI_CODING_AGENT_DIR: agentDir },
            exposure: "direct", timeout: 5, description: "Inert standalone fixture" });
          pi.registerTool(custom("fixture_custom"));
          pi.registerTool(custom("subagent"));
          pi.on("before_provider_request", () => { payloadHooks++; });
          pi.on("after_provider_response", () => { responseHooks++; });
          pi.on("provider_stream_event", () => { providerEvents++; });
          pi.on("tool_result", (event) => {
            resultHooks++;
            rawEvents.push({ type: "result", id: event.toolCallId, name: event.toolName,
              parent: event.parentToolCallId, error: event.isError,
              exit: typeof event.structuredContent?.exit_code === "number" ? event.structuredContent.exit_code : undefined });
          });
          // A second gate cancels AFTER activity admission. This proves admission
          // and tool_execution_start alone are not execute evidence. Do not await
          // abort here: idle waits for this handler to return.
          pi.on("tool_call", (event) => {
            if (event.toolCallId === "cancelled-admission") { admissions++; cancellation = session.abort(); }
          });
        },
      ],
    });
    const manager = SessionManager.create(cwd, join(root, "sessions"));
    const bind = async () => {
      unsubscribe?.();
      await session.bindExtensions({ mode: "print", onError: () => { extensionErrors++; } });
      subscriptions++;
      unsubscribe = session.subscribe((event) => {
        if (event.type === "tool_execution_start") starts++;
        if (event.type === "tool_execution_end") ends++;
        if (event.type === "tool_execution_start" || event.type === "tool_execution_end") rawEvents.push({
          type: event.type === "tool_execution_start" ? "start" : "end", id: event.toolCallId,
          name: event.toolName, parent: event.parentToolCallId, error: event.isError });
      });
      const deadline = Date.now() + 5000;
      while (!session.getAllTools().some((tool) => tool.name === "mcp__sdk_fixture__read") && Date.now() < deadline) await sleep(10);
      assert.ok(session.getAllTools().some((tool) => tool.name === "mcp__sdk_fixture__read"), "real-mcp-connection-bounded");
    };
    const open = async (sessionManager, model) => {
      ({ session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager,
        modelRuntime, ...(model ? { model } : {}), thinkingLevel: "off" }));
      await bind();
    };
    const snapshot = () => structuredClone(session.sessionManager.getBranch().findLast((entry) =>
      entry.type === "custom" && entry.customType === OBSERVATION_ENTRY_TYPE)?.data);
    const command = async (name, value) => {
      const registered = session.extensionRunner.getCommand(name);
      assert.ok(registered, "real-command-registration");
      await registered.handler(value, session.extensionRunner.createCommandContext());
      if (name === "read-only") expectedGuards.readOnly = value === "on";
      if (name === "remote-read-only") expectedGuards.remoteReadOnly = value === "on";
    };
    const call = (id, name, arguments_) => ({ id, name, arguments: arguments_ });
    const prompt = async (calls = []) => { nextCalls = calls; await session.prompt("Synthetic fixture task"); await session.waitForIdle(); };
    const history = (id) => snapshot().history.find((row) => row.id === id);
    const mcpCounts = () => JSON.parse(readFileSync(join(root, "mcp-counts.json"), "utf8"));
    check = "sdk-bind";
    await resourceLoader.reload();
    assert.equal(resourceLoader.getExtensions().errors.length, 0, "resource-load-errors");
    await open(manager, registry.find("sdk-router", "main"));
    for (const name of ["read", "bash", "write", "edit", "codemode"]) {
      const registered = session.getAllTools().find((tool) => tool.name === name);
      assert.equal(registered?.sourceInfo?.source, "builtin", "proven-native-implementation-source");
      assert.equal(registered.sourceInfo.path, `builtin:${name}`, "proven-native-implementation-path");
    }
    for (const tool of wireTools) {
      const registered = session.getAllTools().find((item) => item.name === `mcp__sdk_fixture__${tool.name}`);
      assert.equal(registered.sourceInfo.source, "builtin", "real-mcp-registration-source");
      assert.equal(registered.sourceInfo.path, "builtin:mcp", "real-mcp-registration-provenance");
      assert.deepEqual(JSON.parse(JSON.stringify(registered.parameters)), tool.inputSchema, "real-mcp-schema");
      assert.deepEqual(registered.annotations, tool.annotations, "real-mcp-annotations");
    }
    check = "native-and-evaluated-nested";
    const nestedCode = `// @options: {"timeout_ms":5000}\nconst input = { key: ["computed", 6 * 7].join("-"), payload: { text: "evaluated fixture " + String.fromCharCode(9731), enabled: false, extra: null } };\nconst read = await tools.mcp__sdk_fixture__read(input);\nconst error = await tools.mcp__sdk_fixture__error(input);\nlet blocked = false;\ntry { await tools.mcp__sdk_fixture__remove(input); } catch { blocked = true; }\nif (read.isError || !error.isError || !blocked) throw Error("fixture nested outcome mismatch");\nstore("fixture", { complete: true });\nreturn { read: 1, error: 1, blocked: 1 };`;
    await prompt([
      call("shell-error", "bash", { command: "printf fixture; exit 2", timeout: 5 }),
      call("file-success", "write", { path: "fixture.txt", content: "synthetic fixture\n" }),
      call("file-error", "edit", { path: "absent.txt", oldText: "synthetic", newText: "fixture" }),
      call("direct-read", "mcp__sdk_fixture__read", input), call("direct-error", "mcp__sdk_fixture__error", input),
      call("nested-parent", "codemode", { code: nestedCode }),
      call("custom-denial", "fixture_custom", { key: "synthetic" }),
      call("direct-mutation", "mcp__sdk_fixture__remove", input),
    ]);
    assert.deepEqual(snapshot().totals, { files: 1, sh: 1, mcp: 4, blocked: 3 }, "ordinary-exact-counts");
    assert.equal(readFileSync(join(cwd, "fixture.txt"), "utf8"), "synthetic fixture\n", "native-write-really-happened");
    assert.equal(history("shell-error").status, "error", "executed-shell-error-counts");
    assert.equal(rawEvents.find((event) => event.type === "result" && event.id === "shell-error")?.exit, 2, "native-shell-exited-two");
    assert.equal(history("file-error").counted, false, "failed-file-not-counted");
    assert.equal(history("nested-parent").category, "wrapper", "wrapper-not-mcp");
    assert.equal(history("nested-parent").status, "ok", "quickjs-evaluated-successfully");
    assert.equal(history("nested-parent").counted, false, "wrapper-not-execution-count");
    assert.equal(history("custom-denial").status, "blocked", "custom-final-block");
    assert.equal(customExecutions, 0, "blocked-custom-backend-zero");
    assert.deepEqual(mcpCounts(), { initialized: 1, listed: 1, read: 2, error: 2, remove: 0, evaluated: 4 }, "actual-mcp-transport-counts");
    const nested = snapshot().history.filter((row) => row.nested && row.category === "mcp");
    assert.equal(nested.length, 3, "three-real-nested-calls");
    assert.equal(rawEvents.filter((event) => event.type === "start" && event.parent === "nested-parent").length, 3, "real-parent-call-id");
    assert.equal(rawEvents.filter((event) => event.type === "result" && event.parent === "nested-parent").length, 2, "blocked-nested-call-has-no-result-hook");
    assert.equal(nested.filter((row) => row.status === "blocked").length, 1, "nested-mutation-final-block");
    assert.equal(nested.filter((row) => row.status === "error").length, 1, "nested-mcp-error-counts");
    const ordinaryErrors = snapshot().telemetry.activity.errorsByCategory;
    assert.equal(ordinaryErrors.sh, 1, "shell-one-error");
    assert.equal(ordinaryErrors.files, 1, "file-one-error");
    assert.equal(ordinaryErrors.mcp, 2, "direct-and-nested-mcp-errors");
    assert.equal(reviews, 8, "wrapper-and-native-files-not-reviewed");
    assert.equal(evaluatedReviews, 6, "full-direct-and-nested-review-inputs");
    const baseline = snapshot();
    const baselineLeaf = manager.getLeafId();

    check = "guard-review-and-native-consistency";
    await command("read-only", "on");
    const beforeHard = reviews;
    await prompt([
      call("guard-shell", "bash", { command: "printf fixture; exit 2", timeout: 5 }),
      call("guard-file", "write", { path: "blocked.txt", content: "synthetic" }),
      call("guard-delegation", "subagent", { key: "synthetic" }),
      call("guard-custom", "fixture_custom", { key: "synthetic" }),
      call("guard-parent", "codemode", { code: '// @options: {"timeout_ms":5000}\nlet blocked = false; try { await tools.write({path: "nested-blocked.txt", content: "synthetic"}); } catch { blocked = true; } if (!blocked) throw Error("fixture guard missing"); return {blocked: 1};' }),
    ]);
    assert.equal(reviews - beforeHard, 5, "native-conflicts-shell-subagent-and-custom-all-reviewed");
    assert.deepEqual(snapshot().totals, { files: 1, sh: 2, mcp: 4, blocked: 7 }, "read-only-exact-counts");
    assert.ok(!existsSync(join(cwd, "blocked.txt")) && !existsSync(join(cwd, "nested-blocked.txt")), "hard-block-no-write");
    assert.equal(history("guard-shell").executionConfirmed, true, "review-allowed-shell-executes-under-guard");
    assert.equal(history("guard-delegation").status, "blocked", "trusted-subagent-review-denial-blocks");
    const guardedLeaf = manager.getLeafId();
    await command("read-only", "off");
    await command("remote-read-only", "on");
    const beforeRemote = reviews;
    await prompt([call("remote-shell", "bash", { command: "printf fixture; exit 2", timeout: 5 }),
      call("remote-delegation", "subagent", { key: "synthetic" }),
      call("remote-unavailable", "bash", { command: "printf fixture-unavailable", timeout: 5 })]);
    assert.equal(reviews - beforeRemote, 3, "remote-guard-reviews-shell-and-trusted-subagent");
    assert.equal(history("remote-shell").executionConfirmed, true, "remote-guard-review-allow-executes");
    assert.equal(history("remote-unavailable").executionConfirmed, false, "unavailable-guard-review-never-executes");
    assert.equal(snapshot().totals.blocked, 9, "remote-review-final-block-count");
    configuredJudge = null; configure();
    const beforeMissing = reviews;
    await prompt([call("unconfigured-custom", "fixture_custom", { key: "synthetic" }),
      call("unconfigured-shell", "bash", { command: "printf fixture", timeout: 5 }),
      call("unconfigured-delegation", "subagent", { key: "synthetic" })]);
    assert.equal(reviews, beforeMissing, "missing-judge-no-review-fallback");
    assert.equal(snapshot().totals.blocked, 12, "missing-judge-under-guard-final-block-count");
    await command("remote-read-only", "off");
    configuredJudge = "sdk-fixture/review"; configure();

    check = "cancelled-admission";
    await prompt([call("cancelled-admission", "bash", { command: "printf fixture; exit 2", timeout: 5 })]);
    await cancellation;
    assert.equal(admissions, 1, "cancel-after-activity-admission");
    assert.equal(history("cancelled-admission").verdict, "allow", "admitted-not-gate-blocked");
    assert.equal(history("cancelled-admission").executionConfirmed, false, "cancelled-admission-not-executed");
    assert.equal(rawEvents.filter((event) => event.id === "cancelled-admission" && event.type === "result").length, 0, "no-cancelled-result-hook");
    assert.deepEqual(snapshot().totals, { files: 1, sh: 3, mcp: 4, blocked: 12 }, "cancellation-not-execution-or-final-gate-block");
    await prompt(); // Sixth real user turn makes the five-message summary batch eligible.
    const final = snapshot();
    assert.equal(final.telemetry.approvals.prompts, 0, "print-mode-and-guards-never-offer-manual-override");
    assert.equal(final.telemetry.activity.errorsByCategory.sh, 4,
      "reported-shell-errors-include-unavailable-review");
    assert.ok(manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant")
      .every((entry) => entry.message.provider === "sdk-fixture" && entry.message.model === "main"), "assistant-messages-name-physical-generator");
    const finalLeaf = manager.getLeafId();

    check = "real-registry-review-and-summary";
    const ctx = session.extensionRunner.createContext();
    const observed = [];
    const verdict = await judgeSafety(ctx, "sdk-router/review", "fixture_custom", { key: "synthetic" }, cwd,
      { auto: true, readOnly: false, remoteReadOnly: false }, new AbortController().signal,
      undefined, undefined, undefined, undefined, undefined, "sdk-fixture/summary", undefined,
      { judgeThinking: "off", summaryThinking: "off", persistSummary: (type, data) => manager.appendCustomEntry(type, data), onModelCall: (event) => observed.push(event) });
    assert.equal(verdict.allow, true, "production-judge-through-real-registry");
    assert.equal(verdict.metrics.provider, "sdk-fixture", "physical-review-attribution");
    assert.equal(verdict.metrics.model, "review", "virtual-selection-not-generator");
    assert.equal(verdict.metrics.providerRequests, 1, "synthetic-review-request-observed-once");
    assert.equal(verdict.metrics.summary.status, "generated", "real-summary-stream-generated");
    assert.equal(summaryStreams, 1, "one-synthetic-summary-stream");
    assert.equal(judgeStreams, 1, "one-synthetic-judge-stream");
    const cache = new RollingUserSummary();
    assert.equal(cache.restore(ctx), 1, "completed-summary-persisted");
    const beforeCached = fakeStreams;
    assert.equal((await cache.prepare(ctx, "unregistered/model", new AbortController().signal)).metrics.status, "cached", "summary-reusable-without-model-resolution");
    assert.equal(fakeStreams, beforeCached, "cached-summary-zero-dispatch");
    routingFails = true;
    const failed = await judgeSafety(ctx, "sdk-router/review", "fixture_custom", { key: "synthetic" }, cwd,
      { auto: true, readOnly: false, remoteReadOnly: false }, new AbortController().signal,
      undefined, undefined, undefined, undefined, undefined, "sdk-fixture/summary", undefined, { judgeThinking: "off" });
    routingFails = false;
    assert.equal(failed.ok, false, "real-router-failure-closed");
    assert.equal(failed.metrics.providerRequests, 0, "route-failure-zero-request");
    assert.equal(fakeStreams, beforeCached, "route-failure-zero-provider-stream");

    check = "reload-and-jsonl-reopen";
    await session.reload(); // Real shutdown/reload/start, onError binding enables automatic start.
    await prompt(); // Force restored in-memory observations to create a NEW checkpoint.
    assert.equal(extensionErrors, 0, "no-extension-runtime-errors");
    assert.deepEqual(snapshot().totals, final.totals, "reload-preserves-exact-totals");
    assert.deepEqual(snapshot().history, final.history, "reload-preserves-bounded-history");
    assert.equal(snapshot().telemetry.summaries.restored, 1, "real-reload-summary-restoration");
    const file = session.sessionFile;
    assert.ok(file && existsSync(file), "real-session-jsonl-created");
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    unsubscribe(); session.dispose(); session = undefined;
    const reopened = SessionManager.open(file);
    assert.ok(reopened.getBranch().some((entry) => entry.type === "custom" && entry.customType === SUMMARY_ENTRY_TYPE), "summary-jsonl-roundtrip");
    await resourceLoader.reload();
    await open(reopened); // Restore the virtual selection from the real model_change entry.
    assert.equal(session.model.provider, "sdk-router", "virtual-selection-restored");
    assert.equal(session.model.id, "main", "virtual-model-id-restored");
    await prompt(); // Do not merely compare the old snapshot already present on disk.
    assert.deepEqual(snapshot().totals, final.totals, "reopen-preserves-totals");
    assert.deepEqual(snapshot().history, final.history, "reopen-preserves-bounded-history");
    const restoredCache = new RollingUserSummary();
    assert.equal(restoredCache.restore(session.extensionRunner.createContext()), 1, "summary-reopened-on-active-branch");
    assert.equal(snapshot().telemetry.summaries.restored, 2, "real-rebind-summary-restoration");

    check = "active-branch-restoration";
    await session.navigateTree(guardedLeaf, { summarize: false });
    expectedGuards.readOnly = true;
    const beforeRestoredGuard = reviews;
    await prompt([call("restored-guard-file", "write", { path: "restored-blocked.txt", content: "synthetic" })]);
    assert.deepEqual(snapshot().totals, { files: 1, sh: 2, mcp: 4, blocked: 8 }, "branch-restores-authoritative-read-only-mode");
    assert.equal(reviews, beforeRestoredGuard + 1, "restored-native-conflict-reviewed-without-execution");
    assert.ok(!existsSync(join(cwd, "restored-blocked.txt")), "restored-mode-prevents-native-write");
    await session.navigateTree(baselineLeaf, { summarize: false });
    expectedGuards.readOnly = false;
    // Tree navigation restores state in memory; a fresh real turn persists it.
    await prompt([call("branch-file", "write", { path: "branch.txt", content: "synthetic branch" })]);
    assert.deepEqual(snapshot().totals, { ...baseline.totals, files: 2 }, "abandoned-branch-does-not-pollute-totals");
    assert.ok(!snapshot().history.some((row) => row.id === "guard-shell" || row.id === "cancelled-admission"), "history-is-active-branch-only");
    assert.equal(restoredCache.restore(session.extensionRunner.createContext()), 0, "abandoned-summary-not-restored");
    const branchLeaf = reopened.getLeafId();
    await session.navigateTree(finalLeaf, { summarize: false });
    await prompt();
    assert.deepEqual(snapshot().totals, final.totals, "return-to-original-branch-exact-totals");
    await session.navigateTree(branchLeaf, { summarize: false });
    await prompt(); // Appending persists the chosen leaf; opening JSONL selects its latest entry.
    assert.deepEqual(snapshot().totals, { ...baseline.totals, files: 2 }, "branch-return-exact-totals");
    const branchHistory = snapshot().history;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    unsubscribe(); session.dispose(); session = undefined;
    await resourceLoader.reload();
    await open(SessionManager.open(file));
    await prompt(); // Exercise restored branch state through the live SDK lifecycle.
    assert.deepEqual(snapshot().totals, { ...baseline.totals, files: 2 }, "reopened-active-branch-not-all-entries");
    assert.deepEqual(snapshot().history, branchHistory, "active-branch-history-jsonl-roundtrip");
    assert.equal(new RollingUserSummary().restore(session.extensionRunner.createContext()), 0, "reopened-abandoned-summary-absent");
    // Synthetic JSONL is inspected only here. Custom observations and summary
    // caches do not become provider/model context messages.
    assert.ok(!session.sessionManager.buildSessionContext().messages.some((message) =>
      message.customType === OBSERVATION_ENTRY_TYPE || message.customType === SUMMARY_ENTRY_TYPE), "private-custom-state-outside-model-context");
    assert.equal(wireAttempts, 0, "zero-wire-attempts");
    assert.equal(customExecutions, 0, "all-custom-and-delegation-backends-zero");
    assert.equal(extensionErrors, 0, "extension-errors-zero");
    assert.equal(payloadHooks, responseHooks, "real-provider-hook-pairs");
    assert.equal(providerEvents, payloadHooks, "real-provider-stream-hooks");
    assert.equal(starts, ends, "balanced-real-tool-events");
    assert.ok(routes > 0 && subscriptions === 3, "real-routing-and-rebinding");
    assert.equal(snapshot().telemetry.classifier.enabled, false, "default-classifier-none");
    assert.equal(Object.values(snapshot().telemetry.classifier.byInput).reduce((sum, value) => sum + value.success, 0),
      0, "no-synthetic-classifier-success-invented");
    assert.ok(resultHooks > 0, "real-result-hook-evidence");
    report = { passed: true, wireRequests: wireAttempts, fakeProviderStreams: fakeStreams, routes, reviews,
      evaluatedReviews, shellExecuted: final.totals.sh, shellErrors: final.telemetry.activity.errorsByCategory.sh,
      fileSucceeded: final.totals.files, fileErrors: ordinaryErrors.files,
      mcpExecuted: final.totals.mcp, mcpErrors: ordinaryErrors.mcp, blockedBackendsExecuted: customExecutions,
      finalBlocks: final.totals.blocked, cancelledAdmissions: admissions, cancelledExecuted: 0,
      wrapperCounted: 0, summaryStreams, judgeStreams, sessionRebinds: subscriptions,
      activeBranchFiles: snapshot().totals.files, extensionErrors };
  } catch (error) {
    const label = String(error?.message ?? "").split("\n")[0];
    const failure = error?.code === "ERR_ASSERTION" && /^[a-z0-9-]{1,100}$/.test(label)
      ? label : String(error?.code ?? error?.name ?? "unknown").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 100);
    report = { passed: false, check, failure, wireRequests: wireAttempts, fakeProviderStreams: fakeStreams, extensionErrors };
    process.exitCode = 1;
  } finally {
    try {
      if (session) {
        await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
        unsubscribe?.(); session.dispose();
      }
    } catch { report = { passed: false, check: "fixture-cleanup", wireRequests: wireAttempts }; process.exitCode = 1; }
    process.stdout.write(JSON.stringify(report) + "\n");
  }
}
