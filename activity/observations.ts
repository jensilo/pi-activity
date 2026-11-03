import { LogSanitizer, type RedactionConfig } from "./privacy.js";
import { HEADS, type Head } from "./policy.js";
import { ACTIVITY_VERSION, OBSERVATION_ENTRY_TYPE, OBSERVATION_VERSION } from "./version.js";

export type Modes = { auto: boolean; readOnly: boolean; remoteReadOnly: boolean };
export type Counts = { files: number; sh: number; mcp: number; blocked: number };
export type InputType = "shell" | "file" | "action";
export type Category = "files" | "sh" | "mcp" | "other" | "wrapper";
export type CallStatus = "pending" | "executing" | "ok" | "error" | "blocked" | "rejected" | "interrupted" | "unknown";
export type Preview = { text: string; omittedChars: number };
export type CallEvent = { toolCallId: string; toolName: string; parentToolCallId?: string; input?: unknown; args?: unknown };
export type ToolSource = { sourceInfo?: { source?: string; path?: string; server?: string; serverName?: string }; server?: string; serverName?: string; namespace?: { name: string } };
export type VerdictRoute = "local-allow" | "judge-allow" | "user-override" | "final-block";
export type ClassifierSignals = { probs?: Partial<Record<Head, number>>; preds?: Partial<Record<Head, boolean>>; appliedHeads?: readonly Head[] };
/** Quantiles cover retained samples only; count/sum cover all observed measurements. */
export type Latency = { count: number; sumMs: number; samples: number[] };
export type LatencyStats = { count: number; sampleCount: number; meanMs?: number; medianMs?: number; p95Ms?: number };
export type ModelUsage = { configured?: string; actual: Record<string, number>; omitted: number };
export type RequestOptions = { model?: string; configuredModel?: string };
export type ExecutionOptions = { executionStartedAt?: number; durationMs?: number };
export type GateDetail = { explanation?: string; prefilter?: "allow" | "review"; info?: ToolSource;
  route?: VerdictRoute; reason?: string; gateMs?: number; reviewMs?: number; signals?: ClassifierSignals };
export type CallObservation = {
  id: string; turn: number; tool: string; category: Category; nested: boolean; user: boolean;
  status: CallStatus; executionConfirmed: boolean; startedAt: number; durationMs?: number;
  exitCode?: number; preview?: Preview; explanation?: Preview; verdict?: "allow" | "block";
  prefilter?: "allow" | "review"; counted: boolean;
  route?: VerdictRoute; reason?: string; gateMs?: number; reviewMs?: number;
  submissionDurationMs?: number; executionStartedAt?: number; signals?: ClassifierSignals;
  source?: string; server?: string; namespace?: string; reportedError?: boolean;
};
export type Evaluation = {
  inputType: InputType; status: "success" | "failure" | "disabled" | "skipped";
  probs?: Partial<Record<Head, number>>; preds?: Partial<Record<Head, boolean>>;
  appliedHeads?: readonly Head[]; wallMs?: number; inferenceMs?: number; toolCallId?: string;
};
/** probabilitySum includes positive predictions only. Separate sample counts keep legacy restores honest. */
export type HeadStats = { samples: number; positive: number; probabilitySum: number; supportSum: number; applied: number; appliedSupportSum: number;
  positiveProbabilitySum?: number; positiveProbabilitySamples?: number; appliedPositive?: number; appliedProbabilitySum?: number; appliedPositiveProbabilitySum?: number; appliedLabelSamples?: number };
export type ActivityStats = { errors: number; errorsByCategory: Record<Category, number>; blocksByCategory: Record<Category, number>;
  blocksByReason: Record<string, number>; otherBlockReasons: number };
export type GuardWait = { wallMs: number; coverage: "complete" | "partial" | "unavailable" };
export type Telemetry = {
  classifier: { enabled: boolean; byInput: Record<InputType, { success: number; failure: number; disabled: number; skipped: number; wallMs: number }>; heads: Record<Head, HeadStats>; inference?: Latency; endToEnd?: Latency };
  judge: { started: number; requests: number; requestsKnown: boolean; retries: number; fallbacks: number; wallMs: number; outcomes: Record<JudgeOutcome, number>; latency?: Latency; models?: ModelUsage };
  summaries: { requests: number; requestsKnown: boolean; generated: number; cached: number; shared: number; restored: number; failed: number; unused: number; wallMs: number; latency?: Latency; models?: ModelUsage };
  approvals: { choices: Record<ApprovalChoice, number>; effectiveOverrides: number; prompts?: number; latency?: Latency };
  activity?: ActivityStats; gate?: Latency; guardWait?: GuardWait;
};
export type JudgeOutcome = "allow" | "deny" | "timeout" | "cancelled" | "unavailable" | "interrupted";
export type ApprovalChoice = "allow" | "block" | "timeout" | "cancelled" | "unavailable";
export type LiveJudge = { id: string; startedAt: number; expiresAt?: number; retries: number };
export type TurnObservation = { id: number; startedAt: number; endedAt?: number; counts: Counts; telemetry: Telemetry };
export type ObservationSnapshot = {
  version: 1; packageVersion: string; coverage: "complete" | "incomplete";
  totals: Counts; telemetry: Telemetry; turns: TurnObservation[]; history: CallObservation[];
  omitted: number; liveJudges: LiveJudge[]; active: boolean;
  /** Fixed aggregate uncertainty, independent of retained call histories. */
  unresolved: number;
  /** Fixed pending aggregate only; tokens and monotonic timestamps are never persisted. */
  guardWaitPending?: number;
};
export type ObservationView = ObservationSnapshot & { selected: TurnObservation };
export type BranchEntry = { type: string; customType?: string; data?: unknown };
export type ObservationOptions = { redaction?: RedactionConfig; maxHistory?: number; maxTurns?: number; previewChars?: number; now?: () => number; monotonicNow?: () => number;
  judgeRequestsObserved?: boolean; summaryRequestsObserved?: boolean; judgeModel?: string; summaryModel?: string };
const CATEGORIES: readonly Category[] = ["files", "sh", "mcp", "other", "wrapper"];
const ROUTES: readonly VerdictRoute[] = ["local-allow", "judge-allow", "user-override", "final-block"];
const SAMPLE_LIMIT = 32;
const emptyLatency = (): Latency => ({ count: 0, sumMs: 0, samples: [] });
const emptyModels = (): ModelUsage => ({ actual: {}, omitted: 0 });
const emptyActivity = (): ActivityStats => ({ errors: 0, errorsByCategory: categoryCounts(), blocksByCategory: categoryCounts(), blocksByReason: {}, otherBlockReasons: 0 });
function categoryCounts(): Record<Category, number> { return Object.fromEntries(CATEGORIES.map((key) => [key, 0])) as Record<Category, number>; }
function measure(latency: Latency, ms: unknown): void {
  if (!finite(ms)) return;
  latency.count++; latency.sumMs += ms; latency.samples.push(ms);
  if (latency.samples.length > SAMPLE_LIMIT) latency.samples.shift();
}
export function latencyStats(latency?: Latency): LatencyStats {
  if (!latency?.count) return { count: 0, sampleCount: 0 };
  const samples = [...latency.samples].sort((a, b) => a - b), n = samples.length;
  return { count: latency.count, sampleCount: n, meanMs: latency.sumMs / latency.count,
    ...(n ? { medianMs: n % 2 ? samples[(n - 1) / 2] : (samples[n / 2 - 1] + samples[n / 2]) / 2,
      p95Ms: samples[Math.ceil(n * 0.95) - 1] } : {}) };
}
const LIMITS = { history: 256, turns: 16, preview: 400, bytes: 65_536, pending: 512 };
const emptyCounts = (): Counts => ({ files: 0, sh: 0, mcp: 0, blocked: 0 });
function emptyTelemetry(enabled = true): Telemetry {
  return {
    classifier: { enabled, byInput: Object.fromEntries(["shell", "file", "action"].map((key) => [key,
      { success: 0, failure: 0, disabled: 0, skipped: 0, wallMs: 0 }])) as Telemetry["classifier"]["byInput"],
      heads: Object.fromEntries(HEADS.map((head) => [head, { samples: 0, positive: 0, probabilitySum: 0, supportSum: 0, applied: 0, appliedSupportSum: 0,
        positiveProbabilitySum: 0, positiveProbabilitySamples: 0, appliedPositive: 0, appliedProbabilitySum: 0, appliedPositiveProbabilitySum: 0, appliedLabelSamples: 0 }])) as Record<Head, HeadStats>,
      inference: emptyLatency(), endToEnd: emptyLatency() },
    judge: { started: 0, requests: 0, requestsKnown: false, retries: 0, fallbacks: 0, wallMs: 0,
      outcomes: { allow: 0, deny: 0, timeout: 0, cancelled: 0, unavailable: 0, interrupted: 0 }, latency: emptyLatency(), models: emptyModels() },
    summaries: { requests: 0, requestsKnown: false, generated: 0, cached: 0, shared: 0, restored: 0, failed: 0, unused: 0, wallMs: 0, latency: emptyLatency(), models: emptyModels() },
    approvals: { choices: { allow: 0, block: 0, timeout: 0, cancelled: 0, unavailable: 0 }, effectiveOverrides: 0, prompts: 0, latency: emptyLatency() },
    activity: emptyActivity(), gate: emptyLatency(), guardWait: { wallMs: 0, coverage: "complete" },
  };
}
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
function number(n: unknown): number { return finite(n) ? n : 0; }
function bounded(value: number | undefined, fallback: number, max: number, min = 1): number {
  return finite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}
function object(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
function counts(value: unknown): Counts | undefined {
  if (!object(value) || !["files", "sh", "mcp", "blocked"].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)) return;
  return { files: value.files, sh: value.sh, mcp: value.mcp, blocked: value.blocked };
}
/** Strict field projection: never restore arbitrary record subtrees or operational text. */
function telemetry(value: unknown): Telemetry | undefined {
  const result = emptyTelemetry();
  if (!object(value)) return;
  for (const section of ["classifier", "judge", "summaries", "approvals"] as const) {
    if (!object(value[section])) return;
  }
  function project(target: any, source: any): boolean {
    if (!object(source)) return false;
    const extensions = new Set(["positiveProbabilitySum", "positiveProbabilitySamples", "appliedPositive", "appliedProbabilitySum", "appliedPositiveProbabilitySum", "appliedLabelSamples",
      "inference", "endToEnd", "latency", "models", "prompts", "activity", "gate", "guardWait"]);
    for (const key of Object.keys(target)) {
      if (extensions.has(key)) continue;
      if (typeof target[key] === "number") {
        if (!finite(source[key])) return false;
        target[key] = source[key];
      } else if (typeof target[key] === "boolean") {
        if (typeof source[key] !== "boolean") return false;
        target[key] = source[key];
      } else if (!project(target[key], source[key])) return false;
    }
    return true;
  }
  if (!project(result, value)) return;
  if (value.guardWait === undefined) result.guardWait = { wallMs: 0, coverage: "unavailable" };
  else {
    const wait = value.guardWait;
    if (!object(wait) || !finite(wait.wallMs) || !["complete", "partial", "unavailable"].includes(wait.coverage)) return;
    result.guardWait = { wallMs: wait.wallMs, coverage: wait.coverage };
  }
  function latency(source: unknown): Latency | undefined {
    if (source === undefined) return emptyLatency();
    if (!object(source) || !Number.isSafeInteger(source.count) || source.count < 0 || !finite(source.sumMs) ||
      !Array.isArray(source.samples) || source.samples.length > SAMPLE_LIMIT || source.samples.length > source.count || !source.samples.every(finite)) return;
    return { count: source.count, sumMs: source.sumMs, samples: [...source.samples] };
  }
  function models(source: unknown): ModelUsage | undefined {
    if (source === undefined) return emptyModels();
    if (!object(source) || !object(source.actual) || Object.keys(source.actual).length > 8 || !finite(source.omitted) ||
      (source.configured !== undefined && (typeof source.configured !== "string" || source.configured.length > 120))) return;
    const actual: Record<string, number> = {};
    for (const [key, count] of Object.entries(source.actual)) {
      if (key.length > 120 || !finite(count)) return;
      Object.defineProperty(actual, key, { value: count, enumerable: true, writable: true, configurable: true });
    }
    return { ...(source.configured === undefined ? {} : { configured: source.configured }), actual, omitted: source.omitted };
  }
  result.classifier.inference = latency(value.classifier.inference);
  result.classifier.endToEnd = latency(value.classifier.endToEnd);
  result.gate = latency(value.gate);
  for (const key of ["judge", "summaries", "approvals"] as const) result[key].latency = latency(value[key].latency);
  for (const key of ["judge", "summaries"] as const) result[key].models = models(value[key].models);
  if (!result.classifier.inference || !result.classifier.endToEnd || !result.gate ||
    !result.judge.latency || !result.summaries.latency || !result.approvals.latency || !result.judge.models || !result.summaries.models) return;
  if (value.approvals.prompts !== undefined) {
    if (!finite(value.approvals.prompts)) return;
    result.approvals.prompts = value.approvals.prompts;
  }
  for (const head of HEADS) {
    for (const key of ["positiveProbabilitySum", "positiveProbabilitySamples", "appliedPositive", "appliedProbabilitySum", "appliedPositiveProbabilitySum", "appliedLabelSamples"] as const) {
      const n = value.classifier.heads[head][key];
      if (n === undefined) { delete result.classifier.heads[head][key]; continue; }
      if (!finite(n)) return;
      result.classifier.heads[head][key] = n;
    }
    // Earlier probabilitySum included negatives. Retain only the known positive
    // sum; its separate sample counter prevents retrospective mean claims.
    result.classifier.heads[head].probabilitySum = result.classifier.heads[head].positiveProbabilitySum ?? 0;
  }
  if (value.activity !== undefined) {
    const a = value.activity;
    if (!object(a) || !finite(a.errors) || !finite(a.otherBlockReasons) || !object(a.blocksByReason) || Object.keys(a.blocksByReason).length > 96) return;
    for (const key of ["errorsByCategory", "blocksByCategory"] as const) {
      if (!object(a[key])) return;
      for (const category of CATEGORIES) { if (!finite(a[key][category])) return; result.activity![key][category] = a[key][category]; }
    }
    result.activity!.errors = a.errors; result.activity!.otherBlockReasons = a.otherBlockReasons;
    for (const [reason, n] of Object.entries(a.blocksByReason)) {
      if (blockReason(reason) !== reason || !finite(n)) return;
      result.activity!.blocksByReason[reason] = n;
    }
  }
  return result;
}
/** Aggregate keys are fixed policy categories, never arbitrary operational text. */
export function decisionReasonCode(reason?: string): string {
  const fixed = ["read-only", "remote-read-only", "judge-deny", "judge-timeout", "judge-cancelled", "judge-unavailable", "user-block", "user-timeout", "user-cancelled", "user-unavailable", "policy", "unknown",
    "auto:cancelled", "auto:classifier-unavailable", "auto:delegated-secret", "auto:disabled", "auto:gate-failure", "auto:invalid-action-evidence",
    "auto:judge-allow", "auto:judge-unconfigured", "auto:judge-configuration", "auto:judge", "auto:mode-changed", "auto:user-allow", "auto:action-review", "auto:action-risk",
    "base:empty", "base:file-target-missing", "base:delegated-execution-review", "base:egress-review", "base:generated-execution-review",
    "base:host-control-review", "base:read-outside-allowlist", "base:read-unresolved-scope", "base:remote-review", "base:scope-incomplete",
    "base:destructive-in-cwd", "base:destructive-no-scope", "base:destructive-outside-cwd", "base:mutation-in-cwd", "base:mutation-no-scope", "base:mutation-outside-cwd",
    "base:outbound", "base:local-read", "base:trusted-tool", "base:codemode-tools-gated"];
  if (reason && fixed.includes(reason)) return reason;
  if (reason) for (const head of HEADS) if (reason === `base:${head}` || reason === `auto:${head}`) return reason;
  if (reason?.startsWith("auto:action-risk:")) return "auto:action-risk";
  if (reason?.startsWith("read-only:")) return "read-only";
  if (reason?.startsWith("remote-read-only:")) return "remote-read-only";
  return "unknown";
}
// Retained histories and broadcast decisions share the same fixed reason codes.
const blockReason = decisionReasonCode;
export type DecisionObservation = {
  version: 1; packageVersion: string; callId: string; category: Category; modes: Modes;
  verdict: "allow" | "block"; route: VerdictRoute; reason: string;
  classifier?: Evaluation;
  judge?: { outcome?: JudgeOutcome; wallMs?: number; providerRequests?: number; providerDispatches?: number;
    attempts?: number; retries?: number; fallbackUsed?: boolean; requestCountExact?: false;
    configurationError?: "judge-model-unavailable" };
};
export type DecisionDetail = Pick<DecisionObservation, "verdict" | "route" | "reason" | "classifier" | "judge">;
/** Fixed-category projection only. This notification has no admission authority. */
export function decisionObservation(event: CallEvent, modes: Modes, detail: DecisionDetail, info?: ToolSource): DecisionObservation {
  const result: DecisionObservation = { version: 1, packageVersion: ACTIVITY_VERSION, callId: event.toolCallId,
    category: toolCategory(event.toolName, info), modes: { auto: modes.auto, readOnly: modes.readOnly, remoteReadOnly: modes.remoteReadOnly },
    verdict: detail.verdict, route: detail.route, reason: decisionReasonCode(detail.reason) };
  if (detail.classifier) {
    const source = detail.classifier;
    const probs: Partial<Record<Head, number>> = {}, preds: Partial<Record<Head, boolean>> = {};
    for (const head of HEADS) {
      if (finite(source.probs?.[head]) && source.probs![head]! <= 1) probs[head] = source.probs![head];
      if (typeof source.preds?.[head] === "boolean") preds[head] = source.preds[head];
    }
    result.classifier = { inputType: source.inputType, status: source.status, probs, preds,
      appliedHeads: HEADS.filter((head) => source.appliedHeads?.includes(head)) };
    for (const key of ["wallMs", "inferenceMs"] as const) if (finite(source[key])) result.classifier[key] = source[key];
  }
  if (detail.judge) {
    const source = detail.judge;
    result.judge = { requestCountExact: false };
    for (const key of ["wallMs", "providerRequests", "providerDispatches", "attempts", "retries"] as const) {
      if (finite(source[key])) result.judge[key] = source[key];
    }
    if (source.outcome) result.judge.outcome = source.outcome;
    if (typeof source.fallbackUsed === "boolean") result.judge.fallbackUsed = source.fallbackUsed;
    if (source.configurationError === "judge-model-unavailable") result.judge.configurationError = source.configurationError;
  }
  return result;
}
const NATIVE_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "write", "edit"]);
/** Only the installed host's implementation provenance establishes native effects. */
export function nativeToolKind(tool: string, info?: ToolSource): InputType {
  if (!NATIVE_TOOLS.has(tool) || info?.sourceInfo?.source !== "builtin" || info.sourceInfo.path !== `builtin:${tool}`) return "action";
  return tool === "bash" ? "shell" : "file";
}
export function toolCategory(tool: string, info?: ToolSource): Category {
  if (info?.sourceInfo?.source === "mcp" || (info?.sourceInfo?.source === "builtin" && info.sourceInfo.path === "builtin:mcp")) return "mcp";
  if (tool === "codemode" && info?.sourceInfo?.source === "builtin" && info.sourceInfo.path === "builtin:codemode") return "wrapper";
  const kind = nativeToolKind(tool, info);
  if (kind === "shell") return "sh";
  return kind === "file" && (tool === "write" || tool === "edit") ? "files" : "other";
}

/** Observations never authorize tools. Start means submission, not execution.
 * Installed Pi emits execution_start before lookup, validation, and admission.
 * tool_result is emitted only by afterToolCall, after execute ran (even if it threw).
 * execution_end alone can also be a validation error, block, or pre-execution abort.
 */
export class ActivityObservations {
  private sanitizer: LogSanitizer;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private guardWaitTokens = new Set<symbol>();
  private guardWaitStartedAt?: number;
  private guardWaitTurn?: number;
  private readonly maxHistory: number;
  private readonly maxTurns: number;
  private readonly previewChars: number;
  private epoch = 0;
  private readonly judgeRequestsObserved: boolean;
  private readonly summaryRequestsObserved: boolean;
  private configuredModels: { judge?: string; summaries?: string } = {};
  private pending = new Map<string, CallObservation>();
  private judges = new Map<string, LiveJudge>();
  private evaluations = new Set<string>();
  private completed = new Set<string>();
  private state: ObservationSnapshot;
  constructor(options: ObservationOptions = {}) {
    this.sanitizer = new LogSanitizer(options.redaction);
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.maxHistory = bounded(options.maxHistory, LIMITS.history, LIMITS.history, 0);
    this.maxTurns = bounded(options.maxTurns, LIMITS.turns, LIMITS.turns);
    this.previewChars = bounded(options.previewChars, LIMITS.preview, LIMITS.preview);
    this.judgeRequestsObserved = options.judgeRequestsObserved === true;
    this.summaryRequestsObserved = options.summaryRequestsObserved === true;
    if (options.judgeModel) this.configuredModels.judge = this.modelLabel(options.judgeModel);
    if (options.summaryModel) this.configuredModels.summaries = this.modelLabel(options.summaryModel);
    this.state = this.fresh(false);
  }
  private fresh(incomplete: boolean): ObservationSnapshot {
    const telemetry = this.newTelemetry();
    if (incomplete) {
      telemetry.judge.requestsKnown = false; telemetry.summaries.requestsKnown = false;
      telemetry.guardWait!.coverage = "unavailable";
    }
    return { version: OBSERVATION_VERSION, packageVersion: ACTIVITY_VERSION, coverage: incomplete ? "incomplete" : "complete",
      totals: emptyCounts(), telemetry, turns: [], history: [], omitted: 0, liveJudges: [], active: false, unresolved: 0, guardWaitPending: 0 };
  }
  private newTelemetry(enabled = true): Telemetry {
    const result = emptyTelemetry(enabled);
    result.judge.requestsKnown = this.judgeRequestsObserved;
    result.summaries.requestsKnown = this.summaryRequestsObserved;
    for (const key of ["judge", "summaries"] as const) if (this.configuredModels[key]) result[key].models!.configured = this.configuredModels[key];
    return result;
  }
  private modelLabel(id: string): string {
    const safe = this.safeText(id);
    // Registry IDs use provider/model, which ordinary text scrubbing treats as a
    // relative path. Preserve only this narrow identifier grammar, and still
    // scrub each component for tokens. Literal/credential redactions stay intact.
    if (/^\[redacted:path:[a-f0-9]+\]$/.test(safe) && /^[\w.:-]+\/(?:[\w.:-]+\/)?[\w.:+-]+$/.test(id)) {
      return id.split("/").map((part) => this.safeText(part)).join("/").slice(0, 120);
    }
    return safe.slice(0, 120);
  }
  /** Current configuration is distinct from actual provider invocation receipts. */
  setModels(models: { judge?: string; summary?: string }, scope = this.epoch): void {
    if (!this.valid(scope)) return;
    if (models.judge !== undefined) this.configuredModels.judge = this.modelLabel(models.judge);
    if (models.summary !== undefined) this.configuredModels.summaries = this.modelLabel(models.summary);
    for (const t of this.metrics()) for (const key of ["judge", "summaries"] as const) {
      if (this.configuredModels[key] !== undefined) (t[key].models ??= emptyModels()).configured = this.configuredModels[key];
    }
  }
  private requestModel(t: Telemetry, kind: "judge" | "summaries", options: RequestOptions): void {
    const usage = t[kind].models ??= emptyModels();
    if (options.configuredModel !== undefined) usage.configured = this.modelLabel(options.configuredModel);
    if (!options.model) return;
    const id = this.modelLabel(options.model);
    if (!Object.hasOwn(usage.actual, id) && Object.keys(usage.actual).length >= 8) { usage.omitted++; return; }
    Object.defineProperty(usage.actual, id, { value: (Object.hasOwn(usage.actual, id) ? usage.actual[id] : 0) + 1, enumerable: true, writable: true, configurable: true });
  }
  /** Capture before async work; pass scope to later hooks to ignore stale session/branch callbacks. */
  scope(): number { return this.epoch; }
  private valid(scope: number): boolean { return scope === this.epoch; }
  private selected(): TurnObservation {
    if (!this.state.turns.length) {
      const telemetry = this.newTelemetry(this.state.telemetry.classifier.enabled);
      telemetry.guardWait!.coverage = this.state.telemetry.guardWait?.coverage ?? "unavailable";
      this.state.turns.push({ id: 0, startedAt: this.now(), counts: emptyCounts(), telemetry });
    }
    return this.state.turns[this.state.turns.length - 1];
  }
  private metrics(turn = this.selected().id): Telemetry[] {
    const selected = this.state.turns.find((t) => t.id === turn);
    return selected ? [this.state.telemetry, selected.telemetry] : [this.state.telemetry];
  }
  private waitClock(): number | undefined {
    try { const now = this.monotonicNow(); return finite(now) ? now : undefined; }
    catch { return; }
  }
  private partialWait(metrics: Telemetry[] = this.metrics(this.guardWaitTurn)): void {
    for (const t of metrics) (t.guardWait ??= { wallMs: 0, coverage: "unavailable" }).coverage = "partial";
  }
  /** Independent invocation tokens, not tool-call IDs or admission receipts. */
  gateWaitStarted(scope = this.epoch): symbol | undefined {
    if (!this.valid(scope)) return;
    if (this.guardWaitTokens.size >= LIMITS.pending) { this.partialWait(); return; }
    if (!this.guardWaitTokens.size) {
      this.guardWaitTurn = this.selected().id;
      this.guardWaitStartedAt = this.waitClock();
      if (this.guardWaitStartedAt === undefined) this.partialWait();
    }
    for (const t of this.metrics(this.guardWaitTurn)) {
      const wait = t.guardWait ??= { wallMs: 0, coverage: "unavailable" };
      if (wait.coverage === "unavailable") wait.coverage = "partial";
    }
    const token = Symbol();
    this.guardWaitTokens.add(token);
    return token;
  }
  gateWaitFinished(token: symbol | undefined, scope = this.epoch): void {
    if (!this.valid(scope) || token === undefined || !this.guardWaitTokens.delete(token)) return;
    if (!this.guardWaitTokens.size) this.finishWait(false);
  }
  private addWait(metrics: Telemetry[], now: number | undefined, interrupted = false): void {
    const start = this.guardWaitStartedAt;
    const valid = start !== undefined && now !== undefined && now >= start;
    for (const t of metrics) {
      const wait = t.guardWait ??= { wallMs: 0, coverage: "unavailable" };
      const sum = wait.wallMs + (valid ? now - start : 0);
      if (interrupted || !valid || !Number.isFinite(sum)) wait.coverage = "partial";
      wait.wallMs = Number.isFinite(sum) ? sum : Number.MAX_VALUE;
    }
  }
  private finishWait(interrupted: boolean): void {
    if (this.guardWaitTurn !== undefined) this.addWait(this.metrics(this.guardWaitTurn), this.waitClock(), interrupted);
    this.guardWaitTokens.clear(); this.guardWaitStartedAt = undefined; this.guardWaitTurn = undefined;
  }
  private liveWait<T extends ObservationSnapshot>(snapshot: T): T {
    if (this.guardWaitTokens.size) {
      const turn = snapshot.turns.find((t) => t.id === this.guardWaitTurn);
      this.addWait(turn ? [snapshot.telemetry, turn.telemetry] : [snapshot.telemetry], this.waitClock());
    }
    return snapshot;
  }
  private increment(key: keyof Counts, call: CallObservation): void {
    this.state.totals[key]++;
    const turn = this.state.turns.find((t) => t.id === call.turn);
    if (turn) turn.counts[key]++;
  }
  private safeText(text: string): string {
    // Explanation is intentionally passed through the redactor as ordinary text:
    // LogSanitizer otherwise drops fields called explanation/reviewReason/failure.
    try { return String(this.sanitizer.sanitize({ displayText: text }).displayText).replace(/[\u0000-\u001f\u007f-\u009f]/g, " "); }
    catch { return "[preview unavailable]"; }
  }
  preview(text: string, kind: "text" | "path" = "text"): Preview {
    let safe: string;
    try { safe = kind === "path" ? String(this.sanitizer.sanitize({ path: text }).path) : this.safeText(text); }
    catch { safe = "[preview unavailable]"; }
    return { text: safe.slice(0, this.previewChars), omittedChars: Math.max(0, safe.length - this.previewChars) };
  }
  private actionPreview(event: CallEvent, category: Category): Preview | undefined {
    // Do not stringify arbitrary inputs. MCP/custom args and results are never history text.
    if (category !== "sh" && category !== "files") return;
    const input = event.input ?? event.args;
    if (!object(input)) return;
    const keys = category === "sh" ? ["command"] : ["path", "file", "filePath", "filename"];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string") return this.preview(descriptor.value, category === "files" ? "path" : "text");
    }
  }
  private ensure(event: CallEvent, info?: ToolSource, fresh = false): CallObservation {
    const found = fresh ? undefined : this.pending.get(event.toolCallId) ?? this.state.history.findLast((call) => call.id === event.toolCallId && call.turn === this.selected().id);
    if (found) {
      // Start can precede tool discovery in the integrating host. Reconcile provenance
      // before execution is counted, rather than freezing a name-only guess.
      if (info && !found.executionConfirmed && found.status !== "blocked") {
        found.category = toolCategory(event.toolName, info); this.provenance(found, info);
        if (found.category !== "sh" && found.category !== "files") delete found.preview;
      }
      return found;
    }
    const category = toolCategory(event.toolName, info);
    const call: CallObservation = { id: event.toolCallId, turn: this.selected().id, tool: this.safeText(event.toolName).slice(0, 100),
      category, nested: !!event.parentToolCallId, user: false, status: "pending", executionConfirmed: false,
      startedAt: this.now(), counted: false };
    this.provenance(call, info);
    const preview = this.maxHistory ? this.actionPreview(event, category) : undefined;
    if (preview) call.preview = preview;
    this.pending.set(call.id, call);
    this.state.history.push(call);
    if (this.pending.size > LIMITS.pending) {
      const oldest = this.pending.values().next().value!;
      oldest.status = "interrupted";
      this.pending.delete(oldest.id);
      this.uncertain();
    }
    this.trim();
    return call;
  }
  private provenance(call: CallObservation, info?: ToolSource): void {
    if (info?.sourceInfo?.source) call.source = this.safeText(info.sourceInfo.source).slice(0, 80);
    const server = info?.sourceInfo?.serverName ?? info?.sourceInfo?.server ?? info?.serverName ?? info?.server;
    if (server) call.server = this.safeText(server).slice(0, 100);
    if (info?.namespace?.name) call.namespace = this.safeText(info.namespace.name).slice(0, 100);
    // Namespace aliases identify server groups, but are not necessarily raw server
    // IDs. Preserve them separately rather than inventing a decoded server name.
    // source paths can contain credentials or private filenames; deliberately not retained.
  }
  private uncertain(count = 1): void {
    this.state.unresolved += count;
    if (count) this.state.coverage = "incomplete";
  }
  private complete(call: CallObservation): void {
    if (["unknown", "interrupted"].includes(call.status)) this.uncertain();
    this.pending.delete(call.id); this.completed.add(call.id);
    if (this.completed.size > LIMITS.pending) this.completed.delete(this.completed.values().next().value!);
  }
  private trim(): void {
    while (this.state.history.length > this.maxHistory) { this.state.history.shift(); this.state.omitted++; }
    while (this.state.turns.length > this.maxTurns) this.state.turns.shift();
  }
  beginTurn(scope = this.epoch): number {
    if (!this.valid(scope)) return this.epoch;
    this.interrupt(); this.epoch++;
    const id = (this.state.turns.at(-1)?.id ?? 0) + 1;
    this.state.turns.push({ id, startedAt: this.now(), counts: emptyCounts(), telemetry: this.newTelemetry(this.state.telemetry.classifier.enabled) });
    this.state.active = true;
    this.trim();
    return this.epoch;
  }
  endTurn(scope = this.epoch): void {
    if (!this.valid(scope)) return;
    this.interrupt();
    this.selected().endedAt = this.now();
    this.state.active = false;
    this.epoch++;
  }
  private interrupt(): void {
    this.finishWait(true);
    this.uncertain(this.pending.size);
    for (const call of this.pending.values()) if (["pending", "executing"].includes(call.status)) call.status = "interrupted";
    for (const judge of this.judges.values()) for (const t of this.metrics()) {
      t.judge.outcomes.interrupted++;
      t.judge.wallMs += Math.max(0, this.now() - judge.startedAt);
    }
    this.pending.clear(); this.judges.clear(); this.evaluations.clear(); this.completed.clear();
  }
  executionStart(event: CallEvent, info?: ToolSource, scope = this.epoch): void {
    if (!this.valid(scope)) return;
    // A start establishes a fresh invocation, even when a completed ID is reused.
    // Concurrent duplicate IDs violate the host contract and cannot be correlated.
    const previous = this.pending.get(event.toolCallId);
    if (previous) { previous.status = "interrupted"; this.uncertain(); this.pending.delete(previous.id); }
    this.completed.delete(event.toolCallId); this.evaluations.delete(event.toolCallId);
    this.ensure(event, info, true);
  }
  admitted(event: CallEvent, info?: ToolSource, scope = this.epoch): void {
    if (!this.valid(scope) || this.completed.has(event.toolCallId)) return;
    const call = this.ensure(event, info);
    call.verdict = "allow"; // Admission is not execution evidence.
  }
  /** Final gate verdict only. Prefilter review is not a final block. */
  gate(event: CallEvent, verdict: "allow" | "block", detail: GateDetail = {}, scope = this.epoch): void {
    if (!this.valid(scope) || this.completed.has(event.toolCallId)) return;
    const call = this.ensure(event, detail.info);
    if (call.executionConfirmed || call.status === "blocked") return;
    call.verdict = verdict;
    if (verdict === "block") call.route = "final-block";
    else if (detail.route && detail.route !== "final-block") call.route = detail.route;
    else if (detail.prefilter === "allow") call.route = "local-allow";
    if (detail.reason) call.reason = blockReason(detail.reason);
    if (finite(detail.gateMs)) {
      call.gateMs = detail.gateMs;
      for (const t of this.metrics(call.turn)) measure(t.gate ??= emptyLatency(), detail.gateMs);
    }
    if (finite(detail.reviewMs)) call.reviewMs = detail.reviewMs;
    if (detail.signals) call.signals = this.signals(detail.signals);
    if (detail.prefilter) call.prefilter = detail.prefilter;
    if (this.maxHistory && detail.explanation) call.explanation = this.preview(detail.explanation);
    if (verdict === "block") {
      call.status = "blocked";
      this.increment("blocked", call);
      for (const t of this.metrics(call.turn)) {
        const a = t.activity ??= emptyActivity(), reason = blockReason(detail.reason);
        a.blocksByCategory[call.category]++;
        if (Object.hasOwn(a.blocksByReason, reason) || Object.keys(a.blocksByReason).length < 96) a.blocksByReason[reason] = (a.blocksByReason[reason] ?? 0) + 1;
        else a.otherBlockReasons++;
      }
      this.complete(call);
    }
  }
  /** Optional execute-body hook, only for hosts able to provide actual entry evidence. */
  executionConfirmed(event: CallEvent, info?: ToolSource, scope = this.epoch, options: ExecutionOptions = {}): void {
    if (!this.valid(scope) || this.completed.has(event.toolCallId)) return;
    const call = this.ensure(event, info);
    if (call.status === "blocked" || call.status === "rejected") return;
    if (call.executionStartedAt === undefined) call.executionStartedAt = finite(options.executionStartedAt) ? options.executionStartedAt : this.now();
    this.confirm(call);
  }
  private confirm(call: CallObservation): void {
    if (call.executionConfirmed) return;
    call.executionConfirmed = true; call.status = "executing";
    if (call.category === "sh" || call.category === "mcp") { this.increment(call.category, call); call.counted = true; }
  }
  private finished(call: CallObservation, options: ExecutionOptions = {}, reportedError = call.status === "error"): void {
    call.submissionDurationMs = Math.max(0, this.now() - call.startedAt);
    if (finite(options.executionStartedAt)) call.executionStartedAt = options.executionStartedAt;
    if (finite(options.durationMs)) call.durationMs = options.durationMs;
    else if (finite(call.executionStartedAt)) call.durationMs = Math.max(0, this.now() - call.executionStartedAt);
    // Error receipts do not imply execution: validation can also report an error.
    if (reportedError) {
      call.reportedError = true;
      for (const t of this.metrics(call.turn)) { const a = t.activity ??= emptyActivity(); a.errors++; a.errorsByCategory[call.category]++; }
    }
  }
  private signals(source: ClassifierSignals): ClassifierSignals {
    const probs: Partial<Record<Head, number>> = {}, preds: Partial<Record<Head, boolean>> = {};
    for (const head of HEADS) {
      const p = source.probs?.[head], predicted = source.preds?.[head];
      if (finite(p) && p <= 1) probs[head] = p;
      if (typeof predicted === "boolean") preds[head] = predicted;
    }
    return { probs, preds, appliedHeads: HEADS.filter((head) => source.appliedHeads?.includes(head)) };
  }
  /** Pi's tool_result hook proves execute was entered, including thrown errors. */
  toolResult(event: CallEvent & { isError?: boolean; details?: unknown }, info?: ToolSource, scope = this.epoch, options: ExecutionOptions = {}): void {
    if (!this.valid(scope) || this.completed.has(event.toolCallId)) return;
    const existing = this.pending.get(event.toolCallId) ?? this.state.history.findLast((call) => call.id === event.toolCallId && call.turn === this.selected().id);
    if (existing && ["blocked", "rejected", "ok", "error", "interrupted"].includes(existing.status)) return;
    const call = this.ensure(event, info);
    this.confirm(call);
    call.status = event.isError === false ? "ok" : event.isError === true ? "error" : "unknown";
    this.finished(call, options);
    if (call.category === "files" && event.isError === false && !call.counted) { this.increment("files", call); call.counted = true; }
    const exit = object(event.details) ? event.details.exitCode : undefined;
    if (Number.isInteger(exit)) call.exitCode = exit;
    this.complete(call);
  }
  /** No tool_result and no execute-body hook: end alone cannot distinguish rejection/cancellation. */
  executionEnd(event: CallEvent & { isError?: boolean }, scope = this.epoch, options: ExecutionOptions = {}): void {
    if (!this.valid(scope)) return;
    const call = this.pending.get(event.toolCallId);
    if (!call) {
      // Pi reports execute timing after tool_result has already completed the observation.
      if (!this.completed.has(event.toolCallId) || !finite(options.durationMs)) return;
      const completed = this.state.history.findLast((entry) => entry.id === event.toolCallId && entry.turn === this.selected().id);
      if (completed?.executionConfirmed && ["ok", "error"].includes(completed.status)) completed.durationMs = options.durationMs;
      return;
    }
    call.status = call.executionConfirmed ? event.isError === false ? "ok" : event.isError === true ? "error" : "unknown" : "unknown";
    if (call.executionConfirmed && call.category === "files" && event.isError === false && !call.counted) { this.increment("files", call); call.counted = true; }
    this.finished(call, call.executionConfirmed ? options : {}, event.isError === true);
    this.complete(call);
  }
  rejected(event: CallEvent, scope = this.epoch): void {
    if (!this.valid(scope) || this.completed.has(event.toolCallId)) return;
    const call = this.ensure(event);
    if (!call.executionConfirmed && call.status !== "blocked") call.status = "rejected";
    this.complete(call);
  }
  private userShell(id: string, command: string): CallObservation {
    const event = { toolCallId: id, toolName: "bash", input: { command } };
    const call = this.ensure(event);
    // User shell receipts are not registered tools and carry no builtin provenance.
    call.user = true; call.category = "sh";
    if (this.maxHistory && !call.preview) call.preview = this.actionPreview(event, "sh");
    return call;
  }
  userBashSubmitted(id: string, command: string, scope = this.epoch): void {
    if (!this.valid(scope) || this.completed.has(id)) return;
    this.userShell(id, command);
  }
  /** Caller supplies a stable message entry id. Both host role spellings are supported.
   * Result receipts prove completion, not local shell execution: an interceptor may fabricate
   * a result. Set executed only when the host gives execution provenance. */
  userBashResult(id: string, message: { role?: string; command?: string; exitCode?: number; cancelled?: boolean }, executed = false, scope = this.epoch): void {
    if (!this.valid(scope) || this.completed.has(id) || !["userBashResult", "bashExecution"].includes(message.role ?? "")) return;
    const call = this.userShell(id, message.command ?? "");
    if (["ok", "error", "interrupted"].includes(call.status)) return;
    call.user = true;
    if (executed) this.confirm(call);
    call.status = message.cancelled ? "interrupted" : typeof message.exitCode === "number" ? message.exitCode === 0 ? "ok" : "error" : "unknown";
    if (Number.isInteger(message.exitCode)) call.exitCode = message.exitCode;
    this.finished(call);
    this.complete(call);
  }
  setClassifierEnabled(enabled: boolean): void {
    this.state.telemetry.classifier.enabled = enabled;
    this.selected().telemetry.classifier.enabled = enabled;
  }
  evaluation(id: string, event: Evaluation, scope = this.epoch): void {
    if (!this.valid(scope) || this.evaluations.has(id)) return;
    if (this.evaluations.size >= LIMITS.pending) { this.state.coverage = "incomplete"; return; }
    this.evaluations.add(id);
    const callId = event.toolCallId ?? id;
    const call = this.pending.get(callId) ?? this.state.history.findLast((entry) => entry.id === callId && entry.turn === this.selected().id);
    if (call && event.status === "success") call.signals = this.signals(event);
    for (const t of this.metrics(call?.turn)) {
      measure(t.classifier.inference ??= emptyLatency(), event.inferenceMs);
      measure(t.classifier.endToEnd ??= emptyLatency(), event.wallMs);
      const input = t.classifier.byInput[event.inputType];
      input[event.status]++;
      input.wallMs += number(event.wallMs);
      if (event.status !== "success") continue;
      for (const head of HEADS) {
        const p = event.probs?.[head], predicted = event.preds?.[head];
        if (!finite(p) || p > 1 || typeof predicted !== "boolean") continue;
        const stats = t.classifier.heads[head], support = predicted ? p : 1 - p;
        stats.samples++; stats.positive += +predicted; stats.probabilitySum += predicted ? p : 0; stats.supportSum += support;
        if (predicted) {
          stats.positiveProbabilitySum = (stats.positiveProbabilitySum ?? 0) + p;
          stats.positiveProbabilitySamples = (stats.positiveProbabilitySamples ?? 0) + 1;
        }
        if (event.appliedHeads?.includes(head)) {
          stats.applied++; stats.appliedSupportSum += support;
          stats.appliedLabelSamples = (stats.appliedLabelSamples ?? 0) + 1;
          stats.appliedPositive = (stats.appliedPositive ?? 0) + +predicted;
          stats.appliedProbabilitySum = (stats.appliedProbabilitySum ?? 0) + p;
          stats.appliedPositiveProbabilitySum = (stats.appliedPositiveProbabilitySum ?? 0) + (predicted ? p : 0);
        }
      }
    }
  }
  judgeStarted(id: string, expiresAt?: number, scope = this.epoch): void {
    if (!this.valid(scope) || this.judges.has(id)) return;
    if (this.judges.size >= LIMITS.pending) { this.state.coverage = "incomplete"; return; }
    this.judges.set(id, { id, startedAt: this.now(), retries: 0, ...(finite(expiresAt) ? { expiresAt } : {}) });
    for (const t of this.metrics()) t.judge.started++;
  }
  /** Call at the provider invocation, not retry-loop entry or model/auth resolution. */
  judgeRequest(id: string, fallback = false, scope = this.epoch, options: RequestOptions = {}): void {
    if (!this.valid(scope) || !this.judges.has(id)) return;
    for (const t of this.metrics()) { t.judge.requests++; t.judge.fallbacks += +fallback; this.requestModel(t, "judge", options); }
  }
  judgeRetry(id: string, expiresAt?: number, scope = this.epoch): void {
    if (!this.valid(scope)) return;
    const live = this.judges.get(id); if (!live) return;
    live.retries++; if (finite(expiresAt)) live.expiresAt = expiresAt;
    for (const t of this.metrics()) t.judge.retries++;
  }
  judgeFinished(id: string, outcome: JudgeOutcome, wallMs?: number, scope = this.epoch): void {
    if (!this.valid(scope)) return;
    const live = this.judges.get(id); if (!live) return;
    const duration = finite(wallMs) ? wallMs : Math.max(0, this.now() - live.startedAt);
    for (const t of this.metrics()) {
      t.judge.outcomes[outcome]++; t.judge.wallMs += duration;
      if (outcome !== "interrupted") measure(t.judge.latency ??= emptyLatency(), duration);
    }
    this.judges.delete(id);
  }
  summary(status: "generated" | "cached" | "shared" | "restored" | "failed" | "unused", wallMs?: number, scope = this.epoch): void {
    if (this.valid(scope)) for (const t of this.metrics()) {
      t.summaries[status]++; t.summaries.wallMs += number(wallMs);
      if (["generated", "failed"].includes(status)) measure(t.summaries.latency ??= emptyLatency(), wallMs);
    }
  }
  summaryRequest(scope = this.epoch, options: RequestOptions = {}): void {
    if (this.valid(scope)) for (const t of this.metrics()) { t.summaries.requests++; this.requestModel(t, "summaries", options); }
  }
  approvalPrompt(scope = this.epoch): void {
    if (this.valid(scope)) for (const t of this.metrics()) t.approvals.prompts = (t.approvals.prompts ?? 0) + 1;
  }
  approval(choice: ApprovalChoice, effectiveOverride: boolean, scope = this.epoch, options: { wallMs?: number } = {}): void {
    if (this.valid(scope)) for (const t of this.metrics()) {
      t.approvals.choices[choice]++; if (choice === "allow" && effectiveOverride) t.approvals.effectiveOverrides++;
      measure(t.approvals.latency ??= emptyLatency(), options.wallMs);
    }
  }
  view(): ObservationView {
    const selected = this.selected();
    return this.liveWait(structuredClone({ ...this.state, unresolved: this.state.unresolved + this.pending.size,
      guardWaitPending: this.guardWaitTokens.size, liveJudges: [...this.judges.values()], selected }));
  }
  /** Each append is bounded. Session files remain append-only; checkpoint at meaningful
   * boundaries rather than UI ticks. No prompts, input objects, outputs, or summary text. */
  snapshot(): ObservationSnapshot {
    this.selected();
    const result: ObservationSnapshot = this.liveWait(structuredClone({ ...this.state, unresolved: this.state.unresolved + this.pending.size,
      guardWaitPending: this.guardWaitTokens.size, liveJudges: [...this.judges.values()] }));
    while (Buffer.byteLength(JSON.stringify(result)) > LIMITS.bytes && result.history.length) { result.history.shift(); result.omitted++; }
    while (Buffer.byteLength(JSON.stringify(result)) > LIMITS.bytes && result.turns.length > 1) result.turns.shift();
    // At most 512 tiny timing receipts, but make the byte limit independent of call-id length.
    while (Buffer.byteLength(JSON.stringify(result)) > LIMITS.bytes && result.liveJudges.length) { result.liveJudges.pop(); result.coverage = "incomplete"; }
    return result;
  }
  persist(pi: { appendEntry(type: string, data: unknown): void }): boolean {
    try { pi.appendEntry(OBSERVATION_ENTRY_TYPE, this.snapshot()); return true; }
    catch { return false; } // Observability failures must not change admission.
  }
  /** Restore only getBranch(), never getEntries(). Always call on session_start/tree,
   * including fresh sessions. Old branches with prior messages have incomplete coverage. */
  restore(branch: readonly BranchEntry[]): void {
    this.finishWait(true);
    this.epoch++; this.pending.clear(); this.judges.clear(); this.evaluations.clear(); this.completed.clear();
    this.state = this.fresh(branch.some((entry) => entry.type === "message"));
    let skippedInvalid = false;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type !== "custom" || entry.customType !== OBSERVATION_ENTRY_TYPE) continue;
      const restored = this.decode(entry.data);
      if (!restored) {
        skippedInvalid = true; this.state.coverage = "incomplete"; this.partialWait([this.state.telemetry]); continue;
      }
      this.state = restored;
      if (this.state.unresolved > 0) this.state.coverage = "incomplete";
      if (skippedInvalid || branch.slice(index + 1).some((later) => later.type === "message")) {
        this.state.coverage = "incomplete";
        this.partialWait([this.state.telemetry, ...this.state.turns.map((turn) => turn.telemetry)]);
      }
      if (this.state.guardWaitPending) this.partialWait(this.metrics());
      this.state.guardWaitPending = 0;
      for (const t of [this.state.telemetry, ...this.state.turns.map((turn) => turn.telemetry)]) {
        t.judge.requestsKnown &&= this.judgeRequestsObserved && this.state.coverage === "complete";
        t.summaries.requestsKnown &&= this.summaryRequestsObserved && this.state.coverage === "complete";
      }
      for (const call of this.state.history) if (["pending", "executing"].includes(call.status)) call.status = "interrupted";
      for (const _judge of this.state.liveJudges) for (const t of this.metrics()) t.judge.outcomes.interrupted++;
      this.state.liveJudges = []; this.state.active = false;
      break;
    }
    this.trim();
  }
  private decode(value: unknown): ObservationSnapshot | undefined {
    try {
      // Validate complete JSON without getters/proxies before selecting fields. Sanitizer
      // performs this validation and does not retain or print the input.
      this.sanitizer.sanitize({ validation: value });
      if (!object(value) || value.version !== OBSERVATION_VERSION || Buffer.byteLength(JSON.stringify(value)) > LIMITS.bytes) return;
      const total = counts(value.totals), metrics = telemetry(value.telemetry);
      if (!total || !metrics || !Array.isArray(value.turns) || !value.turns.length || value.turns.length > LIMITS.turns ||
          !Array.isArray(value.history) || value.history.length > LIMITS.history || !Array.isArray(value.liveJudges) || value.liveJudges.length > LIMITS.pending ||
          !["complete", "incomplete"].includes(value.coverage) || !Number.isSafeInteger(value.omitted) || value.omitted < 0 ||
          (value.unresolved !== undefined && (!Number.isSafeInteger(value.unresolved) || value.unresolved < 0)) ||
          (value.guardWaitPending !== undefined && (!Number.isSafeInteger(value.guardWaitPending) || value.guardWaitPending < 0 || value.guardWaitPending > LIMITS.pending))) return;
      const turns: TurnObservation[] = [];
      for (const turn of value.turns) {
        const c = counts(turn.counts), t = telemetry(turn.telemetry);
        if (!c || !t || !Number.isSafeInteger(turn.id) || turn.id < 0 || !finite(turn.startedAt) || (turn.endedAt !== undefined && !finite(turn.endedAt)) || (turns.length && turn.id <= turns.at(-1)!.id)) return;
        turns.push({ id: turn.id, startedAt: turn.startedAt, ...(finite(turn.endedAt) ? { endedAt: turn.endedAt } : {}), counts: c, telemetry: t });
      }
      const history: CallObservation[] = [];
      for (const call of value.history) {
        if (!object(call) || typeof call.id !== "string" || call.id.length > 512 || typeof call.tool !== "string" ||
            !["files", "sh", "mcp", "other", "wrapper"].includes(call.category) ||
            !["pending", "executing", "ok", "error", "blocked", "rejected", "interrupted", "unknown"].includes(call.status) ||
            !finite(call.startedAt) || !Number.isSafeInteger(call.turn) || typeof call.executionConfirmed !== "boolean" || typeof call.counted !== "boolean" ||
            typeof call.user !== "boolean" || typeof call.nested !== "boolean") return;
        const projected: CallObservation = { id: call.id, tool: this.safeText(call.tool).slice(0, 100), turn: call.turn,
          category: call.category, status: call.status, executionConfirmed: call.executionConfirmed, counted: call.counted,
          user: call.user, nested: call.nested, startedAt: call.startedAt };
        // Older snapshots measured from submission and called it execution duration.
        // Do not restore that ambiguous measurement as execution time.
        if (finite(call.submissionDurationMs)) projected.submissionDurationMs = call.submissionDurationMs;
        if (finite(call.executionStartedAt)) projected.executionStartedAt = call.executionStartedAt;
        if (finite(call.durationMs) && (finite(call.submissionDurationMs) || finite(call.executionStartedAt))) projected.durationMs = call.durationMs;
        for (const key of ["gateMs", "reviewMs"] as const) if (finite(call[key])) projected[key] = call[key];
        if (ROUTES.includes(call.route)) projected.route = call.route;
        if (typeof call.reason === "string") projected.reason = blockReason(call.reason);
        for (const key of ["source", "server", "namespace"] as const) if (typeof call[key] === "string") projected[key] = this.safeText(call[key]).slice(0, 100);
        if (object(call.signals)) projected.signals = this.signals(call.signals);
        if (typeof call.reportedError === "boolean") projected.reportedError = call.reportedError;
        if (Number.isInteger(call.exitCode)) projected.exitCode = call.exitCode;
        if (["allow", "block"].includes(call.verdict)) projected.verdict = call.verdict;
        if (["allow", "review"].includes(call.prefilter)) projected.prefilter = call.prefilter;
        for (const key of ["preview", "explanation"] as const) {
          if (key === "preview" && !["files", "sh"].includes(call.category)) continue;
          if (object(call[key]) && typeof call[key].text === "string") {
            projected[key] = this.preview(call[key].text);
            projected[key]!.omittedChars += number(call[key].omittedChars);
          }
        }
        history.push(projected);
      }
      const liveJudges: LiveJudge[] = [];
      for (const live of value.liveJudges) {
        if (!object(live) || typeof live.id !== "string" || live.id.length > 512 || !finite(live.startedAt) || !finite(live.retries)) return;
        liveJudges.push({ id: live.id, startedAt: live.startedAt, retries: live.retries, ...(finite(live.expiresAt) ? { expiresAt: live.expiresAt } : {}) });
      }
      for (const t of [metrics, ...turns.map((turn) => turn.telemetry)]) for (const key of ["judge", "summaries"] as const) {
        const usage = t[key].models!;
        if (usage.configured) usage.configured = this.modelLabel(usage.configured);
        const actual: Record<string, number> = {};
        for (const [id, n] of Object.entries(usage.actual)) {
          const safe = this.modelLabel(id);
          Object.defineProperty(actual, safe, { value: (Object.hasOwn(actual, safe) ? actual[safe] : 0) + n, enumerable: true, writable: true, configurable: true });
        }
        usage.actual = actual;
      }
      return { version: 1, packageVersion: ACTIVITY_VERSION, totals: total, telemetry: metrics, turns, history, liveJudges,
        omitted: value.omitted, coverage: value.telemetry.activity === undefined || (value.unresolved === undefined && value.omitted > 0) ? "incomplete" : value.coverage,
        unresolved: Math.max(value.unresolved ?? 0, history.filter((call) => ["pending", "executing", "unknown", "interrupted"].includes(call.status)).length),
        active: value.active === true, guardWaitPending: value.guardWaitPending ?? 0 };
    } catch { return; }
  }
}
