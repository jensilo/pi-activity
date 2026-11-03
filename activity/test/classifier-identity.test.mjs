// Exact local artifact identity fixtures. No candidate, model, or provider execution.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Classifier } from "../classifier.ts";
import { createFixtureModel, fixtureIdentity, readyResponse, wireResponse } from "./nine-head-fixtures.mjs";

const dir = mkdtempSync(join(tmpdir(), "acclass-identity-"));
const socket = join(dir, "external.sock");
const a = join(dir, "modelA");
const b = join(dir, "modelB");
mkdirSync(a);
mkdirSync(b);
const configA = createFixtureModel(a);
const configB = createFixtureModel(b);
writeFileSync(join(b, "model.safetensors"), "different modelB weights\n");
let ready = readyResponse();
let response = wireResponse();
let inferences = 0;
let probes = 0;
const server = createServer((connection) => {
  connection.on("error", () => {});
  connection.once("data", (bytes) => {
    const request = JSON.parse(bytes);
    if (request.ping) probes++; else inferences++;
    connection.end(JSON.stringify(request.ping ? ready : response) + "\n");
  });
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
const cfg = { enabled: true, ...configA, socket, spawn: true, startTimeoutMs: 100, requestTimeoutMs: 1000 };
const client = new Classifier(cfg);
const call = () => client.classify("git status", dir, dir);
const originalSocket = statSync(socket);
try {
  assert.equal((await call()).ok, true);
  const beforeWrongModel = inferences;
  const wrongModel = new Classifier({ ...cfg, ...configB });
  assert.match((await wrongModel.classify("true", dir, dir)).message, /incompatible classifier daemon identity/);
  assert.equal(inferences, beforeWrongModel, "modelB client never infers against modelA server");
  assert.equal(wrongModel.child, undefined, "responsive external server is never killed/replaced");
  assert.equal(statSync(socket).ino, originalSocket.ino, "incompatible external socket is not unlinked");
  assert.equal((await call()).ok, true, "external daemon remains usable by the matching client");
  assert.match((await new Classifier({ ...cfg, quant: "f32" }).classify("true", dir, dir)).message, /identity/);

  const identity = fixtureIdentity(a, configA.binary);
  const incompatible = [undefined, null, {}, { ...identity, protocol: "acclass-daemon/0" },
    { ...identity, loading_mode: "f32" }, { ...identity, binary_sha256: "0".repeat(64) },
    { ...identity, unexpected: true }];
  for (const name of Object.keys(identity.artifacts)) {
    incompatible.push({ ...identity, artifacts: { ...identity.artifacts, [name]: "0".repeat(64) } });
    const artifacts = { ...identity.artifacts };
    delete artifacts[name];
    incompatible.push({ ...identity, artifacts });
  }
  for (const badIdentity of incompatible) {
    ready = readyResponse(badIdentity);
    // Explicit undefined must remove the helper's default too.
    ready.identity = badIdentity;
    assert.match((await call()).message, /identity/);
    ready = readyResponse();
    response = wireResponse({ identity: badIdentity });
    assert.match((await call()).message, /identity/, "every classify response revalidates identity after readiness");
  }
  response = wireResponse();
  for (const badReady of [wireResponse(), { ready: true }, { ...readyResponse(), ready: false },
    { ...readyResponse(), ready: "true" }, { ...readyResponse(), heads: ["legacy"] },
    { ...readyResponse(), context_limit_inclusive: 512 }]) {
    ready = badReady;
    assert.equal((await call()).ok, false, "arbitrary JSON/old inference responses are not readiness");
  }
  ready = readyResponse();
  response = { error: "fixture error", identity: fixtureIdentity(b, configB.binary) };
  assert.match((await call()).message, /identity/, "error responses cannot silently come from a substituted socket server");
  response = wireResponse();
  assert.equal((await call()).ok, true);
  assert.equal(statSync(socket).ino, originalSocket.ino);

  // Matching bytes remain cached. Size+mtime alone must not miss replacements.
  const cached = new Map(client.hashes);
  assert.equal((await call()).ok, true);
  for (const [path, entry] of cached) assert.equal(client.hashes.get(path), entry, "unchanged artifacts are not rehashed per request");
  const thresholdPath = join(a, "thresholds.json");
  const thresholdStat = statSync(thresholdPath);
  writeFileSync(thresholdPath, readFileSync(thresholdPath, "utf8").replace("synthetic", "different"));
  utimesSync(thresholdPath, thresholdStat.atime, thresholdStat.mtime);
  assert.match((await call()).message, /identity/, "metadata replacement with preserved size/mtime still invalidates cached SHA-256");
  ready = readyResponse(fixtureIdentity(a, configA.binary));
  response = wireResponse({ identity: ready.identity });
  assert.equal((await call()).ok, true);

  // GGUF is the actual selected weight artifact, regardless of runtime quant setting.
  writeFileSync(join(a, "model.gguf"), "synthetic selected GGUF weights\n");
  assert.match((await call()).message, /identity/, "adding GGUF changes selected weight identity");
  ready = readyResponse(fixtureIdentity(a, configA.binary));
  response = wireResponse({ identity: ready.identity });
  assert.equal(ready.identity.loading_mode, "gguf");
  assert.equal((await call()).ok, true);
  const ggufF32 = new Classifier({ ...cfg, quant: "f32" });
  assert.equal((await ggufF32.classify("true", dir, dir)).ok, true, "GGUF selection matches serve arguments");
  assert.equal(ready.identity.artifacts["model.safetensors"], undefined);

  // Daemon-free CLI scope reports have exactly the same completeness validation.
  const scopeFile = join(dir, "scope-report.json");
  const scopeBinary = join(dir, "scope-fixture");
  writeFileSync(scopeBinary, `#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(scopeFile)}));\n`, { mode: 0o700 });
  const scopeClient = new Classifier({ ...cfg, binary: scopeBinary });
  const report = { scope: ["cwd"], paths: { inside: [], outside: [] }, scope_complete: false };
  writeFileSync(scopeFile, JSON.stringify(report));
  assert.deepEqual(await scopeClient.scope("true", dir, dir), { scope: report.scope, paths: report.paths, scopeComplete: false });
  for (const badReport of [{}, { ...report, scope_complete: undefined }, { ...report, scope_complete: "false" },
    { ...report, scope: [] }, { ...report, scope: ["unknown"] }, { ...report, paths: { inside: [], outside: [1] } }]) {
    writeFileSync(scopeFile, JSON.stringify(badReport));
    await assert.rejects(scopeClient.scope("true", dir, dir), /malformed classifier scope response/);
  }
  console.log(`classifier identity tests passed (${probes} strict handshakes, all artifact/binary hashes, mode, socket substitution, external ownership, cache invalidation, scope CLI)`);
} finally {
  client.stop();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
