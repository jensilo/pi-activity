// Real installed SDK requests, entirely synthetic and offline. Prefix equality
// checks cache eligibility preservation, not provider cache hits.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSessionRuntime, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import activityExtension from "../index.ts";

const dir = mkdtempSync(join(tmpdir(), "activity-guard-sdk-"));
const envKeys = ["HOME", "PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE", "PI_SUBAGENT_TASK"];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.HOME = join(dir, "home");
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.PI_ACTIVITY_AUTO_MODE;
delete process.env.PI_SUBAGENT_TASK;
mkdirSync(process.env.HOME);
mkdirSync(join(dir, "config"));
const provider = "guard-sdk-fixture";
const model = { provider, id: "main", name: "Synthetic guard fixture", api: "synthetic-guard-sdk", baseUrl: "",
  reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
writeFileSync(join(dir, "config/activity.json"), JSON.stringify({
  acclass: { enabled: false }, auto: { judgeModel: `${provider}/judge` },
  session: { persistModes: true, persistActivity: false }, log: { enabled: false }, reviewLog: { enabled: false },
}));
const sessions = new Set();
const failures = [];
const modeEntries = (manager) => manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "activity-mode");
const text = (message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n");
const notes = (request) => request.messages.filter((message) => text(message).startsWith("Current guards:"));
function assertMode(request, readOnly, remoteReadOnly, count) {
  const messages = notes(request);
  assert.equal(messages.length, count, "only submitted mode transitions append instructions");
  const latest = messages.at(-1);
  assert.equal(latest.role, "user", "custom guard instructions reach the main request at user level");
  assert.ok(text(latest).includes(`Current guards: read-only ${readOnly ? "ON" : "OFF"}; remote-read-only ${remoteReadOnly ? "ON" : "OFF"}.`));
  assert.ok(text(latest).includes(readOnly
    ? "Do not mutate local or remote state. Non-mutating bash and delegated work are allowed."
    : remoteReadOnly
      ? "Do not mutate remote state. Local changes and compliant delegated work may be allowed."
      : "Earlier read-only restrictions no longer apply."), "the actual main request contains the current guard rule");
}
function assertPrefix(previous, next) {
  assert.equal(next.systemPrompt, previous.systemPrompt, "guard changes must not edit the system prompt");
  assert.deepEqual(next.messages.slice(0, previous.messages.length), previous.messages,
    "every previously sent message remains byte-for-byte structurally identical and in order");
}
async function fixture({ flags = [], manager = SessionManager.inMemory(dir), sessionStartEvent } = {}) {
  const requests = [], reviews = [], executions = [], banners = [], states = [], errors = [];
  let nextCalls = [], nextHold, compactionOverride, continueOnce = false;
  const compactions = [];
  const runtime = await ModelRuntime.create({ credentials: {
    read: async () => undefined, list: async () => [],
    modify: async () => assert.fail("no credential writes"), delete: async () => assert.fail("no credential deletes"),
  }, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider({ id: provider, name: "Offline synthetic guard provider",
    auth: { apiKey: { name: "Keyless fixture", resolve: async () => ({ auth: {}, source: "synthetic" }) } },
    getModels: () => [model], stream: () => assert.fail("no API-specific or external streaming"),
    streamSimple(activeModel, context, options) {
      assert.equal(activeModel.provider, provider);
      assert.equal(activeModel.id, "main", "judge is injected and never dispatched to a provider");
      assert.equal(options.apiKey, undefined);
      requests.push(structuredClone(context));
      const calls = nextCalls;
      nextCalls = [];
      const hold = nextHold;
      nextHold = undefined;
      const stream = createAssistantMessageEventStream();
      hold?.captured.resolve(requests.at(-1));
      queueMicrotask(async () => {
        if (hold) await hold.released.promise;
        const message = { role: "assistant", api: model.api, provider, model: model.id,
          content: calls.length ? calls : [{ type: "text", text: "Synthetic response." }],
          usage: structuredClone(usage), stopReason: calls.length ? "toolUse" : "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
      });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      activityExtension(pi, async (...args) => {
        reviews.push(args);
        return { ok: true, allow: true, reason: "Synthetic non-mutating bash allowed." };
      });
      pi.events.on("activity:state", (state) => states.push(structuredClone(state)));
      // Registered after Activity so it cannot rely on continuation being known earlier.
      pi.on("turn_end", () => {
        if (!continueOnce) return;
        continueOnce = false;
        return { continue: true, entries: [{ type: "custom_message", customType: "synthetic-continuation",
          content: "Synthetic explicit continuation context.", display: false }] };
      });
      pi.on("session_before_compact", (event) => {
        assert.ok(compactionOverride, "summary generation must never reach a provider");
        const result = compactionOverride(event);
        compactions.push({ reason: event.reason, streaming: session.isStreaming, result: structuredClone(result) });
        compactionOverride = undefined;
        settingsManager.setCompactionEnabled(false);
        return { compaction: result };
      });
      pi.registerTool({ name: "bash", label: "Synthetic bash", description: "Inert bash fixture; never spawns a process",
        parameters: Type.Object({ command: Type.String() }), async execute(_id, input) {
          executions.push(structuredClone(input));
          return { content: [{ type: "text", text: "Synthetic bash result." }], details: { exitCode: 0 } };
        } });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader,
    settingsManager, sessionManager: manager, modelRuntime: runtime, model, thinkingLevel: "off", noTools: "builtin", sessionStartEvent });
  sessions.add(session);
  for (const flag of flags) session.extensionRunner.setFlagValue(flag, true);
  await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error), uiContext: {
    setWidget(key, component) {
      if (key === "activity-guard") banners.push(component ? component({}, { fg: (_color, value) => value }).render(160).join("\n") : undefined);
    }, setStatus() {}, notify() {},
  } });
  return { session, manager, requests, reviews, executions, banners, states, compactions,
    hold(calls = []) {
      assert.equal(nextHold, undefined);
      nextCalls = calls;
      const captured = deferred(), released = deferred();
      nextHold = { captured, released };
      return { captured: captured.promise, release: released.resolve };
    },
    continueAfterTurn() { continueOnce = true; },
    compactBetweenTurns(override) {
      compactionOverride = override;
      settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 127_999, keepRecentTokens: 1 } });
    },
    assertNoErrors() { assert.deepEqual(errors, [], "SDK extension events must not silently fail"); },
    async command(name, value) {
      const command = session.extensionRunner.getCommand(name);
      assert.ok(command);
      await command.handler(value, session.extensionRunner.createCommandContext());
    },
    async prompt(calls = []) {
      nextCalls = calls;
      await session.prompt("Synthetic guard submission.");
      await session.waitForIdle();
      assert.deepEqual(errors, [], "SDK extension events must not silently fail");
      return requests.at(-1);
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function capturedRequest(hold) {
  let timer;
  try {
    return await Promise.race([hold.captured, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("synthetic provider request was not captured")), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function close(session) {
  await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  sessions.delete(session);
}
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, error }); console.error(`FAIL ${name}: ${error.stack}`); }
}
try {
  await check("append-only on -> both -> remote-only -> off main requests", async () => {
    const f = await fixture();
    const baseline = await f.prompt();
    assert.equal(notes(baseline).length, 0);
    const transitions = [
      ["read-only", "on", true, false], ["remote-read-only", "on", true, true],
      ["read-only", "off", false, true], ["remote-read-only", "off", false, false],
    ];
    let previous = baseline;
    for (const [name, value, readOnly, remoteReadOnly] of transitions) {
      const sent = structuredClone(modeEntries(f.manager));
      await f.command(name, value);
      assert.deepEqual(modeEntries(f.manager), sent, "pending toggles do not rewrite or append sent messages");
      const request = await f.prompt();
      assertPrefix(previous, request);
      assertMode(request, readOnly, remoteReadOnly, sent.length + 1);
      assert.deepEqual(modeEntries(f.manager).slice(0, sent.length), sent);
      const entry = modeEntries(f.manager).at(-1);
      assert.equal(entry.display, false);
      assert.deepEqual(entry.details.guards, { readOnly, remoteReadOnly });
      assert.equal(text(notes(request).at(-1)), entry.content, "custom persisted instruction is actually sent");
      previous = request;
    }
    assert.match(text(notes(previous).at(-1)), /Earlier read-only restrictions no longer apply/);
    await close(f.session);
  });
  await check("pending ON/OFF coalesces without guard notes", async () => {
    const f = await fixture();
    for (const name of ["read-only", "remote-read-only"]) {
      await f.command(name, "on"); await f.command(name, "off");
    }
    assert.equal(modeEntries(f.manager).length, 0);
    assert.equal(notes(await f.prompt()).length, 0);
    assert.equal(modeEntries(f.manager).length, 0);
    await close(f.session);
  });
  for (const flags of [["read-only"], ["remote-read-only"], ["read-only", "remote-read-only"]]) {
    await check(`initial flags and real /reload after user OFF: ${flags.join(",")}`, async () => {
      const f = await fixture({ flags });
      const first = await f.prompt();
      assertMode(first, flags.includes("read-only"), flags.includes("remote-read-only"), 1);
      assert.ok(f.banners.at(-1), "initial guard displays a banner");
      for (const name of flags) await f.command(name, "off");
      const off = await f.prompt();
      assertMode(off, false, false, 2);
      assertPrefix(first, off);
      await f.session.reload();
      assert.equal(f.states.at(-1).readOnly, false, "reload must not reapply read-only CLI flag");
      assert.equal(f.states.at(-1).guards.remoteReadOnly, false, "reload must not reapply remote CLI flag");
      assert.equal(f.banners.at(-1), undefined);
      const reloaded = await f.prompt();
      assertPrefix(off, reloaded);
      assertMode(reloaded, false, false, 2);
      await close(f.session);
    });
  }
  await check("persisted resume restores banner and sent modes without duplicates", async () => {
    const manager = SessionManager.create(dir, join(dir, "sessions"));
    const f = await fixture({ manager });
    await f.command("remote-read-only", "on");
    const sent = await f.prompt();
    assertMode(sent, false, true, 1);
    const entries = structuredClone(modeEntries(manager));
    const path = manager.getSessionFile();
    assert.ok(path);
    await close(f.session);
    const resumed = await fixture({ manager: SessionManager.open(path, join(dir, "sessions")) });
    assert.match(resumed.banners.at(-1), /Remote-read-only: remote changes are blocked/);
    assert.equal(resumed.states.at(-1).guards.remoteReadOnly, true);
    const unchanged = await resumed.prompt();
    assertMode(unchanged, false, true, 1);
    assertPrefix(sent, unchanged);
    assert.deepEqual(modeEntries(resumed.manager), entries);
    await resumed.command("read-only", "on");
    const changed = await resumed.prompt();
    assertMode(changed, true, true, 2);
    assertPrefix(unchanged, changed);
    assert.deepEqual(modeEntries(resumed.manager).slice(0, entries.length), entries);
    await close(resumed.session);
  });
  await check("classifier unavailable still sends guards and judge allows inert bash", async () => {
    const f = await fixture({ flags: ["read-only", "remote-read-only"] });
    const input = { command: "printf synthetic-guard-fixture" };
    await f.prompt([{ type: "toolCall", id: "synthetic-bash", name: "bash", arguments: input }]);
    assert.equal(f.requests.length, 2, "tool turn and continuation both reach the registered synthetic provider");
    for (const request of f.requests) assertMode(request, true, true, 1);
    assertPrefix(f.requests[0], f.requests[1]);
    assert.equal(f.reviews.length, 1, "unavailable classifier routes bash to the injected judge");
    assert.equal(f.reviews[0][2], "bash");
    assert.deepEqual(f.reviews[0][3], input);
    assert.deepEqual(f.reviews[0][5], { auto: true, readOnly: true, remoteReadOnly: true });
    assert.deepEqual(f.executions, [input], "judge allow executes only the inert registered bash backend");
    assert.ok(f.requests[1].messages.some((message) => message.role === "toolResult" && !message.isError && text(message).includes("Synthetic bash result.")));
    await close(f.session);
  });
  for (const behavior of ["steer", "followUp"]) {
    for (const submission of ["prompt", "direct"]) {
      await check(`streaming ${behavior} via ${submission} flushes current guards once`, async () => {
        const f = await fixture();
        await f.command("read-only", "on");
        const baseline = await f.prompt();
        const persisted = structuredClone(modeEntries(f.manager));
        const hold = f.hold();
        const running = f.session.prompt("Synthetic held streaming turn.");
        try {
          const captured = await capturedRequest(hold);
          assert.equal(f.session.isStreaming, true);
          assertMode(captured, true, false, 1);
          assertPrefix(baseline, captured);
          await f.command("read-only", "off");
          await f.command("remote-read-only", "on");
          assert.deepEqual(modeEntries(f.manager), persisted, "streaming toggles stay pending until submission boundary");
          const queued = `Synthetic queued ${behavior} via ${submission}.`;
          if (submission === "prompt") await f.session.prompt(queued, { streamingBehavior: behavior });
          else await f.session[behavior](queued);
          assert.equal(f.requests.length, 2, "queued input cannot start a request before stream release");
          hold.release();
          await running;
          await f.session.waitForIdle();
          f.assertNoErrors();
          assert.equal(f.requests.length, 3, "one queued input causes exactly one continuation request");
          const next = f.requests[2];
          assertMode(next, false, true, 2);
          assertPrefix(captured, next);
          assert.equal(next.messages.filter((message) => text(message) === queued).length, 1);
          assert.equal(modeEntries(f.manager).length, 2);
          assert.deepEqual(modeEntries(f.manager).slice(0, 1), persisted);
          assert.equal(text(notes(next).at(-1)), modeEntries(f.manager).at(-1).content);
          const sent = structuredClone(modeEntries(f.manager));
          const later = await f.prompt();
          assertPrefix(next, later);
          assertMode(later, false, true, 2);
          assert.deepEqual(modeEntries(f.manager), sent, "later requests do not repeat the streaming guard instruction");
        } finally { hold.release(); await running; await close(f.session); }
      });
    }
    await check(`streaming ${behavior} coalesces toggles back to original before queued input`, async () => {
      const f = await fixture({ flags: ["read-only"] });
      const baseline = await f.prompt();
      const persisted = structuredClone(modeEntries(f.manager));
      const hold = f.hold();
      const running = f.session.prompt("Synthetic held coalescing turn.");
      try {
        const captured = await capturedRequest(hold);
        assert.equal(f.session.isStreaming, true);
        await f.command("read-only", "off");
        await f.command("remote-read-only", "on");
        await f.command("read-only", "on");
        await f.command("remote-read-only", "off");
        await f.session.prompt(`Synthetic coalesced ${behavior} input.`, { streamingBehavior: behavior });
        hold.release();
        await running;
        await f.session.waitForIdle();
        f.assertNoErrors();
        assert.equal(f.requests.length, 3);
        assertPrefix(baseline, captured);
        assertPrefix(captured, f.requests[2]);
        assertMode(f.requests[2], true, false, 1);
        assert.deepEqual(modeEntries(f.manager), persisted, "net-zero pending changes append no instruction");
        const later = await f.prompt();
        assertPrefix(f.requests[2], later);
        assertMode(later, true, false, 1);
        assert.deepEqual(modeEntries(f.manager), persisted);
      } finally { hold.release(); await running; await close(f.session); }
    });
  }
  for (const flags of [["read-only"], ["remote-read-only"], ["read-only", "remote-read-only"], []]) {
    await check(`/new preserves unflushed guards with fresh extension factory: ${flags.join(",") || "commands"}`, async () => {
      const manager = SessionManager.create(dir, join(dir, "unflushed-sessions"));
      const first = await fixture({ flags, manager });
      if (!flags.length) {
        await first.command("read-only", "on"); await first.command("remote-read-only", "on");
      }
      assert.equal(first.requests.length, 0);
      assert.equal(existsSync(manager.getSessionFile()), false, "Pi has not flushed this empty session");
      let current = first;
      const services = { cwd: dir, agentDir: dir };
      const runtime = new AgentSessionRuntime(first.session, services, async ({ sessionManager, sessionStartEvent }) => {
        current = await fixture({ flags, manager: sessionManager, sessionStartEvent });
        return { session: current.session, services };
      });
      await runtime.newSession(); sessions.delete(first.session);
      const readOnly = !flags.length || flags.includes("read-only");
      const remoteReadOnly = !flags.length || flags.includes("remote-read-only");
      assert.equal(current.states.at(-1).readOnly, readOnly);
      assert.equal(current.states.at(-1).guards.remoteReadOnly, remoteReadOnly);
      assert.ok(current.banners.at(-1));
      assertMode(await current.prompt(), readOnly, remoteReadOnly, 1);
      await close(current.session);
    });
  }
  await check("later turn_end extension continuation sees current guard instruction", async () => {
    const f = await fixture({ flags: ["read-only"] });
    await f.prompt();
    const hold = f.hold();
    const running = f.session.prompt("Synthetic held explicit-continuation turn.");
    try {
      const captured = await capturedRequest(hold);
      await f.command("read-only", "off");
      await f.command("remote-read-only", "on");
      f.continueAfterTurn();
      hold.release(); await running; await f.session.waitForIdle();
      f.assertNoErrors();
      assert.equal(f.requests.length, 3);
      assertPrefix(captured, f.requests[2]);
      assertMode(f.requests[2], false, true, 2);
      assert.equal(modeEntries(f.manager).length, 2);
      assert.ok(f.requests[2].messages.some((message) => text(message) === "Synthetic explicit continuation context."));
    } finally { hold.release(); await running; await close(f.session); }
  });
  await check("between-turn compaction restores omitted guard note during continuing tool turn", async () => {
    const f = await fixture({ flags: ["read-only", "remote-read-only"] });
    const baseline = await f.prompt();
    const persisted = structuredClone(modeEntries(f.manager));
    const heldInput = "Synthetic retained compaction context.";
    const call = { type: "toolCall", id: "synthetic-compaction-bash", name: "bash",
      arguments: { command: "printf synthetic-compaction-fixture" } };
    const hold = f.hold([call]);
    const running = f.session.prompt(heldInput);
    try {
      const captured = await capturedRequest(hold);
      assert.equal(f.session.isStreaming, true);
      assertPrefix(baseline, captured);
      const retained = f.manager.getBranch().find((entry) => entry.type === "message" && text(entry.message) === heldInput);
      assert.ok(retained, "retained input is persisted before provider streaming");
      assert.ok(f.manager.getBranch().findIndex((entry) => entry.id === retained.id) >
        f.manager.getBranch().findIndex((entry) => entry.id === persisted[0].id));
      const summary = "Synthetic compaction summary without guard instructions.";
      f.compactBetweenTurns((event) => {
        assert.equal(event.reason, "threshold");
        assert.equal(event.willRetry, false);
        assert.ok(event.branchEntries.some((entry) => entry.type === "message" && entry.message.role === "toolResult"));
        return { summary, firstKeptEntryId: retained.id, tokensBefore: 1000 };
      });
      hold.release();
      await running;
      await f.session.waitForIdle();
      f.assertNoErrors();
      assert.equal(f.compactions.length, 1, "the SDK compacts between tool completion and continuation");
      assert.equal(f.compactions[0].streaming, true, "compaction restores the note while the same agent run is streaming");
      assert.equal(f.requests.length, 3, "custom compaction never sends a summary-provider request or extra guard-only turn");
      assert.deepEqual(f.executions, [call.arguments], "only the inert fixture tool executes");
      const next = f.requests[2];
      assert.equal(next.systemPrompt, captured.systemPrompt);
      assertMode(next, true, true, 1);
      assert.ok(next.messages.some((message) => text(message).includes(summary)));
      assert.deepEqual(next.messages.filter((message) => text(message) === heldInput),
        captured.messages.filter((message) => text(message) === heldInput), "retained context remains unchanged");
      assert.ok(next.messages.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.id === call.id)));
      assert.ok(next.messages.some((message) => message.role === "toolResult" && message.toolCallId === call.id && !message.isError));
      const retainedMessages = f.manager.buildSessionProjection().entries
        .filter((entry) => entry.sourceEntry.type === "message")
        .flatMap((entry) => entry.messages)
        .filter((message) => message.role !== "assistant" || message.content.some((part) => part.type === "toolCall"));
      assert.deepEqual(next.messages.filter((message) => text(message) === heldInput ||
        message.role === "toolResult" || (message.role === "assistant" && message.content.some((part) => part.type === "toolCall"))),
      retainedMessages, "all retained user, assistant-tool-call and tool-result context reaches the provider unchanged");
      assert.equal(modeEntries(f.manager).length, 2, "omitted announcement is re-persisted exactly once");
      assert.deepEqual(modeEntries(f.manager)[0], persisted[0], "compaction does not rewrite historical note");
      const projection = f.manager.buildSessionProjection();
      assert.equal(projection.messages.filter((message) => message.role === "custom" && message.customType === "activity-mode").length, 1);
      assert.equal(text(notes(next)[0]), modeEntries(f.manager).at(-1).content);
      const sent = structuredClone(modeEntries(f.manager));
      const later = await f.prompt();
      assertPrefix(next, later);
      assertMode(later, true, true, 1);
      assert.deepEqual(modeEntries(f.manager), sent);
    } finally { hold.release(); await running; await close(f.session); }
  });
  assert.equal(failures.length, 0, `${failures.length} SDK integration case(s) failed: ${failures.map((failure) => failure.name).join("; ")}`);
  console.log("installed Pi SDK guard-mode tests passed (synthetic requests, append-only prefixes, flags/reload/resume, streaming queued input, compaction, unavailable classifier)");
} finally {
  for (const session of sessions) await close(session);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}
