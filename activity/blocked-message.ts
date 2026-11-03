/** Activity-owned block messages; never register or replace a tool renderer. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";

export type BlockPresentation = "native" | "activity";
export const BLOCKED_MESSAGE_TYPE = "activity-blocked";
export const BLOCKED_NOTICE = "Blocked — tool was not run.";
export const BLOCKED_GUIDANCE = "Continue with a safe alternative that resolves this reason, or other unblocked work; prefer progress when the user is away. Do not bypass guards or retry unchanged. Ask only when no safe path remains.";

export function formatBlockedReason(reason: string): string {
  let body = reason.replace(/^(?:↑ )?Blocked — tool was not run\.\s*/, "");
  if (!body.startsWith("🛡️")) body = `🛡️ Blocked (activity): ${body}`;
  if (!body.includes(BLOCKED_GUIDANCE)) body += `\n${BLOCKED_GUIDANCE}`;
  return `↑ ${BLOCKED_NOTICE}\n${body}`;
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
      const guidanceAt = body.indexOf(`\n${BLOCKED_GUIDANCE}`);
      const box = new Box(outputPad, 1, (line) => theme.bg("toolErrorBg", line));
      box.addChild(new Text(theme.fg("error", guidanceAt < 0 ? body : body.slice(0, guidanceAt)), 0, 0));
      if (guidanceAt >= 0) {
        box.addChild(new Spacer(1));
        box.addChild(new Text(theme.fg("muted", `Model guidance:\n${body.slice(guidanceAt + 1)}`), 0, 0));
      }
      return box;
    });
  }
  return (event: { toolName: string; toolCallId: string; parentToolCallId?: string }, reason: string, display = true) => {
    const text = formatBlockedReason(reason);
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
