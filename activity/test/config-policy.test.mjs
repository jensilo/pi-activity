// Synthetic policy configuration only; never reads personal settings or activity logs.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadActivityConfig } from "../index.ts";

const root = mkdtempSync(join(tmpdir(), "activity-config-policy-"));
const savedDir = process.env.PI_CODING_AGENT_DIR;
const configPath = join(root, "config/activity.json");
const localPath = join(root, "config/activity.local.json");
const cwd = join(root, "project");
const write = (path, value) => writeFileSync(path, JSON.stringify(value));
const trustFields = ["trustedTools", "questionnaireSources"];

try {
  process.env.PI_CODING_AGENT_DIR = root;
  mkdirSync(join(root, "config"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  write(configPath, {});
  assert.deepEqual(loadActivityConfig(cwd).policy, {
    readAllowlist: [], trustedTools: [], questionnaireSources: [],
  });
  for (const field of trustFields) {
    assert.equal(Object.hasOwn(DEFAULT_CONFIG, field), false, "no root trust defaults or aliases");
    assert.equal(Object.hasOwn(loadActivityConfig(cwd), field), false);
  }

  write(configPath, { policy: {
    readAllowlist: ["~/synthetic-reads"], trustedTools: ["Acme.confirm", "literal.*"],
    questionnaireSources: ["~/synthetic/question.ts", "/synthetic/other.ts"],
  } });
  const policy = loadActivityConfig(cwd).policy;
  assert.deepEqual(policy.readAllowlist, [join(homedir(), "synthetic-reads")]);
  assert.deepEqual(policy.trustedTools, ["Acme.confirm", "literal.*"], "tool names remain exact");
  assert.deepEqual(policy.questionnaireSources, [join(homedir(), "synthetic/question.ts"), "/synthetic/other.ts"]);
  assert.deepEqual(DEFAULT_CONFIG.policy, { readAllowlist: [], trustedTools: [], questionnaireSources: [] },
    "home expansion and loading do not mutate defaults");

  write(localPath, { policy: { trustedTools: [], questionnaireSources: ["/synthetic/local.ts"] } });
  assert.deepEqual(loadActivityConfig(cwd).policy, policy, "activity.local.json cannot override global policy");
  write(configPath, { policy: { trustedTools: [], questionnaireSources: [] } });
  assert.deepEqual(loadActivityConfig(cwd).policy, DEFAULT_CONFIG.policy, "empty global lists replace configured trust");
  rmSync(localPath);

  for (const invalid of [null, [], "policy", 42, false]) {
    write(configPath, { policy: invalid });
    assert.throws(() => loadActivityConfig(cwd), /activity\.policy must be an object/);
  }
  for (const field of trustFields) {
    for (const invalid of [null, {}, "tool", 42, false, [null], [42], [false], [{}], [""], ["  "], ["valid", ""]]) {
      write(configPath, { policy: { [field]: invalid } });
      assert.throws(() => loadActivityConfig(cwd), new RegExp(`activity\\.policy\\.${field} must be an array`));
    }
    write(configPath, { policy: { [field]: [] } });
    assert.deepEqual(loadActivityConfig(cwd).policy[field], [], "explicit empty nested lists are valid");

    const nested = { policy: { trustedTools: ["custom"], questionnaireSources: ["/synthetic/question.ts"] } };
    for (const stale of [[], null, ["stale"], "", {}, false]) {
      const message = `activity.${field} is no longer supported; remove it`;
      write(configPath, { ...nested, [field]: stale });
      // An ignored local nested replacement cannot hide an obsolete global root field.
      write(localPath, nested);
      assert.throws(() => loadActivityConfig(cwd), { message });
      write(configPath, nested);
      write(localPath, { [field]: stale });
      assert.deepEqual(loadActivityConfig(cwd).policy, { readAllowlist: [], ...nested.policy }, "ignored local root fields are not parsed or validated");
      rmSync(localPath);
    }
  }

  // Project configuration remains untrusted, including obsolete root fields.
  write(configPath, {});
  write(join(cwd, ".pi/activity.json"), {
    trustedTools: ["custom"], questionnaireSources: ["/synthetic/question.ts"],
    policy: { trustedTools: ["custom"], questionnaireSources: ["/synthetic/question.ts"] },
  });
  assert.deepEqual(loadActivityConfig(cwd).policy, DEFAULT_CONFIG.policy);

  const schema = JSON.parse(readFileSync(new URL("../../activity.schema.json", import.meta.url), "utf8"));
  for (const field of trustFields) {
    assert.deepEqual(schema.properties[field].not, {}, "schema rejects any obsolete root value");
    const nested = schema.properties.policy.properties[field];
    assert.equal(nested.type, "array");
    assert.deepEqual(nested.items, { type: "string", minLength: 1 });
    assert.deepEqual(nested.default, []);
  }
  console.log("nested policy trust defaults, global-only loading, expansion and stale-root rejection tests passed");
} finally {
  if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedDir;
  rmSync(root, { recursive: true, force: true });
}
