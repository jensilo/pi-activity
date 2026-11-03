import assert from "node:assert/strict";
import { syntheticLauncher } from "./delegation-fixture.mjs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Classifier } from "../classifier.ts";
import activityExtension, { setFixtureProvider } from "./synthetic-runtime.mjs";
import { classification, facts, createFixtureProvider, withNativeTools } from "./nine-head-fixtures.mjs";

const agentDir = mkdtempSync(join(tmpdir(), "activity-guard-agent-"));
const cwd = mkdtempSync(join(tmpdir(), "activity-guard-project-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldAutoEnv = process.env.PI_ACTIVITY_AUTO_MODE;
const classify = Classifier.prototype.classify;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_ACTIVITY_AUTO_MODE;
mkdirSync(join(agentDir, "config"), { recursive: true });
const fixtureProvider = createFixtureProvider(agentDir);
const configPath = join(agentDir, "config", "activity.json");
writeFileSync(configPath, JSON.stringify({
  acclass: setFixtureProvider(fixtureProvider), auto: { judgeModel: "fixture/judge" }, log: { enabled: false }, reviewLog: { enabled: false },
}));

let launcher;
const handlers = {};
const commands = {};
const flags = [];
const states = [];
const messages = [];
const notices = [];
const statuses = [];
const pi = {
  registerFlag(name) { flags.push(name); },
  registerCommand(name, options) { commands[name] = options.handler; },
  on(name, handler) { handlers[name] = handler; },
  getFlag(name) { return name === "auto"; }, getAllTools() { return withNativeTools(); },
  appendEntry() {}, sendMessage(message) { messages.push(message); },
  events: { emit(name, value) { launcher?.emit(name, value); if (name === "activity:state") states.push(value); } },
};
const ctx = {
  cwd, mode: "print", hasUI: false,
  sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => "guard-fastpath" },
  ui: { notify(text) { notices.push(text); }, setStatus(_key, text) { statuses.push(text); }, theme: { fg: (_name, value) => value } },
};
Classifier.prototype.classify = async (command) => {
  if (command === "unknown") return { ok: false, kind: "unavailable", message: "test classifier unavailable" };
  const privateRead = command === "cat private";
  const secretRead = command === "cat known-secret";
  const values = command.startsWith("rg ") ? { local_state_change: true, destructive: true }
    : secretRead ? { exposes_secrets: true }
    : command === "git commit" ? { local_state_change: true }
    : command === "git push" ? { remote_state_change: true, outbound: true, egress: true }
    : command.startsWith("touch ") ? { local_state_change: true }
    : command === "worker run" ? { delegated_execution: true }
    : command === "remote worker run" ? { outbound: true, delegated_execution: true }
    : command === "generated run" ? { fetched_or_generated_execution: true }
    : command === "host configure" ? { local_state_change: true, host_control_change: true }
    : command === "upload" ? { outbound: true, egress: true }
    : command === "curl read" ? { outbound: true } : {};
  return classification(facts(values), {
    scope: privateRead || secretRead ? ["home"] : command === "curl read" ? ["none"] : ["cwd"],
    paths: { inside: [], outside: privateRead || secretRead ? [join(homedir(), "private.txt")] : [] },
  });
};
let reviews = 0;
activityExtension(pi, async (_ctx, _ref, tool, input, _cwd, modes) => {
  reviews++;
  assert.equal(modes.auto, states.at(-1).auto);
  assert.equal(modes.readOnly, states.at(-1).readOnly);
  assert.equal(modes.remoteReadOnly, states.at(-1).guards.remoteReadOnly);
  const mutation = ["git commit", "git push", "host configure", "upload"].includes(input.command);
  const allow = tool !== "deploy" && !mutation;
  return { ok: true, allow, reason: allow ? "Established non-mutating action despite predicted risks" : "Mutation forbidden by active guard" };
}, "native");
const action = (toolName, input) => handlers.tool_call({ toolName, toolCallId: `guard-${Date.now()}-${Math.random()}`, input }, ctx);
const bash = (command) => action("bash", { command });
try {
  assert.deepEqual(flags, ["read-only", "remote-read-only", "auto"], "both guard flags are registered");
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  launcher = syntheticLauncher(cwd);
  await handlers.session_start({ reason: "startup" }, ctx);
  try {
    assert.notEqual((await bash("cat known-secret"))?.block, true, "predicted secret exposure receives contextual review");
    assert.equal(reviews, 1, "a shell prediction is not established secret access");
    assert.notEqual((await action("read", { path: join(cwd, ".env") }))?.block, true,
      "credential-path heuristics reach review rather than an unreviewed veto");
    assert.equal(reviews, 2, "delegated credential paths reach the judge with upstream context");
    reviews = 0;
    assert.notEqual((await bash("curl read"))?.block, true, "ordinary network reads remain available in delegated auto-mode");
  } finally {
    launcher.close();
    launcher = undefined;
    await handlers.session_start({ reason: "startup" }, ctx);
  }
  await commands["auto-mode"]("false", ctx);
  assert.match(notices.at(-1), /Usage: \/auto-mode/);
  assert.equal(states.at(-1).auto, true, "old toggle aliases are not accepted");
  await commands["read-only"]("on", ctx);
  assert.notEqual((await bash("git status"))?.block, true);
  assert.notEqual((await bash("curl read"))?.block, true);
  assert.equal(reviews, 0, "known permitted reads fast-path under read-only");
  assert.match((await bash("git commit"))?.reason ?? "", /Mutation forbidden/);
  for (const command of ["worker run", "remote worker run", "generated run"]) {
    assert.notEqual((await bash(command))?.block, true, "a predicted effect is not proof of mutation");
  }
  for (const command of ["host configure", "upload"]) {
    assert.equal((await bash(command))?.block, true, "judge-confirmed violations stay blocked");
  }
  assert.equal(reviews, 6, "predicted guard violations receive mandatory constrained review");
  assert.notEqual((await bash("cat private"))?.block, true);
  assert.equal(reviews, 7, "base private-read policy still requests review under a guard");
  await commands["auto-mode"]("off", ctx);
  assert.notEqual((await bash("cat private"))?.block, true);
  assert.equal(reviews, 7, "auto off skips ordinary base policy while retaining the read-only guard");
  assert.notEqual((await bash("unknown"))?.block, true);
  assert.equal(reviews, 8, "classifier failure goes to the judge under an active guard");

  await commands["read-only"]("off", ctx);
  await commands["auto-mode"]("on", ctx);
  await commands["remote-read-only"]("on", ctx);
  assert.notEqual((await bash("git status"))?.block, true);
  assert.equal((await bash("git push"))?.block, true);
  assert.notEqual((await bash("remote worker run"))?.block, true, "established compliant delegation is allowed");
  assert.equal(reviews, 10, "predicted remote mutation/delegation goes to the judge");
  assert.notEqual((await bash("touch ./new.txt"))?.block, true);
  assert.notEqual((await action("write", { path: join(cwd, "local.txt"), content: "okay" }))?.block, true);
  assert.equal((await action("deploy", { target: "production" }))?.block, true);
  assert.notEqual((await bash("cat private"))?.block, true);
  assert.equal(reviews, 12, "remote-read-only reviews custom actions and retains the enabled ordinary base policy");
  await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" });

  process.env.PI_ACTIVITY_AUTO_MODE = "false";
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  assert.equal(states.at(-1).auto, true, "old environment aliases are not accepted");
  process.env.PI_ACTIVITY_AUTO_MODE = "off";
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  assert.equal(states.at(-1).auto, false, "the canonical environment override remains");
  await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" });

  writeFileSync(configPath, JSON.stringify({ acclass: setFixtureProvider(fixtureProvider), auto: { judgeModel: "fixture/judge" }, log: { enabled: false },
    reviewLog: { enabled: false }, guards: { readOnly: true, remoteReadOnly: true } }));
  ctx.hasUI = true;
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  assert.equal(states.at(-1).readOnly, true, "configured guards must be broadcast as effective modes");
  assert.equal(states.at(-1).guards.remoteReadOnly, true);
  assert.match(statuses.at(-1), /🔏.*🌐/);
  await handlers.before_agent_start({ prompt: "test" }, ctx);
  assert.match(messages.at(-1).content, /read-only ON; remote-read-only ON/);
  assert.match(messages.at(-1).content, /Do not mutate local or remote state/);
  assert.doesNotMatch(messages.at(-1).content, /global activity config|\/read-only off/);
  const beforeRegexRead = reviews;
  assert.notEqual((await bash("rg -n 'Upgrade|RunMigrations|Delete' synthetic-src"))?.block, true,
    "mutation-related search terms do not make a regex search mutating");
  assert.equal(reviews, beforeRegexRead + 1, "false-positive shell mutation signals receive judge review");
  await commands["read-only"]("off", ctx);
  await commands["remote-read-only"]("off", ctx);
  assert.match(notices.at(-2), /Read-only mode on/);
  assert.match(notices.at(-1), /Remote-read-only mode on/);
  assert.equal(states.at(-1).readOnly, true);
  assert.equal(states.at(-1).guards.remoteReadOnly, true);
  assert.equal((await action("write", { path: join(cwd, "local.txt") }))?.block, true);
  assert.equal((await action("deploy", { target: "production" }))?.block, true);
  await commands.activity("", ctx);
  assert.match(notices.at(-1), /\n🔏 🌐\n/, "dashboard must show both effective hard guards even after off requests");
  await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" });
  console.log("activity guard fast-path tests passed");
} finally {
  Classifier.prototype.classify = classify;
  if (oldAutoEnv === undefined) delete process.env.PI_ACTIVITY_AUTO_MODE;
  else process.env.PI_ACTIVITY_AUTO_MODE = oldAutoEnv;
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
