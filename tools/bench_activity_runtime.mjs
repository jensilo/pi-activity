// Real runtime serializer -> classifier -> tool_call gate. Candidates are NEVER executed.
// Explicit --live loads Q8 weights; reviewer is always a deterministic fixture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdtempSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withNativeTools } from "../activity/test/nine-head-fixtures.mjs";

const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
  console.log("SKIP: use --live for real Q8 inference with a fixture reviewer. No providers, auth, private inputs or candidate execution. See docs/testing.md.");
} else if (args.length !== 1 || args[0] !== "--live") {
  console.error("Usage: jiti tools/bench_activity_runtime.mjs [--live|--help]");
  process.exitCode = 1;
} else {
  await run();
}

function expand(path) {
  return resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function distribution(values) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  const round = (value) => Number(value.toFixed(3));
  const percentile = (p) => round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]);
  return { count: values.length, min: round(sorted[0]), p50: percentile(0.5), p95: percentile(0.95), max: round(sorted.at(-1)) };
}
async function sourcePins(root) {
  const names = ["package.json", ...readdirSync(join(root, "activity")).filter((name) => name.endsWith(".ts"))
    .map((name) => `activity/${name}`)].sort();
  const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await sha256(join(root, name))])));
  return { root, files_sha256: files, manifest_sha256: digest(JSON.stringify(files)) };
}
async function packagePin(name) {
  const entry = createRequire(import.meta.url).resolve(name);
  let dir = dirname(entry);
  while (!existsSync(join(dir, "package.json"))) {
    assert.notEqual(dirname(dir), dir);
    dir = dirname(dir);
  }
  const path = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  return { name: pkg.name, version: pkg.version, root: realpathSync(dir),
    package_json_sha256: await sha256(path), entry_sha256: await sha256(entry) };
}

// Match the installed converter's GGUF format. Reject F32 masquerading as Q8.
function checkQ8(model, heads) {
  const contract = JSON.parse(readFileSync(join(model, "model_contract.json"), "utf8"));
  assert.equal(contract.schema, "acclass-vnext-model/1");
  assert.deepEqual(contract.heads, heads);
  assert.equal(contract.num_labels, 9);
  assert.equal(contract.context_limit_inclusive, 2048);
  assert.deepEqual(JSON.parse(readFileSync(join(model, "heads.json"), "utf8")), heads);
  const fd = openSync(join(model, "model.gguf"), "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    let offset = 0;
    const take = (length) => {
      assert.ok(Number.isSafeInteger(length) && length >= 0 && offset + length <= bytes);
      const value = buffer.subarray(offset, offset + length);
      offset += length;
      return value;
    };
    const u32 = () => take(4).readUInt32LE();
    const u64 = () => Number(take(8).readBigUInt64LE());
    assert.equal(take(4).toString(), "GGUF");
    assert.ok([2, 3].includes(u32()));
    const count = u64();
    assert.ok(count > 0 && count <= 512);
    assert.equal(u64(), 0, "expected metadata-free acclass GGUF");
    let quantized = 0;
    let classifier = false;
    for (let i = 0; i < count; i++) {
      const name = take(u64()).toString("utf8");
      const rank = u32();
      assert.ok(rank === 1 || rank === 2);
      const dims = Array.from({ length: rank }, u64);
      const type = u32();
      u64();
      const q8 = rank === 2 && name !== "classifier.weight";
      assert.equal(type, q8 ? 8 : 0);
      if (q8) quantized++;
      if (name === "classifier.weight") { assert.deepEqual(dims, [768, 9]); classifier = true; }
    }
    assert.ok(classifier && quantized > 0);
    return { format: "GGUF Q8_0 matrices / F32 norms and classifier", quantized_matrices: quantized };
  } finally { closeSync(fd); }
}

async function run() {
  let stage = "configuration";
  let dir, handlers, prototype, originalClassify;
  const instances = new Set();
  const priorEnv = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_ACTIVITY_AUTO_MODE", "PI_SUBAGENT_TASK"]
    .map((key) => [key, process.env[key]]));
  try {
    const repeats = Number(process.env.ACCLASS_BENCH_REPEATS ?? "10");
    assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 100);
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const output = process.env.ACCLASS_BENCH_OUT ? expand(process.env.ACCLASS_BENCH_OUT) : undefined;
    if (output) {
      // Benchmark reports carry host paths and artifact identities. Keep them private.
      assert.ok(output.endsWith(".json"), "output must be a private .json path");
      assert.ok(!existsSync(output), "refuse to overwrite an existing report or symlink");
      let parent = dirname(output);
      while (!existsSync(parent)) parent = dirname(parent);
      parent = realpathSync(parent);
      while (true) {
        assert.ok(!existsSync(join(parent, ".git")), "output must remain outside every Git worktree");
        if (dirname(parent) === parent) break;
        parent = dirname(parent);
      }
    }
    const root = realpathSync(expand(process.env.ACCLASS_TEST_EXTENSION_ROOT ?? repo));
    const binary = realpathSync(expand(process.env.ACCLASS_TEST_BINARY ?? "~/.acclass/bin/acclass"));
    const model = realpathSync(expand(process.env.ACCLASS_TEST_MODEL ?? "~/.acclass/model"));
    stage = "identity preflight";
    const source = await sourcePins(root);
    const modelFiles = ["config.json", "tokenizer.json", "thresholds.json", "heads.json", "model_contract.json", "model.gguf"];
    const artifactPins = async () => ({ protocol: "acclass-daemon/1", loading_mode: "gguf",
      artifacts: Object.fromEntries(await Promise.all(modelFiles.map(async (name) => [name, await sha256(join(model, name))]))),
      binary_sha256: await sha256(binary) });
    const identity = await artifactPins();
    const packages = await Promise.all(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox", "jiti"].map(packagePin));

    dir = mkdtempSync(join(tmpdir(), "ac-runtime-"));
    const cwd = join(dir, "project");
    mkdirSync(cwd);
    mkdirSync(join(dir, "config"));
    const providerConfig = { provider: "acclass", binary, model, socket: join(dir, "classifier.sock"), quant: "q8", spawn: true,
      startTimeoutMs: 120_000, requestTimeoutMs: 60_000 };
    writeFileSync(join(dir, "config/activity.json"), JSON.stringify({
      acclass: { enabled: false },
      policy: { trustedTools: [], questionnaireSources: [] }, guards: { readOnly: false, remoteReadOnly: false },
      auto: { judgeModel: "fixture/judge", fallbackJudgeModel: null, summaryModel: "fixture/summary" },
      log: { enabled: false }, reviewLog: { enabled: false },
    }), { mode: 0o600 });
    process.env.PI_CODING_AGENT_DIR = dir;
    delete process.env.PI_ACTIVITY_AUTO_MODE;
    delete process.env.PI_SUBAGENT_TASK;
    stage = "source imports and Q8 validation";
    const jiti = createJiti(import.meta.url);
    const load = (file) => jiti.import(pathToFileURL(join(root, "activity", file)).href);
    const { Classifier } = await load("classifier.ts");
    const { HEADS, hardGuardDecision } = await load("policy.ts");
    const { default: activityExtension } = await load("index.ts");
    const { createEvidenceProvider } = await load("evidence-provider.ts");
    const quantization = checkQ8(model, HEADS);
    const lookup = { name: "mcp__fixture__lookup", description: "Returns inert public catalog data. Backend metadata is unverified.",
      parameters: Type.Object({ key: Type.String({ default: "catalog" }),
        payload: Type.Optional(Type.Readonly(Type.Object({ text: Type.String(), enabled: Type.Boolean(), extra: Type.Null(),
          options: Type.Optional(Type.Array(Type.Unsafe({ type: "string", default: "inert" }))) }))) },
        { "x-public-extension": { kept: true } }),
      namespace: { name: "fixture", description: "Unverified catalog" },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, exposure: "codemode" };
    const deletion = { name: "mcp__fixture__delete", description: "Deletes existing remote production records through a nonlocal API, disrupting availability. Metadata is unverified.",
      parameters: Type.Object({ operation: Type.Literal("delete"), endpoint: Type.String(), id: Type.String(),
        options: Type.Optional(Type.Readonly(Type.Unsafe({ type: "object", default: { inert: true } }))) }),
      namespace: { name: "fixture", description: "Unverified remote record service" },
      annotations: { readOnlyHint: true, destructiveHint: false }, exposure: "deferred" };
    const secret = { name: "mcp__fixture__secret_lookup", description: "Returns the plaintext private API credential value for a stored secret. Metadata is unverified.",
      parameters: Type.Object({ key: Type.String(), reveal: Type.Boolean() }), namespace: { name: "fixture" },
      annotations: { readOnlyHint: true }, exposure: "direct" };
    const tools = [lookup, deletion, secret];
    const samples = [
      { id: "read-lookup", tool: lookup.name, input: { key: "public-catalog-42", payload: { text: "synthetic Unicode ☃", enabled: false, extra: null, options: ["inert"] } } },
      { id: "delete-remote", tool: deletion.name, input: { operation: "delete", endpoint: "https://records.example/production", id: "synthetic-42", options: { inert: true } } },
      { id: "secret-lookup", tool: secret.name, input: { key: "fictional-api-credential", reveal: true } },
      { id: "unknown-metadata", tool: "mcp__unknown__lookup", input: { key: "synthetic-42", computed: [false, null, "☃"] } },
      { id: "near-long-arguments", tool: lookup.name, input: { key: "synthetic-long", payload: { text: "inert ".repeat(1700), enabled: false, extra: null } } },
    ];
    const fixtureHash = digest(JSON.stringify({ tools, samples }));
    handlers = {};
    const commands = {};
    let active;
    const pi = { registerFlag() {}, registerCommand(name, spec) { commands[name] = spec.handler; },
      on(name, handler) { handlers[name] = handler; }, getFlag(name) { return name === "auto"; },
      getAllTools() { return withNativeTools(tools); }, appendEntry() {}, sendMessage() {}, events: { emit() {} } };
    const ctx = { cwd, hasUI: false, mode: "print", sessionManager: SessionManager.inMemory(cwd),
      ui: { notify() {}, setStatus() {}, theme: { fg: (_color, text) => text } } };
    prototype = Classifier.prototype;
    originalClassify = prototype.classify;
    prototype.classify = async function (...args) {
      instances.add(this);
      const started = performance.now();
      const result = await originalClassify.apply(this, args);
      const wallMs = performance.now() - started;
      // Meter the actual result, never replace inference or predictions.
      if (active) active.classifications.push({ args, result, wallMs });
      return result;
    };
    activityExtension(pi, async (...args) => {
      active.reviews.push({ tool: args[2], input: args[3], modes: args[5], metadata: args[11] });
      return { ok: active.outcome !== "unavailable", allow: active.outcome === "allow", reason: "deterministic benchmark reviewer" };
    }, "native", (_settings) => createEvidenceProvider(providerConfig));
    await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
    let callId = 0;
    async function gate(sample, guard = false, outcome = "allow") {
      active = { classifications: [], reviews: [], outcome };
      const started = performance.now();
      const result = await handlers.tool_call({ type: "tool_call", toolName: sample.tool, toolCallId: `synthetic-${++callId}`,
        parentToolCallId: "synthetic-codemode", input: sample.input }, ctx);
      const wallMs = performance.now() - started;
      const observed = active;
      active = undefined;
      assert.equal(observed.classifications.length, 1, "actual runtime classifier must be metered");
      const inference = observed.classifications[0];
      assert.equal(inference.args[3], "action");
      const evidence = JSON.parse(inference.args[0]);
      assert.equal(evidence.representation, "runtime-action-evidence-json/1");
      assert.equal(evidence.evidence_status.prediction_eligibility, "positive-risk-signals-only");
      assert.equal(evidence.evidence_status.backend_behavior, "unverified");
      assert.ok(!("backend_contract" in evidence));
      assert.deepEqual(evidence.evaluated_arguments, sample.input, "full evaluated arguments, no clipping");
      assert.equal(evidence.tool_name, sample.tool);
      const info = tools.find((tool) => tool.name === sample.tool);
      const metadata = info ? Object.fromEntries(["description", "parameters", "namespace", "annotations", "exposure"].map((key) => [key, info[key]])) : undefined;
      assert.deepEqual(evidence.tool_metadata, metadata ? JSON.parse(JSON.stringify(metadata)) : null);
      assert.equal(inference.result.ok, true, "complete real inference required");
      assert.equal(inference.result.inputComplete, true);
      assert.ok(inference.result.tokenCount >= 1 && inference.result.tokenCount <= 2048);
      if (sample.id === "near-long-arguments") assert.ok(inference.result.tokenCount >= 1900, "fixture must be near the full token limit");
      const positives = HEADS.filter((head) => inference.result.preds[head]);
      const guardSignal = guard && !!hardGuardDecision(Object.fromEntries(positives.map((head) => [head, true])), { readOnly: true, remoteReadOnly: false });
      assert.equal(result?.block === true, outcome !== "allow", "guard routing follows reviewer outcome");
      assert.equal(observed.reviews.length, 1, "unverified calls review even with positive guard signals");
      for (const review of observed.reviews) {
        assert.equal(review.tool, sample.tool);
        assert.deepEqual(review.input, sample.input);
        assert.deepEqual(review.modes, { auto: true, readOnly: guard, remoteReadOnly: false }, "authoritative benchmark guard modes");
        assert.deepEqual(review.metadata, metadata, "real TypeBox metadata reaches fixture reviewer unchanged");
      }
      return { wallMs, classifierMs: inference.wallMs, engineMs: inference.result.ms, tokens: inference.result.tokenCount,
        positives, reviews: observed.reviews.length, guardSignal: Number(guardSignal), blocked: Number(result?.block === true) };
    }
    stage = "excluded classifier and gate warmup";
    for (const sample of samples) await gate(sample);
    const summarize = (rows) => ({ calls: rows.length, gate_wall_ms: distribution(rows.map((row) => row.wallMs)),
      classifier_client_wall_ms: distribution(rows.map((row) => row.classifierMs)), engine_inference_ms: distribution(rows.map((row) => row.engineMs)),
      full_input_token_counts: Object.fromEntries([...new Set(rows.map((row) => row.tokens))].sort((a, b) => a - b)
        .map((count) => [count, rows.filter((row) => row.tokens === count).length])),
      positive_signals: Object.fromEntries(HEADS.map((head) => [head, rows.filter((row) => row.positives.includes(head)).length])),
      fixture_reviewer_calls: rows.reduce((n, row) => n + row.reviews, 0), guard_signal_review_count: rows.reduce((n, row) => n + row.guardSignal, 0),
      blocked_calls: rows.reduce((n, row) => n + row.blocked, 0) });
    stage = "serial measured tool_call hooks";
    const measured = [];
    const perFixture = {};
    for (const sample of samples) {
      const rows = [];
      for (let i = 0; i < repeats; i++) rows.push(await gate(sample));
      measured.push(...rows);
      perFixture[sample.id] = summarize(rows);
    }
    stage = "positive-signal read-only review measurements";
    await commands["read-only"]("on", ctx);
    // Validate fail-closed reviewer outcomes outside the measured always-allow rows.
    for (const outcome of ["deny", "unavailable"]) await gate(samples[1], true, outcome);
    const guardRows = [];
    for (let i = 0; i < repeats; i++) guardRows.push(await gate(samples[1], true));
    await commands["read-only"]("off", ctx);
    assert.ok(guardRows.every((row) => row.guardSignal === 1 && row.reviews === 1 && row.blocked === 0),
      "remote deletion must review positive guard signals and permit fixture allow verdicts");
    stage = "final identity verification";
    assert.deepEqual(await sourcePins(root), source, "source changed during benchmark");
    assert.deepEqual(await artifactPins(), identity, "binary/model changed during benchmark");
    const report = { schema: "acclass-activity-runtime-benchmark/1", timestamp: new Date().toISOString(),
      identities: { extension: source, binary, model, daemon: identity, quantization, packages,
        benchmark_sha256: await sha256(fileURLToPath(import.meta.url)), fixtures_sha256: fixtureHash },
      runtime: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logical_cpus: cpus().length },
      method: { repeats_per_fixture: repeats, measured_calls: measured.length, guard_calls: guardRows.length,
        excluded_warmup_calls: samples.length, excluded_guard_verdict_checks: 2, execution: "serial grouped fixtures, nested tool_call hooks only",
        percentile: "nearest rank", reviewer: "deterministic always-allow measured fixture; excluded deny/unavailable guard checks; no backend/provider/auth access",
        gate_wall: "full tool_call hook, including production serialization, classification, fixture review and gate bookkeeping",
        classifier_wall: "actual Classifier.classify call including identity/readiness/socket overhead; result unchanged",
        inference: "engine-reported model forward ms; excludes tokenization and classifier warmup", tokens: "engine full input token_count, including metadata and representation; no clipping",
        logs: "both production loggers disabled; no raw prompts, arguments or per-call traces retained on disk" },
      limitations: ["Five inert synthetic calls are not production workload, backend verification, accuracy or live reviewer safety evidence.",
        "Near-long arguments use a fixed synthetic payload; metadata and tokenizer pins determine full length.",
        "Fixture review has no real provider latency; this measures local gate overhead, not live end-to-end review latency.",
        "Small repeated serial samples are cache-warm, order-dependent and hardware-sensitive; p95 is descriptive, not a statistical guarantee."],
      aggregate: summarize(measured), fixtures: perFixture, read_only_remote_delete_guard: summarize(guardRows) };
    stage = "aggregate output";
    const text = JSON.stringify(report, null, 2) + "\n";
    if (output) { mkdirSync(dirname(output), { recursive: true, mode: 0o700 }); writeFileSync(output, text, { mode: 0o600, flag: "wx" }); }
    process.stdout.write(text);
  } catch {
    // Do not print assertion diffs, serialized evidence, raw engine errors or reviewer arguments.
    console.error(`Runtime benchmark failed during ${stage}; no aggregate written.`);
    process.exitCode = 1;
  } finally {
    const children = [...instances].map((instance) => instance.child).filter(Boolean);
    try { await handlers?.session_shutdown?.({ type: "session_shutdown", reason: "quit" }); }
    finally {
      for (const instance of instances) instance.stop();
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("exit", resolve));
      }
      if (prototype) prototype.classify = originalClassify;
      for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }
}
