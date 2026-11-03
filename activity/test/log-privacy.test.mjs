// Synthetic offline checks. No proposed tools, providers, credentials or real logs are used.
// Run with the installed jiti and NODE_PATH/NODE_OPTIONS from test/README.md.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../index.ts";
import activityExtension, { setFixtureProvider } from "./synthetic-runtime.mjs";
import { Classifier } from "../classifier.ts";
import { CommandLogger, ReviewLogger, rotatedLogPath } from "../logger.ts";
import { LogSanitizer, privateStoragePath } from "../privacy.ts";
import { classification, facts, createFixtureProvider, withNativeTools } from "./nine-head-fixtures.mjs";
import { actionSchema } from "./typebox-fixtures.mjs";

const file = fileURLToPath(import.meta.url);
const piRoot = process.env.PI_GLOBAL;
assert.ok(piRoot, "set PI_GLOBAL to the installed Pi package root or use npm test");
const nestedJiti = join(piRoot, "node_modules", "jiti", "lib", "jiti-cli.mjs");
const jiti = existsSync(nestedJiti) ? nestedJiti : join(dirname(dirname(piRoot)), "jiti", "lib", "jiti-cli.mjs");
const args = process.argv.slice(process.argv.indexOf(file) + 1);
const uuid = "12345678-1234-4567-89ab-123456789abc";
const secrets = {
  password: "synthetic-password-value", connectionString: "Server=synthetic-db;Database=synthetic-catalog;User ID=synthetic-user;Password=synthetic-db-password;",
  privateKey: "-----BEGIN PRIVATE KEY-----\nSYNTHETICKEYMATERIAL\n-----END PRIVATE KEY-----",
  email: "synthetic.person@example.invalid", url: "https://synthetic-user:synthetic-url-password@example.invalid/private",
  cli: `az login --tenant ${uuid} --subscription ${uuid} --resource-group synthetic-group --name synthetic-name --client-secret 'synthetic-client-secret'`,
  bearer: "Authorization: Bearer synthetic-bearer-value",
  basic: "Authorization: Basic c3ludGhldGljOmJhc2ljLXZhbHVl",
  sas: "Authorization: SharedAccessSignature sr=synthetic-sas-resource&sig=synthetic-sas-signature%2B%3D&se=synthetic-sas-expiry&skn=synthetic-sas-key-name",
  SharedAccessKey: "synthetic-shared-access-key",
  sharedConnection: "Endpoint=sb://synthetic-service.example.invalid/;SharedAccessKeyName=synthetic-shared-key-name;SharedAccessKey=synthetic-shared-access-key;EntityPath=synthetic-entity;",
  storageAssignment: "AZURE_STORAGE_KEY='synthetic-storage-key'",
  keyvault: "az keyvault secret set --vault-name synthetic-vault --name synthetic-secret-name --value 'synthetic-keyvault-value'",
  embeddedJson: '{"payload":{"secret":"synthetic-embedded-json-secret","enabled":true}}',
  query: "?sig=synthetic-query-signature%2B%3D&limit=3",
  compactUuid: "abcdef0123456789abcdef0123456789",
};
const privateTexts = [secrets.connectionString, secrets.privateKey, secrets.url, secrets.email, secrets.cli,
  secrets.bearer, secrets.basic, secrets.sas, secrets.sharedConnection, secrets.storageAssignment, secrets.keyvault,
  secrets.embeddedJson, secrets.query, secrets.compactUuid];
const forbidden = [uuid, "synthetic-password-value", "synthetic-db", "synthetic-catalog", "synthetic-user", "synthetic-db-password",
  "SYNTHETICKEYMATERIAL", "synthetic.person@example.invalid", "synthetic-url-password", "synthetic-group", "synthetic-name", "synthetic-client-secret",
  "synthetic-bearer-value", "c3ludGhldGljOmJhc2ljLXZhbHVl", "synthetic-sas-resource", "synthetic-sas-signature", "synthetic-sas-expiry", "synthetic-sas-key-name",
  "synthetic-shared-access-key", "synthetic-shared-key-name", "synthetic-entity", "synthetic-storage-key", "synthetic-vault", "synthetic-secret-name",
  "synthetic-keyvault-value", "synthetic-embedded-json-secret", "synthetic-query-signature", secrets.compactUuid];
function noSecrets(text) {
  for (const value of forbidden) assert.equal(text.includes(value), false, "a synthetic private value survived scrubbing");
}
function rows(path) {
  const text = readFileSync(path, "utf8");
  assert.ok(text.endsWith("\n"), "JSONL ends at a complete record");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}
function config(path, overrides = {}) { return { enabled: true, mode: "full", path, maxBytes: 64_000, maxFiles: 2, ...overrides }; }
let passed = 0;
let failed = 0;
async function check(name, run) {
  const dir = mkdtempSync(join(tmpdir(), "activity-log-privacy-"));
  try {
    await run(dir);
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    // Do not dump full records or synthetic action payloads on failure.
    console.error(`FAIL  ${name}: ${String(error.message).split("\n")[0]}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function child(command, ...extra) {
  return spawnSync(process.execPath, [jiti, file, command, ...extra], { encoding: "utf8", timeout: 30_000,
    env: { ...process.env, ACCLASS_TEST_MODEL: "", PI_ACTIVITY_AUTO_MODE: "", PI_SUBAGENT_TASK: "" } });
}
function worker(path, prefix) {
  return new Promise((done, fail) => {
    const proc = spawn(process.execPath, [jiti, file, "--writer", path, prefix], { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    proc.stderr.on("data", (chunk) => { error += chunk; });
    proc.on("error", fail);
    proc.on("exit", (code) => code === 0 ? done() : fail(new Error(`synthetic writer failed: ${error.split("\n")[0]}`)));
  });
}

async function gateScenario(name, dir) {
  const cwd = join(dir, "project");
  const commandsPath = join(dir, "private", "commands.jsonl");
  const reviewsPath = join(dir, "private", "reviews.jsonl");
  mkdirSync(cwd);
  mkdirSync(join(dir, "config"));
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_ACTIVITY_AUTO_MODE;
  delete process.env.PI_SUBAGENT_TASK;
  const log = config(commandsPath, { enabled: name !== "off" && name !== "review-only", mode: name === "metadata" ? "redacted" : "full" });
  const reviewLog = config(reviewsPath, { enabled: name !== "off" && name !== "command-only" });
  const settings = { acclass: setFixtureProvider(createFixtureProvider(dir)),
    auto: { judgeModel: "fixture/reviewer" }, log, reviewLog };
  if (name === "off") {
    // Exercise the actual disabled defaults, not merely explicit false overrides.
    settings.log = { path: commandsPath };
    settings.reviewLog = { path: reviewsPath };
    assert.equal(DEFAULT_CONFIG.log.enabled, false);
    assert.equal(DEFAULT_CONFIG.reviewLog.enabled, false);
  }
  if (name === "oversize") log.maxBytes = 4096;
  if (name === "dictionary-invalid") {
    const dictionary = join(dir, "invalid-dictionary.json");
    writeFileSync(dictionary, "not JSON");
    settings.redaction = { literalsFile: dictionary };
  }
  if (name === "disk-failure") {
    mkdirSync(join(dir, "private"), { mode: 0o755 });
    // Deliberately unsafe fixture, independent of the invoking process umask.
    chmodSync(join(dir, "private"), 0o755);
  }
  writeFileSync(join(dir, "config", "activity.json"), JSON.stringify(settings));
  const schema = name === "full-plain-schema" ? JSON.parse(JSON.stringify(actionSchema())) : actionSchema();
  const info = { name: "mcp__synthetic__operate", description: "Unverified synthetic server description", parameters: schema,
    namespace: { name: "synthetic", description: "Available namespace metadata", instructions: "Unverified instructions" },
    annotations: { readOnlyHint: true, destructiveHint: false }, exposure: "deferred" };
  const wrapperScenario = name.startsWith("builtin-wrapper");
  const replacementScenario = name === "replacement-codemode";
  const codemodeInfo = { name: "codemode", description: "Synthetic codemode wrapper", parameters: schema,
    exposure: replacementScenario ? "direct" : "model-only",
    sourceInfo: { source: replacementScenario ? "extension" : "builtin", path: "builtin:codemode" } };
  const classified = [];
  const reviewed = [];
  const original = Classifier.prototype.classify;
  const preds = facts({ exposes_secrets: true });
  Classifier.prototype.classify = async (action, _cwd, _home, kind) => {
    classified.push({ action, kind });
    return classification(preds);
  };
  const handlers = {};
  const ctx = { cwd, mode: "print", hasUI: false,
    sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => uuid },
    ui: { notify() {}, setStatus() {}, theme: { fg: (_color, text) => text } } };
  activityExtension({ registerFlag() {}, registerCommand() {}, on(name, fn) { handlers[name] = fn; },
    getFlag: (flag) => flag === "auto" && !["auto-off", "files", "builtin-wrapper-auto-off"].includes(name),
    getAllTools: () => withNativeTools([info, ...(wrapperScenario || replacementScenario ? [codemodeInfo] : [])]),
    appendEntry() {}, sendMessage() {}, events: { emit() {} } }, async (...reviewArgs) => {
    reviewed.push(reviewArgs);
    return { ok: true, allow: name !== "review-deny", reason: "UNRESTRICTED_REVIEWER_ECHO " + JSON.stringify(reviewArgs[3]),
      metrics: { inputTokens: 23, outputTokens: 7, attempts: 1, retries: 0 } };
  }, "native");
  const call = (toolName, input, toolCallId = uuid, parentToolCallId = "synthetic-outer") => handlers.tool_call({ toolName, input, toolCallId,
    ...(parentToolCallId ? { parentToolCallId } : {}) }, ctx);
  try {
    await handlers.session_start({ reason: "startup" }, ctx);
    const input = { key: "catalog", payload: { text: "complete benign ☃", options: ["inert"], nested: { enabled: false, extra: null, ids: [1, 2, 3] } },
      examples: { ...secrets, embedded: privateTexts }, correlation: uuid };
    const before = JSON.stringify(input);
    const fileInput = { path: join(cwd, "synthetic-nested.txt"), content: "KNOWN_WRAPPER_FILE_BODY",
      edits: [{ oldText: "KNOWN_WRAPPER_OLD_BODY", newText: "KNOWN_WRAPPER_NEW_BODY" }] };
    const wrapperInput = { code: `await tools.write(${JSON.stringify(fileInput)}); await tools.mcp__synthetic__operate({key:"catalog"});` };
    const wrapperBefore = JSON.stringify(wrapperInput);
    const nestedCodemodeInput = { code: 'await tools.synthetic_lookup({key:"KNOWN_NESTED_CODE"});' };
    if (wrapperScenario || replacementScenario) {
      assert.notEqual((await call("codemode", wrapperInput, "synthetic-wrapper", null))?.block, true);
      assert.equal(JSON.stringify(wrapperInput), wrapperBefore, "wrapper capture must not mutate code");
      if (wrapperScenario) {
        assert.equal(classified.length, 0, "builtin outer wrapper is not classified");
        assert.equal(reviewed.length, 0, "builtin outer wrapper is allowed without review");
        const fileBefore = JSON.stringify(fileInput);
        assert.notEqual((await call("write", fileInput, "synthetic-nested-file", "synthetic-wrapper"))?.block, true);
        assert.equal(JSON.stringify(fileInput), fileBefore, "nested file capture must not mutate file arguments");
        assert.notEqual((await call(info.name, input, "synthetic-nested-action", "synthetic-wrapper"))?.block, true);
        assert.equal(JSON.stringify(input), before, "nested action capture must not mutate gate input");
        if (name === "builtin-wrapper-auto-off") {
          assert.equal(classified.length, 0);
          assert.equal(reviewed.length, 0);
        } else {
          assert.equal(classified.length, 1, "evaluated nested action is still classified");
          assert.equal(reviewed.length, 1, "evaluated nested action is still reviewed");
          assert.deepEqual(JSON.parse(classified[0].action).evaluated_arguments, input);
          assert.equal(reviewed[0][3], input, "nested reviewer receives the unchanged original arguments");
          assert.equal(reviewed[0][11].parameters, schema);
        }
        assert.notEqual((await call("codemode", nestedCodemodeInput, "synthetic-nested-codemode", "synthetic-wrapper"))?.block, true);
        assert.equal(nestedCodemodeInput.code, 'await tools.synthetic_lookup({key:"KNOWN_NESTED_CODE"});');
        if (name === "builtin-wrapper-auto-off") {
          assert.equal(classified.length, 0);
          assert.equal(reviewed.length, 0);
        } else {
          assert.equal(classified.length, 2, "nested codemode is not an exempt outer wrapper");
          assert.equal(reviewed.length, 2);
          assert.deepEqual(JSON.parse(classified[1].action).evaluated_arguments, nestedCodemodeInput);
          assert.equal(reviewed[1][3], nestedCodemodeInput, "nested codemode reviewer receives unchanged original code");
        }
      } else {
        assert.equal(classified.length, 1, "replacement codemode is classified despite a builtin-looking path");
        assert.equal(reviewed.length, 1, "replacement codemode requires review");
        assert.deepEqual(JSON.parse(classified[0].action).evaluated_arguments, wrapperInput);
        assert.equal(reviewed[0][3], wrapperInput, "replacement reviewer receives original code");
        assert.equal(reviewed[0][11].parameters, schema);
      }
    } else if (name === "files") {
      // Only real native implementations qualify for path-only file capture.
      for (const tool of ["write", "edit", "read", "grep", "find", "ls"]) {
        assert.notEqual((await call(tool, { path: join(cwd, "synthetic.txt"), content: "KNOWN_FILE_BODY", oldText: "KNOWN_OLD_TEXT",
          newText: "KNOWN_NEW_TEXT", edits: [{ oldText: "KNOWN_NESTED_OLD", newText: "KNOWN_NESTED_NEW" }] }, tool))?.block, true);
      }
    } else if (name === "invalid") {
      const cycle = {}; cycle.self = cycle;
      let accessed = false;
      const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { accessed = true; return "NEVER_READ"; } });
      const secretAccessor = Object.defineProperty({}, "password", { enumerable: true, get() { accessed = true; return "NEVER_READ"; } });
      const arrayAccessor = Object.defineProperty([null], "0", { enumerable: true, get() { accessed = true; return "NEVER_READ"; } });
      for (const value of [{ x: undefined }, { x: NaN }, { x: Infinity }, { x: 1n }, { x: () => {} }, cycle, accessor,
        { password: undefined }, { password: NaN }, { password: Infinity }, { credentials: new Map([["hidden", "value"]]) },
        secretAccessor, { values: arrayAccessor }, { credentials: { values: arrayAccessor } }]) {
        assert.equal((await call(info.name, value))?.block, true);
      }
      assert.equal(accessed, false);
      assert.equal(classified.length, 0);
      assert.equal(reviewed.length, 0);
    } else {
      if (name === "oversize") input.payload.text = "benign large action ".repeat(2000);
      const result = await call(info.name, input);
      if (name === "review-deny") assert.equal(result?.block, true, "logging must not alter the reviewed denial");
      else assert.notEqual(result?.block, true, "logging must not alter the reviewed allow");
      if (name !== "oversize") assert.equal(JSON.stringify(input), before, "scrubbing must not mutate gate input");
      if (name === "auto-off") {
        assert.equal(classified.length, 0);
        assert.equal(reviewed.length, 0);
      } else {
        assert.deepEqual(JSON.parse(classified[0].action).evaluated_arguments, input, "classifier sees original arguments");
        assert.equal(reviewed[0][3], input, "reviewer sees original input object");
        assert.equal(reviewed[0][11].parameters, schema, "reviewer sees original TypeBox metadata");
      }
      if (["full", "full-plain-schema", "command-only"].includes(name)) {
        const command = `printf benign; ${secrets.cli}; password='synthetic-password-value'`;
        assert.notEqual((await call("bash", { command }, "synthetic-bash"))?.block, true);
        assert.equal(classified.at(-1).action, command, "shell classifier sees the original command");
      }
    }
    await handlers.session_shutdown({ reason: "quit" }, ctx);
    if (["off", "dictionary-invalid", "disk-failure"].includes(name)) {
      assert.equal(existsSync(commandsPath), false, "disabled/failed capture creates no command file");
      assert.equal(existsSync(reviewsPath), false, "disabled/failed capture creates no review file");
      if (name === "off") assert.equal(existsSync(join(dir, "private")), false, "disabled defaults create no log directory");
      return;
    }
    if (name === "review-only") assert.equal(existsSync(commandsPath), false);
    if (name === "command-only") assert.equal(existsSync(reviewsPath), false);
    const commandRows = existsSync(commandsPath) ? rows(commandsPath) : [];
    const reviewRows = existsSync(reviewsPath) ? rows(reviewsPath) : [];
    const disk = [commandsPath, reviewsPath].filter(existsSync).map((path) => readFileSync(path, "utf8")).join("\n");
    noSecrets(disk);
    assert.equal(disk.includes("UNRESTRICTED_REVIEWER_ECHO"), false, "reviewer explanation is never stored");
    assert.equal(disk.includes('"reviewReason"'), false, "reviewReason is absent, not null or redacted");
    for (const path of [commandsPath, reviewsPath].filter(existsSync)) assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "private")).mode & 0o777, 0o700);
    for (const row of [...commandRows, ...reviewRows]) assert.equal(row.privacy.representation, "activity-redaction/1");
    if (commandRows.length && reviewRows.length) {
      assert.equal(commandRows[0].session, reviewRows[0].session, "both streams correlate UUIDs in one process");
      if (!wrapperScenario && !replacementScenario && name !== "files") assert.equal(commandRows[0].callId, commandRows[0].session, "repeated UUIDs retain correlation");
    }
    if (wrapperScenario) {
      assert.equal(commandRows.length, 4, "wrapper and evaluated nested calls each retain a decision record");
      assert.equal(reviewRows.length, 4);
      assert.equal(commandRows[0].tool, "codemode");
      assert.equal(commandRows[0].decision, "allow");
      assert.equal(commandRows[0].action, null);
      assert.equal(commandRows[0].captureStatus, "omitted-builtin-wrapper");
      assert.equal(/KNOWN_WRAPPER_(?:FILE|OLD|NEW)_BODY/.test(disk), false, "wrapper and nested file bodies never enter either stream");
      const fileAction = commandRows[1].action;
      assert.equal(commandRows[1].captureStatus, "sanitized");
      assert.equal(fileAction.representation, "file-path/1");
      assert.deepEqual(Object.keys(fileAction).sort(), ["path", "representation", "tool_name"]);
      assert.equal(fileAction.tool_name, "write");
      assert.equal(fileAction.path, new LogSanitizer().sanitize({ path: fileInput.path }).path, "nested filepath is retained as a correlated private path");
      assert.equal(commandRows[2].captureStatus, "sanitized");
      assert.equal(commandRows[2].action.tool_name, info.name);
      assert.deepEqual(commandRows[2].action.evaluated_arguments.payload, input.payload, "evaluated nested arguments remain captured");
      assert.equal(commandRows[3].captureStatus, "sanitized", "only an outer builtin codemode wrapper omits code capture");
      assert.equal(commandRows[3].action.tool_name, "codemode");
      assert.deepEqual(commandRows[3].action.evaluated_arguments, nestedCodemodeInput);
      if (name !== "builtin-wrapper-auto-off") assert.equal(commandRows[3].decision, "judge-allow");
    } else if (replacementScenario) {
      assert.equal(commandRows.length, 1);
      assert.equal(reviewRows.length, 1);
      assert.equal(commandRows[0].captureStatus, "sanitized", "replacement codemode must not inherit wrapper capture omission");
      assert.equal(commandRows[0].decision, "judge-allow");
      assert.equal(commandRows[0].action.tool_name, "codemode");
      assert.deepEqual(commandRows[0].action.evaluated_arguments, JSON.parse(JSON.stringify(new LogSanitizer().sanitize({ args: wrapperInput }).args)));
      assert.equal(commandRows[0].action.evaluated_arguments.code.includes("KNOWN_WRAPPER_FILE_BODY"), true, "replacement code retains full sanitized capture");
    } else if (name === "metadata") {
      assert.equal(commandRows[0].action, null);
      assert.equal(commandRows[0].captureStatus, "metadata-only");
      assert.equal(disk.includes("complete benign"), false, "metadata excludes raw action");
      assert.equal(disk.includes("Available namespace metadata"), false);
    } else if (name === "files") {
      assert.equal(commandRows.length, 6);
      for (const row of commandRows) {
        assert.equal(row.action.representation, "file-path/1");
        assert.deepEqual(Object.keys(row.action).sort(), ["path", "representation", "tool_name"]);
      }
      assert.equal(/KNOWN_(?:FILE|OLD|NEW|NESTED)/.test(disk), false, "known file tool contents never enter logs");
    } else if (name === "invalid") {
      assert.ok(commandRows.length > 0);
      assert.ok(commandRows.every((row) => row.captureStatus === "invalid-json" && row.action === null));
    } else if (name === "oversize") {
      assert.equal(commandRows[0].captureStatus, "omitted-oversize");
      assert.equal(commandRows[0].action, null);
      assert.equal(commandRows[0].decision, "judge-allow");
      assert.ok(statSync(commandsPath).size <= log.maxBytes);
    } else if (commandRows.length) {
      const row = commandRows[0];
      assert.equal(row.captureStatus, "sanitized");
      assert.equal(row.action.representation, "runtime-action-evidence-json/1");
      assert.deepEqual(row.action.evaluated_arguments.payload, input.payload, "complete benign nested arguments survive");
      assert.deepEqual(row.action.tool_metadata.parameters, JSON.parse(JSON.stringify(schema)), "complete public TypeBox schema survives");
      assert.deepEqual(row.action.tool_metadata.annotations, info.annotations);
      assert.deepEqual(row.action.tool_metadata.namespace, info.namespace);
      assert.equal(row.action.evidence_status.backend_behavior, "unverified");
      assert.equal(Object.hasOwn(row.action, "backend_contract"), false);
      if (name !== "auto-off") {
        assert.deepEqual(row.preds, preds);
        assert.equal(row.probs.exposes_secrets, 0.99);
        assert.equal(Object.keys(row.preds).length, 9);
      }
      if (commandRows.length > 1) {
        assert.equal(commandRows[1].action.representation, "bash-command/1");
        assert.ok(commandRows[1].action.command.includes("printf benign"));
      }
    }
    if (reviewRows.length && !wrapperScenario && !["auto-off", "files", "invalid"].includes(name)) {
      assert.equal(reviewRows[0].judge.inputTokens, 23, "numeric telemetry survives redaction");
      assert.equal(reviewRows[0].judge.outputTokens, 7);
      assert.equal(disk.includes("UNRESTRICTED_REVIEWER_ECHO"), false);
    }
  } finally {
    await handlers.session_shutdown({ reason: "quit" }, ctx);
    Classifier.prototype.classify = original;
  }
}

if (args[0] === "--writer") {
  const logger = new CommandLogger(config(args[1]));
  for (let i = 0; i < 12; i++) logger.log({ writer: args[2], sequence: i, benign: "complete record" });
  await logger.flush();
  assert.equal(logger.droppedRecords, 0);
} else if (args[0] === "--gate") {
  await check(`gate ${args[1]}`, (dir) => gateScenario(args[1], dir));
  process.exitCode = failed ? 1 : 0;
} else {
  console.log("# private activity logging (synthetic offline)");
  await check("sanitizer creates a private copy, preserves heads/telemetry and removes prose", async () => {
    const sanitizer = new LogSanitizer();
    const preds = facts({ exposes_secrets: true });
    const record = { examples: { ...secrets, embedded: privateTexts }, uuid, nested: { enabled: false, values: [null, 0, "benign"] }, preds,
      probs: classification(preds).probs, incomplete: { exposes_secrets: true }, inputTokens: 19,
      reviewReason: "NEVER_STORE_REASON", explanation: "NEVER_STORE_EXPLANATION", errorMessage: "NEVER_STORE_ERROR", failure: "NEVER_STORE_FAILURE" };
    const before = JSON.stringify(record);
    const safe = sanitizer.sanitize(record);
    assert.notEqual(safe, record);
    assert.equal(JSON.stringify(record), before);
    noSecrets(JSON.stringify(safe));
    assert.equal(JSON.stringify(safe).includes("NEVER_STORE"), false);
    assert.deepEqual(JSON.parse(JSON.stringify(safe.preds)), preds);
    assert.deepEqual(JSON.parse(JSON.stringify(safe.probs)), record.probs);
    assert.deepEqual(Object.keys(safe.incomplete), ["exposes_secrets"], "redaction does not false-fill missing heads");
    assert.equal(safe.inputTokens, 19);
    assert.equal(safe.nested.enabled, false);
    assert.equal(safe.privacy.identifierScope, "process");
    assert.ok(safe.privacy.redactions.field > 0);
    assert.equal(safe.uuid, new LogSanitizer().sanitize({ uuid }).uuid, "independent sanitizers share process UUID correlation");
  });
  await check("credential formats are scrubbed in generic text without changing originals", async () => {
    const sanitizer = new LogSanitizer();
    for (const header of [secrets.bearer, secrets.basic, secrets.sas]) {
      const record = { text: header };
      const safe = sanitizer.sanitize(record);
      assert.equal(safe.text, "Authorization: [redacted:authorization]", "the entire authorization value is removed, including every SAS parameter");
      assert.equal(record.text, header);
      assert.equal(safe.privacy.redactions.authorization, 1);
    }
    for (const [text, category] of [
      [secrets.sharedConnection, "connection-string"], [secrets.storageAssignment, "secret"], ["AZURE_STORAGE_KEY=synthetic-storage-key", "secret"],
      [secrets.keyvault, "cli-value"], [secrets.embeddedJson, "secret"], [secrets.query, "query-credential"],
    ]) {
      const record = { text };
      const safe = sanitizer.sanitize(record);
      noSecrets(JSON.stringify(safe));
      assert.ok(safe.privacy.redactions[category] > 0, "the expected credential redaction route is used");
      assert.equal(record.text, text);
    }
    assert.equal(sanitizer.sanitize({ text: secrets.query }).text, "?sig=[redacted:query-credential]&limit=3", "benign query parameters survive");
    const structured = { SharedAccessKey: secrets.SharedAccessKey, AZURE_STORAGE_KEY: "synthetic-storage-key", nested: { SharedAccessKey: secrets.SharedAccessKey } };
    const before = JSON.stringify(structured);
    const safe = sanitizer.sanitize(structured);
    assert.equal(safe.SharedAccessKey, "[redacted:field]");
    assert.equal(safe.AZURE_STORAGE_KEY, "[redacted:field]");
    assert.equal(safe.nested.SharedAccessKey, "[redacted:field]");
    assert.equal(JSON.stringify(structured), before);
    const identifiers = sanitizer.sanitize({ first: secrets.compactUuid, repeated: secrets.compactUuid.toUpperCase() });
    assert.match(identifiers.first, /^\[uuid:[a-f0-9]{16}\]$/);
    assert.equal(identifiers.first, identifiers.repeated, "compact UUID pseudonyms correlate without exposing original identifiers");
    assert.equal(identifiers.privacy.redactions.uuid, 2);
  });
  await check("optional external literal dictionary scrubs longest matches without mutation", async (dir) => {
    const path = join(dir, "literals.json");
    writeFileSync(path, JSON.stringify(["SYNTHETIC_BUSINESS_LITERAL", "SYNTHETIC_BUSINESS"]));
    const source = { message: "benign SYNTHETIC_BUSINESS_LITERAL plus SYNTHETIC_BUSINESS" };
    const safe = new LogSanitizer({ literalsFile: path }).sanitize(source);
    assert.equal(safe.message, "benign [redacted:literal] plus [redacted:literal]");
    assert.equal(source.message.includes("SYNTHETIC_BUSINESS_LITERAL"), true);
    assert.equal(safe.privacy.redactions.literal, 2);
    assert.equal(new LogSanitizer().sanitize({ value: "benign" }).value, "benign");
  });
  await check("invalid dictionaries fail closed with no raw fallback", async (dir) => {
    const dictionary = join(dir, "dictionary.json");
    const invalid = ["not json", JSON.stringify({ value: "bad" }), JSON.stringify([""]), JSON.stringify([42]), " ".repeat(65_537)];
    for (const [i, raw] of invalid.entries()) {
      writeFileSync(dictionary, raw);
      assert.throws(() => new LogSanitizer({ literalsFile: dictionary }));
      const path = join(dir, `failed-${i}.jsonl`);
      const logger = new CommandLogger(config(path), { literalsFile: dictionary });
      logger.log({ message: "RAW_FALLBACK_FORBIDDEN" });
      await logger.flush();
      assert.equal(logger.droppedRecords, 1);
      assert.equal(existsSync(path), false);
    }
    assert.throws(() => new LogSanitizer({ literalsFile: join(dir, "missing.json") }));
  });
  await check("unsafe storage paths and symlinked Git parents are refused", async (dir) => {
    const git = join(dir, "worktree");
    mkdirSync(git);
    mkdirSync(join(git, ".git"));
    symlinkSync(git, join(dir, "alias"));
    const target = join(dir, "existing.jsonl");
    writeFileSync(target, "");
    symlinkSync(target, join(dir, "file-link.jsonl"));
    const unsafe = ["relative.jsonl", join(git, "logs", "capture.jsonl"), join(dir, "alias", "new", "capture.jsonl"), join(dir, "file-link.jsonl")];
    for (const path of unsafe) {
      assert.throws(() => privateStoragePath(path));
      const logger = new CommandLogger(config(path));
      logger.log({ benign: true });
      await logger.flush();
      assert.equal(logger.droppedRecords, 1);
    }
    const linked = join(dir, "linked-worktree");
    mkdirSync(linked);
    writeFileSync(join(linked, ".git"), "gitdir: /synthetic/unused\n");
    assert.throws(() => privateStoragePath(join(linked, "capture.jsonl")));
    assert.throws(() => new LogSanitizer({ literalsFile: join(git, "dictionary.json") }));
    symlinkSync(dir, join(dir, "private-alias"));
    assert.equal(privateStoragePath(join(dir, "private-alias", "new", "capture.jsonl")), resolve(realpathSync(dir), "new", "capture.jsonl"));
    assert.equal(readFileSync(target, "utf8"), "");
  });
  for (const [name, value] of [
    ["undefined", { value: undefined }], ["NaN", { value: NaN }], ["Infinity", { value: Infinity }],
    ["Date", { value: new Date(0) }], ["Map", { value: new Map([["hidden", "value"]]) }],
    ["sparse array", { value: [, "item"] }], ["BigInt", { value: 1n }], ["function", { value: () => {} }],
  ]) {
    await check(`unsupported ${name} fails closed before queue`, async (dir) => {
      const path = join(dir, "invalid.jsonl");
      const logger = new CommandLogger(config(path));
      const invalid = value.value;
      const records = [value, { password: invalid }, { credentials: { nested: invalid } }, { explanation: { nested: invalid } }];
      for (const record of records) {
        assert.throws(() => new LogSanitizer().sanitize(record), "redacted subtrees still require complete strict JSON");
        logger.log(record);
      }
      await logger.flush();
      assert.equal(logger.droppedRecords, records.length, "invalid values must not be serialized lossily, even inside fields redaction would remove");
      assert.equal(existsSync(path), false, "invalid values create no raw or lossy log");
    });
  }
  await check("object and array accessors fail closed before log or logTelemetry can invoke them", async (dir) => {
    let accessed = 0;
    const getter = () => { accessed++; throw new Error("synthetic getter must not execute"); };
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    const secretAccessor = Object.defineProperty({}, "password", { enumerable: true, get: getter });
    const arrayAccessor = Object.defineProperty([null], "0", { enumerable: true, get: getter });
    const cycle = {}; cycle.self = cycle;
    const records = [accessor, secretAccessor, { values: arrayAccessor }, { credentials: { nested: accessor } },
      { password: arrayAccessor }, cycle, { credentials: cycle }, { explanation: accessor }];
    for (const record of records) assert.throws(() => new LogSanitizer().sanitize(record));
    for (const [index, Logger] of [CommandLogger, ReviewLogger].entries()) {
      for (const method of ["log", "logTelemetry"]) {
        const path = join(dir, `invalid-${index}-${method}.jsonl`);
        const logger = new Logger(config(path));
        for (const record of records) logger[method](record);
        await logger.flush();
        assert.equal(logger.droppedRecords, records.length);
        assert.equal(existsSync(path), false, "unsafe accessors and cycles create no log");
      }
    }
    assert.equal(accessed, 0);
    assert.equal(Object.getOwnPropertyDescriptor(accessor, "value").get, getter, "source object descriptor is unchanged");
    assert.equal(Object.getOwnPropertyDescriptor(arrayAccessor, "0").get, getter, "source array descriptor is unchanged");
  });
  await check("logTelemetry descriptor-copy preserves benign arrays and only omits optional object fields", async (dir) => {
    const path = join(dir, "telemetry.jsonl");
    const logger = new ReviewLogger(config(path));
    const record = { optional: undefined, values: [false, null, 0, { optional: undefined, text: "benign telemetry" }] };
    logger.logTelemetry(record);
    record.values[3].text = "MUTATED_TELEMETRY_INPUT";
    await logger.flush();
    assert.equal(logger.droppedRecords, 0);
    const [safe] = rows(path);
    assert.equal(Object.hasOwn(safe, "optional"), false);
    assert.deepEqual(safe.values, [false, null, 0, { text: "benign telemetry" }]);
    assert.equal(Object.hasOwn(record, "optional"), true, "optional source fields are not deleted");
    assert.equal(Object.hasOwn(record.values[3], "optional"), true);
  });
  await check("logTelemetry rejects non-JSON sensitive values and undefined array items", async (dir) => {
    for (const [index, Logger] of [CommandLogger, ReviewLogger].entries()) {
      const path = join(dir, `invalid-telemetry-${index}.jsonl`);
      const logger = new Logger(config(path));
      const records = [{ password: NaN }, { credentials: { value: Infinity } }, { secret: new Map([["hidden", "value"]]) },
        { values: [undefined] }, { credentials: [undefined] }];
      for (const record of records) logger.logTelemetry(record);
      await logger.flush();
      assert.equal(logger.droppedRecords, records.length);
      assert.equal(existsSync(path), false, "telemetry must not serialize invalid sensitive values or turn undefined array items into null");
    }
  });
  await check("scrubbing occurs before queuing and flush waits for private disk writes", async (dir) => {
    const path = join(dir, "new-private", "capture.jsonl");
    const logger = new CommandLogger(config(path));
    const record = { nested: { value: "benign original" } };
    logger.log(record);
    record.nested.value = "QUEUED_INPUT_MUTATION";
    await logger.flush();
    assert.equal(rows(path)[0].nested.value, "benign original");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "new-private")).mode & 0o777, 0o700);
    assert.equal(existsSync(`${path}.lock`), false);
  });
  await check("bounded sizes, rotation and maxFiles zero", async (dir) => {
    for (const maxFiles of [0, 2]) {
      const path = join(dir, `rotate-${maxFiles}.jsonl`);
      const logger = new CommandLogger(config(path, { maxBytes: 1024, maxFiles }));
      for (let i = 0; i < 16; i++) {
        logger.log({ sequence: i, benign: "x".repeat(180) });
        await logger.flush();
      }
      assert.equal(logger.droppedRecords, 0);
      assert.equal(rows(path).at(-1).sequence, 15);
      for (let index = 1; index <= maxFiles; index++) assert.ok(existsSync(rotatedLogPath(path, index)));
      assert.equal(existsSync(rotatedLogPath(path, maxFiles + 1)), false);
      for (const name of readdirSync(dir).filter((name) => name.startsWith(`rotate-${maxFiles}`))) {
        const rotated = join(dir, name);
        assert.ok(statSync(rotated).size <= 1024);
        assert.equal(statSync(rotated).mode & 0o777, 0o600);
        rows(rotated);
      }
    }
  });
  await check("overflow and oversized metadata count dropped records", async (dir) => {
    const path = join(dir, "bounded.jsonl");
    const logger = new ReviewLogger(config(path, { maxBytes: 1024 }));
    logger.log({ benign: "x".repeat(2000) });
    for (let i = 0; i < 20; i++) logger.log({ sequence: i, benign: "x".repeat(300) });
    await logger.flush();
    assert.ok(logger.droppedRecords > 1);
    assert.ok(rows(path).length > 0);
    assert.ok(statSync(path).size <= 1024);
    logger.log({ recovered: true });
    await logger.flush();
    assert.equal(rows(path).at(-1).logDroppedRecords, logger.droppedRecords, "later records report earlier drops");
  });
  await check("orphan lock is never stolen and failure never rejects flush", async (dir) => {
    const path = join(dir, "locked.jsonl");
    mkdirSync(`${path}.lock`, { mode: 0o700 });
    writeFileSync(join(`${path}.lock`, "owner"), "synthetic-live-writer");
    const logger = new CommandLogger(config(path));
    logger.log({ benign: true });
    await logger.flush();
    assert.equal(logger.droppedRecords, 1);
    assert.equal(existsSync(path), false);
    assert.equal(readFileSync(join(`${path}.lock`, "owner"), "utf8"), "synthetic-live-writer");
  });
  await check("concurrent instances and processes retain complete shared JSON lines", async (dir) => {
    const path = join(dir, "shared.jsonl");
    const first = new CommandLogger(config(path));
    const second = new ReviewLogger(config(path));
    const children = [worker(path, "child-a"), worker(path, "child-b")];
    for (let i = 0; i < 12; i++) {
      first.log({ writer: "instance-a", sequence: i });
      second.log({ writer: "instance-b", sequence: i });
    }
    await Promise.all([first.flush(), second.flush(), ...children]);
    const entries = rows(path);
    assert.equal(entries.length, 48);
    assert.equal(new Set(entries.map((row) => `${row.writer}:${row.sequence}`)).size, 48);
    assert.equal(first.droppedRecords + second.droppedRecords, 0);
    assert.equal(existsSync(`${path}.lock`), false);
  });
  // Runtime loggers intentionally survive session shutdown. Fresh processes isolate
  // independent logging configurations without touching runtime implementation.
  for (const scenario of ["off", "metadata", "full", "full-plain-schema", "command-only", "review-only", "review-deny", "auto-off", "files", "invalid", "oversize", "dictionary-invalid", "disk-failure",
    "builtin-wrapper", "builtin-wrapper-auto-off", "replacement-codemode"]) {
    const result = child("--gate", scenario);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) failed++;
    else passed++;
  }
  console.log(`privacy/logging checks: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
