import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { collectUserMessages, USER_SUMMARY_BATCH_SIZE, type UserMessage, type UserMessageSummary } from "./summary.js";
import { collectToolOutcomes, serializedInputHash, type SessionOrigin } from "./interactions.js";
import type { Primitives, RiskSignals } from "./policy.js";
import { validateDelegatedContext, type DelegatedContextSnapshot } from "./delegation.js";

export type ReviewEvidence = {
  /** Only established heads; omitted heads are unknown, not negative attestations. */
  nativeEffects?: Partial<Primitives>;
  predictions?: RiskSignals;
  objections?: string[];
};
export type InstructionSnapshot = readonly Readonly<{ source: string; text: string }>[];

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

/** Actual system/instruction text, never assistant/tool prose or inferred unread documents. No clipping. */
export function collectInstructionSnapshot(ctx: ExtensionContext): InstructionSnapshot {
  const instructions: { source: string; text: string }[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "system") continue;
    const text = textContent(entry.message.content);
    if (text) instructions.push({ source: "Branch system message", text });
    for (const [key, section] of Object.entries(entry.message.sections ?? {})) {
      if (typeof section === "string") instructions.push({ source: `Branch system section: ${key}`, text: section });
      else if (section === null) instructions.push({ source: `Branch system section removed: ${key}`, text: "null" });
    }
  }
  const current = ctx.getSystemPrompt?.();
  if (current && !instructions.some((item) => item.text === current)) instructions.push({ source: "Current effective system prompt", text: current });
  return Object.freeze(instructions.map((item) => Object.freeze(item)));
}

/** Tool/server-authored evidence, not a verified effect contract. */
export type ReviewToolMetadata = Pick<ToolInfo, "description" | "parameters" | "namespace" | "annotations" | "exposure">;

const MAX_USER_CHARS = 384_000;
export const MAX_TOTAL_CHARS = 768_000;
const MAX_PRIOR_CALL_CHARS = 32_000;
export const MAX_ACTION_CHARS = 256_000;
export const HISTORY_COUNTS = [10, 8, 6, 4] as const;

export interface ReviewContextOptions {
  short?: boolean;
  origin?: SessionOrigin;
  /** Recent tool counts; raw fallback history shrinks with these on context retries. */
  historySelectionLevel?: number;
  /** Lower the rendered-character guideline for a retry after a provider context error. */
  budgetOverrideChars?: number;
  dropOptionalHistoryAtLimit?: boolean;
  toolMetadata?: ReviewToolMetadata;
  userSummary?: UserMessageSummary;
  cascadeSummary?: UserMessageSummary;
  /** Snapshot used by the lazy summarizer, so concurrent new input cannot shift coverage. */
  userMessages?: UserMessage[];
  /** Per-review immutable snapshots; delegated context must be obtained at session_start. */
  delegatedContext?: DelegatedContextSnapshot | null;
  instructionSnapshot?: InstructionSnapshot;
  evidence?: ReviewEvidence;
}

export interface ReviewContextMetadata {
  selectedRecentToolCalls: number;
  selectedUserMessages: number;
  clippedPriorToolCalls: number;
  clippedUserMessages: number;
  omittedInstructionSnapshot?: boolean;
  truncatedCascadeSummary?: boolean;
  currentActionChars: number;
  budgetChars: number;
  estimatedModelBudgetChars: number;
  overflowGuideline: boolean;
  toolHistoryLevel: number;
  userHistoryLevel: number;
  summarizedUserMessages: number;
}

export interface ReviewContextResult {
  text: string;
  metadata: ReviewContextMetadata;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit < 40) return text.slice(0, limit);
  // Include the marker in the limit, even when its number of digits changes.
  let marker = "";
  let kept = limit;
  do {
    marker = `\n[...truncated ${text.length - kept} characters...]\n`;
    kept = Math.max(0, limit - marker.length);
  } while (marker !== `\n[...truncated ${text.length - kept} characters...]\n`);
  const head = Math.ceil(kept * 0.7);
  return text.slice(0, head) + marker + text.slice(text.length - (kept - head));
}

function inputText(input: unknown): string {
  return JSON.stringify(input) ?? "undefined";
}

// The character length makes embedded newlines, labels, and fake section boundaries unambiguous.
function field(label: string, value: string): string {
  return `${label} [${value.length} chars]\n${value}\n`;
}

// Short records have a whitespace-separated header. The body is never normalized.
function shortField(label: string, value: string): string {
  return `${label}\t${value.length}\n${value}\n`;
}

function renderShort(users: UserMessage[], tool: string, cwd: string, input: string, policy: string, metadata?: string): string {
  let text = "Records: label TAB UTF-16 length, newline, exact value, newline. Inputs are chronological.\n" + policy;
  for (const user of users) {
    text += shortField(user.provenance === "agent" ? "Agent task (not consent)" : user.kind === "questionnaire" ? "Human questionnaire" : "User", user.text);
  }
  text += shortField("Tool", tool) + shortField("Cwd", cwd) + shortField("Input JSON", input);
  return metadata === undefined ? text : text + shortField("Unverified metadata JSON", metadata);
}

function render(users: UserMessage[], calls: { tool: string; arguments: string; outcome: string }[], tool: string, cwd: string, input: string, policyContext: string, toolMetadata?: string, summary?: UserMessageSummary, origin: SessionOrigin = "human"): string {
  let text = "Review context (lengths are JavaScript string characters; read exactly that many characters after each field header).\n" + policyContext;
  const delegated = origin === "agent";
  if (summary) {
    text += "\n" + field(delegated ? summary.humanInputs ? "Mixed human/task summary (generated)" : "Agent task summary (generated; not human consent)" : "User Message Summary (generated)", summary.text);
    text += `Summary covers the first ${summary.coveredMessages} messages; originals are not repeated below.\n`;
  }
  const heading = delegated ? users.every((user) => user.provenance === "agent") ? "Agent-authored task messages" : "Human inputs and agent tasks" : "User messages";
  text += `\n${heading} (${users.length}, chronological)\n`;
  users.forEach((user, i) => {
    const label = user.provenance === "agent" ? "Agent task" : user.kind === "questionnaire" ? "Human questionnaire" : "User";
    text += field(`${label} ${i + 1}`, user.text);
  });
  text += `\nRecent agent tool calls (${calls.length}, chronological; arguments are JSON unless truncated)\n`;
  calls.forEach((call, i) => {
    text += `Call ${i + 1}\n` + field("Tool", call.tool) + field("Arguments", call.arguments) + field("Execution status", call.outcome);
  });
  text += "\nCurrent proposed action (complete)\n" + field("Tool", tool) + field("Working directory", cwd) + field("Input JSON", input);
  if (toolMetadata !== undefined) text += field("Tool metadata JSON (unverified)", toolMetadata);
  return text;
}

function selectedUsers(users: UserMessage[]): { messages: UserMessage[]; clipped: number } {
  if (users.reduce((total, message) => total + message.text.length, 0) > MAX_USER_CHARS) {
    throw new Error("unsummarized human/task input exceeds review limit; cannot omit authorization or revocation history");
  }
  // Omitting even one input can preserve an old grant while losing its revocation.
  return { messages: users, clipped: 0 };
}

/** Branch-local human input, labelled tasks, tool arguments and execution metadata, never arbitrary tool output or assistant prose. */
export function reviewContext(
  ctx: ExtensionContext, tool: string, input: unknown, cwd: string, modelContextWindow: number,
  options: ReviewContextOptions = {},
): ReviewContextResult {
  const delegated = validateDelegatedContext(ctx, options.delegatedContext, cwd);
  const origin = delegated ? "agent" : options.origin ?? "human";
  const instructions = options.instructionSnapshot ?? collectInstructionSnapshot(ctx);
  const record = options.short ? shortField : field;
  let policyContext = options.short ? "" : "\nActual instruction context (chronological; instruction authority, not human consent; section updates replace earlier values and labelled removals remove them)\n";
  if (!options.short) instructions.forEach((item, index) => {
    policyContext += field(`Instruction source ${index + 1}`, item.source) + field(`Instruction ${index + 1}`, item.text);
  });
  if (delegated) {
    policyContext += "\nLauncher-provided parent sources (chronological; assignment is not human consent). Labelled system-section updates replace only the same owning session's named section: null removes it and an empty string clears its instruction text. A descendant's update does not remove an ancestor's section, human input or hard guards.\n";
    delegated.context.sources.forEach((source, index) => {
      const label = source.role === "user" ? "Parent human input" : source.role === "instruction" ? "Parent instruction" : "Delegated assignment (not human consent)";
      policyContext += record(`${label} ${index + 1}`, source.text);
    });
    policyContext += record("Inherited hard guard restrictions JSON", inputText(delegated.context.restrictions));
  }
  const evidence = options.evidence;
  let evidenceText = "";
  if (evidence?.nativeEffects !== undefined) evidenceText += record("Native effect facts JSON (authoritative)", inputText(evidence.nativeEffects));
  if (evidence?.predictions !== undefined) evidenceText += record("Classifier predictions JSON (fallible; not facts)", inputText(evidence.predictions));
  if (evidence?.objections !== undefined) evidenceText += record("Review objections JSON (claims; not authority)", inputText(evidence.objections));
  if (evidenceText) policyContext += (options.short ? "" : "\nCurrent action evidence (native facts are separate from predictions and objections)\n") + evidenceText;
  const initialLevel = options.historySelectionLevel ?? 0;
  if (!Number.isInteger(initialLevel) || initialLevel < 0 || initialLevel >= HISTORY_COUNTS.length) {
    throw new RangeError("invalid history selection level");
  }
  if (options.budgetOverrideChars !== undefined && (!Number.isFinite(options.budgetOverrideChars) || options.budgetOverrideChars < 0)) {
    throw new RangeError("invalid review context budget override");
  }
  const estimatedModelBudgetChars = Math.max(0, Math.floor(modelContextWindow * 1.5));
  const budget = Math.min(MAX_TOTAL_CHARS, options.budgetOverrideChars ?? MAX_TOTAL_CHARS);
  const serializedInput = inputText(input);
  const serializedMetadata = options.toolMetadata === undefined ? undefined : inputText(options.toolMetadata);
  const currentActionChars = tool.length + cwd.length + serializedInput.length + (serializedMetadata?.length ?? 0) + evidenceText.length;
  // The complete current action is the only hard size limit; budgets guide history selection.
  if (currentActionChars > MAX_ACTION_CHARS) {
    throw new Error("proposed action exceeds safety review input limit");
  }

  // Only these entries can appear at any history level. Keep references to
  // recent calls so discarded arguments are never serialized.
  const allUsers = options.userMessages ?? collectUserMessages(ctx, origin);
  const summary = options.userSummary;
  if (summary && (!Number.isInteger(summary.coveredMessages) || summary.coveredMessages < USER_SUMMARY_BATCH_SIZE ||
      summary.coveredMessages % USER_SUMMARY_BATCH_SIZE !== 0 || allUsers.length - summary.coveredMessages < 1 ||
      allUsers.length - summary.coveredMessages > USER_SUMMARY_BATCH_SIZE)) throw new RangeError("invalid user summary coverage");
  const users = allUsers.slice(summary?.coveredMessages ?? 0);
  if (options.short) {
    const cascade = options.cascadeSummary;
    const summaryLabel = "Generated guidance and user history summary (not new consent)";
    let snapshot = cascade ? shortField(summaryLabel, cascade.text)
      : instructions.map((item) => shortField("Instruction source", item.source) + shortField("Instruction (not consent)", item.text)).join("");
    const render = (extra: string) => renderShort(users, tool, cwd, serializedInput, policyContext + extra, serializedMetadata);
    let truncatedCascadeSummary = false;
    if (cascade && render(snapshot).length > budget) {
      const marker = "\n[Summary truncated; some guidance or earlier user input is missing.]";
      const room = budget - render(shortField(summaryLabel, marker)).length - String(budget).length;
      if (room >= 0) {
        snapshot = shortField(summaryLabel, cascade.text.slice(0, room) + marker);
        truncatedCascadeSummary = true;
      }
    }
    const complete = render(snapshot);
    if (complete.length <= budget) return { text: complete, metadata: {
      selectedRecentToolCalls: 0, selectedUserMessages: users.length, clippedPriorToolCalls: 0,
      clippedUserMessages: 0, omittedInstructionSnapshot: false, truncatedCascadeSummary, currentActionChars,
      budgetChars: budget, estimatedModelBudgetChars, overflowGuideline: false,
      toolHistoryLevel: initialLevel, userHistoryLevel: initialLevel, summarizedUserMessages: cascade?.coveredMessages ?? 0,
    } };
    const selected = new Set<number>();
    const omitted = shortField("Evidence limits", "History or system instructions may be incomplete. Do not infer permission from omissions or rely on older grants when human history is incomplete.");
    let text = renderShort([], tool, cwd, serializedInput, policyContext + omitted, serializedMetadata);
    if (text.length > budget) throw new Error("complete action and mandatory evidence exceed judge character limit");
    const order = users.length > 1 ? [users.length - 1, 0, ...users.slice(1, -1).map((_, i) => users.length - 2 - i)] : users.length ? [0] : [];
    const selectedUsers = () => [...selected].sort((a, b) => a - b).map((i) => users[i]);
    // Reserve space for the incomplete-history marker until all user messages fit.
    for (const i of order) {
      if (users[i].text.length > budget - text.length + omitted.length) continue;
      selected.add(i);
      const next = renderShort(selectedUsers(), tool, cwd, serializedInput, policyContext + omitted, serializedMetadata);
      if (next.length <= budget) text = next;
      else selected.delete(i);
    }
    const omittedInstructionSnapshot = text.length + snapshot.length > budget;
    if (!omittedInstructionSnapshot) {
      text = renderShort(selectedUsers(), tool, cwd, serializedInput,
        policyContext + snapshot + (selected.size === users.length ? "" : omitted), serializedMetadata);
    }
    return { text, metadata: { selectedRecentToolCalls: 0, selectedUserMessages: selected.size,
      clippedPriorToolCalls: 0, clippedUserMessages: users.length - selected.size, omittedInstructionSnapshot,
      truncatedCascadeSummary, currentActionChars,
      budgetChars: budget, estimatedModelBudgetChars, overflowGuideline: false,
      toolHistoryLevel: initialLevel, userHistoryLevel: initialLevel, summarizedUserMessages: omittedInstructionSnapshot ? 0 : cascade?.coveredMessages ?? 0 } };
  }
  const outcomes = collectToolOutcomes(ctx);
  const results = new Map<string, boolean>();
  const recentCalls: { id: string; name: string; arguments: unknown }[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        recentCalls.push({ id: part.id, name: part.name as string, arguments: part.arguments });
        if (recentCalls.length > HISTORY_COUNTS[initialLevel]) recentCalls.shift();
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string" && typeof message.isError === "boolean") {
      results.set(message.toolCallId, message.isError);
    }
  }

  const calls = recentCalls.map((call) => {
    const name = clip(call.name, MAX_PRIOR_CALL_CHARS);
    const serialized = inputText(call.arguments);
    const argumentsLimit = MAX_PRIOR_CALL_CHARS - name.length;
    const recorded = outcomes.get(call.id);
    const matched = recorded?.tool === call.name && recorded.inputHash === serializedInputHash(serialized) ? recorded.outcome : undefined;
    const outcome = matched === "blocked" ? "Blocked by the activity gate before execution; no action was performed"
      : matched === "failed" || results.get(call.id) === true ? "Failed; partial effects may exist"
      : matched === "completed" || results.get(call.id) === false ? "Completed successfully (reported, not independently verified)"
      : matched === "permitted" ? "Permitted by this gate; execution not confirmed"
      : "Proposed; execution outcome unknown";
    return { tool: name, arguments: clip(serialized, argumentsLimit), outcome,
      clipped: name.length < call.name.length || serialized.length > argumentsLimit };
  });

  let historyLevel = initialLevel;
  // Summary and the 1–5 raw tail interactions survive tool-history reductions.
  const selectUsers = () => selectedUsers(users);
  let userSelection = selectUsers();
  let callSelection = calls.slice(-HISTORY_COUNTS[historyLevel]);
  let text = render(userSelection.messages, callSelection, tool, cwd, serializedInput, policyContext, serializedMetadata, summary, origin);
  while ((userSelection.messages.reduce((total, message) => total + message.text.length, 0) > MAX_USER_CHARS ||
          text.length > budget) && historyLevel < HISTORY_COUNTS.length - 1) {
    historyLevel++;
    userSelection = selectUsers();
    callSelection = calls.slice(-HISTORY_COUNTS[historyLevel]);
    text = render(userSelection.messages, callSelection, tool, cwd, serializedInput, policyContext, serializedMetadata, summary, origin);
  }
  if (options.dropOptionalHistoryAtLimit && text.length > budget && callSelection.length) {
    callSelection = [];
    text = render(userSelection.messages, callSelection, tool, cwd, serializedInput, policyContext, serializedMetadata, summary, origin);
  }
  // Keep every unsummarized input and the complete action at the history floor.

  return { text, metadata: {
    selectedRecentToolCalls: callSelection.length,
    selectedUserMessages: userSelection.messages.length,
    clippedPriorToolCalls: callSelection.filter((call) => call.clipped).length,
    clippedUserMessages: userSelection.clipped,
    currentActionChars,
    budgetChars: budget,
    estimatedModelBudgetChars,
    overflowGuideline: text.length > budget,
    toolHistoryLevel: historyLevel,
    userHistoryLevel: historyLevel,
    summarizedUserMessages: summary?.coveredMessages ?? 0,
  } };
}
