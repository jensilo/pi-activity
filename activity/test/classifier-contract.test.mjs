// Offline protocol checks. The socket returns fixed facts, never runs inputs or a model.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Classifier } from "../classifier.ts";
import { HEADS } from "../policy.ts";
import { serializeActionCall } from "../action-classifier.ts";
import { createFixtureModel, facts, NINE_HEADS, readyResponse, scores, wireResponse } from "./nine-head-fixtures.mjs";

assert.deepEqual(HEADS, NINE_HEADS, "the wire contract is the exact canonical nine-head set");
const dir = mkdtempSync(join(tmpdir(), "acclass-contract-"));
const socket = join(dir, "stub.sock");
const cwd = join(dir, "project");
const home = join(dir, "home");
const requests = [];
let reply = wireResponse();
const fixtureConfig = createFixtureModel(dir);
const server = createServer((connection) => {
  connection.setEncoding("utf8"); // Preserve multibyte features across socket chunks.
  let buffer = "";
  connection.on("data", (chunk) => {
    buffer += chunk.toString();
    if (!buffer.includes("\n")) return;
    const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
    if (request.cwd !== undefined) requests.push(request); // Ignore daemon liveness probes.
    connection.end(JSON.stringify(request.ping === true ? readyResponse() : reply) + "\n");
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(socket, resolve);
});
const cfg = { enabled: true, socket, ...fixtureConfig, spawn: false, requestTimeoutMs: 1000 };
const client = new Classifier(cfg);
let rejected = 0;
async function rejectResponse(value, label, message = "incompatible or incomplete nine-head classifier response") {
  reply = value;
  const result = await client.classify("git status", cwd, home);
  assert.deepEqual(result, { ok: false, kind: "error", message }, label);
  rejected++;
}

try {
  for (const token_count of [1, 2048]) {
    const preds = facts({ outbound: true, remote_state_change: true, egress: true });
    reply = wireResponse({ preds, probs: scores(preds), token_count, scope: ["cwd", "home"],
      paths: { inside: [join(cwd, "file")], outside: [join(home, "file")] }, ms: 7 });
    const result = await client.classify("git push", cwd, home);
    assert.deepEqual(result, { ok: true, source: "local", preds, probs: scores(preds), tokenCount: token_count,
      inputComplete: true, scopeComplete: true, scope: reply.scope, paths: reply.paths, ms: 7 });
    assert.deepEqual(requests.at(-1), { cmd: "git push", cwd, home, input_kind: "shell" });
  }
  reply = wireResponse({ probs: Object.fromEntries(NINE_HEADS.map((head, index) => [head, index % 2])) });
  assert.equal((await client.classify("true", cwd, home)).ok, true, "scores at zero and one are valid");

  for (const head of NINE_HEADS) {
    for (const field of ["preds", "probs"]) {
      const incomplete = wireResponse();
      delete incomplete[field][head];
      await rejectResponse(incomplete, `missing ${field}.${head}`);
    }
    await rejectResponse(wireResponse({ preds: { ...facts(), [head]: 1 } }), `nonboolean ${head}`);
    for (const value of [null, "0.5", -0.01, 1.01]) {
      await rejectResponse(wireResponse({ probs: { ...scores(facts()), [head]: value } }), `invalid score ${head}: ${value}`);
    }
  }
  // Deliberately incompatible legacy wire payload, not a conversion fixture.
  const legacy = { read_only: true, outbound: false, egress: false,
    remote_mutation: false, accesses_secrets: false, destructive: false };
  await rejectResponse(wireResponse({ preds: legacy, probs: scores(legacy) }), "six-head daemon rejected");
  await rejectResponse(wireResponse({ preds: { ...facts(), read_only: true } }), "extra prediction rejected");
  await rejectResponse(wireResponse({ probs: { ...scores(facts()), accesses_secrets: 0 } }), "extra score rejected");
  for (const field of ["preds", "probs"]) {
    for (const value of [undefined, null, [], "invalid"]) {
      await rejectResponse(wireResponse({ [field]: value }), `invalid ${field} object`);
    }
  }
  for (const input_complete of [undefined, null, false, "true", 1]) {
    await rejectResponse(wireResponse({ input_complete }), "completion must be explicit boolean true");
  }
  for (const token_count of [undefined, null, "12", 0, -1, 1.5, 2049]) {
    await rejectResponse(wireResponse({ token_count }), "token count must be an integer in 1..2048");
  }
  for (const scope of [undefined, null, [], "cwd", [1], ["unknown-scope"]]) {
    await rejectResponse(wireResponse({ scope }), "malformed scope rejected", "malformed classifier scope response");
  }
  for (const paths of [undefined, null, {}, { inside: [], outside: null }, { inside: [42], outside: [] }]) {
    await rejectResponse(wireResponse({ paths }), "malformed paths rejected", "malformed classifier scope response");
  }
  for (const scope_complete of [undefined, null, "true", 1]) {
    await rejectResponse(wireResponse({ scope_complete }), "parser completeness must be an explicit boolean", "malformed classifier scope response");
  }
  reply = wireResponse({ scope_complete: false });
  const incompleteScope = await client.classify("git status", cwd, home);
  assert.equal(incompleteScope.ok, true, "incomplete parser coverage does not invalidate full inference");
  assert.equal(incompleteScope.scopeComplete, false);
  reply = null;
  assert.match((await client.classify("true", cwd, home)).message, /incompatible classifier daemon identity/);

  // Oversize safety is attested by the daemon, not guessed from character count.
  const oversized = `printf '%s' '${"long unicode feature ☃ ".repeat(4000)}'`;
  reply = wireResponse({ token_count: 2049 });
  assert.equal((await client.classify(oversized, cwd, home)).ok, false);
  assert.equal(requests.at(-1).cmd, oversized, "the client must not truncate shell input to get an allow");
  reply = wireResponse({ input_complete: false, token_count: 2048 });
  assert.equal((await client.classify(oversized, cwd, home)).ok, false, "truncated 2048-token response rejected");
  reply = { identity: wireResponse().identity, error: "input exceeds 2048 tokens" };
  assert.deepEqual(await client.classify(oversized, cwd, home), { ok: false, kind: "error", message: reply.error });

  const evidence = {
    representation: "action-behavior-evidence-json/0.3",
    trust_condition: "Fictional backend obeys only the supplied contract.",
    backend_contract: { description: "Returns a stored object without changing state or executing its strings." },
    input_schema: { type: "object", properties: { payload: { type: "string" } } },
    evaluated_arguments: { payload: "$(git push) is inert data ☃", enabled: false, extra: null },
    effective_namespace: "fixture.read",
  };
  const exact = ` \n${JSON.stringify(evidence, null, 2)}\n `;
  reply = wireResponse();
  assert.equal((await client.classifyActionEvidence(exact, cwd, home)).ok, true);
  assert.deepEqual(requests.at(-1), { cmd: exact, cwd, home, input_kind: "action" },
    "action evidence preserves exact feature bytes and has no injected metadata");
  const largeEvidence = JSON.stringify({ ...evidence,
    evaluated_arguments: { payload: "not executed ".repeat(5000) } }, null, 2);
  reply = wireResponse({ token_count: 2049 });
  assert.equal((await client.classifyActionEvidence(largeEvidence, cwd, home)).ok, false);
  assert.equal(requests.at(-1).cmd, largeEvidence, "oversized action evidence is not reserialized/truncated");

  const runtimeInput = { operation: "delete", payload: "full evaluated ☃ input ".repeat(3000), enabled: false, extra: null };
  const runtimeMetadata = { description: "Unverified server operation", parameters: { type: "object" },
    namespace: { name: "fixture", instructions: "Unverified hints only" }, annotations: { readOnlyHint: true }, exposure: "deferred" };
  const runtimeExact = serializeActionCall("mcp__fixture__operate", runtimeInput, runtimeMetadata);
  reply = wireResponse({ scope: ["none"], paths: { inside: [], outside: [] } });
  const runtime = await client.classifyActionCall("mcp__fixture__operate", runtimeInput, runtimeMetadata, cwd, home);
  assert.equal(runtime.ok, true);
  assert.deepEqual(requests.at(-1), { cmd: runtimeExact, cwd, home, input_kind: "action" },
    "real call uses its own complete deterministic representation and action scope isolation");
  assert.equal((await client.classifyActionEvidence(runtimeExact, cwd, home)).ok, false,
    "runtime evidence cannot be mistaken for a fictional backend contract");
  reply = wireResponse({ token_count: 2049 });
  assert.equal((await client.classifyActionCall("mcp__fixture__operate", runtimeInput, runtimeMetadata, cwd, home)).ok, false);
  assert.equal(requests.at(-1).cmd, runtimeExact, "full runtime input is never clipped to pass token bounds");
  const beforeUnsupported = requests.length;
  const wireOverflow = await client.classifyActionCall("fixture", { payload: "x".repeat(256 * 1024) }, undefined, cwd, home);
  assert.equal(wireOverflow.ok, false);
  assert.match(wireOverflow.message, /byte limit; clipping is forbidden/);
  assert.equal(requests.length, beforeUnsupported, "wire overflow is rejected, never sent as shortened action evidence");
  assert.equal((await client.classifyActionCall("fixture", { value: undefined }, undefined, cwd, home)).ok, false);
  assert.equal(requests.length, beforeUnsupported, "non-JSON calls never reach transport as lossy evidence");
  reply = wireResponse({ preds: facts({ remote_state_change: true }), probs: scores(facts({ remote_state_change: true })) });
  assert.equal((await client.classifyActionCall("fixture", {}, undefined, cwd, home)).preds.remote_state_change, true,
    "runtime classifier returns raw nine-head predictions, not fabricated facts");

  const beforeInvalid = requests.length;
  for (const key of ["backend_contract", "input_schema", "evaluated_arguments"]) {
    for (const value of [null, false, 1, "contract", []]) {
      assert.equal((await client.classifyActionEvidence(JSON.stringify({ ...evidence, [key]: value }), cwd, home)).ok, false,
        `${key} must be an evidence object`);
    }
  }
  for (const key of ["trust_condition", "effective_namespace"]) {
    assert.equal((await client.classifyActionEvidence(JSON.stringify({ ...evidence, [key]: " \n " }), cwd, home)).ok, false,
      `${key} must be nonempty`);
  }
  for (const invalid of ["{", "null", "[]", JSON.stringify({ ...evidence, representation: "action-behavior-evidence-json/0.2" }),
    JSON.stringify({ ...evidence, trust_condition: null }), JSON.stringify({ ...evidence, effective_namespace: null })]) {
    const result = await client.classifyActionEvidence(invalid, cwd, home);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "error");
  }
  for (const key of ["representation", "trust_condition", "backend_contract", "input_schema", "evaluated_arguments", "effective_namespace"]) {
    const missing = { ...evidence };
    delete missing[key];
    assert.equal((await client.classifyActionEvidence(JSON.stringify(missing), cwd, home)).ok, false, `missing ${key}`);
  }
  assert.equal(requests.length, beforeInvalid, "unsupported action evidence never reaches the daemon");
  assert.equal((await client.classify(" \n ", cwd, home)).kind, "error");
  assert.equal((await new Classifier({ ...cfg, enabled: false }).classify("true", cwd, home)).kind, "unavailable");
  assert.equal(requests.length, beforeInvalid, "empty/disabled requests never reach the daemon");
  console.log(`classifier contract tests passed (${rejected} malformed responses, boundaries, oversize, exact action evidence)`);
} finally {
  client.stop();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
