// Local protocol/lifecycle fixtures only. No model, provider, or candidate execution.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Classifier } from "../classifier.ts";
import { createFixtureModel, readyResponse, wireResponse } from "./nine-head-fixtures.mjs";

const dir = mkdtempSync(join(tmpdir(), "acclass-transport-"));
const socket = join(dir, "stub.sock");
const fixtureConfig = createFixtureModel(dir);
const connections = new Set();
let respond = (connection) => connection.end(JSON.stringify(wireResponse()) + "\n");
let requests = 0;
const server = createServer((connection) => {
  connections.add(connection);
  connection.on("close", () => connections.delete(connection));
  connection.on("error", () => {});
  connection.setEncoding("utf8");
  let input = "";
  connection.on("data", (chunk) => {
    input += chunk;
    if (!input.includes("\n")) return;
    const request = JSON.parse(input.slice(0, input.indexOf("\n")));
    if (request.ping === true) connection.end(JSON.stringify(readyResponse()) + "\n");
    else { requests++; respond(connection); }
  });
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
const cfg = { enabled: true, ...fixtureConfig, socket,
  spawn: false, startTimeoutMs: 1000, requestTimeoutMs: 100 };
const client = new Classifier(cfg);
const call = () => client.classify("git status", dir, dir);
const waitFor = async (predicate) => {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), "fixture did not settle");
};
const stopped = (pid) => {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
};
const children = [];

try {
  // Split a literal UTF-8 character, not an escaped JSON sequence, across writes.
  const response = Buffer.from(JSON.stringify(wireResponse({ paths: { inside: [join(dir, "☃")], outside: [] } })) + "\n");
  const split = response.indexOf(Buffer.from("☃")) + 1;
  respond = (connection) => {
    connection.write(response.subarray(0, split));
    setTimeout(() => connection.end(response.subarray(split)), 10);
  };
  assert.deepEqual((await call()).paths.inside, [join(dir, "☃")]);

  respond = (connection) => connection.end(Buffer.from([0xff, 10]));
  assert.equal((await call()).ok, false, "invalid UTF-8 cannot be replaced and accepted");
  respond = (connection) => connection.end(JSON.stringify({ identity: wireResponse().identity, input_complete: true }) + "\n");
  assert.equal((await call()).kind, "error", "partial contract is rejected");
  respond = (connection) => connection.end("{" + "x".repeat(256 * 1024));
  assert.match((await call()).message, /response exceeds byte limit/);
  respond = (connection) => connection.end('{"probs":');
  assert.match((await call()).message, /closed before a response/);
  respond = () => {};
  assert.match((await call()).message, /timed out/);

  const before = requests;
  assert.match((await client.classify("☃".repeat(100_000), dir, dir)).message, /request exceeds byte limit/);
  assert.equal(requests, before, "oversize requests fail before connecting, without clipping");

  let finishResponse;
  respond = (connection) => { finishResponse = () => connection.end(JSON.stringify(wireResponse()) + "\n"); };
  const pending = call();
  await waitFor(() => finishResponse);
  client.stop();
  finishResponse();
  assert.equal((await pending).ok, false, "shutdown cannot accept a late response");

  // A permission-denied spawn must be a result, not an unhandled process error.
  const denied = join(dir, "denied");
  writeFileSync(denied, "fixture", { mode: 0o600 });
  const deniedClient = new Classifier({ ...cfg, binary: denied, socket: join(dir, "denied.sock"), spawn: true });
  children.push(deniedClient);
  assert.match((await deniedClient.classify("true", dir, dir)).message, /EACCES/);

  const pidPath = join(dir, "pid");
  const sleeper = join(dir, "sleeper");
  writeFileSync(sleeper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const timeoutClient = new Classifier({ ...cfg, binary: sleeper, socket: join(dir, "timeout.sock"), spawn: true, startTimeoutMs: 2000 });
  children.push(timeoutClient);
  assert.match((await timeoutClient.classify("true", dir, dir)).message, /did not become ready/);
  const timeoutPid = Number(readFileSync(pidPath, "utf8"));
  await waitFor(() => stopped(timeoutPid));

  rmSync(pidPath);
  const stoppedClient = new Classifier({ ...cfg, binary: sleeper, socket: join(dir, "stop.sock"), spawn: true });
  children.push(stoppedClient);
  const starting = stoppedClient.classify("true", dir, dir);
  await waitFor(() => { try { return !!readFileSync(pidPath, "utf8"); } catch { return false; } });
  const stoppedPid = Number(readFileSync(pidPath, "utf8"));
  stoppedClient.stop();
  assert.equal((await starting).ok, false);
  await waitFor(() => stopped(stoppedPid));

  // Concurrent requests supervise one fixture daemon, never one child per call.
  const launches = join(dir, "launches");
  const daemon = join(dir, "daemon");
  const daemonSocket = join(dir, "daemon.sock");
  writeFileSync(daemon, `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const hash = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
const files = ['config.json', 'tokenizer.json', 'thresholds.json', 'heads.json', 'model_contract.json', 'model.safetensors'];
const identity = { protocol: 'acclass-daemon/1', loading_mode: 'q8-runtime',
  artifacts: Object.fromEntries(files.map(name => [name, hash(fs.readFileSync(require('node:path').join(${JSON.stringify(dir)}, name)))])),
  binary_sha256: hash(fs.readFileSync(__filename)) };
const ready = { ...${JSON.stringify(readyResponse())}, identity };
const response = { ...${JSON.stringify(wireResponse())}, identity };
fs.appendFileSync(${JSON.stringify(launches)}, process.pid + '\\n');
const server = net.createServer(c => { c.on('error', () => {}); c.once('data', bytes => c.end(JSON.stringify(JSON.parse(bytes).ping ? ready : response) + '\\n')); });
// Like the real engine, remove only a socket whose old listener is gone.
const probe = net.createConnection(${JSON.stringify(daemonSocket)});
probe.on('connect', () => process.exit(1));
probe.on('error', error => {
  if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) process.exit(1);
  fs.rmSync(${JSON.stringify(daemonSocket)}, { force: true });
  server.listen(${JSON.stringify(daemonSocket)});
});
`, { mode: 0o700 });
  const concurrent = new Classifier({ ...cfg, binary: daemon, socket: daemonSocket, spawn: true });
  children.push(concurrent);
  assert.ok((await Promise.all(Array.from({ length: 4 }, () => concurrent.classify("true", dir, dir)))).every((r) => r.ok));
  let pids = readFileSync(launches, "utf8").trim().split("\n").map(Number);
  assert.equal(pids.length, 1);
  // A rebuilt binary also gets exactly one replacement across sibling calls.
  utimesSync(daemon, new Date(), new Date(Date.now() + 2000));
  assert.ok((await Promise.all(Array.from({ length: 4 }, () => concurrent.classify("true", dir, dir)))).every((r) => r.ok));
  pids = readFileSync(launches, "utf8").trim().split("\n").map(Number);
  assert.equal(pids.length, 2, "concurrent stale detection must share one replacement");
  assert.ok(stopped(pids[0]), "the previous daemon exits before its socket is replaced");
  // Same-size model content replacement must invalidate the hash cache and restart.
  const weights = join(dir, "model.safetensors");
  const oldStat = (await import("node:fs")).statSync(weights);
  const originalWeights = readFileSync(weights, "utf8");
  writeFileSync(weights, originalWeights.replace("synthetic", "different"));
  utimesSync(weights, oldStat.atime, oldStat.mtime);
  assert.ok((await Promise.all(Array.from({ length: 4 }, () => concurrent.classify("true", dir, dir)))).every((r) => r.ok));
  pids = readFileSync(launches, "utf8").trim().split("\n").map(Number);
  assert.equal(pids.length, 3, "model replacement restarts one owned daemon even with preserved size/mtime");
  assert.ok(stopped(pids[1]));
  concurrent.stop();
  await waitFor(() => pids.every(stopped));
  console.log("classifier transport tests passed (UTF-8, byte bounds, EOF, timeout, shutdown, spawn failure, concurrent startup/replacement)");
} finally {
  client.stop();
  for (const child of children) child.stop();
  for (const connection of connections) connection.destroy();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
