import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";

export const USER_SUMMARY_BATCH_SIZE = 5;
export const HUMAN_ANSWER_TYPE = "activity-human-answer";
export const TOOL_OUTCOME_TYPE = "activity-tool-outcome";
export type SessionOrigin = "human" | "agent";
export type UserMessage = { id: string; text: string; provenance: "human" | "agent"; kind?: "questionnaire"; source?: string };
export type ToolOutcome = "permitted" | "blocked" | "completed" | "failed";
type Call = { toolCallId: string; toolName: string; input: unknown };
type Question = { header: string; question: string; options: { label: string; description: string; preview?: string }[]; multiSelect?: boolean; allowCustom?: boolean };
type Pending = { tool: string; inputHash: string; manager: ExtensionContext["sessionManager"]; anchor?: string; questions?: Question[]; source?: string };
type HumanAnswer = { version: 1; callId: string; inputHash: string; source: string; text: string };

export function serializedInputHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function inputHash(input: unknown): string {
  return serializedInputHash(JSON.stringify(input) ?? "undefined");
}
function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}
function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isHumanAnswer(value: unknown): value is HumanAnswer {
  return object(value) && value.version === 1 && typeof value.callId === "string" &&
    typeof value.inputHash === "string" && typeof value.source === "string" && typeof value.text === "string";
}

/** Only gate-owned receipts are human input. A name or "User answered" string in a tool result is not provenance. */
export function collectUserMessages(ctx: ExtensionContext, origin: SessionOrigin = "human"): UserMessage[] {
  const users: UserMessage[] = [];
  const seen = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "user") {
      const content = entry.message.content;
      const text = typeof content === "string" ? content : content
        .filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (text) users.push({ id: entry.id ?? String(users.length), text,
        provenance: origin });
    } else if (entry.type === "custom" && entry.customType === HUMAN_ANSWER_TYPE && isHumanAnswer(entry.data)) {
      const key = JSON.stringify([entry.data.callId, entry.data.inputHash]);
      if (seen.has(key)) continue;
      seen.add(key);
      users.push({ id: entry.id, text: entry.data.text, provenance: "human", kind: "questionnaire", source: entry.data.source });
    }
  }
  return users;
}

/** Validate results against the exact questionnaire shown, retaining only selected option context and human text. */
export function questionnaireText(questions: Question[], details: unknown): string | undefined {
  if (!Array.isArray(questions) || !questions.length || questions.length > 8 || questions.some((q) =>
    !object(q) || typeof q.question !== "string" || typeof q.header !== "string" || !Array.isArray(q.options) ||
    !q.options.length || q.options.length > 8 || q.options.some((o) => !object(o) || typeof o.label !== "string" || typeof o.description !== "string") ||
    new Set(q.options.map((o) => o.label)).size !== q.options.length)) return undefined;
  if (!object(details) || details.cancelled !== false || details.error !== undefined || !Array.isArray(details.answers) ||
      details.answers.length !== questions.length) return undefined;
  const seen = new Set<number>();
  const answers: unknown[] = [];
  for (const answer of details.answers) {
    if (!object(answer) || !Number.isInteger(answer.questionIndex) || seen.has(answer.questionIndex)) return undefined;
    const q = questions[answer.questionIndex];
    if (!q || answer.question !== q.question || answer.header !== q.header ||
        (answer.comment !== undefined && typeof answer.comment !== "string")) return undefined;
    seen.add(answer.questionIndex);
    let selected: Question["options"] = [];
    if (answer.kind === "option") {
      if (q.multiSelect || typeof answer.answer !== "string") return undefined;
      selected = q.options.filter((option) => option.label === answer.answer);
      if (selected.length !== 1) return undefined;
    } else if (answer.kind === "multi") {
      if (!q.multiSelect || answer.answer !== null || !Array.isArray(answer.selected) ||
          !answer.selected.length || new Set(answer.selected).size !== answer.selected.length ||
          answer.selected.some((label: unknown) => typeof label !== "string" || !q.options.some((option) => option.label === label))) return undefined;
      selected = answer.selected.map((label: string) => q.options.find((option) => option.label === label)!);
    } else if (answer.kind === "custom") {
      if (q.multiSelect || q.allowCustom === false || typeof answer.answer !== "string" || !answer.answer.trim()) return undefined;
    } else if (answer.kind === "skip") {
      if (answer.answer !== null || (answer.selected !== undefined && (!Array.isArray(answer.selected) || answer.selected.length))) return undefined;
    } else return undefined;
    answers.push({ questionIndex: answer.questionIndex, question: q.question, header: q.header,
      kind: answer.kind, answer: answer.answer, selectedOptions: selected,
      ...(answer.comment !== undefined ? { comment: answer.comment } : {}) });
  }
  return JSON.stringify({ submission: "confirmed human questionnaire", answers });
}

/** Capture provenance while a known user-installed tool runs, then persist branch-local receipts for reload/restart. */
export class ReviewRecorder {
  private pending = new Map<string, Pending>();
  constructor(private pi: Pick<ExtensionAPI, "appendEntry">) {}
  clear(): void { this.pending.clear(); }
  private append(type: string, data: unknown): void {
    // Recording failure must not change the tool's safety decision or execution result.
    try { this.pi.appendEntry(type, data); } catch { /* No receipt means no inferred human authorization. */ }
  }
  private active(pending: Pending, ctx: ExtensionContext): boolean {
    return pending.manager === ctx.sessionManager && (!pending.anchor ||
      ctx.sessionManager.getBranch().some((entry) => entry.id === pending.anchor));
  }
  begin(event: Call, ctx: ExtensionContext, info: ToolInfo | undefined, sources: string[]): void {
    const pending: Pending = { tool: event.toolName, inputHash: inputHash(event.input), manager: ctx.sessionManager,
      anchor: ctx.sessionManager.getBranch().findLast((entry) => typeof entry.id === "string")?.id };
    const source = info?.sourceInfo;
    if (pending.anchor && event.toolName === "ask_user_question" && info?.name === event.toolName && source?.scope === "user" && typeof source.path === "string" &&
        !source.path.startsWith("builtin:") && !source.path.startsWith("<") &&
        sources.some((path) => canonical(path) === canonical(source.path)) && object(event.input) && Array.isArray(event.input.questions)) {
      // Snapshot the displayed questions before later tool/event mutations.
      pending.questions = JSON.parse(JSON.stringify(event.input.questions));
      pending.source = canonical(source.path);
    }
    this.pending.set(event.toolCallId, pending);
  }
  decision(event: Call, ctx: ExtensionContext, blocked: boolean): void {
    const pending = this.pending.get(event.toolCallId);
    if (!pending || !this.active(pending, ctx)) return;
    this.append(TOOL_OUTCOME_TYPE, { version: 1, callId: event.toolCallId, tool: pending.tool,
      inputHash: pending.inputHash, outcome: blocked ? "blocked" : "permitted" });
    if (blocked) this.pending.delete(event.toolCallId);
  }
  result(event: Call & { isError?: boolean; details?: unknown }, ctx: ExtensionContext): void {
    const pending = this.pending.get(event.toolCallId);
    this.pending.delete(event.toolCallId);
    if (!pending || !this.active(pending, ctx) || pending.tool !== event.toolName ||
        pending.inputHash !== inputHash(event.input)) return;
    this.append(TOOL_OUTCOME_TYPE, { version: 1, callId: event.toolCallId, tool: pending.tool,
      inputHash: pending.inputHash, outcome: event.isError === false ? "completed" : "failed" });
    if (event.isError !== false || !pending.questions || !pending.source) return;
    const text = questionnaireText(pending.questions, event.details);
    if (text) this.append(HUMAN_ANSWER_TYPE, { version: 1, callId: event.toolCallId,
      inputHash: pending.inputHash, source: pending.source, text } satisfies HumanAnswer);
  }
}

export function collectToolOutcomes(ctx: ExtensionContext): Map<string, { tool: string; inputHash: string; outcome: ToolOutcome }> {
  const outcomes = new Map<string, { tool: string; inputHash: string; outcome: ToolOutcome }>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== TOOL_OUTCOME_TYPE || !object(entry.data)) continue;
    const d = entry.data;
    if (d.version === 1 && typeof d.callId === "string" && typeof d.tool === "string" && typeof d.inputHash === "string" &&
        ["permitted", "blocked", "completed", "failed"].includes(d.outcome)) outcomes.set(d.callId,
          { tool: d.tool, inputHash: d.inputHash, outcome: d.outcome as ToolOutcome });
  }
  return outcomes;
}
