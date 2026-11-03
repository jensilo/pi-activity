// classifier — local `acclass` client.
//
// One Unix-socket NDJSON request per command against a resident `acclass serve`
// daemon, with spawn + supervision when the daemon is not already up. The
// engine answers with nine factual probabilities, thresholded booleans,
// and a scope report. `scope()` exposes daemon-free tree-sitter scope parsing
// for diagnostics; the runtime gate uses `classify()`.
//
// Protocol (see engine/src/main.rs):
//   request : {"cmd","cwd","home"}
//   response: {"identity":{...},"probs":{...},"preds":{...},"ms":n,
//              "scope":[...],"paths":{...},"scope_complete":bool}
//   error   : {"identity":{...},"error":"..."}

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { HEADS, type Head, type Primitives, type ScopeReport } from "./policy.js";
import { serializeActionCall } from "./action-classifier.js";
import type { ReviewToolMetadata } from "./context.js";
import { abortableTask, retryOperation, transientFailure } from "./retry.js";

export type ClassifierDevice = "auto" | "cpu" | "cuda" | "metal";

export interface ClassifierConfig {
  enabled: boolean;
  binary: string;
  socket: string;
  model: string;
  quant: string;
  /** Requested startup backend only; the daemon protocol does not attest it. */
  device?: ClassifierDevice;
  spawn: boolean;
  startTimeoutMs: number;
  requestTimeoutMs: number;
  readAllowlist: string[];
}

export interface ClassifyOk {
  ok: true;
  source: "local";
  probs: Record<Head, number>;
  preds: Primitives;
  scope: string[];
  paths: { inside: string[]; outside: string[] };
  ms: number;
  tokenCount: number;
  inputComplete: true;
  scopeComplete: boolean;
}

export interface ClassifyFailure {
  ok: false;
  kind: "unavailable" | "error";
  message: string;
}

export type ClassifyResult = ClassifyOk | ClassifyFailure;

const MAX_WIRE_BYTES = 256 * 1024;
const PROTOCOL = "acclass-daemon/1";
const MODEL_METADATA = ["config.json", "tokenizer.json", "thresholds.json", "heads.json", "model_contract.json"];

interface DaemonIdentity {
  protocol: typeof PROTOCOL;
  loading_mode: "gguf" | "q8-runtime" | "f32";
  artifacts: Record<string, string>;
  binary_sha256: string;
}

function fingerprint(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) throw new Error(`classifier artifact is not a file: ${path}`);
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(":");
}

/** Both CLI and daemon reports must explicitly attest parser completeness. */
function returnsScopeReport(value: unknown): value is Record<string, unknown> & { scope: string[]; paths: { inside: string[]; outside: string[] }; scope_complete: boolean } {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  const paths = raw.paths as { inside?: unknown; outside?: unknown } | undefined;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
  const knownScopes = new Set(["none", "cwd", "tmp", "home", "system", "other"]);
  return typeof raw.scope_complete === "boolean" && strings(raw.scope) && raw.scope.length > 0 &&
    raw.scope.every((s) => knownScopes.has(s)) && !!paths && strings(paths.inside) && strings(paths.outside);
}

/** The local engine needs no provider credentials, proxy settings or loader hooks. */
function engineEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: homedir(), PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" };
  for (const key of ["RAYON_NUM_THREADS", "CANDLE_NUM_THREADS"]) {
    const value = process.env[key];
    if (value && /^[1-9]\d{0,3}$/.test(value)) env[key] = value;
  }
  return env;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function transportError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code, classifierTransport: true });
}

/** One request/response line over the daemon socket, with a hard timeout. */
function socketRequest(socketPath: string, request: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    signal?.throwIfAborted();
    const sock = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (fn: (v: unknown) => void, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      sock.destroy();
      fn(value);
    };
    const onAbort = () => finish(rejectPromise, signal?.reason ?? new Error("classifier request cancelled"));
    const timer = setTimeout(() => finish(rejectPromise, transportError(`request timed out after ${timeoutMs}ms`, "ETIMEDOUT")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    sock.on("connect", () => { if (!settled) sock.write(JSON.stringify(request) + "\n"); });
    sock.on("data", (chunk: Buffer) => {
      const nl = chunk.indexOf(10);
      const part = nl < 0 ? chunk : chunk.subarray(0, nl);
      bytes += part.length;
      if (bytes > MAX_WIRE_BYTES) {
        finish(rejectPromise, new Error("classifier response exceeds byte limit"));
        return;
      }
      chunks.push(part);
      if (nl < 0) return;
      try {
        const line = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
        finish(resolvePromise, JSON.parse(line));
      } catch (err) {
        finish(rejectPromise, err instanceof Error ? err : new Error(String(err)));
      }
    });
    sock.on("error", (err) => finish(rejectPromise, Object.assign(err, { classifierTransport: true })));
    sock.on("close", () => finish(rejectPromise, transportError("connection closed before a response", "ECONNRESET")));
  });
}

function toPrimitives(preds: unknown): Primitives | undefined {
  if (!preds || typeof preds !== "object" || Object.keys(preds).length !== HEADS.length) return undefined;
  const out = {} as Primitives;
  for (const head of HEADS) {
    const v = (preds as Record<string, unknown>)[head];
    if (typeof v !== "boolean") return undefined;
    out[head] = v;
  }
  return out;
}

function toProbs(probs: unknown): Record<Head, number> | undefined {
  if (!probs || typeof probs !== "object" || Object.keys(probs).length !== HEADS.length) return undefined;
  const out = {} as Record<Head, number>;
  for (const head of HEADS) {
    const v = (probs as Record<string, unknown>)[head];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return undefined;
    out[head] = v;
  }
  return out;
}

export class Classifier {
  private child?: ChildProcess;
  private starting?: Promise<DaemonIdentity>;
  private generation = 0;
  private spawnedFingerprint?: string;
  private readonly hashes = new Map<string, { fingerprint: string; digest: string }>();

  constructor(private readonly cfg: ClassifierConfig) {}

  /** Classify one command. Never throws: failures are a discriminated result. */
  async classify(cmd: string, cwd: string, home: string, inputKind: "shell" | "action" = "shell", signal?: AbortSignal): Promise<ClassifyResult> {
    if (!this.cfg.enabled) return { ok: false, kind: "unavailable", message: "classifier disabled" };
    if (!cmd.trim()) return { ok: false, kind: "error", message: "empty command" };
    try {
      const raw = (await this.request({ cmd, cwd, home, input_kind: inputKind }, signal)) as Record<string, unknown>;
      if (raw && typeof raw.error === "string") return { ok: false, kind: "error", message: raw.error };
      const preds = toPrimitives(raw?.preds);
      const probs = toProbs(raw?.probs);
      if (!preds || !probs || raw.input_complete !== true || !Number.isInteger(raw.token_count) ||
          (raw.token_count as number) < 1 || (raw.token_count as number) > 2048) {
        return { ok: false, kind: "error", message: "incompatible or incomplete nine-head classifier response" };
      }
      if (!returnsScopeReport(raw)) {
        return { ok: false, kind: "error", message: "malformed classifier scope response" };
      }
      return {
        ok: true,
        source: "local",
        probs,
        preds,
        scope: raw.scope,
        paths: { inside: raw.paths.inside, outside: raw.paths.outside },
        ms: typeof raw.ms === "number" && Number.isFinite(raw.ms) ? raw.ms : 0,
        tokenCount: raw.token_count as number,
        inputComplete: true,
        scopeComplete: raw.scope_complete,
      };
    } catch (err) {
      return { ok: false, kind: "unavailable", message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Score full runtime observations, not the stipulated fictional backend contract.
   * Only positive risk signals are eligible; negatives cannot certify absent effects. */
  async classifyActionCall(tool: string, input: unknown, metadata: ReviewToolMetadata | undefined,
    cwd: string, home: string, signal?: AbortSignal): Promise<ClassifyResult> {
    let evidence: string;
    try {
      evidence = serializeActionCall(tool, input, metadata);
    } catch (err) {
      return { ok: false, kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
    return this.classify(evidence, cwd, home, "action", signal);
  }

  /** Score exact fictional evidence, never certify a real MCP backend or policy allow. */
  async classifyActionEvidence(exactInput: string, cwd: string, home: string, signal?: AbortSignal): Promise<ClassifyResult> {
    try {
      const value = JSON.parse(exactInput);
      const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
      if (!object(value) || value.representation !== "action-behavior-evidence-json/0.3" ||
          typeof value.trust_condition !== "string" || !value.trust_condition.trim() || !object(value.backend_contract) ||
          !object(value.input_schema) || !object(value.evaluated_arguments) ||
          typeof value.effective_namespace !== "string" || !value.effective_namespace.trim()) {
        return { ok: false, kind: "error", message: "unsupported action evidence contract" };
      }
    } catch {
      return { ok: false, kind: "error", message: "invalid action evidence JSON" };
    }
    // Preserve the exact supplied feature bytes, without reserialization or metadata.
    return this.classify(exactInput, cwd, home, "action", signal);
  }

  /** Daemon-free scope analysis via the `acclass scope` CLI. Throws on failure. */
  async scope(cmd: string, cwd: string, home: string): Promise<ScopeReport> {
    if (!existsSync(this.cfg.binary)) throw new Error(`classifier binary not found: ${this.cfg.binary}`);
    return new Promise<ScopeReport>((resolvePromise, rejectPromise) => {
      const child = spawn(this.cfg.binary, ["scope", "--cwd", cwd, "--home", home, "--stdin"], {
        stdio: ["pipe", "pipe", "pipe"], env: engineEnvironment(),
      });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.stderr?.on("data", (d) => (err += d.toString()));
      child.on("error", rejectPromise);
      child.on("close", (code) => {
        if (code !== 0) {
          rejectPromise(new Error(err.trim() || `acclass scope exited with code ${code}`));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(out.trim());
          if (!returnsScopeReport(parsed)) throw new Error("malformed classifier scope response");
          resolvePromise({ scope: parsed.scope, paths: parsed.paths, scopeComplete: parsed.scope_complete });
        } catch (e) {
          rejectPromise(e instanceof Error ? e : new Error(String(e)));
        }
      });
      child.stdin?.end(cmd);
    });
  }

  /** Stop the daemon we spawned (idempotent). */
  stop(): void {
    this.generation++;
    this.stopChild();
  }

  private stopChild(): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }

  private async request(body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_WIRE_BYTES) {
      throw new Error("classifier request exceeds byte limit; clipping is forbidden");
    }
    const generation = this.generation;
    return retryOperation(async (callSignal, remainingMs) => {
      this.checkGeneration(generation);
      // Startup is shared, but waiting/cancellation and inference sockets belong
      // to this request. Never stop a shared daemon to cancel one sibling.
      const expected = await abortableTask(() => this.ensureDaemon(generation), callSignal);
      this.checkGeneration(generation);
      callSignal.throwIfAborted();
      const response = await socketRequest(this.cfg.socket, body, Math.min(this.cfg.requestTimeoutMs, remainingMs), callSignal);
      this.checkGeneration(generation);
      this.checkIdentity(response, expected);
      const raw = response as Record<string, unknown>;
      if (typeof raw.error === "string") {
        const error = Object.assign(new Error(raw.error), { status: raw.status, code: raw.code, retryAfterMs: raw.retry_after_ms });
        if (transientFailure(error)) throw Object.assign(error, { classifierTransport: true });
      }
      return response;
    }, {
      signal,
      shouldRetry: (error) => {
        this.checkGeneration(generation);
        return !!(error && typeof error === "object" && "classifierTransport" in error && error.classifierTransport && transientFailure(error));
      },
    });
  }

  private checkGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error("classifier stopped during request");
  }

  private checkIdentity(response: unknown, expected: DaemonIdentity): void {
    if (!response || typeof response !== "object" ||
        !isDeepStrictEqual((response as Record<string, unknown>).identity, expected)) {
      throw new Error("incompatible classifier daemon identity (protocol, model artifacts, loading mode, or binary)");
    }
  }

  private async expectedIdentity(): Promise<{ identity: DaemonIdentity; fingerprint: string }> {
    const loading_mode = existsSync(join(this.cfg.model, "model.gguf")) ? "gguf" : this.cfg.quant === "q8" ? "q8-runtime" : "f32";
    if (loading_mode !== "gguf" && !["q8", "f32", "f16"].includes(this.cfg.quant)) throw new Error("unsupported classifier quantization");
    const files = [...MODEL_METADATA, loading_mode === "gguf" ? "model.gguf" : "model.safetensors"];
    const paths = [...files.map((name) => join(this.cfg.model, name)), this.cfg.binary];
    const before = paths.map(fingerprint);
    const digests: string[] = [];
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const cached = this.hashes.get(path);
      if (cached?.fingerprint === before[i]) {
        digests.push(cached.digest);
        continue;
      }
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      if (fingerprint(path) !== before[i]) throw new Error("classifier artifacts changed while hashing");
      const digest = hash.digest("hex");
      this.hashes.set(path, { fingerprint: before[i], digest });
      digests.push(digest);
    }
    if (!isDeepStrictEqual(paths.map(fingerprint), before)) throw new Error("classifier artifacts changed while hashing");
    return { identity: { protocol: PROTOCOL, loading_mode,
      artifacts: Object.fromEntries(files.map((name, i) => [name, digests[i]])), binary_sha256: digests.at(-1)! },
      fingerprint: JSON.stringify([paths, before, loading_mode, this.cfg.device ?? null]) };
  }

  /** Only refusal/missing sockets mean absent. A responsive incompatible server is never replaced. */
  private async ping(expected: DaemonIdentity): Promise<boolean> {
    let response: unknown;
    try {
      response = await socketRequest(this.cfg.socket, { ping: true }, Math.min(500, this.cfg.requestTimeoutMs));
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "ECONNREFUSED" || code === "ENOENT") return false;
      throw err;
    }
    this.checkIdentity(response, expected);
    const raw = response as Record<string, unknown>;
    if (raw.ready !== true || raw.context_limit_inclusive !== 2048 || !isDeepStrictEqual(raw.heads, HEADS)) {
      throw new Error("incompatible classifier readiness response");
    }
    return true;
  }

  private async ensureDaemon(generation: number): Promise<DaemonIdentity> {
    // Serialize hashing, readiness, and replacement so sibling calls share one startup.
    if (!this.starting) {
      this.starting = this.prepareDaemon(generation).finally(() => {
        this.starting = undefined;
      });
    }
    const identity = await this.starting;
    this.checkGeneration(generation);
    return identity;
  }

  private async prepareDaemon(generation: number): Promise<DaemonIdentity> {
    const expected = await this.expectedIdentity();
    this.checkGeneration(generation);
    if (this.child && this.spawnedFingerprint !== expected.fingerprint) {
      await this.restartStale();
      this.checkGeneration(generation);
    }
    const running = await this.ping(expected.identity);
    this.checkGeneration(generation);
    if (running) return expected.identity;
    if (this.child) {
      await this.restartStale();
      this.checkGeneration(generation);
      // A different server may have bound while our own child was exiting.
      if (await this.ping(expected.identity)) return expected.identity;
    }
    if (!this.cfg.spawn) throw new Error("classifier daemon is not running and classifier.spawn is false");
    await this.spawnDaemon(generation, expected.identity, expected.fingerprint);
    return expected.identity;
  }

  /** Stop only our own stale child; never unlink a possibly replaced socket. */
  private async restartStale(): Promise<void> {
    const child = this.child;
    this.stopChild();
    if (child) {
      const deadline = Date.now() + 2000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(50);
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error("stale classifier daemon did not exit; socket was not removed");
      }
    }
    // Do not unlink here: another server could have taken over the socket.
    // The engine removes a stale socket only after probing for a listener.
  }

  private async spawnDaemon(generation: number, expected: DaemonIdentity, spawnedFingerprint: string): Promise<void> {
    const args = ["serve", "--model", this.cfg.model, "--socket", this.cfg.socket];
    if (expected.loading_mode === "gguf") args.push("--gguf");
    else args.push("--quant", this.cfg.quant);
    // Omission preserves compatibility with engines predating backend selection.
    if (this.cfg.device !== undefined) args.push("--device", this.cfg.device);

    mkdirSync(dirname(this.cfg.socket), { recursive: true });
    const child = spawn(this.cfg.binary, args, { stdio: ["ignore", "pipe", "pipe"], env: engineEnvironment(), cwd: dirname(this.cfg.socket) });
    this.child = child;
    let spawnError: Error | undefined;
    child.on("error", (err) => { spawnError = err; });
    this.spawnedFingerprint = spawnedFingerprint;
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("exit", () => {
      if (this.child === child) this.child = undefined;
    });

    const deadline = Date.now() + this.cfg.startTimeoutMs;
    try {
      while (Date.now() < deadline) {
        this.checkGeneration(generation);
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`classifier daemon exited (${child.exitCode ?? child.signalCode})`);
        }
        const ready = await this.ping(expected);
        this.checkGeneration(generation);
        if (spawnError) throw spawnError;
        if (ready) return;
        await sleep(100);
      }
      throw new Error(`classifier daemon did not become ready within ${this.cfg.startTimeoutMs}ms`);
    } catch (err) {
      if (this.child === child) this.stopChild();
      throw err;
    }
  }
}
