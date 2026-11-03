// Synthetic inline-custom adapter. Real host mounting and focus routing are
// covered by approval-ui.test.mjs and approval-sdk.test.mjs.
import assert from "node:assert/strict";
import { getKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";

export function escapedEvidence(text) {
  return text.replace(/[\\\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff\ud800-\udfff]/gu,
    (char) => char === "\\" ? "\\\\" : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Inspect the rendered body, not an unrendered copy of the full evidence. All
// pages must be reachable with h/l without changing the selected decision.
export function collectApprovalEvidence(view, input = (key) => view.handleInput(key), width = 80) {
  view.render(width);
  input("\x1b[H");
  let evidence = "", pages = 0;
  const selected = view.selected;
  for (;;) {
    const rendered = view.render(width).map(stripTerminalSequences);
    assert.ok(rendered.length <= 18, "approval stays within its compact inline row budget");
    assert.equal(view.page, pages, "every evidence page is inspected in order");
    assert.equal(view.selected, selected, "paging preserves the decision");
    const body = rendered.slice(2, -6);
    assert.ok(body.length > 0, "each page exposes evidence directly above the choices");
    evidence += body.map((line) => {
      assert.ok(line.startsWith(" ") && line.endsWith(" "), "evidence body uses invisible side padding");
      return line.slice(1, -1);
    }).join("");
    pages++;
    input("l");
    if (view.page === pages - 1) break;
  }
  assert.ok(pages > 0);
  input("h");
  assert.equal(view.page, Math.max(0, pages - 2), "h reaches the previous evidence page");
  input("\x1b[H");
  assert.equal(view.page, 0, "Home returns to the first evidence page");
  input("\x1b[F");
  assert.equal(view.page, pages - 1, "End reaches the final evidence page");
  assert.equal(view.selected, selected);
  return evidence;
}

export function assertCompleteArguments(evidence, input) {
  assert.ok(evidence.includes(`Full arguments (backslashes and controls escaped):${escapedEvidence(JSON.stringify(input))}`),
    "all exact JSON characters are inspectable, including every null field and the final tail");
}

export function approvalFixture(ctx, onOpen = () => {}) {
  return (factory, options) => new Promise((resolve, reject) => {
    assert.notEqual(options?.overlay, true, "approval is inline, never an overlay");
    let settled = false, view;
    const complete = (outcome) => {
      if (settled) return;
      settled = true;
      view?.dispose?.();
      resolve(outcome);
    };
    // Labels use the real input path; lifecycle outcomes can be injected for
    // gate-only tests whose actual timeout/cancellation coverage lives elsewhere.
    const done = (choice) => {
      if (settled) return;
      if (choice === "Allow" || choice === "Block") {
        const selected = choice === "Allow" ? 1 : 0;
        if (view.selected !== selected) view.handleInput(selected ? "j" : "k");
        view.handleInput("\r");
      } else if (choice === undefined || choice === "cancelled") view.handleInput("\x1b");
      else complete(choice);
    };
    const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} };
    const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, ...ctx.ui.theme };
    Promise.resolve().then(() => factory(tui, theme, getKeybindings(), complete)).then((component) => {
      view = component;
      if (settled) { view?.dispose?.(); return; }
      view.render(80);
      return onOpen(done, view);
    }).catch((error) => {
      if (settled) return;
      settled = true;
      view?.dispose?.();
      reject(error);
    });
  });
}
