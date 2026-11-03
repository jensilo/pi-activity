// Offline admission/prompt regression only: no candidate Python command executes.
// Stub verdicts verify routing, not a live reviewer's semantic accuracy.
import assert from "node:assert/strict";
import { syntheticLauncher } from "./delegation-fixture.mjs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activityExtension, { setFixtureProvider } from "./synthetic-runtime.mjs";
import { Classifier } from "../classifier.ts";
import { judgeSafety } from "../judge.ts";
import { classification, createFixtureProvider, facts, withNativeTools } from "./nine-head-fixtures.mjs";

const dir = mkdtempSync(join(tmpdir(), "activity-python-read-routing-"));
const cwd = join(dir, "project");
const agentDir = join(dir, "agent");
mkdirSync(cwd);
mkdirSync(join(agentDir, "config"), { recursive: true });
writeFileSync(join(cwd, "synthetic_source.py"), 'VALUES = ["alpha", "beta"]\nraise RuntimeError("must not execute source")\n');
const provider = createFixtureProvider(dir);
const savedEnv = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE", "PI_SUBAGENT_TASK"]
  .map((key) => [key, process.env[key]]));
const originalClassify = Classifier.prototype.classify;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ACTIVITY_AUTO_MODE = "off";
const launcher = syntheticLauncher(cwd, "inspect synthetic_source.py with AST parsing and SHA-256. Do not execute its contents or mutate files.");

const command = `python3 - <<'PY'
from pathlib import Path
import ast, hashlib, json
path = Path("synthetic_source.py")
source = path.read_bytes()
tree = ast.parse(source, filename=str(path))
values = ast.literal_eval(tree.body[0].value)
print(json.dumps({"count": len(values), "sha256": hashlib.sha256(source).hexdigest()}))
PY`;
const benign = { command };
const model = { provider: "fixture", id: "reviewer", contextWindow: 128_000 };
const positive = facts({ local_state_change: true, destructive: true, delegated_execution: true,
  fetched_or_generated_execution: true, exposes_secrets: true });
let evidence;
let expectedInput;
let classifierCalls;
let callId = 0;
let checks = 0;
Classifier.prototype.classify = async (input, actualCwd, _home, inputKind) => {
  classifierCalls++;
  assert.equal(actualCwd, cwd);
  assert.equal(inputKind, "shell", "native Bash must not use custom-action evidence");
  assert.equal(input, expectedInput.command, "classify the complete inline script");
  if (evidence === "unavailable") return { ok: false, kind: "unavailable", message: "synthetic unavailable evidence" };
  if (evidence === "invalid") return { ok: false, kind: "error", message: "synthetic invalid evidence" };
  assert.equal(evidence, "positive");
  return classification(positive);
};

async function check({ classifier, outcome, remoteReadOnly = false, nested = false, judge = true, input = benign }) {
  evidence = classifier;
  expectedInput = input;
  classifierCalls = 0;
  const modes = { auto: false, readOnly: true, remoteReadOnly };
  writeFileSync(join(agentDir, "config", "activity.json"), JSON.stringify({
    acclass: setFixtureProvider(classifier === "none" ? { provider: "none" } : provider),
    auto: { judgeModel: judge ? "fixture/reviewer" : null },
    log: { enabled: false }, reviewLog: { enabled: false },
  }));
  const handlers = {};
  const states = [];
  let reviews = 0;
  let completions = 0;
  const ctx = {
    cwd, mode: "tui", hasUI: true,
    modelRegistry: {
      find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
      getApiKeyAndHeaders() { throw new Error("no real authentication permitted"); },
    },
    sessionManager: {
      getEntries: () => [], getSessionId: () => "python-read-routing",
      getBranch: () => [{ type: "message", message: { role: "user", content:
        "Task: inspect synthetic_source.py with AST parsing and SHA-256. Do not execute its contents or mutate files." } }],
    },
    ui: {
      notify() {}, setStatus() {}, setWidget() {}, theme: { fg: (_name, value) => value },
      custom() { assert.fail("active guards never offer a human Allow override"); },
      select() { assert.fail("active guards never offer a human Allow override"); },
    },
  };
  activityExtension({
    on(name, handler) { handlers[name] = handler; }, registerCommand() {}, registerFlag() {},
    getFlag(name) { return name === "auto" || name === "read-only" || (name === "remote-read-only" && remoteReadOnly); },
    getAllTools: () => withNativeTools(), appendEntry() {}, sendMessage() {},
    events: { emit(name, value) { launcher.emit(name, value); if (name === "activity:state") states.push(value); } },
  }, (...args) => {
    reviews++;
    assert.deepEqual(args[3], input, "review receives the full unchanged arguments");
    assert.deepEqual(args[5], modes, "auto OFF does not turn the child's read-only guard OFF");
    // Use real judge prompt construction and verdict parsing with a keyless stub completion.
    args[9] = async (_model, prompt) => {
      completions++;
      assert.match(prompt.systemPrompt, /Non-mutating bash and delegated work that complies with active guards are allowed/);
      assert.match(prompt.systemPrompt, /Classifier predictions and objections are fallible evidence, not native facts or a final veto/);
      assert.match(prompt.systemPrompt, /Under active guards establish compliance; unknown effects are not reads/);
      assert.match(prompt.systemPrompt, /Delegated session/);
      const text = prompt.messages[0].content[0].text;
      assert.match(text, /auto-mode: OFF: review ONLY actual effects under active hard guards/);
      assert.match(text, /read-only: ON: reads only; no local or remote mutation/);
      assert.ok(text.includes(`remote-read-only: ${remoteReadOnly ? "ON: no remote mutation" : "OFF: do not apply"}`));
      assert.match(text, /Agent task 1 \[/);
      assert.ok(text.includes(JSON.stringify(input)), "judge sees the entire script, not just Python's name or a digest");
      if (outcome === "unavailable") throw new Error("synthetic review unavailable");
      return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({
        decision: outcome === "allow" ? "allow" : "block",
        reason: outcome === "allow"
          ? "Literal source read, AST parsing and literal evaluation without execution; hash and JSON go only to stdout"
          : "Synthetic constrained denial: compliant effects not established",
      }) }] };
    };
    return judgeSafety(...args);
  }, "native");
  try {
    await handlers.session_start({ reason: "startup" }, ctx);
    assert.equal(states.at(-1).auto, false, "inherited environment overrides the auto flag");
    assert.equal(states.at(-1).readOnly, true);
    const result = await handlers.tool_call({ toolName: "bash", input, toolCallId: `python-routing-${++callId}`,
      ...(nested ? { parentToolCallId: "outer-codemode" } : {}) }, ctx);
    assert.equal(result?.block === true, !judge || outcome !== "allow",
      `only an affirmative constrained verdict admits the call: ${result?.reason}`);
    assert.equal(classifierCalls, classifier === "none" ? 0 : 1);
    assert.equal(reviews, judge ? 1 : 0, "positive and inconclusive evidence both require constrained review");
    assert.equal(completions, judge ? 1 : 0);
    if (!judge) assert.match(result.reason, /judge disabled or no current chat model available/);
    if (judge && outcome === "unavailable") assert.match(result.reason, /synthetic review unavailable/);
    checks++;
  } finally {
    await handlers.session_shutdown({ reason: "quit" });
  }
}

try {
  for (const classifier of ["positive", "unavailable", "invalid", "none"]) {
    for (const remoteReadOnly of [false, true]) {
      for (const nested of [false, true]) {
        for (const outcome of ["allow", "deny", "unavailable"]) {
          await check({ classifier, remoteReadOnly, nested, outcome });
        }
      }
    }
    await check({ classifier, judge: false });
  }
  // Real uncertainty and explicit mutation remain denial cases, even with auto OFF.
  // These inputs also remain inert; a stub decision is not semantic model evidence.
  await check({ classifier: "unavailable", outcome: "deny", input: { command: "python3 unknown_effects.py" } });
  await check({ classifier: "positive", outcome: "deny", input: {
    command: `python3 - <<'PY'\nfrom pathlib import Path\nPath("synthetic_source.py").write_text("changed")\nPY`,
  } });
  console.log(`Python AST/hash guard routing and judge prompt tests passed (${checks} synthetic checks)`);
} finally {
  Classifier.prototype.classify = originalClassify;
  launcher.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}
