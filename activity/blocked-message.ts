/** Activity-owned block messages; never register or replace a tool renderer. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";

export type BlockPresentation = "native" | "activity";
export const BLOCKED_MESSAGE_TYPE = "activity-blocked";
export const BLOCKED_NOTICE = "Blocked — tool was not run.";

// Why auto mode refused decides what the model may usefully do next. A judged
// block names a real objection, so a safe alternative is the way forward. A
// technical failure judged nothing, so retrying is legitimate. Missing
// configuration blocks the same way every time, so retrying only wastes turns.

/** A judge examined the action and objected to it. */
export const BLOCKED_GUIDANCE = "Continue with a safe alternative or other unblocked work. Continue progress if possible. Ask only when no safe path remains.";

/** The action was never judged: transport failure, timeout, or an unusable answer. */
export const TECHNICAL_BLOCKED_GUIDANCE = "A technical failure prevented auto mode from checking this action. The action itself was not judged. You may try it again or use a different approach.";

/** Auto mode has no way to judge this action; the block repeats until it is configured. */
export const CONFIG_BLOCKED_GUIDANCE = "Auto mode is not configured to check this action, so it stays blocked. Do not retry it. Tell the user what is missing and continue with other work.";

export type BlockedGuidanceKind = "judged" | "technical" | "config";

const GUIDANCES: Record<BlockedGuidanceKind, string> = {
  judged: BLOCKED_GUIDANCE,
  technical: TECHNICAL_BLOCKED_GUIDANCE,
  config: CONFIG_BLOCKED_GUIDANCE,
};

export function blockedGuidance(kind: BlockedGuidanceKind = "judged"): string {
  return GUIDANCES[kind];
}

// Where the appended guidance begins in a formatted reason, for the UI split.
function guidanceOffset(body: string): number {
  return Object.values(GUIDANCES).map((guidance) => body.indexOf(`\n${guidance}`)).find((offset) => offset >= 0) ?? -1;
}

// Guidance is Activity-owned wording, never model content. Remove every copy so an
// echoed or previously appended sentence cannot replace the wording for this block.
function stripGuidance(text: string): string {
  let body = text;
  for (const guidance of Object.values(GUIDANCES)) body = body.split(guidance).join("");
  return body.replace(/\n+$/, "").replace(/^\n+/, "").trim();
}

export function formatBlockedReason(reason: string, kind: BlockedGuidanceKind = "judged"): string {
  const body = stripGuidance(reason.replace(/^(?:↑ )?Blocked — tool was not run\.\s*/, ""));
  const annotated = body.startsWith("🛡️") ? body : `🛡️ Blocked (activity): ${body}`;
  return `↑ ${BLOCKED_NOTICE}\n${annotated}\n${blockedGuidance(kind)}`;
}

export function createBlockPresentation(pi: ExtensionAPI, style: BlockPresentation) {
  if (style === "activity") {
    pi.registerMessageRenderer(BLOCKED_MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
      const details = message.details as { toolName: string; toolCallId: string };
      const reference = `\nTool call: ${details.toolName} (${details.toolCallId}).`;
      const content = String(message.content);
      // Keep call identity in model context; show it in the UI only on expansion.
      const text = !expanded && content.endsWith(reference) ? content.slice(0, -reference.length) : content;
      // The native result already states that execution was blocked. Keep its
      // duplicate notice in model context, not in this Activity-owned UI block.
      const body = text.replace(/^↑ Blocked — tool was not run\.\n/, "↑ ");
      const guidanceAt = guidanceOffset(body);
      const box = new Box(outputPad, 1, (line) => theme.bg("toolErrorBg", line));
      box.addChild(new Text(theme.fg("error", guidanceAt < 0 ? body : body.slice(0, guidanceAt)), 0, 0));
      if (guidanceAt >= 0) {
        box.addChild(new Spacer(1));
        box.addChild(new Text(theme.fg("muted", `Model guidance:\n${body.slice(guidanceAt + 1)}`), 0, 0));
      }
      return box;
    });
  }
  return (event: { toolName: string; toolCallId: string; parentToolCallId?: string }, reason: string, display = true,
    kind: BlockedGuidanceKind = "judged") => {
    const text = formatBlockedReason(reason, kind);
    // Nested callers need the full reason immediately. Cancelled/stale work must
    // not enqueue a message in a replacement session or turn.
    if (style === "activity" && display && !event.parentToolCallId) {
      pi.sendMessage({ customType: BLOCKED_MESSAGE_TYPE,
        content: `${text}\nTool call: ${event.toolName} (${event.toolCallId}).`,
        display: true, details: { toolName: event.toolName, toolCallId: event.toolCallId },
      }, { triggerTurn: false });
      return { block: true as const, reason: BLOCKED_NOTICE };
    }
    return { block: true as const, reason: text };
  };
}
