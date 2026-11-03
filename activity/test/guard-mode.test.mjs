// Offline guard UI/state fixtures. All persisted sessions are synthetic and outside Git.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import activityExtension from "../index.ts";
import { withNativeTools } from "./nine-head-fixtures.mjs";

const dir = mkdtempSync(join(tmpdir(), "activity-guard-modes-"));
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE"].map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.PI_ACTIVITY_AUTO_MODE;
mkdirSync(join(dir, "config"));
const configure = (extra = {}) => writeFileSync(join(dir, "config/activity.json"), JSON.stringify({
  acclass: { enabled: false }, log: { enabled: false }, reviewLog: { enabled: false },
  session: { persistModes: true, persistActivity: false }, ...extra,
}));
const notes = (manager) => manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "activity-mode");
const expected = (readOnly, remoteReadOnly) => ({ readOnly, remoteReadOnly });
function harness({ flags = [], manager = SessionManager.inMemory(dir), reason = "startup", mode = "tui" } = {}) {
  const handlers = {}, commands = {}, registeredFlags = {}, widgets = new Map(), states = [], notices = [];
  let active = manager;
  const pi = {
    registerFlag(name, spec) { registeredFlags[name] = spec; },
    registerCommand(name, spec) { commands[name] = spec.handler; },
    on(name, handler) { handlers[name] = handler; },
    getFlag(name) { return name === "auto" || flags.includes(name); },
    getAllTools: () => withNativeTools(),
    appendEntry(type, data) { active.appendCustomEntry(type, structuredClone(data)); },
    sendMessage(message, options) {
      assert.ok(JSON.stringify(options) === JSON.stringify({ triggerTurn: false }) ||
        JSON.stringify(options) === JSON.stringify({ deliverAs: "steer" }), "only safe context append or queued steering delivery");
      assert.equal(message.display, false, "the live banner is separate from chat-level instructions");
      active.appendCustomMessageEntry(message.customType, message.content, message.display, structuredClone(message.details));
    },
    events: { emit(name, data) { if (name === "activity:state") states.push(structuredClone(data)); } },
  };
  const ctx = { cwd: dir, mode, hasUI: mode === "tui", sessionManager: {
    getBranch: () => active.getBranch(), getSessionId: () => active.getSessionId(),
    buildContextEntries: () => active.buildContextEntries(), buildSessionProjection: () => active.buildSessionProjection(),
    getEntries() { throw new Error("never restore from abandoned branches"); },
  }, ui: {
    setWidget(key, component, options) { widgets.set(key, { component, options }); },
    setStatus() {}, notify(text) { notices.push(text); }, theme: { fg: (_color, text) => text },
  } };
  activityExtension(pi, undefined, "native");
  return { handlers, commands, ctx, states, registeredFlags, notices,
    get manager() { return active; },
    start: () => handlers.session_start({ reason }, ctx),
    close: () => handlers.session_shutdown({ reason: "quit" }, ctx),
    toggle: (name, value = "") => commands[name](value, ctx),
    async submit() {
      const prompt = { systemPrompt: "FIXED_SYNTHETIC_SYSTEM", prompt: "Synthetic request" };
      const before = structuredClone(prompt);
      assert.equal(await handlers.before_agent_start(prompt, ctx), undefined);
      assert.deepEqual(prompt, before, "guard instructions never alter prompt options or system text");
    },
    async select(manager) { active = manager; await handlers.session_tree({}, ctx); },
    banner(width = 100) {
      const widget = widgets.get("activity-guard");
      if (!widget?.component) return undefined;
      assert.equal(widget.options.placement, "aboveEditor");
      return widget.component({}, ctx.ui.theme).render(width);
    },
  };
}
function assertNote(h, guards, count) {
  const messages = notes(h.manager);
  assert.equal(messages.length, count);
  assert.deepEqual(messages.at(-1).details.guards, guards);
  assert.ok(messages.at(-1).content.length < 260, "mode instructions stay short");
  assert.doesNotMatch(messages.at(-1).content, /classifier|cache|global activity config|\/read-only off|delegation is disabled/);
}
const assistant = { role: "assistant", api: "synthetic", provider: "fixture", model: "fixture", stopReason: "stop",
  timestamp: 1, content: [{ type: "text", text: "Synthetic response" }],
  usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };

try {
  configure();
  for (const flags of [[], ["read-only"], ["remote-read-only"], ["read-only", "remote-read-only"]]) {
    const h = harness({ flags }); await h.start();
    assert.deepEqual(Object.keys(h.registeredFlags), ["read-only", "remote-read-only", "auto"]);
    assert.equal(h.registeredFlags["remote-read-only"].default, false);
    const guards = expected(flags.includes("read-only"), flags.includes("remote-read-only"));
    assert.equal(h.states.at(-1).readOnly, guards.readOnly);
    assert.equal(h.states.at(-1).guards.remoteReadOnly, guards.remoteReadOnly);
    assert.equal(notes(h.manager).length, 0, "flags show a live banner without prematurely sending instructions");
    if (flags.length) {
      assert.ok(h.banner(), "startup banner is visible before the first input");
      for (const width of [0, 1, 8, 24, 80]) for (const line of h.banner(width)) assert.ok(visibleWidth(line) <= width);
      assert.deepEqual(await h.handlers.cache_warming_decision({}, h.ctx), { action: "stop" }, "do not warm obsolete mode instructions");
      await h.submit(); assertNote(h, guards, 1);
      assert.equal(await h.handlers.cache_warming_decision({}, h.ctx), undefined);
      await h.submit(); assertNote(h, guards, 1);
    } else {
      assert.equal(h.banner(), undefined);
      await h.submit(); assert.equal(notes(h.manager).length, 0);
    }
    await h.close(); assert.equal(h.banner(), undefined, "shutdown clears only its own guard widget");
  }

  const h = harness(); await h.start();
  await h.toggle("read-only"); assert.match(h.banner().join(" "), /^Read-only: local and remote changes are blocked\./);
  await h.toggle("remote-read-only"); assert.match(h.banner().join(" "), /^Read-only \+ remote-read-only:/);
  await h.toggle("read-only"); assert.match(h.banner().join(" "), /^Remote-read-only:/);
  assert.equal(notes(h.manager).length, 0, "all unsubmitted toggles coalesce");
  await h.submit(); assertNote(h, expected(false, true), 1);
  const sent = structuredClone(notes(h.manager));
  await h.toggle("read-only"); await h.toggle("read-only");
  await h.submit(); assert.deepEqual(notes(h.manager), sent, "returning to the last sent mode appends nothing");
  await h.toggle("remote-read-only"); assert.equal(h.banner(), undefined);
  await h.submit(); assertNote(h, expected(false, false), 2);
  assert.deepEqual(notes(h.manager).slice(0, sent.length), sent, "sent prefix is never rewritten or removed");
  await h.close();

  for (const flags of [[], ["read-only"], ["remote-read-only"], ["read-only", "remote-read-only"]]) {
    const h = harness({ flags }); await h.start();
    if (!flags.length) await h.toggle("read-only");
    for (const name of flags.length ? flags : ["read-only"]) await h.toggle(name);
    assert.equal(h.banner(), undefined);
    await h.submit(); assert.equal(notes(h.manager).length, 0, "OFF before first submission leaves no guard instruction");
    await h.close();
  }

  // A real process restart preserves both pending state and sent instructions.
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendMessage({ role: "user", content: "Synthetic persisted session", timestamp: 1 });
  manager.appendMessage(structuredClone(assistant));
  const original = harness({ manager }); await original.start();
  await original.toggle("read-only"); await original.toggle("remote-read-only");
  const path = manager.getSessionFile(); await original.close();
  const resumed = harness({ manager: SessionManager.open(path) }); await resumed.start();
  assert.match(resumed.banner().join(" "), /Read-only \+ remote-read-only/);
  assert.equal(notes(resumed.manager).length, 0);
  await resumed.submit(); assertNote(resumed, expected(true, true), 1);
  const guardedLeaf = resumed.manager.getLeafId();
  await resumed.close();
  const restarted = harness({ manager: SessionManager.open(path) }); await restarted.start();
  await restarted.submit(); assertNote(restarted, expected(true, true), 1);
  await restarted.toggle("read-only", "off"); await restarted.toggle("remote-read-only", "off");
  await restarted.submit(); assertNote(restarted, expected(false, false), 2);
  const offLeaf = restarted.manager.getLeafId();
  restarted.manager.branch(guardedLeaf); await restarted.handlers.session_tree({}, restarted.ctx);
  assert.match(restarted.banner().join(" "), /Read-only \+ remote-read-only/);
  await restarted.submit(); assertNote(restarted, expected(true, true), 1);
  restarted.manager.branch(offLeaf); await restarted.handlers.session_tree({}, restarted.ctx);
  assert.equal(restarted.banner(), undefined); await restarted.submit(); assertNote(restarted, expected(false, false), 2);
  await restarted.close();

  // Retained context, not obsolete notification metadata, decides reannouncement.
  const compacted = harness({ flags: ["read-only"] }); await compacted.start(); await compacted.submit();
  const oldInstruction = notes(compacted.manager)[0];
  const kept = compacted.manager.appendMessage({ role: "user", content: "Kept synthetic context", timestamp: 2 });
  compacted.manager.appendCompaction("Synthetic summary", kept, 100);
  await compacted.handlers.session_compact({}, compacted.ctx);
  await compacted.submit(); assertNote(compacted, expected(true, false), 2);
  const latest = notes(compacted.manager).at(-1);
  compacted.manager.appendContextEdit(latest.id, null);
  await compacted.handlers.session_tree({}, compacted.ctx);
  await compacted.submit(); assertNote(compacted, expected(true, false), 3);
  assert.deepEqual(notes(compacted.manager)[0], oldInstruction);
  await compacted.close();

  const legacyManager = SessionManager.inMemory(dir);
  legacyManager.appendCustomEntry("activity-state", { readOnly: true, auto: true, readOnlyNotified: true });
  legacyManager.appendCustomMessageEntry("activity-mode", "Read-only mode is on. Only reads are allowed, including remote reads; no local or remote mutation.", true);
  const legacy = harness({ manager: legacyManager }); await legacy.start();
  assert.match(legacy.banner().join(" "), /^Read-only:/);
  await legacy.submit(); assert.equal(notes(legacy.manager).length, 1, "legacy sent read-only notes do not duplicate on resume");
  await legacy.toggle("remote-read-only"); await legacy.submit(); assertNote(legacy, expected(true, true), 2);
  await legacy.close();

  configure({ guards: expected(true, true) });
  const floors = harness(); await floors.start();
  await floors.toggle("read-only", "off"); await floors.toggle("remote-read-only", "off");
  assert.match(floors.banner().join(" "), /Read-only \+ remote-read-only/);
  await floors.submit(); assertNote(floors, expected(true, true), 1);
  assert.equal((await floors.handlers.tool_call({ toolName: "write", toolCallId: "synthetic-violation", input: { path: "never-written.txt", content: "synthetic" } }, floors.ctx)).block, true);
  await floors.close();
  console.log("guard mode tests passed: immediate live banner, coalesced append-only instructions, flags, real restart, branch restore, compaction and global floors");
} finally {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(dir, { recursive: true, force: true });
}
