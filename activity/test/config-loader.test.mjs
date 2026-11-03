// Synthetic configuration only; no runtime captures or authentication.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";

const root = mkdtempSync(join(tmpdir(), "activity-config-loader-"));
const saved = process.env.PI_CODING_AGENT_DIR;
const directory = join(root, "agent", "config");
const cwd = join(root, "project");
const global = join(directory, "activity.json");
const local = join(directory, "activity.local.json");
const defaults = { auto: { judgeInstructions: "", judgeModel: "fixture/judge" }, guards: { readOnly: false }, list: [0] };
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
try {
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  assert.equal(loadConfig("activity", defaults, { cwd }), defaults);
  writeJson(global, { auto: { judgeInstructions: "Synthetic global guidance." }, guards: { readOnly: true }, list: [1, 2] });
  writeJson(local, { auto: { judgeInstructions: "Ignored local guidance." }, guards: { readOnly: false }, list: [] });
  writeJson(join(cwd, ".pi", "activity.json"), { auto: { judgeModel: "untrusted/project" }, guards: { readOnly: false } });
  const config = loadConfig("activity", defaults, { cwd });
  assert.deepEqual(config, { auto: { judgeInstructions: "Synthetic global guidance.", judgeModel: "fixture/judge" }, guards: { readOnly: true }, list: [1, 2] });
  assert.deepEqual(defaults, { auto: { judgeInstructions: "", judgeModel: "fixture/judge" }, guards: { readOnly: false }, list: [0] }, "loading cannot mutate defaults");
  for (const projectTrusted of [false, true]) {
    assert.deepEqual(loadConfig("activity", defaults, { cwd, projectTrusted }), config, "legacy trust options cannot enable project config");
  }
  writeFileSync(local, "{ invalid ignored local JSON");
  writeFileSync(join(cwd, ".pi", "activity.json"), "{ invalid ignored project JSON");
  assert.deepEqual(loadConfig("activity", defaults, { cwd, projectTrusted: true }), config);
  writeJson(global, { auto: { judgeInstructions: "", judgeModel: null }, list: [] });
  assert.deepEqual(loadConfig("activity", defaults, { cwd }), { auto: { judgeInstructions: "", judgeModel: null }, guards: { readOnly: false }, list: [] }, "global objects merge; arrays, empty strings and null replace");
  writeFileSync(global, "{ invalid synthetic JSON");
  assert.throws(() => loadConfig("activity", defaults, { cwd }), /Invalid extension config JSON/);
  assert.throws(() => loadConfig("../activity", defaults), /Invalid config name/);
  console.log("config loader tests passed: only global activity.json, immutable defaults, merge and validation");
} finally {
  if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved;
  rmSync(root, { recursive: true, force: true });
}
