// Functional tests for the activity wiring modules.
//
//   node <jiti> test/wiring.test.mjs
//
// Policy tests are pure. The classifier test spawns the real `acclass serve` daemon
// on /tmp and exercises classify() and the daemon-free scope() fallback.

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalFilePath, classifyPath, decide, filePrimitives, looksSecret, scopeForPath } from "../policy.ts";
import { Classifier } from "../classifier.ts";
import { loadConfig } from "../config.ts";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { facts as P } from "./nine-head-fixtures.mjs";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ac-wiring-cwd-")));
process.on("exit", () => rmSync(cwd, { recursive: true, force: true }));
const home = homedir();
const allow = [join(home, ".pi"), join(home, ".nvm")];
const NO_GUARDS = { readOnly: false, remoteReadOnly: false };
const opts = { guards: NO_GUARDS, readAllowlist: allow, cwd, home };

const rep = (scope, outside = []) => ({ scope, paths: { inside: [], outside } });
const verdict = (p, r, o = opts) => decide(p, r, o).verdict;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}: ${err.message}`);
  }
}

console.log("# policy");

check("unresolved scope blocks private reads", () =>
  assert.equal(verdict(P(), rep(["other"])), "block"));
check("unresolved scope blocks mutations", () =>
  assert.equal(verdict(P({ local_state_change: true }), rep(["other"])), "block"));

console.log("# config trust");

check("Activity project config is always ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-cfg-"));
  try {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "activity.json"), JSON.stringify({ maxCommandChars: 1 }));
    const defaults = { maxCommandChars: 4000 };
    assert.equal(
      loadConfig("activity", defaults, { cwd: dir, projectTrusted: false }).maxCommandChars,
      4000,
    );
    assert.equal(loadConfig("activity", defaults, { cwd: dir }).maxCommandChars, 4000);
    assert.equal(loadConfig("activity", defaults, { cwd: dir, projectTrusted: true }).maxCommandChars, 4000,
      "the legacy projectTrusted option cannot opt Activity into project configuration");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("secrets always block", () => assert.equal(verdict(P({ exposes_secrets: true }), rep(["cwd"])), "block"));
check("destructive inside cwd is allowed", () => assert.equal(verdict(P({ destructive: true }), rep(["cwd"])), "allow"));
check("destructive inside tmp is allowed", () => assert.equal(verdict(P({ destructive: true }), rep(["tmp"])), "allow"));
check("destructive in mixed scopes still needs review", () => assert.equal(verdict(P({ destructive: true }), rep(["cwd", "home"])), "block"));
check("remote destructive inside cwd still needs review", () => assert.equal(verdict(P({ destructive: true, remote_state_change: true }), rep(["cwd"])), "block"));
check("egress destructive inside cwd still needs review", () => assert.equal(verdict(P({ destructive: true, egress: true }), rep(["cwd"])), "block"));
check("destructive in /etc blocks", () => assert.equal(verdict(P({ destructive: true }), rep(["system"])), "block"));
check("destructive with no scope blocks", () => assert.equal(verdict(P({ destructive: true }), rep(["none"])), "block"));
check("remote mutation requires review", () => assert.equal(verdict(P({ remote_state_change: true }), rep(["none"])), "block"));
check("remote mutation + destructive blocks", () => assert.equal(verdict(P({ remote_state_change: true, destructive: true }), rep(["none"])), "block"));
check("outbound read allows by base", () => assert.equal(verdict(P({ outbound: true }), rep(["none"])), "allow"));
check("outbound writing outside cwd needs review", () =>
  assert.equal(verdict(P({ outbound: true, local_state_change: true }), rep(["system"])), "block"));
check("egress requires review", () => assert.equal(verdict(P({ egress: true }), rep(["none"])), "block"));
check("local mutation in cwd allows", () => assert.equal(verdict(P({ local_state_change: true }), rep(["cwd"])), "allow"));
check("local mutation outside cwd blocks", () => assert.equal(verdict(P({ local_state_change: true }), rep(["other"])), "block"));
check("local mutation with no scope blocks", () => assert.equal(verdict(P({ local_state_change: true }), rep(["none"])), "block"));
check("read of allowlisted home path allows", () => {
  const r = rep(["home"], [join(home, ".pi", "agent", "config.json")]);
  assert.equal(verdict(P(), r), "allow");
});
check("read of non-allowlisted home path blocks", () => {
  const r = rep(["home"], [join(home, ".ssh", "id_rsa")]);
  assert.equal(verdict(P(), r), "block");
});
check("outbound reads still check private paths", () => {
  const r = rep(["home"], [join(home, "Documents", "private.txt")]);
  assert.equal(decide(P({ outbound: true }), r, opts).reason, "base:read-outside-allowlist");
});
check("read with unresolved home scope blocks", () => assert.equal(verdict(P(), rep(["home"], [])), "block"));
check("system read allows by base", () => {
  const r = rep(["system"], ["/etc/passwd"]);
  assert.equal(verdict(P(), r), "allow");
});

console.log("# guards");
check("read-only blocks mutation even when base would allow", () => {
  const o = { ...opts, guards: { ...NO_GUARDS, readOnly: true } };
  assert.equal(decide(P({ local_state_change: true }), rep(["cwd"]), o).reason, "read-only");
});
check("read-only blocks remote mutation even without a local write", () => {
  const o = { ...opts, guards: { ...NO_GUARDS, readOnly: true } };
  assert.equal(decide(P({ remote_state_change: true }), rep(["none"]), o).reason, "read-only");
});
check("remote-read-only blocks remote mutation", () => {
  const o = { ...opts, guards: { ...NO_GUARDS, remoteReadOnly: true } };
  assert.equal(decide(P({ remote_state_change: true }), rep(["none"]), o).reason, "remote-read-only");
});

console.log("# file tools");
check("write inside cwd allows", () => {
  const p = filePrimitives("write", join(cwd, "src", "x.ts"));
  const r = scopeForPath(join(cwd, "src", "x.ts"), cwd, home);
  assert.equal(decide(p, r, opts).verdict, "allow");
});
check("write to /etc blocks", () => {
  const p = filePrimitives("write", "/etc/hosts");
  const r = scopeForPath("/etc/hosts", cwd, home);
  assert.equal(decide(p, r, opts).verdict, "block");
});
check("read of ~/.ssh/id_rsa blocks as secrets", () => {
  const p = filePrimitives("read", join(home, ".ssh", "id_rsa"));
  assert.equal(p.exposes_secrets, true);
  const r = scopeForPath(join(home, ".ssh", "id_rsa"), cwd, home);
  assert.equal(decide(p, r, opts).verdict, "block");
});
check("read of ~/.pi file allows", () => {
  const target = join(home, ".pi", "agent", "config", "activity.json");
  const p = filePrimitives("read", target);
  assert.equal(decide(p, scopeForPath(target, cwd, home), opts).verdict, "allow");
});
check("secret path shapes", () => {
  assert.equal(looksSecret(join(home, ".ssh", "id_rsa")), true);
  assert.equal(looksSecret(join(home, ".ssh", "id_rsa.pub")), false);
  assert.equal(looksSecret(join(home, ".aws", "credentials")), true);
  assert.equal(looksSecret("/etc/shadow"), true);
  assert.equal(looksSecret("/etc/hosts"), false);
  assert.equal(looksSecret(join(home, ".pi", "agent", "auth.json")), true);
});
check("read of ~/.pi/agent/auth.json blocks despite allowlist", () => {
  const target = join(home, ".pi", "agent", "auth.json");
  const p = filePrimitives("read", target);
  assert.equal(p.exposes_secrets, true);
  assert.equal(decide(p, scopeForPath(target, cwd, home), opts).verdict, "block");
});
check("symlinked file reads and new write parents use canonical targets", () => {
  const dir = mkdtempSync(join(cwd, "symlink-test-"));
  try {
    symlinkSync(join(home, ".pi", "agent", "auth.json"), join(dir, "alias"));
    assert.equal(looksSecret(canonicalFilePath(join(dir, "alias"), cwd, home)), true);
    assert.equal(scopeForPath(join(dir, "alias"), cwd, home).scope[0], "home");
    symlinkSync(home, join(dir, "out"));
    assert.equal(scopeForPath(join(dir, "out", "new.txt"), cwd, home).scope[0], "home");
    const danglingTarget = join(home, `acclass-new-${process.pid}.txt`);
    symlinkSync(danglingTarget, join(dir, "dangling"));
    assert.equal(canonicalFilePath(join(dir, "dangling"), cwd, home), danglingTarget);
    assert.equal(scopeForPath(join(dir, "dangling"), cwd, home).scope[0], "home");
    symlinkSync(join(home, `acclass-new-dir-${process.pid}`), join(dir, "dangling-parent"));
    assert.equal(scopeForPath(join(dir, "dangling-parent", "child.txt"), cwd, home).scope[0], "home");
    symlinkSync(dir, join(tmpdir(), `ac-cwd-${process.pid}`));
    try {
      assert.equal(scopeForPath(join(dir, "new.txt"), join(tmpdir(), `ac-cwd-${process.pid}`), home).scope[0], "cwd");
    } finally {
      rmSync(join(tmpdir(), `ac-cwd-${process.pid}`));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
check("path classification", () => {
  assert.equal(classifyPath(join(cwd, "a"), cwd, home), "cwd");
  assert.equal(classifyPath("/tmp/x", cwd, home), "tmp");
  assert.equal(classifyPath(join(home, "x"), cwd, home), "home");
  assert.equal(classifyPath("/etc/passwd", cwd, home), "system");
  assert.equal(classifyPath("/opt/elsewhere/x", cwd, home), "system");
});

if (!process.env.ACCLASS_TEST_MODEL) {
  console.log("  pending live classifier checks: set ACCLASS_TEST_MODEL to a trained nine-head model");
} else {
console.log("# classifier (live)");
const classifier = new Classifier({
  enabled: true,
  binary: process.env.ACCLASS_TEST_BINARY ?? join(homedir(), ".acclass/bin/acclass"),
  socket: "/tmp/ac_wiring_test.sock",
  model: process.env.ACCLASS_TEST_MODEL,
  quant: "q8",
  spawn: true,
  startTimeoutMs: 20000,
  requestTimeoutMs: 3000,
  readAllowlist: allow,
});

try {
  const ls = await classifier.classify("ls -la", cwd, home);
  if (!ls.ok) throw new Error(`classify failed: ${ls.message}`);
  console.log(`  ok  classify ls -la (${ls.ms}ms, scope=${ls.scope.join(",")})`);
} catch (err) {
  failures++;
  console.error(`FAIL  classify ls -la: ${err.message}`);
}

try {
  const secret = await classifier.classify("cat ~/.ssh/id_rsa", cwd, home);
  if (!secret.ok) throw new Error(`classify failed: ${secret.message}`);
  assert.equal(secret.scope.includes("home"), true, `scope=${secret.scope.join(",")}`);
  assert.equal(secret.preds.exposes_secrets, true, "expected exposes_secrets");
  assert.equal(decide(secret.preds, { scope: secret.scope, paths: secret.paths }, opts).verdict, "block");
  console.log("  ok  secret read classify + policy");
} catch (err) {
  failures++;
  console.error(`FAIL  secret read: ${err.message}`);
}

try {
  const auth = await classifier.classify("cat ~/.pi/agent/auth.json", cwd, home);
  if (!auth.ok) throw new Error(`classify failed: ${auth.message}`);
  assert.equal(auth.preds.exposes_secrets, true, `expected exposes_secrets, scope=${auth.scope.join(",")}`);
  assert.equal(decide(auth.preds, { scope: auth.scope, paths: auth.paths }, opts).verdict, "block");
  console.log("  ok  local model flags ~/.pi/agent/auth.json as secrets");
} catch (err) {
  failures++;
  console.error(`FAIL  pi auth secret probe: ${err.message}`);
}

try {
  const scoped = await classifier.scope("cd /etc && rm ./passwd", cwd, home);
  assert.deepEqual(scoped.scope, ["system"]);
  assert.deepEqual(scoped.paths.outside, ["/etc/passwd"]);
  console.log("  ok  daemon-free scope CLI");
} catch (err) {
  failures++;
  console.error(`FAIL  scope CLI: ${err.message}`);
} finally {
  classifier.stop();
}
}

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
