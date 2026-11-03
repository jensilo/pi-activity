// Synthetic local sockets/artifacts only; no candidate execution or host daemon.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { Classifier } from "../classifier.ts";
import { createEvidenceProvider } from "../evidence-provider.ts";
import { createFixtureModel, readyResponse, wireResponse } from "./nine-head-fixtures.mjs";

const dir = mkdtempSync(join(tmpdir(), "pi-activity-retry-"));
const socket = join(dir, "synthetic.sock");
const cfg = { enabled: true, ...createFixtureModel(dir), socket, spawn: false,
  startTimeoutMs: 1000, requestTimeoutMs: 60_000 };
const connections = new Set();
let requests = 0;
let probes = 0;
let respond = (connection) => connection.end(JSON.stringify(wireResponse()) + "\n");
const realSetTimeout = setTimeout;
const waitFor = async (condition) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => realSetTimeout(resolve, 5));
  assert.ok(condition(), "synthetic socket fixture did not settle");
};
const server = createServer((connection) => {
  connections.add(connection);
  connection.on("error", () => {});
  connection.on("close", () => connections.delete(connection));
  connection.once("data", (bytes) => {
    const request = JSON.parse(bytes);
    if (request.ping) {
      probes++;
      connection.end(JSON.stringify(readyResponse()) + "\n");
    } else {
      requests++;
      respond(connection, request);
    }
  });
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
const client = new Classifier(cfg);
const provider = createEvidenceProvider({ ...cfg, provider: "acclass" });
const classify = (command = "synthetic read", signal) => client.classify(command, dir, dir, "shell", signal);
try {
  let failures = 0;
  respond = (connection) => {
    if (failures++ < 5) connection.destroy();
    else connection.end(JSON.stringify(wireResponse()) + "\n");
  };
  const beforeSuccess = requests;
  assert.equal((await classify()).ok, true);
  assert.equal(requests - beforeSuccess, 6, "initial request plus five transport retries reaches success");

  const beforeExhausted = requests;
  respond = (connection) => connection.destroy();
  assert.equal((await classify()).ok, false);
  assert.equal(requests - beforeExhausted, 6, "transient failures are capped at six requests");

  // Complete but incompatible contracts and identities must never blind retry.
  for (const response of ["not JSON\n", JSON.stringify(wireResponse({ identity: {} })) + "\n",
    JSON.stringify({ identity: wireResponse().identity, preds: {} }) + "\n",
    JSON.stringify({ identity: wireResponse().identity, error: "bad schema", status: 503 }) + "\n",
    JSON.stringify({ identity: wireResponse().identity, error: "quota exceeded", status: 429 }) + "\n"]) {
    const before = requests;
    respond = (connection) => connection.end(response);
    assert.equal((await classify()).ok, false);
    assert.equal(requests - before, 1, "permanent response failure is not retried");
  }
  const beforeMissing = probes;
  const missing = new Classifier({ ...cfg, binary: join(dir, "nonexistent-binary") });
  assert.equal((await missing.classify("synthetic read", dir, dir)).ok, false);
  assert.equal(probes, beforeMissing, "missing artifacts fail before any daemon request");

  // Rate-limit backoff is abortable, with no follow-up socket after cancellation.
  const backoff = new AbortController();
  const beforeBackoff = requests;
  respond = (connection) => {
    connection.end(JSON.stringify({ identity: wireResponse().identity,
      error: "rate limited", status: 429, retry_after_ms: 999999 }) + "\n");
    realSetTimeout(() => backoff.abort(), 20);
  };
  const backoffStart = Date.now();
  assert.equal((await classify("synthetic rate limit", backoff.signal)).ok, false);
  assert.equal(requests - beforeBackoff, 1);
  assert.ok(Date.now() - backoffStart < 500, "abort interrupts bounded Retry-After backoff");

  // Both inference requests must be accepted concurrently; cancelling one must
  // close its actual socket, not stop or disrupt the healthy sibling/daemon.
  const abort = new AbortController();
  const pendingConnections = new Map();
  respond = (connection, request) => pendingConnections.set(request.cmd, connection);
  const cancelled = provider.classify("cancel synthetic request", dir, dir, "shell", abort.signal);
  const healthy = provider.classify("healthy synthetic request", dir, dir, "shell");
  await waitFor(() => pendingConnections.size === 2);
  const cancelledSocket = pendingConnections.get("cancel synthetic request");
  const healthySocket = pendingConnections.get("healthy synthetic request");
  abort.abort();
  assert.equal((await cancelled).ok, false);
  await waitFor(() => cancelledSocket.destroyed);
  assert.equal(healthySocket.destroyed, false, "sibling socket remains alive");
  healthySocket.end(JSON.stringify(wireResponse()) + "\n");
  assert.equal((await healthy).ok, true);
  respond = (connection) => connection.end(JSON.stringify(wireResponse()) + "\n");
  assert.equal((await classify()).ok, true, "listener remains usable after a sibling abort");

  // Advance only the synthetic clock: a request that never responds must have
  // its socket destroyed at the fixed 30-second total deadline, without retry.
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let deadlineSocket;
  const beforeDeadline = requests;
  respond = (connection) => { deadlineSocket = connection; };
  const deadlineResult = classify("synthetic stalled request");
  await waitFor(() => deadlineSocket);
  mock.timers.tick(30_000);
  assert.equal((await deadlineResult).ok, false);
  mock.timers.reset();
  await waitFor(() => deadlineSocket.destroyed);
  assert.equal(requests - beforeDeadline, 1, "deadline cannot be extended for another retry");

  const preAborted = new AbortController();
  preAborted.abort();
  const beforeAbort = requests;
  assert.equal((await classify("synthetic cancelled before start", preAborted.signal)).ok, false);
  assert.equal(requests, beforeAbort);
  console.log("classifier retry tests passed (six attempts, permanent errors, abortable backoff/socket, overlap, deadline)");
} finally {
  mock.timers.reset();
  client.stop();
  provider.stop();
  for (const connection of connections) connection.destroy();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
