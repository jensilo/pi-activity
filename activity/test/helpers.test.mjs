import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.ts";
import { carryStateFromPreviousSession } from "../carry.ts";
import { resolveModelForCall } from "../model-policy.ts";

const directory = mkdtempSync(join(tmpdir(), "ac-helpers-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
try {
  const agent = join(directory, "agent");
  const cwd = join(directory, "project");
  mkdirSync(join(agent, "config"), { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agent;
  const writeConfig = (path, value) => writeFileSync(path, JSON.stringify(value));
  const defaults = { nested: { kept: true, value: 0 }, list: [0], nullable: true };
  assert.equal(loadConfig("activity", defaults), defaults);
  writeConfig(join(agent, "config/activity.json"), { nested: { value: 1 }, list: [1, 2] });
  writeConfig(join(agent, "config/activity.local.json"), { nested: { value: 2 }, list: [3], nullable: null });
  writeConfig(join(cwd, ".pi/activity.json"), { nested: { value: 3 } });
  assert.deepEqual(loadConfig("activity", defaults), {
    nested: { kept: true, value: 1 }, list: [1, 2], nullable: true,
  });
  assert.equal(loadConfig("activity", defaults, { cwd }).nested.value, 1, "local and project files are ignored");
  assert.equal(loadConfig("activity", defaults, { cwd, projectTrusted: true }).nested.value, 1);
  assert.equal(loadConfig("activity", defaults, { cwd, projectTrusted: false }).nested.value, 1);
  assert.deepEqual(defaults, { nested: { kept: true, value: 0 }, list: [0], nullable: true });
  assert.throws(() => loadConfig("../activity", defaults), /Invalid config name/);
  writeFileSync(join(agent, "config/activity.local.json"), "{");
  assert.equal(loadConfig("activity", defaults).nested.value, 1, "invalid ignored local JSON is not read");
  writeFileSync(join(agent, "config/activity.json"), "{");
  assert.throws(() => loadConfig("activity", defaults), /Invalid extension config JSON.*activity.json/);
  writeConfig(join(agent, "config/activity.json"), {});
  console.log("ok global-only config, validation, and immutable defaults");

  const session = SessionManager.create(cwd, join(directory, "sessions"));
  session.appendMessage({ role: "user", content: "Synthetic helper test", timestamp: Date.now() });
  const stateType = "activity-state";
  const root = session.appendCustomEntry(stateType, { readOnly: true });
  session.appendCustomEntry(stateType, { readOnly: false, auto: true });
  session.branch(root);
  session.appendCustomEntry("unrelated", {});
  const event = { reason: "new", previousSessionFile: session.getSessionFile() };
  assert.deepEqual(carryStateFromPreviousSession(event, [], stateType), { readOnly: true });
  assert.equal(carryStateFromPreviousSession(event, [{ type: "custom", customType: stateType }], stateType), undefined);
  for (const reason of ["startup", "resume", "fork"]) {
    assert.equal(carryStateFromPreviousSession({ ...event, reason }, [], stateType), undefined);
  }
  assert.equal(carryStateFromPreviousSession({ reason: "new" }, [], stateType), undefined);
  assert.equal(carryStateFromPreviousSession({ ...event, previousSessionFile: join(directory, "missing.jsonl") }, [], stateType), undefined);
  assert.equal(carryStateFromPreviousSession(event, [], "absent"), undefined);
  const pendingModes = { readOnly: true, auto: false, guards: { remoteReadOnly: true } };
  assert.deepEqual(carryStateFromPreviousSession({ reason: "new" }, [], stateType, pendingModes), pendingModes);
  assert.deepEqual(carryStateFromPreviousSession({ ...event, previousSessionFile: join(directory, "not-flushed.jsonl") }, [], stateType, pendingModes), pendingModes);
  assert.deepEqual(carryStateFromPreviousSession(event, [], stateType, pendingModes), { readOnly: true }, "saved branch state takes precedence");
  assert.equal(carryStateFromPreviousSession(event, [{ type: "custom", customType: stateType }], stateType, pendingModes), undefined);
  assert.equal(carryStateFromPreviousSession({ ...event, reason: "resume" }, [], stateType, pendingModes), undefined);
  console.log("ok carry uses the active previous branch, preserves unflushed modes and respects existing state");

  // Personal tier config is not a hidden activity route or escalation source.
  writeConfig(join(agent, "config/model-policy.json"), { subagentTiers: { fixture: { cheap: "fixture/model" } } });
  writeConfig(join(agent, "config/model-policy.local.json"), { subagentTiers: { fixture: { cheap: { model: "fixture/override", thinking: "max" } } } });
  const model = { provider: "fixture", id: "model" };
  const virtual = { provider: "tiers", id: "review", api: "pi-virtual" };
  const models = [model, virtual];
  let authLookups = 0;
  const ctx = { modelRegistry: {
    getAll: () => models,
    find: (provider, id) => models.find((target) => provider === target.provider && id === target.id),
    getApiKeyAndHeaders: async () => { authLookups++; throw new Error("auth belongs to registry dispatch"); },
  } };
  assert.deepEqual(await resolveModelForCall(ctx, "fixture/model", "high"), { model, thinking: "high" });
  assert.deepEqual(await resolveModelForCall(ctx, "model", "off"), { model, thinking: "off" });
  assert.equal((await resolveModelForCall(ctx, "tiers/review", "max")).model, virtual);
  await assert.rejects(resolveModelForCall(ctx, ""), /explicit activity model/);
  await assert.rejects(resolveModelForCall(ctx, "cheap"), /Model not found/);
  await assert.rejects(resolveModelForCall(ctx, "absent"), /Model not found/);
  models.push({ provider: "other", id: "model" });
  await assert.rejects(resolveModelForCall(ctx, "model"), /Ambiguous/);
  assert.equal((await resolveModelForCall(ctx, "fixture/model")).model, model);
  assert.equal(authLookups, 0, "resolution must not bypass virtual registry dispatch or resolve credentials itself");
  console.log("ok explicit physical/virtual model resolution, no personal aliases or auth bypass");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(directory, { recursive: true, force: true });
}
