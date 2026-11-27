// Synthetic comparison previews: tool renderers are never touched.
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { BLOCKED_GUIDANCE, BLOCKED_MESSAGE_TYPE, BLOCKED_NOTICE, CONFIG_BLOCKED_GUIDANCE,
  TECHNICAL_BLOCKED_GUIDANCE, blockedGuidance, createBlockPresentation, formatBlockedReason } from "../blocked-message.ts";

const event = { toolName: "edit", toolCallId: "synthetic-edit" };

// A judged objection invites an alternative; a failure that judged nothing invites
// a retry; missing configuration blocks the same way every time. The wording must
// stay in its own lane so the model cannot read a hard denial into a technical fault.
assert.notEqual(BLOCKED_GUIDANCE, TECHNICAL_BLOCKED_GUIDANCE);
assert.notEqual(BLOCKED_GUIDANCE, CONFIG_BLOCKED_GUIDANCE);
assert.notEqual(TECHNICAL_BLOCKED_GUIDANCE, CONFIG_BLOCKED_GUIDANCE);
assert.doesNotMatch(BLOCKED_GUIDANCE, /technical failure|try it again|not configured/i);
assert.doesNotMatch(TECHNICAL_BLOCKED_GUIDANCE, /safe alternative|not configured/i);
assert.match(TECHNICAL_BLOCKED_GUIDANCE, /not judged[\s\S]*try it again/i);
assert.doesNotMatch(CONFIG_BLOCKED_GUIDANCE, /try it again|technical failure/i);
assert.match(CONFIG_BLOCKED_GUIDANCE, /not configured[\s\S]*stays blocked/i);
assert.equal(blockedGuidance(), BLOCKED_GUIDANCE, "a refusal without a kind is a judged block");

const CASES = [
  ["judged", "Synthetic read-only guard is ON.", BLOCKED_GUIDANCE],
  ["technical", "Synthetic safety review replied with invalid JSON.", TECHNICAL_BLOCKED_GUIDANCE],
  ["config", "Synthetic safety judge is not configured.", CONFIG_BLOCKED_GUIDANCE],
];

for (const [kind, subject, guidance] of CASES) {
  const reason = `Blocked — tool was not run. 🛡️ Blocked (llm): ${subject}\n${guidance}`;
  const full = `↑ ${BLOCKED_NOTICE}\n🛡️ Blocked (llm): ${subject}\n${guidance}`;
  assert.equal(formatBlockedReason(reason, kind), full);
  assert.equal(formatBlockedReason(full, kind), full, "formatting is idempotent");
  assert.equal(formatBlockedReason(`Synthetic ${kind} decline.`, kind), `↑ ${BLOCKED_NOTICE}\n🛡️ Blocked (activity): Synthetic ${kind} decline.\n${guidance}`);
  // Activity owns this wording. An echoed or stale sentence is replaced, never stacked.
  const other = kind === "judged" ? "technical" : "judged";
  assert.equal(formatBlockedReason(full, other),
    `↑ ${BLOCKED_NOTICE}\n🛡️ Blocked (llm): ${subject}\n${blockedGuidance(other)}`);
  const echoed = `Synthetic ${kind} decline. ${blockedGuidance("config")} Please confirm.`;
  assert.equal(formatBlockedReason(echoed, kind),
    `↑ ${BLOCKED_NOTICE}\n🛡️ Blocked (activity): Synthetic ${kind} decline.  Please confirm.\n${guidance}`,
    "a judge-echoed guidance sentence cannot produce a second one");
}

for (const [kind, subject, guidance] of CASES) {
  const reason = `Blocked — tool was not run. 🛡️ Blocked (llm): ${subject}\n${guidance}`;
  const full = `↑ ${BLOCKED_NOTICE}\n🛡️ Blocked (llm): ${subject}\n${guidance}`;
  for (const style of ["native", "activity"]) {
    const messages = [];
    const renderers = new Map();
    const present = createBlockPresentation({
      registerMessageRenderer(type, renderer) { renderers.set(type, renderer); },
      registerToolRenderer() { assert.fail("no tool renderer overrides"); },
      registerTool() { assert.fail("no tool shadowing"); },
      sendMessage(message, options) { messages.push({ message, options }); },
    }, style);
    const result = present(event, reason, true, kind);
    assert.equal(result.block, true);
    if (style === "native") {
      assert.equal(result.reason, full);
      assert.equal(messages.length, 0);
      assert.equal(renderers.size, 0);
    } else {
      assert.equal(result.reason, BLOCKED_NOTICE);
      assert.equal(messages.length, 1);
      const { message, options } = messages[0];
      assert.equal(message.content, `${full}\nTool call: edit (synthetic-edit).`);
      assert.equal(message.display, true);
      assert.deepEqual(message.details, event);
      assert.deepEqual(options, { triggerTurn: false }, "flush after this turn's tool results, before model continuation");
      const renderer = renderers.get(BLOCKED_MESSAGE_TYPE);
      assert.equal(typeof renderer, "function");
      let backgroundLines = 0;
      const foregrounds = [];
      const theme = { fg(color, text) { foregrounds.push({ color, text }); return text; }, bg(color, text) {
        assert.equal(color, "toolErrorBg"); backgroundLines++; return text;
      } };
      for (const width of [28, 70, 140]) {
        const component = renderer(message, { outputPad: 1 }, theme);
        const lines = component.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width), `wrapped at ${width} columns`);
        const rendered = lines.map(stripTerminalSequences).join("\n");
        assert.match(rendered, /↑ 🛡️ Blocked/);
        assert.doesNotMatch(rendered, /tool was not run/, "native execution notice is not repeated in the Activity block");
        const trimmed = lines.map((line) => stripTerminalSequences(line).trim());
        const guidanceAt = trimmed.indexOf("Model guidance:");
        assert.ok(guidanceAt > 1, "transparent model guidance is visibly labelled");
        assert.equal(trimmed[guidanceAt - 1], "", "blank line separates the reason from model guidance");
        assert.doesNotMatch(rendered, /synthetic-edit/, "call ID is hidden only in the collapsed UI");
        assert.doesNotMatch(rendered, /NOT EXECUTED|Failed/);
        component.invalidate();
        assert.deepEqual(component.render(width), lines);
      }
      assert.match(renderer(message, { outputPad: 1, expanded: true }, theme).render(140).map(stripTerminalSequences).join("\n"), /synthetic-edit/);
      assert.ok(backgroundLines > 0, "one themed error background covers the block");
      assert.ok(foregrounds.some(({ color, text }) => color === "error" && text === `↑ 🛡️ Blocked (llm): ${subject}`));
      assert.ok(foregrounds.some(({ color, text }) => color === "muted" && text.startsWith(`Model guidance:\n${guidance}`)));
      assert.ok(foregrounds.filter(({ color }) => color === "error").every(({ text }) => !text.includes(guidance)), "guidance is not styled as an error");
      assert.equal(message.content, `${full}\nTool call: edit (synthetic-edit).`, "UI styling does not remove model-visible safety guidance");
    }
    const count = messages.length;
    assert.equal(present({ ...event, parentToolCallId: "synthetic-parent" }, reason, true, kind).reason, full, "nested caller gets full reason immediately");
    assert.equal(present(event, reason, false, kind).reason, full, "cancelled or stale work keeps full native reason");
    assert.equal(messages.length, count, "no extra message for nested or cancelled work");
  }
}
console.log("blocked message tests passed: three refusal kinds, native multiline, short native plus model-visible Activity message, themed wrapping, nested/cancelled safety");
