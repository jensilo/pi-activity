// Explicit operation facts for offline tests, not a legacy-label conversion.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NATIVE_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "write", "edit"];

// Installed native tools carry both builtin source and a name-matching path.
export function nativeToolInfo(name) {
  if (!NATIVE_TOOL_NAMES.includes(name)) throw new Error(`Not a native fixture tool: ${name}`);
  return { name, sourceInfo: { source: "builtin", path: `builtin:${name}` } };
}

// Explicit registrations, including custom shadows, take precedence over defaults.
export function withNativeTools(tools = []) {
  return [...tools, ...NATIVE_TOOL_NAMES.filter((name) => !tools.some((tool) => tool.name === name)).map(nativeToolInfo)];
}

const METADATA = ["config.json", "tokenizer.json", "thresholds.json", "heads.json", "model_contract.json"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtureBytes = (name) => `synthetic fixture ${name}\n`;
export const FIXTURE_IDENTITY = {
  protocol: "acclass-daemon/1", loading_mode: "q8-runtime",
  artifacts: Object.fromEntries([...METADATA, "model.safetensors"].map((name) => [name, hash(fixtureBytes(name))])),
  binary_sha256: hash(fixtureBytes("binary")),
};

// Real local bytes use the production hashing path. Nothing bypasses identity checks.
export function createFixtureModel(dir) {
  for (const name of [...METADATA, "model.safetensors"]) writeFileSync(join(dir, name), fixtureBytes(name));
  const binary = join(dir, "fixture-binary");
  writeFileSync(binary, fixtureBytes("binary"));
  return { model: dir, binary, quant: "q8" };
}

// Explicit backend selection for gate tests that stub Classifier.classify.
export function createFixtureProvider(dir) {
  const modelDir = join(dir, "synthetic-model");
  mkdirSync(modelDir, { recursive: true });
  return { provider: "acclass", ...createFixtureModel(modelDir),
    socket: join(dir, "synthetic-classifier.sock"), spawn: false };
}

export function fixtureIdentity(model, binary, quant = "q8") {
  const loading_mode = existsSync(join(model, "model.gguf")) ? "gguf" : quant === "q8" ? "q8-runtime" : "f32";
  return { protocol: "acclass-daemon/1", loading_mode,
    artifacts: Object.fromEntries([...METADATA, loading_mode === "gguf" ? "model.gguf" : "model.safetensors"]
      .map((name) => [name, hash(readFileSync(join(model, name)))])),
    binary_sha256: hash(readFileSync(binary)) };
}

export function readyResponse(identity = FIXTURE_IDENTITY) {
  return { ready: true, heads: NINE_HEADS, context_limit_inclusive: 2048, identity };
}
export const NINE_HEADS = [
  "local_state_change", "outbound", "egress", "remote_state_change",
  "delegated_execution", "exposes_secrets", "destructive",
  "host_control_change", "fetched_or_generated_execution",
];

export function facts(overrides = {}) {
  return {
    local_state_change: false,
    outbound: false,
    egress: false,
    remote_state_change: false,
    delegated_execution: false,
    exposes_secrets: false,
    destructive: false,
    host_control_change: false,
    fetched_or_generated_execution: false,
    ...overrides,
  };
}

export function scores(preds) {
  return Object.fromEntries(Object.entries(preds).map(([head, value]) => [head, value ? 0.99 : 0.01]));
}

export function classification(preds = facts(), overrides = {}) {
  return {
    ok: true, source: "local", preds, probs: scores(preds),
    scope: ["cwd"], paths: { inside: [], outside: [] }, ms: 0,
    inputComplete: true, tokenCount: 12, scopeComplete: true,
    ...overrides,
  };
}

export function wireResponse(overrides = {}) {
  const preds = facts();
  return {
    preds, probs: scores(preds), scope: ["cwd"],
    paths: { inside: [], outside: [] }, ms: 1,
    input_complete: true, token_count: 12, scope_complete: true,
    identity: FIXTURE_IDENTITY,
    ...overrides,
  };
}
