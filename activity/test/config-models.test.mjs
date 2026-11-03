import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadActivityConfig } from "../index.ts";
import { resolveModelForCall } from "../model-policy.ts";
import { judgeSafety } from "../judge.ts";

const root = mkdtempSync(join(tmpdir(), "activity-config-models-"));
const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE", "PI_SUBAGENT_TASK"].map((key) => [key, process.env[key]]));
const cwd = join(root, "project");
const write = (path, value) => writeFileSync(path, JSON.stringify(value));
try {
  process.env.PI_CODING_AGENT_DIR = root;
  delete process.env.PI_ACTIVITY_AUTO_MODE;
  delete process.env.PI_SUBAGENT_TASK;
  mkdirSync(join(root, "config"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const example = JSON.parse(readFileSync(new URL("../../activity.example.json", import.meta.url), "utf8"));
  assert.equal(DEFAULT_CONFIG.auto.judgeModel, undefined, "omitted judge follows ctx.model");
  assert.equal(DEFAULT_CONFIG.auto.summaryModel, undefined, "summary follows the effective judge");
  assert.equal(DEFAULT_CONFIG.auto.fallbackJudgeModel ?? undefined, undefined, "no implicit escalation");
  write(join(root, "config/activity.json"), { acclass: { enabled: false }, auto: { judgeModel: "fixture/judge" }, guards: { readOnly: true } });
  write(join(root, "config/activity.local.json"), { auto: { summaryModel: "fixture/digest" }, log: { mode: "redacted" } });
  write(join(cwd, ".pi/activity.json"), { classifier: {}, acclass: { enabled: true, variant: "q8" }, guards: { readOnly: false }, auto: { judgeModel: "expensive/current" } });
  const cfg = loadActivityConfig(cwd);
  assert.equal(cfg.auto.judgeModel, "fixture/judge");
  assert.equal(cfg.auto.summaryModel, undefined, "local config cannot choose a summary model");
  assert.equal(cfg.guards.readOnly, true);
  assert.equal(cfg.acclass.enabled, false, "project cannot enable the evidence provider");
  assert.equal(cfg.log.mode, DEFAULT_CONFIG.log.mode, "local logging config is ignored");
  assert.equal(DEFAULT_CONFIG.acclass.enabled, true, "loading config cannot mutate shared defaults");
  write(join(root, "config/activity.json"), { auto: { judgeModel: null } });
  assert.equal(loadActivityConfig(cwd).auto.judgeModel, null, "explicit null remains a disabled judge, not omission");
  write(join(root, "config/activity.json"), {});
  assert.equal(loadActivityConfig(cwd).auto.judgeModel, undefined, "loading preserves omitted judge selection");

  // Personal files do not supply aliases or provider-routed policy to this module.
  write(join(root, "config/activity.json"), { auto: { modelAliases: { cheap: "fixture/judge" } } });
  write(join(root, "config/model-policy.json"), { subagentTiers: { openai: { cheap: "fixture/judge" } } });
  const models = [{ provider: "fixture", id: "judge", contextWindow: 128000 },
    { provider: "fixture", id: "digest", contextWindow: 128000 },
    { provider: "tiers", id: "cheap", api: "pi-virtual" }];
  const ctx = { model: { provider: "expensive", id: "current" },
    sessionManager: { getSessionId: () => "model-config", getBranch: () => [] },
    modelRegistry: { getAll: () => models, find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
      getApiKeyAndHeaders: () => { throw new Error("auth must be owned by registry dispatch"); } },
  };
  assert.equal((await resolveModelForCall(ctx, "judge")).model, models[0]);
  assert.equal((await resolveModelForCall(ctx, "cheap")).model, models[2], "bare tier is only an unambiguous registered id");
  assert.equal((await resolveModelForCall(ctx, "tiers/cheap", "low")).thinking, "low");
  assert.equal((await resolveModelForCall(ctx, "fixture/judge", "off")).thinking, "off");
  // Every colon stays part of the exact id, including former thinking suffixes.
  for (const suffix of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "HIGH", "unknown", "7b"]) {
    const colonModel = { provider: "fixture", id: `path/model:${suffix}` };
    const bareModel = { provider: "fixture", id: `model:${suffix}` };
    models.push(colonModel, bareModel);
    assert.deepEqual(await resolveModelForCall(ctx, `fixture/path/model:${suffix}`, "minimal"),
      { model: colonModel, thinking: "minimal" });
    assert.deepEqual(await resolveModelForCall(ctx, `model:${suffix}`), { model: bareModel, thinking: "off" });
  }
  await assert.rejects(resolveModelForCall(ctx, "fixture/judge:off"), /Model not found/,
    "legacy syntax is not stripped or routed to a different model");
  for (const ref of ["/judge", "fixture/", "fixture/judge extra"]) {
    await assert.rejects(resolveModelForCall(ctx, ref), /Invalid activity model|explicit activity model/);
  }
  models.push({ provider: "other", id: "model:high" });
  await assert.rejects(resolveModelForCall(ctx, "model:high"), /Ambiguous/);
  models.push({ provider: "other", id: "cheap" });
  await assert.rejects(resolveModelForCall(ctx, "cheap"), /Ambiguous/);
  await assert.rejects(resolveModelForCall(ctx, "smart"), /Model not found/);
  await assert.rejects(resolveModelForCall(ctx, ""), /explicit/);
  let calls = 0;
  const missing = await judgeSafety(ctx, "", "bash", { command: "git push" }, cwd,
    { auto: true, readOnly: false, remoteReadOnly: false }, new AbortController().signal, undefined, undefined,
    async () => { calls++; throw new Error("no implicit reviewer"); });
  assert.equal(missing.ok, false);
  assert.equal(calls, 0);
  assert.equal(missing.metrics.providerRequests, 0);
  // Check published metadata last so stale metadata cannot hide runtime failures.
  assert.deepEqual(example, { acclass: DEFAULT_CONFIG.acclass }, "published example is the brief first-start config, not all advanced defaults");
  console.log("explicit registry model configuration tests passed");
} finally {
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
}
