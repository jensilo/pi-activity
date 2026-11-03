// Synthetic installation + real managed verifier/client/Unix daemon. No downloads or providers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import activityExtension from "../index.ts";
import { createManagedEvidenceProvider } from "../evidence-provider.ts";
import { fixtureIdentity, readyResponse, wireResponse, withNativeTools } from "./nine-head-fixtures.mjs";

const metadata = ["config.json", "tokenizer.json", "thresholds.json", "heads.json", "model_contract.json"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = await realpath(await mkdtemp(join(tmpdir(), "a-md-")));
const saved = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_TASK", "PI_SUBAGENT_POLICY_CONTEXT_FD", "PI_ACTIVITY_AUTO_MODE",
  "ACTIVITY_TEST_CREDENTIAL", "NODE_OPTIONS", "RAYON_NUM_THREADS", "CANDLE_NUM_THREADS"]
  .map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let fetches = 0;

// The executable is self-contained: it reads only synthetic files in its HOME.
// Protocol fixtures provide the exact nine-head/readiness shape; hashes use real bytes.
const daemon = `#!${process.execPath}
const { appendFileSync, chmodSync, existsSync, readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { createServer } = require("node:net");
const { join } = require("node:path");
process.umask(0o077);
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
const socket = args[args.indexOf("--socket") + 1];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const files = [...${JSON.stringify(metadata)}, args.includes("--gguf") ? "model.gguf" : "model.safetensors"];
const identity = { protocol: "acclass-daemon/1", loading_mode: args.includes("--gguf") ? "gguf" : "f32",
  artifacts: Object.fromEntries(files.map(name => [name, hash(readFileSync(join(model, name)))])),
  binary_sha256: hash(readFileSync(__filename)) };
const record = (event, extra = {}) => appendFileSync(join(process.env.HOME, "daemon.ndjson"),
  JSON.stringify({ event, pid: process.pid, socket, ...extra }) + "\\n", { mode: 0o600 });
record("start", { args, identity, envKeys: Object.keys(process.env).sort(), threads: process.env.RAYON_NUM_THREADS });
const server = createServer(connection => {
  connection.on("error", () => {});
  let input = "";
  connection.on("data", bytes => {
    input += bytes.toString("utf8");
    const newline = input.indexOf("\\n");
    if (newline < 0) return;
    const request = JSON.parse(input.slice(0, newline));
    record(request.ping ? "ping" : "classify", { request });
    const response = request.ping ? ${JSON.stringify(readyResponse())} : ${JSON.stringify(wireResponse())};
    response.identity = !request.ping && existsSync(join(process.env.HOME, "bad-identity"))
      ? { ...identity, binary_sha256: "0".repeat(64) } : identity;
    connection.end(JSON.stringify(response) + "\\n");
  });
});
server.listen(socket, () => chmodSync(socket, 0o600));
process.once("SIGTERM", () => { record("stop"); server.close(() => process.exit(0)); });
`;

async function install(home, variant) {
  const base = join(home, ".acclass");
  const version = join(base, "versions", `1.0.0-${variant}`);
  // Set every directory explicitly: recursive mkdir alone does not set intermediate modes.
  for (const path of [home, base, join(base, "versions"), version, join(version, "bin"), join(version, "model")]) {
    await mkdir(path, { mode: 0o700 });
  }
  const files = [...metadata, variant === "fp32" ? "model.safetensors" : "model.gguf"];
  const modelBytes = Object.fromEntries(files.map((name) => [name, Buffer.from(`synthetic ${variant} ${name}\n`)]));
  const asset = (bytes, url) => ({ url, sha256: hash(bytes), size: Buffer.byteLength(bytes) });
  const manifest = JSON.stringify({ schema: "acclass-release/2", version: "1.0.0",
    binaries: { "linux-x86_64": asset("synthetic archive, never downloaded", "https://example.invalid/engine.tar.gz") },
    models: { [variant]: Object.fromEntries(files.map((name) => [name, asset(modelBytes[name], `https://example.invalid/${variant}/${name}`)])) } });
  const inventory = { "bin/acclass": daemon, "release.json": manifest,
    ...Object.fromEntries(files.map((name) => [`model/${name}`, modelBytes[name]])) };
  for (const [name, bytes] of Object.entries(inventory)) await writeFile(join(version, name), bytes, { mode: 0o600 });
  await chmod(join(version, "bin/acclass"), 0o700);
  await writeFile(join(version, "INSTALLATION.json"), JSON.stringify({ schema: "acclass-installation/2", version: "1.0.0",
    model: variant, platform: "linux-x86_64", manifest_sha256: hash(manifest),
    files_sha256: Object.fromEntries(Object.entries(inventory).map(([name, bytes]) => [name, hash(bytes)])) }), { mode: 0o600 });
  await symlink(`versions/1.0.0-${variant}`, join(base, "current"));
  return { base, version, binary: join(version, "bin/acclass"), model: join(version, "model"),
    socket: join(base, "run", `1.0.0-${variant}`, "ac.sock") };
}

async function events(home) {
  try { return (await readFile(join(home, "daemon.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function waitForExit(pid, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (alive(pid) && Date.now() < deadline) await sleep(20);
  return !alive(pid);
}

function gate(home) {
  const handlers = {};
  let reviews = 0, calls = 0;
  const ctx = { cwd: home, hasUI: false, mode: "print",
    model: { provider: "synthetic", id: "never-contacted" },
    sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => "managed-daemon" },
    ui: { notify() {}, setStatus() {}, theme: { fg: (_color, text) => text } } };
  // Only the judge is a stub. Setup, provider selection, verification and transport are production paths.
  activityExtension({ on(name, handler) { handlers[name] = handler; }, registerFlag() {}, registerCommand() {},
    getFlag: (name) => name === "auto", getAllTools: () => withNativeTools(), appendEntry() {}, sendMessage() {}, events: { emit() {} } },
  async () => { reviews++; return { ok: true, allow: false, decision: "block", reason: "Synthetic judge refusal" }; }, "native");
  return { get reviews() { return reviews; },
    start: () => handlers.session_start({ reason: "startup" }, ctx),
    call: () => handlers.tool_call({ toolName: "bash", toolCallId: `managed-daemon-${++calls}`,
      input: { command: "synthetic-command --status" } }, ctx),
    stop: () => handlers.session_shutdown({}, ctx) };
}

try {
  globalThis.fetch = async () => { fetches++; throw new Error("Synthetic test forbids network"); };
  delete process.env.PI_SUBAGENT_TASK;
  delete process.env.PI_SUBAGENT_POLICY_CONTEXT_FD;
  delete process.env.PI_ACTIVITY_AUTO_MODE;
  process.env.ACTIVITY_TEST_CREDENTIAL = "synthetic-do-not-forward";
  process.env.NODE_OPTIONS = "--require=/synthetic/do-not-load";
  process.env.RAYON_NUM_THREADS = "3";
  process.env.CANDLE_NUM_THREADS = "invalid-thread-count";
  for (const variant of ["q8", "q5", "fp32"]) {
    const home = join(root, variant);
    const f = await install(home, variant);
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
    // No explicit binary/model/socket, and no injected verifier, client or spawner.
    const provider = createManagedEvidenceProvider({ enabled: true, variant });
    let extension;
    try {
      assert.equal(await readlink(join(f.base, "current")), `versions/1.0.0-${variant}`);
      const call = () => provider.classify("synthetic-command --status", home, home);
      const first = await call();
      assert.equal(first.ok, true, first.message);
      assert.equal(first.identity.daemonIdentityVerified, true);
      assert.equal(first.identity.configuredBinary, f.binary);
      assert.equal(first.identity.configuredModel, f.model);
      assert.equal(first.identity.configuredQuant, variant === "fp32" ? "f32" : "q8");
      assert.deepEqual(first.preds, wireResponse().preds);
      assert.deepEqual(first.probs, wireResponse().probs);
      assert.deepEqual(first.scope, { scope: ["cwd"], paths: { inside: [], outside: [] }, scopeComplete: true });
      assert.equal(first.inputComplete, true);
      assert.equal(first.tokenCount, 12);
      for (const path of [home, f.base, join(f.base, "run"), dirname(f.socket)]) {
        assert.equal((await lstat(path)).mode & 0o777, 0o700, path);
      }
      assert.equal((await lstat(f.socket)).isSocket(), true);
      assert.equal((await lstat(f.socket)).mode & 0o777, 0o600);
      const start = (await events(home)).filter((event) => event.event === "start");
      assert.equal(start.length, 1);
      const pid = start[0].pid;
      assert.equal(alive(pid), true);
      assert.equal(start[0].socket, f.socket, "socket is version/variant-specific");
      assert.deepEqual(start[0].envKeys, ["HOME", "LANG", "PATH", "RAYON_NUM_THREADS"],
        "engine inherits neither credentials nor interpreter/loader hooks");
      assert.equal(start[0].threads, "3", "only valid numeric thread settings are forwarded");
      assert.deepEqual(start[0].args, ["serve", "--model", f.model, "--socket", f.socket,
        ...(variant === "fp32" ? ["--quant", "f32"] : ["--gguf"])]);
      assert.deepEqual(start[0].identity, fixtureIdentity(f.model, f.binary, variant === "fp32" ? "f32" : "q8"));
      assert.equal((await call()).ok, true, "a second classification reuses the daemon");
      let recorded = await events(home);
      assert.equal(recorded.filter((event) => event.event === "start").length, 1);
      assert.equal(recorded.filter((event) => event.event === "classify").length, 2);
      assert.ok(recorded.some((event) => event.event === "ping"), "real readiness handshake ran");
      for (const event of recorded.filter((event) => event.event === "classify")) {
        assert.deepEqual(event.request, { cmd: "synthetic-command --status", cwd: home, home, input_kind: "shell" });
      }

      await writeFile(join(home, "bad-identity"), "synthetic response tampering", { mode: 0o600 });
      const mismatch = await call();
      assert.equal(mismatch.ok, false);
      assert.equal(mismatch.identity.daemonIdentityVerified, false);
      assert.match(mismatch.message, /incompatible classifier daemon identity/);
      await rm(join(home, "bad-identity"));
      assert.equal((await call()).ok, true, "matching responses remain usable without respawning");

      if (variant === "q8") {
        extension = gate(home);
        await extension.start();
        assert.deepEqual(JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR, "config/activity.json"), "utf8")),
          { acclass: { enabled: true, variant: "q8" } }, "first-start config contains no manual daemon paths");
        assert.notEqual((await extension.call())?.block, true, "verified negative shell evidence can fast allow");
        assert.equal(extension.reviews, 0);
      }
      recorded = await events(home);
      const inferences = recorded.filter((event) => event.event === "classify").length;
      assert.equal(recorded.filter((event) => event.event === "start").length, 1, "all calls share the original daemon");
      await writeFile(join(f.model, "config.json"), "synthetic corrupted metadata\n");
      const corrupt = await call();
      assert.equal(corrupt.ok, false);
      assert.equal(corrupt.kind, "unavailable");
      assert.equal(corrupt.identity.daemonIdentityVerified, false);
      assert.match(corrupt.message, /verification\/use failed.*judge fallback/);
      assert.equal(await waitForExit(pid), true, "verification failure stops the owned daemon");
      assert.equal((await call()).ok, false, "corrupt artifacts cannot recreate a client");
      if (extension) {
        assert.equal((await extension.call())?.block, true, "corruption cannot use cached evidence to fast allow at the extension gate");
        assert.equal(extension.reviews, 1, "failed real managed verification reaches the synthetic judge");
      }
      recorded = await events(home);
      assert.equal(recorded.filter((event) => event.event === "classify").length, inferences, "corruption blocks cached-client transport");
      assert.equal(recorded.filter((event) => event.event === "start").length, 1, "no unchecked replacement daemon");
      assert.equal(recorded.filter((event) => event.event === "stop").length, 1, "owned child received SIGTERM");
    } finally {
      try { await extension?.stop(); }
      finally {
        provider.stop();
        // Only PIDs emitted by our own synthetic executable are eligible for cleanup.
        for (const { pid } of (await events(home)).filter((event) => event.event === "start")) {
          if (!await waitForExit(pid)) {
            process.kill(pid, "SIGKILL");
            assert.equal(await waitForExit(pid), true, "owned fixture process must exit before HOME removal");
          }
        }
      }
    }
  }
  assert.equal(fetches, 0, "installed managed runtime stays offline");
  console.log("managed daemon tests passed (q8/q5/fp32, real verification/start/reuse, identity, corruption, gate fallback, child cleanup)");
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  await rm(root, { recursive: true, force: true });
}
