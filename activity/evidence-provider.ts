import { homedir } from "node:os";
import { join } from "node:path";
import { verifyInstallation, type AcclassSettings } from "./acclass-setup.js";
import { abortableTask } from "./retry.js";
import { Classifier, type ClassifierConfig, type ClassifierDevice, type ClassifyResult } from "./classifier.js";
import { configuredClassifierIdentity } from "./telemetry.js";
import type { Head, Primitives, ScopeReport } from "./policy.js";

/** Only these package-owned implementations may supply classifier evidence. */
export type EvidenceProviderConfig = {
  provider: "none" | "acclass";
  binary?: string;
  socket?: string;
  model?: string;
  quant?: "q8" | "f32";
  device?: ClassifierDevice;
  spawn?: boolean;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
};

export type EvidenceIdentity = {
  provider: "none" | "acclass";
  protocol?: "acclass-daemon/1";
  configuredBinary?: string;
  configuredModel?: string;
  configuredQuant?: string;
  /** Requested backend, never an attestation of the daemon's actual device. */
  configuredDevice?: ClassifierDevice;
  configuredThresholds?: Record<Head, number>;
  /** The existing transport verifies artifact SHA-256s and binary identity on
   * every response, not the backend device. Configured paths alone are not an attestation. */
  daemonIdentityVerified: boolean;
};

export type EvidenceResult = {
  ok: true;
  provider: "acclass";
  preds: Primitives;
  probs: Record<Head, number>;
  scope: ScopeReport;
  inputComplete: true;
  tokenCount: number;
  ms: number;
  wallMs: number;
  identity: EvidenceIdentity;
} | {
  ok: false;
  provider: "none" | "acclass";
  kind: "unavailable" | "invalid" | "cancelled";
  message: string;
  wallMs: number;
  identity: EvidenceIdentity;
};

export interface EvidenceProvider {
  readonly kind: "none" | "acclass";
  classify(input: string, cwd: string, home: string, inputKind?: "shell" | "action", signal?: AbortSignal): Promise<EvidenceResult>;
  stop(): void;
}

class NoEvidenceProvider implements EvidenceProvider {
  readonly kind = "none";
  async classify(_input: string, _cwd: string, _home: string, _kind?: "shell" | "action", signal?: AbortSignal): Promise<EvidenceResult> {
    return { ok: false, provider: "none", kind: signal?.aborted ? "cancelled" : "unavailable",
      message: signal?.aborted ? "classification cancelled" : "acclass is disabled",
      wallMs: 0, identity: { provider: "none", daemonIdentityVerified: false } };
  }
  stop(): void {}
}

class AcclassEvidenceProvider implements EvidenceProvider {
  readonly kind = "acclass";
  private readonly client: Classifier;
  private readonly identity: EvidenceIdentity;

  constructor(cfg: ClassifierConfig) {
    this.client = new Classifier(cfg);
    this.identity = { provider: "acclass", protocol: "acclass-daemon/1", configuredBinary: cfg.binary,
      ...configuredClassifierIdentity(cfg) };
  }

  async classify(input: string, cwd: string, home: string, kind: "shell" | "action" = "shell", signal?: AbortSignal): Promise<EvidenceResult> {
    const startedAt = performance.now();
    const failed = (failure: "unavailable" | "invalid" | "cancelled", message: string): EvidenceResult => ({
      ok: false, provider: "acclass", kind: failure, message,
      wallMs: Math.round(performance.now() - startedAt), identity: this.identity,
    });
    if (signal?.aborted) return failed("cancelled", "classification cancelled");
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<undefined>((resolve) => {
      if (!signal) return;
      onAbort = () => resolve(undefined);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      // Cancelling one consumer never stops the shared daemon or sibling work.
      const result: ClassifyResult | undefined = await Promise.race([
        this.client.classify(input, cwd, home, kind, signal), cancelled,
      ]);
      if (!result || signal?.aborted) return failed("cancelled", "classification cancelled");
      if (!result.ok) return failed(result.kind === "error" ? "invalid" : "unavailable", result.message);
      return { ok: true, provider: "acclass", preds: result.preds, probs: result.probs,
        scope: { scope: result.scope, paths: result.paths, scopeComplete: result.scopeComplete },
        inputComplete: result.inputComplete, tokenCount: result.tokenCount, ms: result.ms,
        wallMs: Math.round(performance.now() - startedAt),
        identity: { ...this.identity, daemonIdentityVerified: true } };
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  stop(): void { this.client.stop(); }
}

/** Internal explicit-path adapter. Not a public Activity configuration API. */
export function normalizeEvidenceProviderConfig(cfg: EvidenceProviderConfig, home: string = homedir()): EvidenceProviderConfig {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("activity.classifier must be an object");
  const normalized = { ...cfg };
  for (const key of ["binary", "socket", "model"] as const) {
    const value = normalized[key];
    if (typeof value === "string") {
      if (value === "~") normalized[key] = home;
      else if (value.startsWith("~/")) normalized[key] = join(home, value.slice(2));
    }
  }
  return normalized;
}

/** Validate normalized configuration without touching artifacts, sockets or processes. */
export function validateEvidenceProviderConfig(cfg: EvidenceProviderConfig): void {
  if (!cfg || !["none", "acclass"].includes(cfg.provider)) throw new Error("activity.classifier.provider must be none or acclass");
  if (cfg.device !== undefined && !["auto", "cpu", "cuda", "metal"].includes(cfg.device)) {
    throw new Error("activity.classifier.device must be auto, cpu, cuda or metal");
  }
  if (cfg.provider === "none") return;
  for (const key of ["binary", "socket", "model"] as const) {
    if (typeof cfg[key] !== "string" || !cfg[key]!.trim()) {
      throw new Error(`activity.classifier.${key} is required when provider is acclass`);
    }
  }
  if (cfg.quant !== undefined && cfg.quant !== "q8" && cfg.quant !== "f32") {
    throw new Error("activity.classifier.quant must be q8 or f32");
  }
  if (cfg.spawn !== undefined && typeof cfg.spawn !== "boolean") throw new Error("activity.classifier.spawn must be boolean");
  for (const key of ["startTimeoutMs", "requestTimeoutMs"] as const) {
    if (cfg[key] !== undefined && (!Number.isInteger(cfg[key]) || cfg[key]! < 1)) {
      throw new Error(`activity.classifier.${key} must be a positive integer`);
    }
  }
}

/** No discovery, PATH lookup, plugin loading or implicit acclass startup. */
export function createEvidenceProvider(cfg: EvidenceProviderConfig): EvidenceProvider {
  cfg = normalizeEvidenceProviderConfig(cfg);
  validateEvidenceProviderConfig(cfg);
  if (cfg.provider === "none") return new NoEvidenceProvider();
  return new AcclassEvidenceProvider({ enabled: true, binary: cfg.binary!, socket: cfg.socket!, model: cfg.model!,
    quant: cfg.quant ?? "q8", device: cfg.device, spawn: cfg.spawn ?? false, startTimeoutMs: cfg.startTimeoutMs ?? 30_000,
    requestTimeoutMs: cfg.requestTimeoutMs ?? 10_000, readAllowlist: [] });
}

export type EvidenceProviderFactory = (settings: AcclassSettings) => EvidenceProvider;

/** Managed adapter verifies every file before each use, including cached daemon use.
 * A verification failure drops the client; it never falls back to unchecked paths. */
export function createManagedEvidenceProvider(settings: AcclassSettings, dependencies: {
  verify?: (variant: AcclassSettings["variant"]) => Promise<EvidenceProviderConfig>;
  create?: (config: EvidenceProviderConfig) => EvidenceProvider;
} = {}): EvidenceProvider {
  if (!settings.enabled) return new NoEvidenceProvider();
  const verify = dependencies.verify ?? ((variant) => verifyInstallation(undefined, variant));
  const create = dependencies.create ?? createEvidenceProvider;
  let client: EvidenceProvider | undefined;
  let key: string | undefined;
  let stopped = false;
  const drop = () => { client?.stop(); client = undefined; key = undefined; };
  return {
    kind: "acclass",
    async classify(input, cwd, home, inputKind = "shell", signal) {
      const started = performance.now();
      const failure = (): EvidenceResult => ({ ok: false, provider: "acclass",
        kind: signal?.aborted ? "cancelled" : "unavailable",
        message: signal?.aborted ? "classification cancelled" : "managed acclass verification/use failed; using judge fallback",
        wallMs: Math.round(performance.now() - started), identity: { provider: "acclass", daemonIdentityVerified: false } });
      if (stopped || signal?.aborted) return failure();
      try {
        const config = signal ? await abortableTask(() => verify(settings.variant), signal) : await verify(settings.variant);
        if (stopped || signal?.aborted) return failure();
        const next = JSON.stringify(config);
        if (!client || next !== key) {
          drop();
          client = create(config);
          key = next;
        }
        return await client.classify(input, cwd, home, inputKind, signal);
      } catch {
        // Cancellation of one consumer must not terminate sibling requests.
        if (!signal?.aborted) drop();
        return failure();
      }
    },
    stop() { stopped = true; drop(); },
  };
}
