// Installed Pi SDK registration + nested execution pipeline, entirely offline.
// Only inert fixture backends run; no model or MCP/provider is contacted.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import activityExtension, { setFixtureProvider } from "./synthetic-runtime.mjs";
import { Classifier } from "../classifier.ts";
import { OBSERVATION_ENTRY_TYPE } from "../version.ts";
import { classification, createFixtureProvider, facts } from "./nine-head-fixtures.mjs";
import { actionSchema } from "./typebox-fixtures.mjs";

const dir = mkdtempSync(join(tmpdir(), "ac-sdk-"));
const originalClassify = Classifier.prototype.classify;
const savedEnv = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE"].map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.PI_ACTIVITY_AUTO_MODE;
mkdirSync(join(dir, "config"));
writeFileSync(join(dir, "config/activity.json"), JSON.stringify({
  acclass: setFixtureProvider(createFixtureProvider(dir)), auto: { judgeModel: "fixture/judge" }, log: { enabled: false }, reviewLog: { enabled: false },
}));
const evidence = [];
let classifierFacts = facts();
Classifier.prototype.classify = async (text, _cwd, _home, kind) => {
  assert.equal(kind, "action");
  evidence.push(JSON.parse(text));
  return classification(classifierFacts);
};
let session, lastExecutionEnd;
const reviews = [];
let reviewerAllows = true;
let reviewerAvailable = true;
let backendCalls = 0;
let target = "fixture_typebox";
let requestedInput = { key: "computed", payload: { text: "complete ☃", options: ["inert"] } };
const schemas = {
  fixture_typebox: actionSchema(),
  fixture_plain: JSON.parse(JSON.stringify(actionSchema())),
  fixture_dangerous: Object.assign(actionSchema(), { "x-lost-extension": undefined }),
};
try {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      activityExtension(pi, async (...args) => {
        reviews.push(args);
        return { ok: reviewerAvailable, allow: reviewerAllows, reason: "fixture reviewer" };
      });
      pi.on("tool_execution_end", (event) => { lastExecutionEnd = { id: event.toolCallId, durationMs: event.durationMs }; });
      for (const [name, parameters] of Object.entries(schemas)) pi.registerTool({
        name, label: name, description: "Inert synthetic catalog lookup", parameters, exposure: "codemode",
        async execute() {
          backendCalls++;
          return { content: [{ type: "text", text: "inert fixture data" }], details: undefined };
        },
      });
      pi.registerTool({ name: "fixture_driver", label: "Driver", description: "Exercise the installed nested pipeline",
        parameters: Type.Object({}), async execute(_id, _args, _signal, _update, ctx) {
          const nested = await ctx.executeTool(target, requestedInput);
          return { ...nested.result, isError: nested.isError };
        } });
    }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const sessionManager = SessionManager.inMemory(dir);
  sessionManager.appendMessage({ role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    content: [{ type: "toolCall", id: "sdk-parent", name: "fixture_driver", arguments: {} }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: Date.now() });
  ({ session } = await createAgentSession({
    cwd: dir, agentDir: dir, resourceLoader, settingsManager, sessionManager, noTools: true,
    // Explicit inert selection avoids auth-based model selection; no prompt/stream runs.
    model: { provider: "fixture", id: "fixture", name: "Fixture", api: "openai-completions", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 },
  }));
  await session.bindExtensions({ mode: "print" });
  const driver = session.agent.state.tools.find((tool) => tool.name === "fixture_driver");
  assert.ok(driver, "inline extension driver must be registered and active");
  const execute = () => driver.execute("sdk-parent", {}, new AbortController().signal);
  const latestReceipt = () => sessionManager.getBranch().findLast((entry) => entry.customType === OBSERVATION_ENTRY_TYPE)
    .data.history.findLast((call) => call.id === lastExecutionEnd.id);
  for (target of ["fixture_typebox", "fixture_plain"]) {
    const registered = session.getAllTools().find((tool) => tool.name === target);
    assert.ok(registered);
    if (target === "fixture_typebox") assert.equal(Object.getOwnPropertyDescriptor(registered.parameters, "~kind").enumerable, false,
      "SDK getAllTools exposes the real hidden-tag schema that caused the regression");
    const before = backendCalls;
    const allowed = await execute();
    assert.notEqual(allowed.isError, true, JSON.stringify(allowed));
    assert.equal(backendCalls, before + 1);
    assert.equal(typeof lastExecutionEnd.durationMs, "number", "real nested execution end supplies host timing");
    assert.equal(latestReceipt().durationMs, lastExecutionEnd.durationMs, "real nested timing reaches Activity's checkpoint");
    assert.equal(latestReceipt().nested, true);
    assert.deepEqual(evidence.at(-1).evaluated_arguments, requestedInput);
    assert.deepEqual(evidence.at(-1).tool_metadata.parameters, JSON.parse(JSON.stringify(schemas[target])));
    assert.deepEqual(reviews.at(-1)[3], requestedInput);
    assert.equal(reviews.at(-1)[11].parameters, registered.parameters);
  }
  reviewerAllows = false;
  target = "fixture_typebox";
  const beforeDeny = backendCalls;
  assert.equal((await execute()).isError, true);
  assert.equal(backendCalls, beforeDeny, "review denial blocks the actual registered inert backend");
  assert.equal(lastExecutionEnd.durationMs, undefined);
  assert.equal(latestReceipt().durationMs, undefined, "blocked real nested calls retain unknown execution timing");
  // Inert lookup effects are unchanged even when classification predicts a mutation.
  // The real SDK must apply the guard-aware judge result, not a classifier veto.
  classifierFacts = facts({ remote_state_change: true, local_state_change: true });
  for (const guard of ["read-only", "remote-read-only"]) {
    const command = session.extensionRunner.getCommand(guard);
    assert.ok(command);
    await command.handler("on", session.extensionRunner.createCommandContext());
    for (const outcome of ["allow", "deny", "unavailable"]) {
      reviewerAllows = outcome === "allow";
      reviewerAvailable = outcome !== "unavailable";
      const before = backendCalls;
      const beforeReview = reviews.length;
      const guarded = await execute();
      assert.equal(guarded.isError === true, outcome !== "allow");
      assert.equal(reviews.length, beforeReview + 1, "nested positive guard signals always reach review");
      assert.deepEqual(reviews.at(-1)[3], requestedInput);
      assert.deepEqual(reviews.at(-1)[5], { auto: true,
        readOnly: guard === "read-only", remoteReadOnly: guard === "remote-read-only" });
      assert.equal(backendCalls, before + (outcome === "allow" ? 1 : 0), "only guard-compliant review executes the inert backend");
    }
    await command.handler("off", session.extensionRunner.createCommandContext());
  }
  reviewerAvailable = true;
  target = "fixture_dangerous";
  const backendBeforeInvalid = backendCalls;
  const reviewsBefore = reviews.length;
  const evidenceBefore = evidence.length;
  const result = await execute();
  assert.equal(result.isError, true);
  assert.match(result.content.map((part) => part.text ?? "").join("\n"), /without lossy serialization/);
  assert.equal(reviews.length, reviewsBefore);
  assert.equal(evidence.length, evidenceBefore);
  assert.equal(backendCalls, backendBeforeInvalid);
  console.log("installed Pi SDK action tests passed (registered TypeBox/plain schemas, real nested gate/classifier/reviewer/backend routing, unsafe extension rejection)");
} finally {
  if (session) {
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  Classifier.prototype.classify = originalClassify;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}
