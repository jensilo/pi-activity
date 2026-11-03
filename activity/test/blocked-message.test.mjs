// Synthetic comparison previews: tool renderers are never touched.
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { BLOCKED_GUIDANCE, BLOCKED_MESSAGE_TYPE, BLOCKED_NOTICE, createBlockPresentation, formatBlockedReason } from "../blocked-message.ts";

const event = { toolName: "edit", toolCallId: "synthetic-edit" };
const reason = `Blocked — tool was not run. 🛡️ Blocked (llm): Synthetic read-only guard is ON.\n${BLOCKED_GUIDANCE}`;
const full = `↑ ${BLOCKED_NOTICE}\n🛡️ Blocked (llm): Synthetic read-only guard is ON.\n${BLOCKED_GUIDANCE}`;
assert.equal(formatBlockedReason(reason), full);
assert.equal(formatBlockedReason(full), full, "formatting is idempotent");
assert.equal(formatBlockedReason("Synthetic policy context expired."), `↑ ${BLOCKED_NOTICE}\n🛡️ Blocked (activity): Synthetic policy context expired.\n${BLOCKED_GUIDANCE}`);

for (const style of ["native", "activity"]) {
  const messages = [];
  const renderers = new Map();
  const present = createBlockPresentation({
    registerMessageRenderer(type, renderer) { renderers.set(type, renderer); },
    registerToolRenderer() { assert.fail("no tool renderer overrides"); },
    registerTool() { assert.fail("no tool shadowing"); },
    sendMessage(message, options) { messages.push({ message, options }); },
  }, style);
  const result = present(event, reason);
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
      const text = lines.map(stripTerminalSequences).join("\n");
      assert.match(text, /↑ 🛡️ Blocked/);
      assert.doesNotMatch(text, /tool was not run/, "native execution notice is not repeated in the Activity block");
      const trimmed = lines.map((line) => stripTerminalSequences(line).trim());
      const guidanceAt = trimmed.indexOf("Model guidance:");
      assert.ok(guidanceAt > 1, "transparent model guidance is visibly labelled");
      assert.equal(trimmed[guidanceAt - 1], "", "blank line separates the reason from model guidance");
      assert.doesNotMatch(text, /synthetic-edit/, "call ID is hidden only in the collapsed UI");
      assert.doesNotMatch(text, /NOT EXECUTED|Failed/);
      component.invalidate();
      assert.deepEqual(component.render(width), lines);
    }
    assert.match(renderer(message, { outputPad: 1, expanded: true }, theme).render(140).map(stripTerminalSequences).join("\n"), /synthetic-edit/);
    assert.ok(backgroundLines > 0, "one themed error background covers the block");
    assert.ok(foregrounds.some(({ color, text }) => color === "error" && text === "↑ 🛡️ Blocked (llm): Synthetic read-only guard is ON."));
    assert.ok(foregrounds.some(({ color, text }) => color === "muted" && text.startsWith(`Model guidance:\n${BLOCKED_GUIDANCE}`)));
    assert.ok(foregrounds.filter(({ color }) => color === "error").every(({ text }) => !text.includes(BLOCKED_GUIDANCE)), "guidance is not styled as an error");
    assert.equal(message.content, `${full}\nTool call: edit (synthetic-edit).`, "UI styling does not remove model-visible safety guidance");
  }
  const count = messages.length;
  assert.equal(present({ ...event, parentToolCallId: "synthetic-parent" }, reason).reason, full, "nested caller gets full reason immediately");
  assert.equal(present(event, reason, false).reason, full, "cancelled or stale work keeps full native reason");
  assert.equal(messages.length, count, "no extra message for nested or cancelled work");
}
console.log("blocked message tests passed: native multiline, short native plus model-visible Activity message, themed wrapping, nested/cancelled safety");
