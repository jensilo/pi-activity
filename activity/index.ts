/**
 * activity — monitor what the agent does and gate dangerous activity.
 *
 * Three concerns in one extension, sharing the activity display:
 *
 *   1. Observations: branch-aware turn/session totals, bounded redacted histories,
 *      final gate outcomes, classifier evidence and independent review work.
 *   2. Read-only mode (🔏): `--read-only` flag / `/read-only [on|off|toggle]`.
 *      Reviews guard conflicts; established native mutation cannot be approved
 *      under read-only. Unknown effects fail closed without a conclusive review.
 *   3. Auto-mode (🛡️): `--auto` flag (default on) / `/auto-mode [on|off|toggle]`,
 *      plus `--remote-read-only` / `/remote-read-only`. Native file policy is deterministic. An explicit
 *      managed classifier can fast-path shell actions after download consent.
 *      MCP/custom actions (except explicitly trusted tools), blocked candidates,
 *      and classifier failures require a judge (the current chat model by default)
 *      (fixed 30 seconds, initial attempt plus five transient retries). Ordinary
 *      ask_user verdicts and eligible technical failures offer a TUI Allow/Block prompt
 *      (30 seconds); active guards and non-interactive modes never prompt.
 *      `PI_ACTIVITY_AUTO_MODE=off` disables ordinary auto-mode gating for sandbox use.
 *
 * Private metadata and sanitized action capture are independently opt-in
 * (JSONL, 0600). No raw archive, outputs or user-history capture. Toggles are broadcast on
 * `pi.events` ("activity:state") so the subagent extension can forward
 * `--read-only` to spawned children. See REVIEW-CONTEXT.md for the review contract.
 */

import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, ensureDefaultActivityConfig } from "./config.js";
import { DEFAULT_ACCLASS, ensureAcclass, type AcclassSettings } from "./acclass-setup.js";
import { createBlockPresentation, type BlockPresentation } from "./blocked-message.js";
import { carryStateFromPreviousSession } from "./carry.js";
import { judgeSafety, restoreSafetySummaries, clearSafetySummaries, cancelSafetySummaryWork, INITIAL_REVIEW_MS, MAX_REVIEW_MS, MAX_RETRIES,
  type ReviewMetadata, type ReviewRetry } from "./judge.js";
import { requestApproval, type Approval } from "./approval.js";
import { collectInstructionSnapshot, type ReviewToolMetadata } from "./context.js";
import { obtainDelegatedContext, validateDelegatedContext, type DelegatedContextSnapshot } from "./delegation.js";
import { createManagedEvidenceProvider, type EvidenceProviderFactory, type EvidenceProvider, type EvidenceIdentity, type EvidenceResult } from "./evidence-provider.js";
import { fileClassifierCommand } from "./read-classifier.js";
import { completeJson, serializeActionCall, actionEvidenceTelemetry, type ActionEvidenceTelemetry } from "./action-classifier.js";
import { collectUserMessages, type SummaryMetadata } from "./summary.js";
import { ActivityObservations, decisionObservation, nativeToolKind, type InputType, type DecisionDetail, type ToolSource, type Modes } from "./observations.js";
import { formatFooter, layoutActivityStatus, renderDashboard, renderHistory, type DisplayTheme } from "./display.js";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ActivityPanel, type ActivityPanelOptions } from "./panel.js";
import { ReviewRecorder } from "./interactions.js";
import { selectedLabelSupport, type ClassifierTelemetry } from "./telemetry.js";
import { CommandLogger, ReviewLogger, type LogConfig, type ReviewLogConfig } from "./logger.js";
import type { RedactionConfig } from "./privacy.js";
import {
  HEADS,
  canonicalFilePath,
  looksSecret,
  resolvePath as lexicalFilePath,
  actionDecision,
  positiveRiskSignals,
  decide,
  filePrimitives,
  hardGuardDecision,
  scopeForPath,
  type Decision,
  type Guards,
  type Head,
  type Primitives,
  type RiskSignals,
  type ScopeReport,
} from "./policy.js";

export type ActivityConfig = {
  maxCommandChars: number;
  display: { enabled: boolean };
  history: { maxEntries: number };
  session: { persistModes: boolean; persistActivity: boolean };
  acclass: AcclassSettings;
  policy: { readAllowlist: string[]; trustedTools: string[]; questionnaireSources: string[] };
  auto: { judgeModel?: string | null; fallbackJudgeModel?: string | null; summaryModel?: string | null;
    judgeThinking: ModelThinkingLevel; summaryThinking?: ModelThinkingLevel; fallbackJudgeThinking?: ModelThinkingLevel;
    judgeInstructions: string };
  guards: Guards;
  log: LogConfig;
  reviewLog: ReviewLogConfig;
  redaction: RedactionConfig;
};

export const DEFAULT_CONFIG: ActivityConfig = {
  maxCommandChars: 4000,
  display: { enabled: true },
  history: { maxEntries: 200 },
  session: { persistModes: true, persistActivity: true },
  acclass: { ...DEFAULT_ACCLASS },
  policy: { readAllowlist: [], trustedTools: [], questionnaireSources: [] },
  auto: { judgeThinking: "off", fallbackJudgeModel: null, judgeInstructions: "" },
  guards: { readOnly: false, remoteReadOnly: false },
  log: { enabled: false, path: "~/.local/share/pi-activity/private/commands.jsonl", mode: "redacted", maxBytes: 8_388_608, maxFiles: 7 },
  reviewLog: { enabled: false, path: "~/.local/share/pi-activity/private/reviews.jsonl", maxBytes: 2_097_152, maxFiles: 7 },
  redaction: { literalsFile: null },
};

const STATE_TYPE = "activity-state";

const MODE_MESSAGE_TYPE = "activity-mode";

function guardBanner(guards: Guards): string | undefined {
  if (guards.readOnly) return `${guards.remoteReadOnly ? "Read-only + remote-read-only" : "Read-only"}: local and remote changes are blocked.`;
  if (guards.remoteReadOnly) return "Remote-read-only: remote changes are blocked; local changes may be allowed.";
  return undefined;
}

function guardInstruction(guards: Guards): string {
  const state = `Current guards: read-only ${guards.readOnly ? "ON" : "OFF"}; remote-read-only ${guards.remoteReadOnly ? "ON" : "OFF"}.`;
  const rule = guards.readOnly ? "Do not mutate local or remote state. Non-mutating bash and delegated work are allowed."
    : guards.remoteReadOnly ? "Do not mutate remote state. Local changes and compliant delegated work may be allowed."
    : "Earlier read-only restrictions no longer apply.";
  return `${state} ${rule} Normal safety rules still apply.`;
}

function sameGuards(a: Guards | undefined, b: Guards): boolean {
  return a?.readOnly === b.readOnly && a.remoteReadOnly === b.remoteReadOnly;
}

type GuardState = Pick<Guards, "remoteReadOnly">;

/** Local runtime, created on first gate evaluation and stopped on shutdown. */
const runtime: { classifier?: EvidenceProvider; providerConfig?: string; logger?: CommandLogger; reviews?: ReviewLogger } = {};

function ensureRuntime(cfg: ActivityConfig, factory: EvidenceProviderFactory): void {
  const providerConfig = JSON.stringify(cfg.acclass);
  if (!runtime.classifier || runtime.providerConfig !== providerConfig) {
    runtime.classifier?.stop();
    runtime.classifier = factory(cfg.acclass);
    runtime.providerConfig = providerConfig;
  }
  if (!runtime.logger) runtime.logger = new CommandLogger(cfg.log, cfg.redaction);
  if (!runtime.reviews) runtime.reviews = new ReviewLogger(cfg.reviewLog, cfg.redaction);
}

const state = {
  readOnly: false,
  auto: true,
  guards: { remoteReadOnly: false } as GuardState,
  inheritedGuards: { readOnly: false, remoteReadOnly: false } as Guards,
};

function config(_cwd?: string): ActivityConfig {
  // One personal snapshot only; never read project or local override files.
  const cfg = structuredClone(loadConfig<ActivityConfig>("activity", DEFAULT_CONFIG));
  for (const key of ["classifier", "trustedTools", "questionnaireSources"]) {
    if (Object.hasOwn(cfg, key)) {
      throw new Error(`activity.${key} is no longer supported; remove it`);
    }
  }
  if (cfg.auto && Object.hasOwn(cfg.auto, "judgePromptFiles")) {
    throw new Error("activity.auto.judgePromptFiles is no longer supported; use inline judgeInstructions");
  }
  if (!cfg.auto || typeof cfg.auto !== "object" || Array.isArray(cfg.auto) ||
      [cfg.auto.judgeModel, cfg.auto.summaryModel, cfg.auto.fallbackJudgeModel].some((ref) =>
      ref != null && (typeof ref !== "string" || !ref.trim()))) {
    throw new Error("activity.auto model references must be nonempty strings or null; configure auto.judgeModel as provider/model to enable safety review");
  }
  if (typeof cfg.auto.judgeInstructions !== "string" || Buffer.byteLength(cfg.auto.judgeInstructions, "utf8") > 32 * 1024) {
    throw new Error("activity.auto.judgeInstructions must be a string of at most 32768 UTF-8 bytes");
  }
  for (const key of ["judgeThinking", "summaryThinking", "fallbackJudgeThinking"] as const) {
    const value = cfg.auto[key];
    if (value !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) {
      throw new Error(`activity.auto.${key} must be a supported thinking level`);
    }
  }
  if (!cfg.acclass || typeof cfg.acclass !== "object" || Array.isArray(cfg.acclass) ||
      typeof cfg.acclass.enabled !== "boolean" || !["q8", "q5", "fp32"].includes(cfg.acclass.variant) ||
      Object.keys(cfg.acclass).some((key) => !["enabled", "variant"].includes(key))) {
    throw new Error("activity.acclass accepts only enabled (boolean) and variant (q8, q5 or fp32)");
  }
  if (!cfg.policy || typeof cfg.policy !== "object" || Array.isArray(cfg.policy)) throw new Error("activity.policy must be an object");
  if (!Array.isArray(cfg.policy.readAllowlist) || cfg.policy.readAllowlist.some((path) => typeof path !== "string" || !path.trim())) {
    throw new Error("activity.policy.readAllowlist must be an array of nonempty paths");
  }
  if (!cfg.display || typeof cfg.display.enabled !== "boolean" ||
      !cfg.history || !Number.isInteger(cfg.history.maxEntries) || cfg.history.maxEntries < 0 ||
      !cfg.session || typeof cfg.session.persistModes !== "boolean" || typeof cfg.session.persistActivity !== "boolean" ||
      !Number.isInteger(cfg.maxCommandChars) || cfg.maxCommandChars < 1) {
    throw new Error("activity display/session flags must be booleans and history/maxCommandChars limits must be nonnegative/positive integers");
  }
  if (!cfg.guards || typeof cfg.guards.readOnly !== "boolean" || typeof cfg.guards.remoteReadOnly !== "boolean") {
    throw new Error("activity.guards values must be booleans");
  }
  if (!Array.isArray(cfg.policy.trustedTools) || cfg.policy.trustedTools.some((tool) => typeof tool !== "string" || !tool.trim())) {
    throw new Error("activity.policy.trustedTools must be an array of exact nonempty tool names");
  }
  if (!Array.isArray(cfg.policy.questionnaireSources) || cfg.policy.questionnaireSources.some((path) => typeof path !== "string" || !path.trim())) {
    throw new Error("activity.policy.questionnaireSources must be an array of trusted questionnaire extension paths");
  }
  cfg.policy.questionnaireSources = cfg.policy.questionnaireSources.map(expandHome);
  cfg.policy.readAllowlist = cfg.policy.readAllowlist.map(expandHome);
  cfg.log = { ...cfg.log, path: expandHome(cfg.log.path) };
  cfg.reviewLog = { ...cfg.reviewLog, path: expandHome(cfg.reviewLog.path) };
  cfg.redaction = { ...cfg.redaction, literalsFile: typeof cfg.redaction.literalsFile === "string"
    ? expandHome(cfg.redaction.literalsFile) : cfg.redaction.literalsFile };
  return cfg;
}

export { config as loadActivityConfig };

function judgeModelRef(cfg: ActivityConfig, ctx: ExtensionContext): string | undefined {
  if (cfg.auto.judgeModel !== undefined) return cfg.auto.judgeModel ?? undefined;
  return ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function short(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function stringInput(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function pathFromInput(input: unknown): string | undefined {
  return (
    stringInput(input, "path") ??
    stringInput(input, "file") ??
    stringInput(input, "filePath") ??
    stringInput(input, "filename")
  );
}

function commandFromInput(input: unknown): string | undefined {
  return stringInput(input, "command");
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolvePath(homedir(), p.slice(2));
  return p;
}

/** Advisory observers and UI must never change a safety verdict. */
function observe(work: () => void): void {
  try { work(); } catch { /* best-effort observation */ }
}

function broadcastState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const guards = effectiveGuards(config(ctx.cwd));
  pi.events.emit("activity:state", { readOnly: guards.readOnly, auto: state.auto, guards: { remoteReadOnly: guards.remoteReadOnly } });
}

/** Mark interactive approval as needing user attention in herdr.
 *  Safety review itself keeps the agent working until a prompt opens. */
function emitBlocked(pi: ExtensionAPI, active: boolean, label?: string): void {
  pi.events.emit("herdr:blocked", active ? { active: true, label } : { active: false });
}

function persistState(pi: ExtensionAPI): void {
  if (!config().session.persistModes) return;
  observe(() => pi.appendEntry(STATE_TYPE, {
    readOnly: state.readOnly,
    auto: state.auto,
    guards: { ...state.guards },
  }));
}

function parseToggle(args: string): boolean | "toggle" | null {
  const a = args.trim().toLowerCase();
  if (!a || a === "toggle") return "toggle";
  if (a === "on") return true;
  if (a === "off") return false;
  return null;
}

function applyToggle(value: boolean | "toggle", current: boolean): boolean {
  return value === "toggle" ? !current : value;
}

type Source = "local" | "file" | "action" | "llm";

interface Evaluation {
  decision: Decision;
  source: Source;
  prims?: Primitives;
  riskSignals?: RiskSignals;
  actionEvidence?: ActionEvidenceTelemetry;
  probs?: Record<Head, number>;
  classifierPreds?: Primitives;
  classifierIdentity?: EvidenceIdentity;
  classifierEvidence?: EvidenceResult;
  scope: ScopeReport;
  ms: number;
  failure?: string;
  reviewStatus?: "allow" | "deny" | "timeout" | "cancelled" | "unavailable";
}

type ReviewTrace = {
  startedAt: number;
  callId: string;
  inputChars: number | null;
  modes: { auto: boolean; readOnly: boolean; remoteReadOnly: boolean };
  trigger?: string;
  prefilter?: { source: Source; reason: string; verdict: Decision["verdict"]; wallMs: number; inferenceMs: number };
  classifier?: Omit<ClassifierTelemetry, "identity"> & { identity: EvidenceIdentity };
  actionEvidence?: ActionEvidenceTelemetry;
  classifierAttempted?: boolean;
  summary?: SummaryMetadata;
  judge?: { ref: string; outcome: Evaluation["reviewStatus"]; wallMs: number } & ReviewMetadata;
  prompt?: { outcome: Approval; wallMs: number };
  actionJson?: string;
  toolMetadata?: ReviewToolMetadata;
  omitWrapperCapture?: boolean;
  inputType: InputType;
  observeDecision?: (evaluation: Evaluation, trace: ReviewTrace) => void;
};

type InvocationScope = { scope: number; generation: number; invocation: symbol; signal?: AbortSignal; info?: ToolSource };
type GateReceipt = InvocationScope & { observations: ActivityObservations; modes: Modes; decision?: DecisionDetail };

const EMPTY_SCOPE: ScopeReport = { scope: ["none"], paths: { inside: [], outside: [] } };
/** Scope used when the parser itself failed: fail closed (no path is trusted). */
const SCOPE_FAILED: ScopeReport = { scope: ["other"], paths: { inside: [], outside: [] } };

function effectiveGuards(cfg: ActivityConfig): Guards {
  return {
    readOnly: state.readOnly || cfg.guards.readOnly || state.inheritedGuards.readOnly,
    remoteReadOnly: state.guards.remoteReadOnly || cfg.guards.remoteReadOnly || state.inheritedGuards.remoteReadOnly,
  };
}

function anyGuardOn(g: Guards): boolean {
  return g.readOnly || g.remoteReadOnly;
}

/** Merge persisted guard flags into runtime state (only known booleans). */
function seedGuards(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as Partial<GuardState>;
  if (typeof d.remoteReadOnly === "boolean") state.guards.remoteReadOnly = d.remoteReadOnly;
}

/** Cancel this gate's wait, not the shared classifier daemon or sibling requests.
 * Promise.race observes late rejection; the listener is removed on every outcome. */
async function waitForClassification<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (signal?.aborted) return undefined;
  if (!signal) return work();
  let onAbort: () => void;
  const cancelled = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work(), cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
}

/** Native policy plus optional typed evidence. A block requires the explicit judge. */
async function evaluateAction(
  tool: string,
  input: unknown,
  cwd: string,
  home: string,
  cfg: ActivityConfig,
  inputType: InputType,
  toolMetadata?: ReviewToolMetadata,
  serializedAction?: string,
  signal?: AbortSignal,
): Promise<Evaluation> {
  const guards = effectiveGuards(cfg);
  const policyOpts = { guards, readAllowlist: cfg.policy.readAllowlist, cwd, home };
  const policyDecision = (prims: Primitives, scope: ScopeReport): Decision => state.auto
    ? decide(prims, scope, policyOpts)
    : hardGuardDecision(prims, guards) ?? { verdict: "allow", reason: "auto:disabled", guard: "auto" };

  // Real calls use their own honest runtime representation, never a fictional
  // complete backend contract. Negatives remain unknown; positives inform policy.
  if (inputType === "action") {
    const local = await runtime.classifier!.classify(serializedAction ?? serializeActionCall(tool, input, toolMetadata), cwd, home, "action", signal);
    if (!local.ok) return { decision: actionDecision({}, guards), source: "action", scope: EMPTY_SCOPE, ms: 0,
      classifierEvidence: local, actionEvidence: actionEvidenceTelemetry(local.kind === "invalid" ? "invalid" : "unavailable"), failure: local.message };
    const riskSignals = positiveRiskSignals(local.preds);
    return { decision: actionDecision(riskSignals, guards), source: "action", riskSignals,
      actionEvidence: actionEvidenceTelemetry("complete"), scope: EMPTY_SCOPE,
      probs: local.probs, classifierPreds: local.preds, classifierIdentity: local.identity, classifierEvidence: local, ms: local.ms };
  }

  if (inputType === "file") {
    const path = pathFromInput(input) || (["grep", "find", "ls"].includes(tool) ? cwd : undefined);
    // Path intent and canonical material are independent secret-bearing evidence.
    // Preserve known lexical secrets even when canonical resolution fails.
    const prims = filePrimitives(tool, path ? lexicalFilePath(path, cwd, home) : undefined);
    let target: string | undefined;
    let scope: ScopeReport;
    try {
      target = path ? canonicalFilePath(path, cwd, home) : undefined;
      if (target && !prims.local_state_change) prims.exposes_secrets ||= looksSecret(target);
      // Only the canonical target can establish scope authorization.
      scope = target ? scopeForPath(target, cwd, home) : EMPTY_SCOPE;
    } catch {
      return { decision: { verdict: "block", reason: "base:file-target-missing", guard: "auto" },
        source: "file", prims, scope: SCOPE_FAILED, ms: 0, failure: "file target could not be resolved; provide a verifiable path" };
    }
    if (!target) return { decision: { verdict: "block", reason: "base:file-target-missing", guard: "auto" },
      source: "file", prims, scope, ms: 0, failure: "file target is missing; provide a verifiable path" };
    if (state.auto && (tool === "read" || tool === "grep") && runtime.classifier!.kind !== "none") {
      const local = await runtime.classifier!.classify(fileClassifierCommand(tool, input, target), cwd, home, "shell", signal);
      if (!local.ok) return { decision: { verdict: "block", reason: "auto:classifier-unavailable", guard: "auto" },
        source: "file", prims, scope, ms: 0, classifierEvidence: local, failure: local.message };
      // Native effects/path evidence stay separate from fallible predictions.
      // Only predicted secret exposure requests ordinary auto review for a read.
      const riskSignals: RiskSignals = local.preds.exposes_secrets ? { exposes_secrets: true } : {};
      return { decision: policyDecision({ ...prims, exposes_secrets: prims.exposes_secrets || !!riskSignals.exposes_secrets }, scope),
        source: "file", prims, riskSignals, scope,
        probs: local.probs, classifierPreds: local.preds, classifierIdentity: local.identity, classifierEvidence: local, ms: local.ms };
    }
    return { decision: policyDecision(prims, scope), source: "file", prims, scope, ms: 0 };
  }

  const cmd = commandFromInput(input) ?? "";
  if (!cmd.trim()) {
    return { decision: { verdict: "allow", reason: "base:empty", guard: "auto" }, source: "local", scope: EMPTY_SCOPE, ms: 0 };
  }

  const local = await runtime.classifier!.classify(cmd, cwd, home, "shell", signal);
  if (!local.ok) {
    return { decision: { verdict: "block", reason: "auto:classifier-unavailable", guard: "auto" },
      source: "local", scope: SCOPE_FAILED, ms: 0, classifierEvidence: local, failure: local.message };
  }
  const scope = local.scope;
  const decision = policyDecision(local.preds, scope);
  // Cwd identifies a scope, not expendable data. Destructive shell effects need
  // contextual review so essential project data is not mistaken for build output.
  if (state.auto && decision.verdict === "allow" && local.preds.destructive) {
    decision.verdict = "block";
    decision.reason = "base:destructive-review";
  }
  return { decision, source: "local", prims: local.preds, probs: local.probs,
    classifierPreds: local.preds, classifierIdentity: local.identity, classifierEvidence: local, scope, ms: local.ms };
}

function humanReason(decision: Decision): string {
  if (decision.reason.startsWith("auto:action-risk:")) {
    return `unverified MCP/custom tool requires safety review; predicted risk signals: ${decision.reason.slice("auto:action-risk:".length)}`;
  }
  switch (decision.reason) {
    case "base:remote-review":
      return "remote mutation requires safety review";
    case "base:egress-review":
      return "data egress requires safety review";
    case "base:host-control-review":
      return "initiating-machine control requires safety review";
    case "base:delegated-execution-review":
      return "distinct-worker execution requires safety review";
    case "base:generated-execution-review":
      return "fetched or generated instruction execution requires safety review";
    case "auto:classifier-unavailable":
      return "classifier unavailable";
    case "auto:action-review":
      return "MCP/custom tool requires safety review";
    case "base:exposes_secrets":
      return "possible secret exposure requires contextual review";
    case "base:destructive-review":
      return "destructive shell effects require contextual safety review";
    case "base:destructive-no-scope":
      return "a destructive command with no identifiable scope";
    case "base:destructive-outside-cwd":
      return "a destructive command outside the working directory";
    case "base:mutation-no-scope":
      return "a local mutation with no identifiable scope";
    case "base:mutation-outside-cwd":
      return "a local mutation outside the working directory";
    case "base:read-outside-allowlist":
      return "a read outside the read allowlist";
    case "base:read-unresolved-scope":
      return "a read whose target could not be resolved";
    case "read-only":
      return "the command is not read-only";
    case "remote-read-only":
      return "remote mutation blocked by the remote-read-only guard";
    case "auto:judge":
      return "the safety judge declined the action";
    default:
      return decision.reason;
  }
}

// Pi permits later admission handlers to mutate this same execution object.
// After reviewed or human approval, ordinary in-place mutation must fail rather
// than change the exact action that was approved. This is not isolation from hostile same-process code.
function freezeApprovedInput(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) freezeApprovedInput(descriptor.value, seen);
  }
  Object.freeze(value);
}

function appendReason(reason: string, detail: string): string {
  return `${reason.trimEnd().replace(/[.!?;]+$/, "")}; ${detail}`;
}

function blockReason(evaluation: Evaluation): string {
  const reason = (evaluation.failure ?? humanReason(evaluation.decision)).trimEnd().replace(/[.!?]+$/, "");
  return `🛡️ Blocked (${evaluation.source}): ${reason}.`;
}

function logDecision(
  cfg: ActivityConfig, ctx: ExtensionContext, tool: string, input: unknown,
  evaluation: Evaluation, decision: string, trace: ReviewTrace,
): void {
  observe(() => recordDecision(cfg, ctx, tool, input, evaluation, decision, trace));
}

function recordDecision(
  cfg: ActivityConfig,
  ctx: ExtensionContext,
  tool: string,
  input: unknown,
  evaluation: Evaluation,
  decision: string,
  trace: ReviewTrace,
): void {
  observe(() => trace.observeDecision?.(evaluation, trace));
  let session: string | undefined;
  try {
    session = ctx.sessionManager.getSessionId();
  } catch {
    session = undefined;
  }
  const metadata = {
    ts: Date.now(),
    session,
    callId: trace.callId,
    tool,
    inputChars: trace.inputChars,
    modes: trace.modes,
    trigger: trace.trigger ?? null,
    prefilter: trace.prefilter ?? null,
    classifier: trace.classifier ?? null,
    actionEvidence: trace.actionEvidence ?? null,
    summary: trace.judge?.summary ?? trace.summary ?? null,
    judge: trace.judge ? { ...trace.judge, summary: undefined } : null,
    prompt: trace.prompt ?? null,
    final: { verdict: evaluation.decision.verdict, decision, reason: evaluation.decision.reason },
    wallMs: Math.round(performance.now() - trace.startedAt),
  };
  if (cfg.reviewLog.enabled === true) runtime.reviews?.logTelemetry(metadata);
  if (cfg.log.enabled !== true) return;
  const full = cfg.log.mode === "full";
  const cmd = trace.inputType === "shell" ? (commandFromInput(input) ?? "")
    : trace.inputType === "file" ? `${tool} ${pathFromInput(input) ?? ""}`.trim() : tool;
  let action: unknown = null;
  let captureStatus = "metadata-only";
  if (full && trace.omitWrapperCapture) captureStatus = "omitted-builtin-wrapper";
  else if (full) {
    try {
      action = trace.inputType === "shell" ? { representation: "bash-command/1", command: commandFromInput(input) ?? "" }
        : trace.inputType === "file" ? { representation: "file-path/1", tool_name: tool, path: pathFromInput(input) ?? null }
        : JSON.parse(trace.actionJson ?? serializeActionCall(tool, input, trace.toolMetadata));
      captureStatus = "sanitized";
    } catch {
      // Unsupported values are never serialized lossily or logged as error prose.
      captureStatus = "invalid-json";
    }
  }
  runtime.logger?.logTelemetry({
    ...metadata,
    cmd: full ? cmd : "[redacted]",
    cwd: full ? ctx.cwd : "[redacted]",
    action,
    captureStatus,
    source: evaluation.source,
    ms: evaluation.ms,
    probs: evaluation.probs ?? null,
    preds: evaluation.classifierPreds ?? evaluation.prims ?? null,
    policyPrimitives: evaluation.prims ?? null,
    policyRiskSignals: evaluation.riskSignals ?? null,
    actionEvidence: trace.actionEvidence ?? null,
    classifier: trace.classifier ?? null,
    prefilter: trace.prefilter ?? null,
    modes: trace.modes,
    judgeOutcome: trace.judge?.outcome ?? null,
    userOverride: trace.prompt?.outcome ?? null,
    scope: evaluation.scope.scope,
    paths: full ? evaluation.scope.paths : { inside: [], outside: [] },
    verdict: evaluation.decision.verdict,
    guard: evaluation.decision.reason,
    decision,
    feedback: null,
    reviewStatus: evaluation.reviewStatus ?? null,
  });
}

// Native presentation remains available to isolated policy fixtures and comparison previews.
export default function activityExtension(pi: ExtensionAPI, reviewSafety: typeof judgeSafety = judgeSafety, blockPresentation: BlockPresentation = "activity",
  evidenceFactory: EvidenceProviderFactory = createManagedEvidenceProvider): void {
  const presentBlock = createBlockPresentation(pi, blockPresentation);
  state.inheritedGuards = { readOnly: false, remoteReadOnly: false };
  let delegatedContext: DelegatedContextSnapshot | null = null;
  let delegatedError: string | undefined;
  // Capture the optional launch hint once; never reclassify a live session from mutable env.
  const launchOrigin = process.env.PI_SUBAGENT_TASK === "1" ? "agent" : "human";
  let sessionOrigin: "agent" | "human" = launchOrigin;
  let contextLifecycle = new AbortController();
  const reviewRecorder = new ReviewRecorder(pi);
  let observations = new ActivityObservations();
  let operationalPreviews = true;
  const observedEvent = (event: any) => operationalPreviews ? event : {
    toolCallId: event.toolCallId, toolName: event.toolName, parentToolCallId: event.parentToolCallId,
    isError: event.isError, details: typeof event.details?.exitCode === "number" ? { exitCode: event.details.exitCode } : undefined,
  };
  let lifecycle = new AbortController();
  let generation = 0;
  let stopped = false;
  let nextUserBash = 0;
  let bashReceiptAnchor: string | undefined;
  const callScopes = new Map<string, InvocationScope>();
  const pendingUserBash: string[] = [];
  const deadlines = new Map<AbortController, ReturnType<typeof setTimeout>>();
  const pendingReviews = new Map<symbol, { startedAt: number; expiresAt: number; trigger: string; retry?: ReviewRetry }>();
  const pendingApprovals = new Set<symbol>();
  let reviewStatusCtx: ExtensionContext | undefined;
  let reviewStatusTimer: ReturnType<typeof setInterval> | undefined;
  let renderPanel: (() => void) | undefined;
  let announcedGuards: Guards | undefined;
  let hasGuardHistory = false;
  let initializing = true;
  let startupFlagsApplied = false;
  let configCreationWarningShown = false;
  let setupAttempted = false;

  function updateGuardBanner(ctx: ExtensionContext): void {
    observe(() => {
      if (ctx.mode !== "tui" || !ctx.hasUI || !ctx.ui.setWidget) return;
      const cfg = config(ctx.cwd);
      const text = cfg.display.enabled ? guardBanner(effectiveGuards(cfg)) : undefined;
      ctx.ui.setWidget("activity-guard", text ? (_tui, theme) => ({
        invalidate() {},
        render: (width) => width > 0 ? wrapTextWithAnsi(theme.fg("warning", text), width) : [],
      }) : undefined, { placement: "aboveEditor" });
    });
  }

  function restoreGuardInstructions(ctx: ExtensionContext): void {
    const branch = ctx.sessionManager.getBranch();
    hasGuardHistory = branch.some((entry) => entry.type === "custom_message" && entry.customType === MODE_MESSAGE_TYPE);
    announcedGuards = undefined;
    // Compaction/context edits can remove old instructions. Only retained context
    // establishes what the model still knows; never rewrite its cached prefix.
    const messages = ctx.sessionManager.buildSessionProjection?.().messages ??
      (ctx.sessionManager.buildContextEntries?.() ?? branch).flatMap((entry) =>
        entry.type === "custom_message" ? [{ role: "custom" as const, customType: entry.customType,
          content: entry.content, details: entry.details }] : []);
    for (const message of messages) {
      if (message.role !== "custom" || message.customType !== MODE_MESSAGE_TYPE) continue;
      const guards = (message.details as { guards?: Guards } | undefined)?.guards;
      if (typeof guards?.readOnly === "boolean" && typeof guards.remoteReadOnly === "boolean" &&
          message.content === guardInstruction(guards)) {
        announcedGuards = { readOnly: guards.readOnly, remoteReadOnly: guards.remoteReadOnly };
      } else if (typeof message.content === "string") {
        // Old releases only announced read-only, not the remote guard.
        if (message.content.startsWith("Read-only mode is on.")) announcedGuards = { readOnly: true, remoteReadOnly: false };
        if (message.content.startsWith("Read-only mode is off.")) announcedGuards = { readOnly: false, remoteReadOnly: false };
      }
    }
  }

  function syncGuardInstruction(ctx: ExtensionContext, steer = false): void {
    const guards = effectiveGuards(config(ctx.cwd));
    if (sameGuards(announcedGuards, guards) || (!anyGuardOn(guards) && !hasGuardHistory)) return;
    // Pending toggles coalesce until submission. Sent instructions are append-only
    // user-level messages, never system-prompt edits or historical replacements.
    pi.sendMessage({ customType: MODE_MESSAGE_TYPE, content: guardInstruction(guards),
      display: false, details: { guards: { ...guards } } }, steer ? { deliverAs: "steer" } : { triggerTurn: false });
    announcedGuards = { ...guards };
    hasGuardHistory = true;
  }

  function changeGuard(name: keyof Guards, value: boolean | "toggle", ctx: ExtensionContext, notify = true): void {
    if (name === "readOnly") state.readOnly = applyToggle(value, state.readOnly);
    else state.guards.remoteReadOnly = applyToggle(value, state.guards.remoteReadOnly);
    persistState(pi);
    observe(() => broadcastState(pi, ctx));
    updateGuardBanner(ctx);
    updateWidget(ctx);
    const effective = effectiveGuards(config(ctx.cwd))[name];
    if (notify) observe(() => ctx.ui.notify(`${name === "readOnly" ? "🔏 Read-only" : "🌐 Remote-read-only"} mode ${effective ? "on" : "off"}`, "info"));
  }

  const modes = (cfg: ActivityConfig): Modes => ({ auto: state.auto, ...effectiveGuards(cfg) });
  function observationView() {
    const view = observations.view();
    if (!operationalPreviews) for (const call of view.history) { delete call.preview; delete call.explanation; }
    return view;
  }

  function updateWidget(ctx: ExtensionContext, expectedGeneration = generation): void {
    if (stopped || expectedGeneration !== generation) return;
    observe(() => {
      renderPanel?.();
      if (!ctx.hasUI) return;
      if (pendingReviews.size) { renderReviewStatus(); return; }
      setActivityLine(ctx);
    });
  }

  function setActivityLine(ctx: ExtensionContext, judge = "", reason = ""): void {
    const cfg = config(ctx.cwd);
    const activity = formatFooter(observationView(), modes(cfg));
    const color = anyGuardOn(effectiveGuards(cfg)) || state.auto ? "warning" : "dim";
    if (ctx.mode === "tui" && typeof ctx.ui.setWidget === "function") {
      // Built-in status text collapses padding and mixes other extension statuses.
      // A dedicated passive row preserves alignment without owning Pi's footer.
      ctx.ui.setStatus("activity", undefined);
      ctx.ui.setStatus("activity-judge", undefined);
      ctx.ui.setWidget("activity-status", cfg.display.enabled ? (_tui, theme) => ({
        invalidate() {},
        render: (width) => [theme.fg(color, layoutActivityStatus(activity, judge, width, reason))],
      }) : undefined, { placement: "belowEditor" });
    } else {
      ctx.ui.setStatus("activity", !judge && cfg.display.enabled ? ctx.ui.theme.fg(color, activity) : undefined);
      if (judge) ctx.ui.setStatus("activity-judge", cfg.display.enabled ? ctx.ui.theme.fg(color,
        layoutActivityStatus(activity, judge, process.stdout.columns ?? 100, reason)) : undefined);
    }
  }

  function checkpoint(ctx: ExtensionContext): void {
    observe(() => {
      if (!config(ctx.cwd).session.persistActivity) return;
      observations.persist({ appendEntry(type, data) {
        // Sanitized history remains private session data, independent of audit logging.
        const snapshot = data as ReturnType<ActivityObservations["snapshot"]>;
        if (!operationalPreviews) for (const call of snapshot.history) { delete call.preview; delete call.explanation; }
        pi.appendEntry(type, snapshot);
      } });
    });
  }

  function cancelPending(resetSummaries = true): void {
    generation++;
    callScopes.clear();
    lifecycle.abort();
    lifecycle = new AbortController();
    for (const [controller, timer] of deadlines) { clearTimeout(timer); controller.abort(); }
    deadlines.clear();
    pendingReviews.clear();
    renderReviewStatus();
    for (const approval of pendingApprovals) {
      pendingApprovals.delete(approval);
      observe(() => emitBlocked(pi, false));
    }
    pendingUserBash.length = 0;
    reviewRecorder.clear();
    if (resetSummaries) clearSafetySummaries();
    else cancelSafetySummaryWork();
  }

  function scanBashReceipts(ctx: ExtensionContext): void {
    observe(() => {
      const branch = ctx.sessionManager.getBranch();
      const anchor = bashReceiptAnchor ? branch.findIndex((entry) => entry.id === bashReceiptAnchor) : -1;
      for (const entry of branch.slice(anchor + 1)) {
        if (entry.type !== "message" || !["bashExecution", "userBashResult"].includes(entry.message.role)) continue;
        const id = pendingUserBash.shift() ?? `user-receipt:${entry.id}`;
        // Interceptors can synthesize receipts. No host execution provenance is exposed.
        observations.userBashResult(id, operationalPreviews ? entry.message as any : {
          role: entry.message.role, exitCode: (entry.message as any).exitCode, cancelled: (entry.message as any).cancelled,
        }, false);
      }
      bashReceiptAnchor = branch.at(-1)?.id;
    });
  }

  function restoreSession(ctx: ExtensionContext): void {
    stopped = false;
    cancelPending();
    const cfg = config(ctx.cwd);
    const branch = ctx.sessionManager.getBranch();
    state.readOnly = false;
    state.auto = pi.getFlag("auto") === true;
    state.guards = { remoteReadOnly: false };
    if (cfg.session.persistModes) for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
      const data = entry.data as { readOnly?: boolean; auto?: boolean; guards?: Partial<GuardState> } | undefined;
      if (typeof data?.readOnly === "boolean") state.readOnly = data.readOnly;
      if (typeof data?.auto === "boolean") state.auto = data.auto;
      seedGuards(data?.guards);
    }
    if (process.env.PI_ACTIVITY_AUTO_MODE?.trim().toLowerCase() === "off") state.auto = false;
    observe(() => observations.restore(cfg.session.persistActivity ? branch : []));
    observe(() => observations.setClassifierEnabled(cfg.acclass.enabled));
    observe(() => observations.setModels({ judge: judgeModelRef(cfg, ctx),
      summary: cfg.auto.summaryModel ?? judgeModelRef(cfg, ctx) }));
    observe(() => {
      const restored: unknown = cfg.session.persistActivity ? restoreSafetySummaries(ctx, sessionOrigin) : 0;
      if (typeof restored === "number" && Number.isSafeInteger(restored) && restored >= 0) {
        for (let i = 0; i < restored; i++) observations.summary("restored");
      }
    });
    // Only new receipts are observed. Reload does not infer missing historic executions.
    bashReceiptAnchor = branch.at(-1)?.id;
    restoreGuardInstructions(ctx);
    observe(() => broadcastState(pi, ctx));
    updateGuardBanner(ctx);
    updateWidget(ctx);
  }

  function renderReviewStatus(): void {
    observe(() => renderPanel?.());
    if (!pendingReviews.size) {
      if (reviewStatusTimer) clearInterval(reviewStatusTimer);
      reviewStatusTimer = undefined;
      try {
        reviewStatusCtx?.ui.setStatus("activity-judge", undefined);
        if (reviewStatusCtx) updateWidget(reviewStatusCtx);
      } catch {
        // UI teardown must not prevent a safety decision or daemon cleanup.
      }
      reviewStatusCtx = undefined;
      return;
    }
    if (!reviewStatusCtx) return;
    const current = [...pendingReviews.values()].reduce((a, b) => a.expiresAt <= b.expiresAt ? a : b);
    const left = Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000));
    const count = pendingReviews.size > 1 ? ` ×${pendingReviews.size}` : "";
    try {
      const elapsed = Math.max(0, Math.floor((Date.now() - current.startedAt) / 1000));
      const progress = current.retry ? ` · retry ${current.retry.retry}/${MAX_RETRIES} (${current.retry.cause})` : "";
      const judge = `⚖️ judge ${elapsed}s elapsed · ${left}s left${count}${progress}`;
      // Timing is separate from the expendable reason so it survives clipping.
      setActivityLine(reviewStatusCtx, judge, short(current.trigger, 48));
    } catch {
      // UI rendering is advisory; the tool gate remains authoritative.
    }
  }

  function showReviewStatus(ctx: ExtensionContext, trigger: string, expiresAt: number): {
    retry: (event: ReviewRetry) => void; clear: () => void;
  } {
    if (ctx.mode !== "tui" || !ctx.hasUI || !config(ctx.cwd).display.enabled) return { retry: () => {}, clear: () => {} };
    const id = Symbol("judge-review");
    const review = { startedAt: Date.now(), expiresAt, trigger, retry: undefined as ReviewRetry | undefined };
    pendingReviews.set(id, review);
    reviewStatusCtx = ctx;
    renderReviewStatus();
    if (!reviewStatusTimer) reviewStatusTimer = setInterval(renderReviewStatus, 1000);
    return {
      retry: (event) => {
        if (!pendingReviews.has(id)) return;
        review.retry = event;
        renderReviewStatus();
      },
      clear: () => {
        pendingReviews.delete(id);
        renderReviewStatus();
      },
    };
  }

  pi.registerFlag("read-only", {
    description: "Start in read-only mode (block writes and mutating bash)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("remote-read-only", {
    description: "Start in remote-read-only mode (block remote changes; local changes may be allowed)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("auto", {
    description: "Start with automatic activity gating on (default on)",
    type: "boolean",
    default: true,
  });

  pi.on("session_start", async (event, ctx) => {
    // Startup errors must leave admission closed, even if Pi keeps dispatching tools.
    initializing = true;
    try { ensureDefaultActivityConfig(); }
    catch {
      // An absent file uses defaults. Invalid files still fail closed below.
      if (!configCreationWarningShown) {
        configCreationWarningShown = true;
        observe(() => ctx.ui.notify("Activity could not create its default configuration. Missing configuration uses built-in defaults; guards still apply.", "warning"));
      }
    }
    contextLifecycle.abort();
    const acquisition = contextLifecycle = new AbortController();
    delegatedContext = null;
    const inherited = await obtainDelegatedContext(pi, ctx, acquisition.signal);
    if (acquisition.signal.aborted || contextLifecycle !== acquisition) return;
    delegatedContext = inherited.context;
    sessionOrigin = delegatedContext ? "agent" : launchOrigin;
    delegatedError = inherited.error;
    state.inheritedGuards = delegatedContext?.context.restrictions ?? { readOnly: false, remoteReadOnly: false };
    const cfg = config(ctx.cwd);
    operationalPreviews = true;
    try {
      observations = new ActivityObservations({ redaction: cfg.redaction, maxHistory: cfg.history.maxEntries,
        previewChars: cfg.maxCommandChars });
    } catch {
      // Bad optional redaction storage disables operational text, not the safety gate.
      operationalPreviews = false;
      observations = new ActivityObservations({ maxHistory: cfg.history.maxEntries });
    }
    const previousModes = event.reason === "new" ? {
      readOnly: state.readOnly, auto: state.auto, guards: { ...state.guards },
    } : undefined;
    restoreSession(ctx);
    // Carry mode state across a session boundary (/new, handoff): the
    // previous session's last activity-state becomes this session's starting
    // state. A new conversation has no announced guard instructions.
    const carried = (cfg.session.persistModes ? carryStateFromPreviousSession(event, ctx.sessionManager.getBranch(), STATE_TYPE, previousModes) : undefined) as
      { readOnly?: unknown; auto?: unknown; guards?: unknown } | undefined;
    if (carried) {
      if (typeof carried.readOnly === "boolean") state.readOnly = carried.readOnly;
      if (typeof carried.auto === "boolean") state.auto = carried.auto;
      seedGuards(carried.guards);
      persistState(pi);
    }
    // Explicit startup flags act like the corresponding /command on after
    // restoration. Do not reapply them on /new, /reload or tree navigation.
    if (!startupFlagsApplied) {
      if (event.reason === "startup" || event.reason === undefined) {
        if (pi.getFlag("read-only") === true) changeGuard("readOnly", true, ctx, false);
        if (pi.getFlag("remote-read-only") === true) changeGuard("remoteReadOnly", true, ctx, false);
      }
      startupFlagsApplied = true;
    }
    // PI_ACTIVITY_AUTO_MODE=off disables auto-mode, not active read-only guards.
    if (process.env.PI_ACTIVITY_AUTO_MODE?.trim().toLowerCase() === "off") state.auto = false;
    // Inherited restrictions, restored modes and startup flags are now authoritative.
    initializing = false;
    observe(() => broadcastState(pi, ctx));
    updateGuardBanner(ctx);
    updateWidget(ctx);
    // One offer per extension runtime. A later /reload can retry a declined setup.
    // RPC dialogs are supported; print/JSON sessions never prompt or download.
    if (!setupAttempted && cfg.acclass.enabled && evidenceFactory === createManagedEvidenceProvider) {
      setupAttempted = true;
      const setupSignal = lifecycle.signal;
      const setup = await ensureAcclass(cfg.acclass, ctx.hasUI ? (request) =>
        ctx.ui.confirm("Install optional local Activity classifier?", request.message, { signal: setupSignal }) : undefined,
      setupSignal);
      if (!setupSignal.aborted && setup.status === "unavailable") {
        observe(() => ctx.ui.notify("acclass setup or verification failed. Activity will use the LLM judge. Check the release endpoint and installation integrity, then /reload to retry.", "warning"));
      }
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    restoreGuardInstructions(ctx);
    // During between-turn compaction the agent is still streaming. Steering is
    // polled before its next request; context-only sends would arrive too late.
    syncGuardInstruction(ctx, true);
  });

  pi.on("turn_end", async (_event, ctx) => {
    // Streaming input and explicit continuations skip before_agent_start. Append
    // any change from the already-submitted turn at this safe boundary, before
    // queued work or a later extension's continuation can resume.
    syncGuardInstruction(ctx);
  });

  pi.on("cache_warming_decision", async (_event, ctx) => {
    const guards = effectiveGuards(config(ctx.cwd));
    if (!sameGuards(announcedGuards, guards) && (anyGuardOn(guards) || hasGuardHistory)) return { action: "stop" };
  });

  pi.on("session_tree", async (_event, ctx) => { restoreSession(ctx); });

  // Release session-scoped resources. Idempotent: quit, reload, and session
  // replacement can all converge here.
  pi.on("session_shutdown", async (_event, ctx) => {
    stopped = true;
    contextLifecycle.abort();
    delegatedContext = null;
    cancelPending();
    observe(() => observations.endTurn());
    if (ctx) {
      checkpoint(ctx);
      observe(() => ctx.ui.setStatus("activity", undefined));
      observe(() => ctx.ui.setWidget?.("activity-status", undefined));
      observe(() => ctx.ui.setWidget?.("activity-guard", undefined));
    }
    runtime.classifier?.stop();
    runtime.classifier = undefined;
    runtime.providerConfig = undefined;
    await Promise.all([runtime.reviews?.flush(), runtime.logger?.flush()]);
    // A review finishing during shutdown still has a logger to append to.
    // Keep loggers across session boundaries; only the daemon is session-scoped.
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // The optional supplier attests task binding. Pi may transform input;
    // transformed child messages remain assignments, never new human consent.
    scanBashReceipts(ctx);
    cancelPending(false);
    observe(() => observations.beginTurn());
    syncGuardInstruction(ctx);
    updateGuardBanner(ctx);
    updateWidget(ctx);
  });

  const gateToolCall = async (event: any, ctx: ExtensionContext, cfg: ActivityConfig, receipt: GateReceipt, serializedAction?: string, toolMetadata?: ReviewToolMetadata, omitWrapperCapture?: boolean) => {
    const tool = event.toolName ?? "";
    const cwd = ctx.cwd;
    const home = homedir();
    ensureRuntime(cfg, evidenceFactory);
    const guards = effectiveGuards(cfg);
    const inputType = nativeToolKind(tool, receipt.info);
    const boundInput = event.input;
    const boundCall = completeJson({ tool, input: event.input, cwd, id: event.toolCallId, parent: event.parentToolCallId ?? null });
    const contextIdentity = () => JSON.stringify({ session: ctx.sessionManager.getSessionId(),
      origin: sessionOrigin, inherited: delegatedContext?.context ?? null,
      users: collectUserMessages(ctx, sessionOrigin), instructions: collectInstructionSnapshot(ctx) });
    // Inline instruction identity is part of each admission, including guards.
    const judgeInstructions = cfg.auto.judgeInstructions;
    const judgeModel = judgeModelRef(cfg, ctx);
    const judgePromptIdentity = () => config().auto.judgeInstructions;
    const boundContext = contextIdentity();
    const staleCall = () => {
      try {
        validateDelegatedContext(ctx, delegatedContext, cwd);
        return ctx.cwd !== cwd || event.input !== boundInput || boundCall !== completeJson({ tool: event.toolName, input: event.input,
          cwd: ctx.cwd, id: event.toolCallId, parent: event.parentToolCallId ?? null }) || contextIdentity() !== boundContext ||
          judgePromptIdentity() !== judgeInstructions || judgeModelRef(config(), ctx) !== judgeModel;
      } catch { return true; }
    };
    let originalJudgeReason: string | undefined;
    let explicitUserBlock = false;
    const refusal = (reason: string) => {
      const original = originalJudgeReason?.replace(/[.!?;]+$/, "");
      let preserved = original && !reason.includes(original)
        ? appendReason(originalJudgeReason!, reason) : reason;
      if (explicitUserBlock && !preserved.includes("action declined by user; do not retry unchanged")) preserved = appendReason(preserved, "action declined by user; do not retry unchanged");
      return `Blocked — tool was not run. ${preserved}\nContinue with a safe alternative that resolves this reason, or other unblocked work; prefer progress when the user is away. Do not bypass guards or retry unchanged. Ask only when no safe path remains.`;
    };
    const staleResult = () => ({ block: true as const, reason: refusal("Tool arguments or policy context changed during review; this call cannot execute.") });
    const trace: ReviewTrace = {
      inputType,
      startedAt: performance.now(),
      callId: event.toolCallId,
      inputChars: JSON.stringify(event.input)?.length ?? 0,
      modes: { auto: state.auto, readOnly: guards.readOnly, remoteReadOnly: guards.remoteReadOnly },
      actionJson: serializedAction,
      toolMetadata,
      omitWrapperCapture,
      observeDecision: (evaluation, finalTrace) => {
        receipt.decision = {
          verdict: evaluation.decision.verdict, reason: evaluation.decision.reason,
          route: evaluation.decision.verdict === "block" ? "final-block" : evaluation.decision.reason === "auto:user-allow" ? "user-override"
            : evaluation.decision.reason === "auto:judge-allow" ? "judge-allow" : "local-allow",
          classifier: {
            inputType,
            status: finalTrace.classifier ? "success" : evaluation.classifierEvidence?.provider === "none" ? "disabled"
              : (evaluation.classifierEvidence && !evaluation.classifierEvidence.ok) || finalTrace.classifierAttempted ? "failure" : "skipped",
            probs: finalTrace.classifier?.probs, preds: finalTrace.classifier?.preds,
            appliedHeads: finalTrace.classifier?.appliedHeads,
            wallMs: evaluation.classifierEvidence?.wallMs ?? (finalTrace.classifierAttempted ? finalTrace.prefilter?.wallMs : undefined),
            inferenceMs: finalTrace.classifier ? finalTrace.prefilter?.inferenceMs : undefined,
          },
          judge: finalTrace.judge,
        };
        if (!currentInvocation(event, receipt)) return;
        const obs = receipt.observations;
        obs.gate(observedEvent(event), evaluation.decision.verdict, { info: receipt.info,
          explanation: operationalPreviews ? evaluation.failure ?? humanReason(evaluation.decision) : undefined, reason: evaluation.decision.reason,
          route: evaluation.decision.verdict === "block" ? "final-block" : evaluation.decision.reason === "auto:user-allow" ? "user-override"
            : evaluation.decision.reason === "auto:judge-allow" ? "judge-allow" : "local-allow",
          gateMs: Math.round(performance.now() - finalTrace.startedAt), reviewMs: finalTrace.judge?.wallMs,
          signals: finalTrace.classifier,
          prefilter: finalTrace.prefilter?.verdict === "block" ? "review" : "allow" }, receipt.scope);
        obs.evaluation(event.toolCallId, {
          inputType,
          status: finalTrace.classifier ? "success" : evaluation.classifierEvidence?.provider === "none" ? "disabled"
            : (evaluation.classifierEvidence && !evaluation.classifierEvidence.ok) || finalTrace.classifierAttempted ? "failure" : "skipped",
          probs: finalTrace.classifier?.probs, preds: finalTrace.classifier?.preds,
          appliedHeads: finalTrace.classifier?.appliedHeads, wallMs: evaluation.classifierEvidence?.wallMs ?? (finalTrace.classifierAttempted ? finalTrace.prefilter?.wallMs : undefined),
          inferenceMs: finalTrace.classifier ? finalTrace.prefilter?.inferenceMs : undefined, toolCallId: event.toolCallId,
        }, receipt.scope);
        if (finalTrace.prompt) obs.approval(finalTrace.prompt.outcome,
          evaluation.decision.verdict === "allow" && evaluation.decision.reason === "auto:user-allow", receipt.scope,
          { wallMs: finalTrace.prompt.wallMs });
      },
    };

    // Shell classification is local. The judge and optional TUI prompt each get their
    // own fixed deadline. Judge retries share a total 30-second budget;
    // RPC/print/subagent modes never wait for approval.
    if (state.auto || anyGuardOn(guards)) {
      const actionTool = inputType === "action";
      const info = receipt.info;
      // Only Pi's built-in outer wrapper is exempt. Its evaluated nested calls
      // each reach this gate; a replacement tool named codemode is not trusted.
      const codemodeWrapper = tool === "codemode" && !event.parentToolCallId &&
        info?.sourceInfo?.source === "builtin" && info.sourceInfo.path === "builtin:codemode";
      const trusted = actionTool && !anyGuardOn(guards) && cfg.policy.trustedTools.includes(tool);
      let evaluation: Evaluation = {
        decision: { verdict: "block", reason: "auto:classifier-unavailable", guard: "auto" },
        source: "local", scope: EMPTY_SCOPE, ms: 0,
      };
      trace.classifierAttempted = !codemodeWrapper && !trusted &&
        (inputType === "shell" || actionTool || (state.auto && ["read", "grep"].includes(tool) && runtime.classifier!.kind !== "none"));
      try {
        evaluation = codemodeWrapper || trusted
          ? { decision: { verdict: "allow", reason: codemodeWrapper ? "base:codemode-tools-gated" : "base:trusted-tool", guard: "auto" },
            source: "action", scope: EMPTY_SCOPE, ms: 0 }
          : await waitForClassification(() => evaluateAction(tool, event.input, cwd, home, cfg, inputType, toolMetadata, serializedAction, ctx.signal),
            ctx.signal) ?? evaluation;
      } catch (err) {
        if (actionTool && !codemodeWrapper && !trusted) {
          evaluation.source = "action";
          evaluation.decision = actionDecision({}, guards);
          evaluation.actionEvidence = actionEvidenceTelemetry("unavailable");
        }
        evaluation.failure = `classification failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      trace.actionEvidence = evaluation.actionEvidence;
      trace.prefilter = { source: evaluation.source, reason: evaluation.decision.reason,
        verdict: evaluation.decision.verdict, inferenceMs: evaluation.ms,
        wallMs: Math.round(performance.now() - trace.startedAt) };
      if (ctx.signal?.aborted) {
        evaluation = { ...evaluation, decision: { verdict: "block", reason: "auto:cancelled", guard: "auto" },
          source: actionTool ? "action" : evaluation.source, failure: "turn cancelled during classification; action declined" };
        trace.trigger = "auto:cancelled";
        logDecision(cfg, ctx, tool, event.input, evaluation, "cancelled", trace);
        // No safety reviewer, approval prompt, or UI update for cancelled work.
        return { block: true, reason: blockReason(evaluation) };
      }
      if (staleCall()) return staleResult();
      trace.actionEvidence = evaluation.actionEvidence;
      if (evaluation.probs && evaluation.classifierPreds) {
        trace.classifier = { probs: evaluation.probs, preds: evaluation.classifierPreds,
          actionEvidence: evaluation.actionEvidence,
          appliedHeads: actionTool ? HEADS.filter((head) => evaluation.riskSignals?.[head] === true)
            : inputType === "shell" ? HEADS : ["exposes_secrets"],
          support: selectedLabelSupport(evaluation.probs, evaluation.classifierPreds) ?? null,
          identity: evaluation.classifierIdentity! };
      }
      trace.prefilter = { source: evaluation.source, reason: evaluation.decision.reason,
        verdict: evaluation.decision.verdict, inferenceMs: evaluation.ms,
        wallMs: Math.round(performance.now() - trace.startedAt) };
      // Proven native effects constrain review consistency, not whether review runs.
      // Secret-looking paths are heuristics, NOT immutable effect attestations.
      const nativePrims = inputType === "file" ? evaluation.prims : undefined;
      const nativeEffects = nativePrims ? Object.freeze({
        local_state_change: nativePrims.local_state_change, remote_state_change: false,
        outbound: false, egress: false, delegated_execution: false,
        host_control_change: false, fetched_or_generated_execution: false,
      }) : undefined;
      const guardBlock = nativeEffects && hardGuardDecision(nativeEffects, guards);
      if (guardBlock) evaluation.decision = guardBlock;
      const objections = [evaluation.decision.reason];
      if (state.auto && nativePrims?.exposes_secrets) objections.push("Credential-path heuristic; establish task scope and actual upstream permission, not assignment claims.");
      let technicalStop = false;
      let policyBlock = false;
      const needsReview = evaluation.decision.verdict === "block";
      const missingJudge = needsReview && !judgeModel;
      if (missingJudge) {
        evaluation = { ...evaluation, source: "llm", reviewStatus: "unavailable",
          decision: { verdict: "block", reason: "auto:judge-unconfigured", guard: "auto" },
          failure: "Safety review unavailable (technical failure): judge disabled or no current chat model available. Set auto.judgeModel to provider/model, or omit it to use the current chat model." };
        trace.trigger = "auto:judge-unconfigured";
      }
      if (needsReview && judgeModel) {
          trace.trigger = evaluation.decision.reason;
          const trigger = humanReason(evaluation.decision);
          const reviewStartedAt = Date.now();
          const reviewExpiresAt = reviewStartedAt + INITIAL_REVIEW_MS;
          const deadlineController = new AbortController();
          const deadlineTimer = setTimeout(() => deadlineController.abort(), MAX_REVIEW_MS);
          deadlines.set(deadlineController, deadlineTimer);
          const deadline = deadlineController.signal;
          const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
          const status = showReviewStatus(ctx, trigger, reviewExpiresAt);
          observe(() => receipt.observations.judgeStarted(trace.callId, reviewExpiresAt, receipt.scope));
          const onRetry = (event: ReviewRetry) => {
            if (receipt.generation !== generation || signal.aborted) return;
            observe(() => receipt.observations.judgeRetry(trace.callId, reviewExpiresAt, receipt.scope));
            status.retry(event);
          };
          const judgeStartedAt = performance.now();
          let judgeMetrics: ReviewMetadata | undefined;
          try {
            const judgeRef = judgeModel;
            const summaryRef = cfg.auto.summaryModel ?? judgeRef;
            const fallbackRef = cfg.auto.fallbackJudgeModel ?? undefined;
            const outcome = reviewSafety(ctx, judgeRef, tool, event.input, cwd, trace.modes, signal, onRetry,
              reviewExpiresAt, undefined, fallbackRef, toolMetadata, summaryRef,
              (summary) => {
                if (receipt.generation === generation) trace.summary = { ...summary };
              }, {
                evidence: { nativeEffects, predictions: evaluation.classifierPreds ? positiveRiskSignals(evaluation.classifierPreds) : evaluation.riskSignals, objections },
                delegatedContext, origin: sessionOrigin,
                instructionSnapshot: collectInstructionSnapshot(ctx),
                judgeInstructions,
                judgeThinking: cfg.auto.judgeThinking,
                summaryThinking: cfg.auto.summaryThinking,
                fallbackJudgeThinking: cfg.auto.fallbackJudgeThinking,
                persistSummary: (type, data) => {
                  if (receipt.generation === generation && !signal.aborted && cfg.session.persistActivity) {
                    observe(() => pi.appendEntry(type, data));
                  }
                },
                onModelCall: (event) => {
                  if (receipt.generation !== generation || signal.aborted || event.kind !== "provider-request") return;
                  observe(() => {
                    const model = event.provider && event.model ? `${event.provider}/${event.model}` : undefined;
                    if (event.operation === "summary") receipt.observations.summaryRequest(receipt.scope, { model, configuredModel: summaryRef });
                    else {
                      receipt.observations.judgeRequest(trace.callId, event.fallbackUsed === true,
                        receipt.scope, { model, configuredModel: judgeRef });
                    }
                  });
                },
              });
            const verdict = await waitForClassification(() => outcome, signal);
            evaluation.source = "llm";
            judgeMetrics = verdict?.metrics;
            technicalStop = !!verdict?.technicalStop || !!judgeMetrics?.configurationError;
            if (verdict?.ok && typeof verdict.reason === "string") originalJudgeReason = verdict.reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 300);
            policyBlock = verdict?.ok === true && !verdict.allow && verdict.decision !== "ask_user";
            const inconsistent = verdict?.ok && verdict.allow && !!guardBlock;
            if (inconsistent) technicalStop = true;
            const reviewExpired = deadline.aborted || Date.now() >= reviewExpiresAt;
            evaluation.reviewStatus = ctx.signal?.aborted ? "cancelled" : reviewExpired ? "timeout"
              : inconsistent || technicalStop ? "unavailable" : verdict?.ok ? verdict.allow ? "allow" : "deny" : "unavailable";
            evaluation.failure = ctx.signal?.aborted ? "safety review cancelled"
              : reviewExpired ? `safety judge timed out after ${(reviewExpiresAt - reviewStartedAt) / 1000} seconds`
              : inconsistent ? "Invalid/inconsistent safety review: allow contradicts established native mutation under the active read-only restriction"
              : verdict?.ok ? verdict.reason : `Safety review unavailable (technical failure): ${verdict?.reason ?? "no result"}`;
            evaluation.decision = !technicalStop && !signal.aborted && !reviewExpired && verdict?.ok && verdict.allow
              ? { verdict: "allow", reason: "auto:judge-allow", guard: "auto" }
              : { verdict: "block", reason: judgeMetrics?.configurationError ? "auto:judge-configuration" : "auto:judge", guard: "auto" };
          } catch (err) {
            evaluation = { ...evaluation, source: "llm", reviewStatus: "unavailable",
              decision: { verdict: "block", reason: "auto:judge", guard: "auto" },
              failure: `Safety review unavailable (technical failure): ${err instanceof Error ? err.message : String(err)}` };
          } finally {
            trace.judge = { ref: judgeModel, outcome: evaluation.reviewStatus ?? "unavailable",
              wallMs: Math.round(performance.now() - judgeStartedAt), ...judgeMetrics };
            clearTimeout(deadlineTimer);
            deadlines.delete(deadlineController);
            if (receipt.generation === generation) {
              observe(() => receipt.observations.judgeFinished(trace.callId, evaluation.reviewStatus ?? "unavailable", trace.judge!.wallMs, receipt.scope));
              // Summary callbacks are cumulative progress, not separate logical summaries.
              const summary = judgeMetrics?.summary ?? trace.summary;
              if (summary) observe(() => receipt.observations.summary(summary.status, summary.wallMs, receipt.scope));
            }
            status.clear();
          }
      }
      if (staleCall()) return staleResult();
      let decision = evaluation.decision.verdict === "allow"
        ? evaluation.source === "llm" ? "judge-allow" : "allow"
        : evaluation.source === "llm" ? "judge-block" : "policy-block";
      // A newly enabled mode must never be bypassed by a stale model verdict.
      const modeChanged = () => {
        const now = effectiveGuards(config(cwd));
        return Object.entries(now).some(([key, on]) => on && !guards[key as keyof Guards]);
      };
      if (modeChanged()) {
        evaluation = { ...evaluation, decision: { verdict: "block", reason: "auto:mode-changed", guard: "auto" },
          failure: "safety mode changed during review; retry the action" };
        decision = "mode-block";
      }
      if (evaluation.decision.verdict === "block" && !policyBlock && !technicalStop && !anyGuardOn(guards) &&
          !modeChanged() && !ctx.signal?.aborted && ctx.mode === "tui" && ctx.hasUI) {
        // Evidence is complete and ephemeral. Review input limits are technical
        // failures, not a prohibition on informed human approval.
        const rawArguments = JSON.stringify(event.input) ?? "(no arguments)";
        const label = `${tool} · cwd: ${cwd}`;
        const approvalId = Symbol("approval");
        pendingApprovals.add(approvalId);
        observe(() => receipt.observations.approvalPrompt(receipt.scope));
        observe(() => emitBlocked(pi, true, evaluation.failure ?? humanReason(evaluation.decision)));
        try {
          const promptStartedAt = performance.now();
          const approval = await requestApproval(ctx, label, evaluation.failure ?? humanReason(evaluation.decision), 30_000, rawArguments);
          trace.prompt = { outcome: approval, wallMs: Math.round(performance.now() - promptStartedAt) };
          explicitUserBlock = approval === "block";
          const argumentsChanged = (JSON.stringify(event.input) ?? "(no arguments)") !== rawArguments;
          const effectiveOverride = approval === "allow" && !argumentsChanged && !staleCall() && !modeChanged() && !ctx.signal?.aborted && receipt.generation === generation;
          if (effectiveOverride) {
            freezeApprovedInput(event.input);
            evaluation.decision = { verdict: "allow", reason: "auto:user-allow", guard: "auto" };
            decision = "user-allow";
          } else {
            decision = approval === "timeout" ? "prompt-timeout" : approval === "block" ? "user-block"
              : approval === "cancelled" ? "prompt-cancelled" : approval === "unavailable" ? "prompt-unavailable" : "approval-invalidated";
            // Timeout is unavailable approval, not a human rejection. Keep the
            // same refusal as immediate judge block; only telemetry records timeout.
            const detail = approval === "timeout" ? undefined
              : approval === "block" ? "action declined by user; do not retry unchanged"
              : approval === "cancelled" ? "approval cancelled; action declined"
              : approval === "unavailable" ? "no interactive approval available; action declined"
              : argumentsChanged ? "tool arguments changed during approval; this call cannot execute"
              : "safety mode changed or turn was cancelled; action declined";
            if (detail) evaluation.failure = appendReason(evaluation.failure ?? "safety review declined", detail);
          }
        } finally {
          if (pendingApprovals.delete(approvalId)) observe(() => emitBlocked(pi, false));
        }
      }
      if (staleCall()) return staleResult();
      if (evaluation.decision.verdict === "block" || modeChanged() || ctx.signal?.aborted) {
        if (modeChanged()) {
          evaluation.failure = "safety mode changed; action declined";
          evaluation.decision = { verdict: "block", reason: "auto:mode-changed", guard: "auto" };
          decision = "mode-block";
        } else if (ctx.signal?.aborted) {
          evaluation.failure = "turn cancelled; action declined";
          evaluation.decision = { verdict: "block", reason: "auto:cancelled", guard: "auto" };
          decision = "cancelled";
        }
        evaluation.decision = { ...evaluation.decision, verdict: "block" };
        if (!policyBlock && !technicalStop && !modeChanged() && !ctx.signal?.aborted &&
            (ctx.mode !== "tui" || !ctx.hasUI) && !anyGuardOn(guards)) {
          evaluation.failure = appendReason(evaluation.failure ?? humanReason(evaluation.decision), "no interactive approval available; action declined");
        }
        const reason = refusal(blockReason(evaluation));
        logDecision(cfg, ctx, tool, event.input, evaluation, decision === "allow" ? "judge-block" : decision, trace);
        updateWidget(ctx, receipt.generation);
        return { block: true, reason };
      }
      if (evaluation.decision.reason === "auto:judge-allow" || evaluation.decision.reason === "auto:user-allow") {
        freezeApprovedInput(event.input);
        Object.defineProperty(event, "input", { value: event.input, writable: false, configurable: false, enumerable: true });
      }
      logDecision(cfg, ctx, tool, event.input, evaluation, decision, trace);
    } else {
      logDecision(cfg, ctx, tool, event.input, { decision: { verdict: "allow", reason: "auto:disabled", guard: "auto" },
        source: inputType === "shell" ? "local" : inputType === "file" ? "file" : "action", scope: EMPTY_SCOPE, ms: 0 }, "allow", trace);
    }

    updateWidget(ctx, receipt.generation);
  };

  const toolInfo = (name: string) => pi.getAllTools().find((tool) => tool.name === name);
  function callScope(event: any, ctx: ExtensionContext, fresh = false): InvocationScope {
    let receipt = fresh ? undefined : callScopes.get(event.toolCallId);
    if (!receipt) {
      receipt = { scope: observations.scope(), generation, invocation: Symbol("tool-invocation"),
        signal: ctx.signal, info: toolInfo(event.toolName) };
      callScopes.set(event.toolCallId, receipt);
      if (callScopes.size > 1024) callScopes.delete(callScopes.keys().next().value!);
    }
    return receipt;
  }
  function currentInvocation(event: any, receipt: InvocationScope, ctx?: ExtensionContext): boolean {
    return receipt.generation === generation && receipt.scope === observations.scope() &&
      callScopes.get(event.toolCallId)?.invocation === receipt.invocation &&
      (!ctx?.signal || !receipt.signal || receipt.signal === ctx.signal);
  }
  // Terminal hooks never mint scopes. Old operation signals and detached async
  // gate receipts are rejected after reuse. If the host emits concurrent duplicate
  // IDs (or old receipts without any operation identity after reuse), IDs alone
  // cannot distinguish them; that is a host-contract violation.

  // Pi emits start before lookup, validation and admission. It is not execute evidence.
  pi.on("tool_execution_start", async (event, ctx) => {
    observe(() => {
      if (ctx.signal?.aborted) return;
      const receipt = callScope(event, ctx, true);
      observations.executionStart(observedEvent(event), receipt.info, receipt.scope);
    });
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    const receipt = callScopes.get(event.toolCallId);
    if (!receipt || !currentInvocation(event, receipt, ctx)) return;
    observe(() => observations.executionEnd(observedEvent(event), receipt.scope, { durationMs: event.durationMs }));
    callScopes.delete(event.toolCallId);
    checkpoint(ctx);
    updateWidget(ctx);
  });

  pi.on("tool_call", async (event: any, ctx) => {
    // Capture scope and cancellation before the first await. Replacement/tree invalidates both.
    const receipt: GateReceipt = { ...callScope(event, ctx), observations,
      modes: { auto: state.auto, readOnly: state.readOnly, remoteReadOnly: state.guards.remoteReadOnly } };
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, lifecycle.signal]) : lifecycle.signal;
    const gateCtx = Object.defineProperty({ ...ctx, signal }, "cwd", { get: () => ctx.cwd }) as ExtensionContext;
    let waitToken: symbol | undefined;
    observe(() => { waitToken = receipt.observations.gateWaitStarted(receipt.scope); });
    checkpoint(ctx);
    try {
      if (initializing) return presentBlock(event, "Activity initialization is incomplete; retry after session startup.", !signal.aborted && currentInvocation(event, receipt));
      const cfg = config(ctx.cwd);
      if (delegatedError) return presentBlock(event, delegatedError, !signal.aborted && currentInvocation(event, receipt));
      try { validateDelegatedContext(ctx, delegatedContext); }
      catch { return presentBlock(event, "Missing, invalid, or stale delegated policy context; restart the delegated task.", !signal.aborted && currentInvocation(event, receipt)); }
      receipt.modes = modes(cfg);
      const info = toolInfo(event.toolName);
      receipt.info = info;
      if (currentInvocation(event, receipt)) callScopes.get(event.toolCallId)!.info = info;
      const actionTool = nativeToolKind(event.toolName, info) === "action";
      const codemodeWrapper = event.toolName === "codemode" && !event.parentToolCallId &&
        info?.sourceInfo?.source === "builtin" && info.sourceInfo.path === "builtin:codemode";
      const toolMetadata: ReviewToolMetadata | undefined = info ? { description: info.description, parameters: info.parameters,
        namespace: info.namespace, annotations: info.annotations, exposure: info.exposure } : undefined;
      let serializedAction: string | undefined;
      if (actionTool && (state.auto || anyGuardOn(effectiveGuards(cfg))) &&
          !codemodeWrapper && (anyGuardOn(effectiveGuards(cfg)) || !cfg.policy.trustedTools.includes(event.toolName))) {
        try { serializedAction = serializeActionCall(event.toolName, event.input, toolMetadata); }
        catch (err) {
          receipt.decision = { verdict: "block", reason: "auto:invalid-action-evidence", route: "final-block",
            classifier: { inputType: "action", status: "skipped" } };
          const failure = `🛡️ Invalid MCP/custom action evidence; call declined without lossy serialization: ${err instanceof Error ? err.message : String(err)}`;
          observe(() => receipt.observations.gate(observedEvent(event), "block", { info, reason: "auto:invalid-action-evidence", explanation: "auto:invalid-action-evidence", route: "final-block" }, receipt.scope));
          ensureRuntime(cfg, evidenceFactory);
          const trace: ReviewTrace = { inputType: "action", startedAt: performance.now(), callId: event.toolCallId, inputChars: null,
            modes: modes(cfg), trigger: "auto:invalid-action-evidence", actionEvidence: actionEvidenceTelemetry("invalid") };
          logDecision(cfg, ctx, event.toolName, undefined, { decision: { verdict: "block", reason: "auto:invalid-action-evidence", guard: "auto" },
            source: "action", scope: EMPTY_SCOPE, ms: 0, failure }, "invalid-action-block", trace);
          updateWidget(ctx);
          return presentBlock(event, failure, !signal.aborted && currentInvocation(event, receipt));
        }
      }
      observe(() => reviewRecorder.begin(event, ctx, info, cfg.policy.questionnaireSources));
      let result = await gateToolCall(event, gateCtx, cfg, receipt, serializedAction, toolMetadata, codemodeWrapper);
      if ((signal.aborted || !currentInvocation(event, receipt)) && !result?.block) {
        result = { block: true, reason: "Blocked — tool was not run. Session or turn changed; action declined." };
        receipt.decision = { ...receipt.decision, verdict: "block", reason: "auto:cancelled", route: "final-block" };
      }
      if (currentInvocation(event, receipt)) {
        observe(() => receipt.observations.gate(observedEvent(event), result?.block ? "block" : "allow", { info,
          explanation: operationalPreviews ? result?.reason : undefined }, receipt.scope));
        observe(() => reviewRecorder.decision(event, ctx, result?.block === true));
        updateWidget(ctx);
      }
      return result?.block ? presentBlock(event, result.reason, !signal.aborted && currentInvocation(event, receipt)) : result;
    } catch (error) {
      receipt.decision = { verdict: "block", reason: "auto:gate-failure", route: "final-block" };
      if (currentInvocation(event, receipt)) {
        observe(() => receipt.observations.gate(observedEvent(event), "block", { info: receipt.info, reason: "auto:gate-failure", explanation: "auto:gate-failure", route: "final-block" }, receipt.scope));
        observe(() => reviewRecorder.decision(event, ctx, true));
        updateWidget(ctx);
      }
      // Preserve Pi's fail-closed handler-error semantics, including invalid configuration.
      throw error;
    } finally {
      observe(() => receipt.observations.gateWaitFinished(waitToken, receipt.scope));
      if (currentInvocation(event, receipt)) {
        checkpoint(ctx);
        observe(() => renderPanel?.());
      }
      // Exactly one final observational notification per gate, including fail-closed errors.
      // Detached fixed-category metadata cannot change the already chosen verdict.
      observe(() => pi.events.emit("activity:decision", decisionObservation(event, receipt.modes, receipt.decision ?? {
        verdict: "block", reason: "auto:gate-failure", route: "final-block",
      }, receipt.info)));
    }
  });

  pi.on("tool_result", async (event: any, ctx) => {
    const receipt = callScopes.get(event.toolCallId);
    if (!receipt || !currentInvocation(event, receipt, ctx)) return;
    observe(() => reviewRecorder.result(event, ctx));
    observe(() => observations.toolResult(observedEvent(event), receipt.info, receipt.scope));
    checkpoint(ctx);
    updateWidget(ctx);
  });

  pi.on("user_bash", async (event: any, ctx) => {
    observe(() => {
      scanBashReceipts(ctx);
      if (typeof event.command !== "string" || !event.command.trim()) return;
      const id = `user-submission:${++nextUserBash}`;
      pendingUserBash.push(id);
      if (pendingUserBash.length > 256) pendingUserBash.shift();
      observations.userBashSubmitted(id, operationalPreviews ? event.command : "[preview unavailable]");
      checkpoint(ctx);
      updateWidget(ctx);
    });
    return undefined;
  });

  pi.on("message_end", async (_event, ctx) => { scanBashReceipts(ctx); });
  pi.on("agent_settled", async (_event, ctx) => {
    reviewRecorder.clear();
    scanBashReceipts(ctx);
    observe(() => observations.endTurn());
    callScopes.clear();
    checkpoint(ctx);
    updateWidget(ctx);
  });

  pi.registerCommand("read-only", {
    description: "Toggle read-only mode. Usage: /read-only [on|off|toggle]",
    handler: async (args, ctx) => {
      const value = parseToggle(args);
      if (value === null) {
        ctx.ui.notify(`Usage: /read-only [on|off|toggle] (currently ${effectiveGuards(config(ctx.cwd)).readOnly ? "on" : "off"})`, "info");
        return;
      }
      changeGuard("readOnly", value, ctx);
    },
  });

  pi.registerCommand("auto-mode", {
    description: "Toggle automatic activity gating. Usage: /auto-mode [on|off|toggle]",
    handler: async (args, ctx) => {
      const value = parseToggle(args);
      if (value === null) {
        ctx.ui.notify(`Usage: /auto-mode [on|off|toggle] (currently ${state.auto ? "on" : "off"})`, "info");
        return;
      }
      state.auto = applyToggle(value, state.auto);
      persistState(pi);
      observe(() => broadcastState(pi, ctx));
      updateWidget(ctx);
      observe(() => ctx.ui.notify(`🛡️ Auto-mode ${state.auto ? "on" : "off"}`, "info"));
    },
  });

  pi.registerCommand("remote-read-only", {
    description: "Toggle remote-read-only mode. Usage: /remote-read-only [on|off|toggle]",
    handler: async (args, ctx) => {
      const value = parseToggle(args);
      if (value === null) {
        ctx.ui.notify(`Usage: /remote-read-only [on|off|toggle] (currently ${effectiveGuards(config(ctx.cwd)).remoteReadOnly ? "on" : "off"})`, "info");
        return;
      }
      changeGuard("remoteReadOnly", value, ctx);
    },
  });

  async function showPanel(ctx: ExtensionContext, options: ActivityPanelOptions,
    lines: (width: number, theme: DisplayTheme) => string[]): Promise<void> {
    if (!ctx.hasUI) return;
    let requestRender: (() => void) | undefined;
    try {
      if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
        ctx.ui.notify(lines(process.stdout.columns ?? 100, ctx.ui.theme).join("\n"), "info");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        requestRender = () => tui.requestRender();
        renderPanel = requestRender;
        return new ActivityPanel(tui, theme, () => {
          if (renderPanel === requestRender) renderPanel = undefined;
          done();
        }, observationView, {
          ...options,
          modes: () => modes(config(ctx.cwd)),
          droppedRecords: () => ({ actions: runtime.logger?.droppedRecords ?? 0, metadata: runtime.reviews?.droppedRecords ?? 0 }),
        });
      }, { overlay: true, overlayOptions: {
        anchor: "center", width: 110, maxHeight: "80%",
      } });
    } catch { /* UI teardown cannot affect admission or session state. */ }
    finally { if (renderPanel === requestRender) renderPanel = undefined; }
  }

  for (const [command, category] of [["bash-history", "sh"], ["mcp-history", "mcp"]] as const) {
    pi.registerCommand(command, {
      description: `Show observed ${category === "sh" ? "bash" : "MCP"} history. Usage: /${command} [turn|complete]`,
      handler: async (args, ctx) => {
        const scope = (args.trim() || "turn").toLowerCase();
        if (scope !== "turn" && scope !== "complete") {
          observe(() => ctx.ui.notify(`Usage: /${command} [turn|complete]`, "error"));
          return;
        }
        scanBashReceipts(ctx);
        await showPanel(ctx, { initialTab: "history", category, scope: scope === "complete" ? "session" : "turn" }, (width, theme) => [
          theme.fg("accent", `${category === "sh" ? "Bash" : "MCP"} history · ${scope}`),
          ...renderHistory(observationView(), { width, theme, category, scope: scope === "complete" ? "session" : "turn", maxEntries: 256 }),
          truncateToWidth("Sanitized histories remain private session data.", width, ""),
          truncateToWidth("↑↓ / PgUp PgDn scroll · Esc close", width, ""),
        ]);
      },
    });
  }

  pi.registerCommand("activity", {
    description: "Show activity dashboard. Usage: /activity [details]",
    handler: async (args, ctx) => {
      const details = args.trim().toLowerCase();
      if (details && details !== "details") {
        observe(() => ctx.ui.notify("Usage: /activity [details]", "error"));
        return;
      }
      scanBashReceipts(ctx);
      await showPanel(ctx, { initialTab: details === "details" ? "diagnostics" : "overview" }, (width, theme) => [
        ...renderDashboard(observationView(), { width, theme, details: details === "details", modes: modes(config(ctx.cwd)) }),
        ...(runtime.logger?.droppedRecords || runtime.reviews?.droppedRecords ? [truncateToWidth(
          `Private log dropped records: actions=${runtime.logger?.droppedRecords ?? 0}, metadata=${runtime.reviews?.droppedRecords ?? 0}`, width, "")] : []),
        truncateToWidth("↑↓ / PgUp PgDn scroll · Esc close", width, ""),
      ]);
      updateWidget(ctx);
    },
  });
}
