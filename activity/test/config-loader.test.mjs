// Synthetic configuration only; no runtime captures or authentication.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDefaultActivityConfig, loadConfig } from "../config.ts";
import { loadActivityConfig } from "../index.ts";

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
  assert.equal(loadConfig("activity", defaults), defaults);
  writeJson(local, { auto: { judgeModel: null } });
  assert.equal(loadConfig("activity", defaults).auto.judgeModel, null, "local works without the base file");
  const localContents = readFileSync(local, "utf8");
  ensureDefaultActivityConfig();
  assert.equal(readFileSync(local, "utf8"), localContents, "default creation leaves local overrides untouched");

  rmSync(local);
  writeJson(global, { auto: { judgeInstructions: "Synthetic guidance.", judgeMode: "short" }, guards: { readOnly: true }, list: [1, 2] });
  assert.deepEqual(loadConfig("activity", defaults), {
    auto: { judgeInstructions: "Synthetic guidance.", judgeMode: "short", judgeModel: "fixture/judge" },
    guards: { readOnly: true }, list: [1, 2],
  });
  writeJson(local, { auto: { judgeInstructions: "", judgeModel: null }, list: [] });
  writeJson(join(cwd, ".pi", "activity.json"), { guards: { readOnly: false } });
  writeFileSync(join(cwd, ".pi", "activity.local.json"), "{ invalid ignored project JSON");
  const merged = {
    auto: { judgeInstructions: "", judgeMode: "short", judgeModel: null }, guards: { readOnly: true }, list: [],
  };
  for (const projectTrusted of [false, true]) {
    assert.deepEqual(loadConfig("activity", defaults, { cwd, projectTrusted }), merged, "project files never participate");
  }
  assert.equal(loadActivityConfig(cwd).guards.readOnly, true);
  assert.equal(loadActivityConfig(cwd).auto.judgeModel, null);
  assert.deepEqual(defaults, { auto: { judgeInstructions: "", judgeModel: "fixture/judge" }, guards: { readOnly: false }, list: [0] });

  writeJson(local, { auto: { judgeResponseFormat: "invalid" } });
  assert.throws(() => loadActivityConfig(), /judgeResponseFormat must be off, json_object, or json_schema/);
  writeJson(global, { auto: { judgeResponseFormat: "invalid" }, guards: { readOnly: true } });
  writeJson(local, { auto: { judgeResponseFormat: "json_object" }, guards: { readOnly: false } });
  const overridden = loadActivityConfig();
  assert.equal(overridden.auto.judgeResponseFormat, "json_object", "validate only after applying both JSON layers");
  assert.equal(overridden.guards.readOnly, false, "the personal override can replace a base boolean");
  for (const path of [local, global]) {
    writeJson(global, {});
    writeJson(local, {});
    writeJson(path, []);
    assert.throws(() => loadConfig("activity", defaults), (error) => error.message.includes(`must be an object in ${path}`));
    writeFileSync(path, "{ invalid synthetic JSON");
    assert.throws(() => loadConfig("activity", defaults), (error) => error.message.includes(`Invalid extension config JSON in ${path}`));
  }
  writeJson(global, {});
  writeFileSync(local, '{"guards":{"__proto__":{"unexpectedGuard":true}}}');
  const guards = loadConfig("activity", defaults).guards;
  assert.equal(guards.unexpectedGuard, undefined, "special JSON keys cannot inject inherited settings");
  assert.equal(Object.getPrototypeOf(guards), Object.prototype);
  assert.throws(() => loadConfig("../activity", defaults), /Invalid config name/);
  console.log("config loader tests passed: personal layers, precedence, merge, and validation");
} finally {
  if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved;
  rmSync(root, { recursive: true, force: true });
}
