// Synthetic executables and artifacts only. No accelerator, model or private data.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Classifier } from "../classifier.ts";
import { createEvidenceProvider, validateEvidenceProviderConfig } from "../evidence-provider.ts";
import { createFixtureModel, readyResponse, wireResponse } from "./nine-head-fixtures.mjs";

const dir = mkdtempSync(join(tmpdir(), "acclass-device-"));
const launches = join(dir, "launches.jsonl");
const devices = ["auto", "cpu", "cuda", "metal"];
const clients = [];
const records = () => {
  try { return readFileSync(launches, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
};
const stopped = (pid) => {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
};
const waitForExit = async () => {
  for (let i = 0; i < 200 && !records().every(({ pid }) => stopped(pid)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(records().every(({ pid }) => stopped(pid)), "owned fixtures must exit");
};

function writeDaemon(binary, supportsDevice) {
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== 'serve') process.exit(2);
if (!${supportsDevice} && args.includes('--device')) process.exit(2);
const option = flag => args[args.indexOf(flag) + 1];
if (args.includes('--device') && !${JSON.stringify(devices)}.includes(option('--device'))) process.exit(2);
const model = option('--model');
const socket = option('--socket');
const loading_mode = args.includes('--gguf') ? 'gguf' : option('--quant') === 'q8' ? 'q8-runtime' : 'f32';
const files = ['config.json', 'tokenizer.json', 'thresholds.json', 'heads.json', 'model_contract.json',
  loading_mode === 'gguf' ? 'model.gguf' : 'model.safetensors'];
const hash = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
const identity = { protocol: 'acclass-daemon/1', loading_mode,
  artifacts: Object.fromEntries(files.map(name => [name, hash(fs.readFileSync(path.join(model, name)))])),
  binary_sha256: hash(fs.readFileSync(__filename)) };
const ready = { ...${JSON.stringify(readyResponse())}, identity };
const response = { ...${JSON.stringify(wireResponse())}, identity };
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ pid: process.pid, args }) + '\\n');
const server = net.createServer(c => {
  c.on('error', () => {});
  c.once('data', bytes => c.end(JSON.stringify(JSON.parse(bytes).ping ? ready : response) + '\\n'));
});
const probe = net.createConnection(socket);
probe.on('connect', () => process.exit(1));
probe.on('error', error => {
  if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) process.exit(1);
  fs.rmSync(socket, { force: true });
  server.listen(socket);
});
`, { mode: 0o700 });
}

try {
  const fixture = createFixtureModel(dir);
  const binary = join(dir, "daemon");
  const legacyBinary = join(dir, "legacy-daemon");
  writeDaemon(binary, true);
  writeDaemon(legacyBinary, false);
  const base = { provider: "acclass", model: fixture.model, binary, quant: "q8", spawn: true,
    socket: join(dir, "classifier.sock"), startTimeoutMs: 3000, requestTimeoutMs: 1000 };
  const schema = JSON.parse(readFileSync(new URL("../../activity.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.classifier, { not: {}, description: "Not a supported public configuration field." },
    "explicit device and path knobs belong only to the internal adapter");
  for (const device of ["", "mps", "CUDA", "gpu", null, false, 0, [], {}]) {
    for (const cfg of [base, { provider: "none" }]) {
      assert.throws(() => validateEvidenceProviderConfig({ ...cfg, device }), /classifier.device/);
      assert.throws(() => createEvidenceProvider({ ...cfg, device }), /classifier.device/);
    }
  }
  assert.equal(records().length, 0, "validation never spawns");

  // Omitted device must still work with an engine that rejects the new flag.
  const legacy = createEvidenceProvider({ ...base, binary: legacyBinary, socket: join(dir, "legacy.sock") });
  clients.push(legacy);
  const legacyResult = await legacy.classify("true", dir, dir);
  assert.equal(legacyResult.ok, true, JSON.stringify(legacyResult));
  assert.equal(Object.hasOwn(legacyResult.identity, "configuredDevice"), false);
  assert.deepEqual(records().at(-1).args, ["serve", "--model", fixture.model, "--socket", join(dir, "legacy.sock"), "--quant", "q8"]);
  legacy.stop();
  await waitForExit();

  // Exercise the internal adapter -> client -> serve path for every explicit device.
  for (const device of devices) {
    const provider = createEvidenceProvider({ ...base, device, socket: join(dir, `${device}.sock`) });
    clients.push(provider);
    const result = await provider.classify("true", dir, dir);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.identity.configuredDevice, device);
    assert.equal(result.identity.daemonIdentityVerified, true, "artifact identity verification is unchanged");
    assert.deepEqual(records().at(-1).args.slice(-2), ["--device", device]);
    assert.equal(Object.hasOwn(result.identity, "actualDevice"), false);

    // A compatible external listener can be reused; its backend is NOT attested.
    const observer = createEvidenceProvider({ ...base, socket: join(dir, `${device}.sock`), device: "auto", spawn: false });
    clients.push(observer);
    const count = records().length;
    const observed = await observer.classify("true", dir, dir);
    assert.equal(observed.ok, true);
    assert.equal(observed.identity.configuredDevice, "auto", "configured request is not inferred from the listener");
    assert.equal(records().length, count);
    observer.stop();
    provider.stop();
    await waitForExit();
  }

  // A changed request invalidates an owned child's reuse key, without changing
  // protocol identity. Omitted and explicit auto are intentionally distinct.
  const mutable = { ...base, enabled: true, readAllowlist: [] };
  const client = new Classifier(mutable);
  clients.push(client);
  let count = records().length;
  let previousPid;
  for (const device of [undefined, "auto", "cpu", "cuda", "metal", undefined]) {
    mutable.device = device;
    assert.ok((await Promise.all(Array.from({ length: 3 }, () => client.classify("true", dir, dir)))).every(r => r.ok));
    assert.equal(records().length, ++count, "one replacement across concurrent requests per device change");
    const launch = records().at(-1);
    if (previousPid) assert.ok(stopped(previousPid), "old owned daemon exits before replacement");
    previousPid = launch.pid;
    assert.equal(launch.args.includes("--device"), device !== undefined);
    if (device !== undefined) assert.deepEqual(launch.args.slice(-2), ["--device", device]);
    assert.equal((await client.classify("true", dir, dir)).ok, true);
    assert.equal(records().length, count, "same requested device reuses the owned daemon");
  }
  client.stop();
  await waitForExit();

  // GGUF and f32 startup retain their original loading flags alongside device.
  for (const gguf of [false, true]) {
    if (gguf) writeFileSync(join(dir, "model.gguf"), "synthetic GGUF weights");
    const provider = createEvidenceProvider({ ...base, quant: "f32", device: "cuda" });
    clients.push(provider);
    assert.equal((await provider.classify("true", dir, dir)).ok, true);
    assert.deepEqual(records().at(-1).args.slice(-4), gguf
      ? [base.socket, "--gguf", "--device", "cuda"] : ["--quant", "f32", "--device", "cuda"]);
    provider.stop();
    await waitForExit();
  }
  console.log("classifier device tests passed (explicit devices, legacy omission, config validation, configured-only identity, owned reuse, loading modes)");
} finally {
  for (const client of clients) client.stop();
  await waitForExit();
  rmSync(dir, { recursive: true, force: true });
}
