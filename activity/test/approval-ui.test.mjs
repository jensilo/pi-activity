import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Container, stripTerminalSequences, truncateToWidth, visibleWidth, TuiMainScreen, TuiAltScreen } from "@earendil-works/pi-tui";
import { requestApproval } from "../approval.ts";
import { collectApprovalEvidence, escapedEvidence } from "./approval-fixture.mjs";

// Actual installed Pi inline lifecycle and both compositors, entirely synthetic.
// Never construct a host session or start a real terminal/provider.
const require = createRequire(import.meta.url);
const host = process.env.PI_GLOBAL ?? dirname(dirname(require.resolve("@earendil-works/pi-coding-agent")));
const load = (path) => import(pathToFileURL(join(host, "dist", path)).href);
const { InteractiveMode } = await load("modes/interactive/interactive-mode.js");
const { KeybindingsManager } = await load("core/keybindings.js");
const { Theme, setThemeInstance } = await load("modes/interactive/theme/theme.js");
setThemeInstance(new Theme({ dim: 244, muted: 244, accent: 39, border: 244, warning: 214, text: 255, thinkingXhigh: 141 },
  { selectedBg: 0 }, "256color", { name: "synthetic-inline-approval" }));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = `${"synthetic 界 é 👩‍💻  ".repeat(180)}\nFULL_ARGUMENT_TAIL`;

function fixture(Renderer, bindings = {}, beforeMount) {
  const calls = [], editorInputs = [];
  const terminal = { columns: 80, rows: 24, write() {}, hideCursor() {}, showCursor() {},
    start() { assert.fail("no real terminal"); }, stop() { assert.fail("no real terminal"); } };
  const tui = new Renderer(terminal);
  if (Renderer === TuiAltScreen) tui.altScreenActive = true;
  let editorText = "preserved synthetic editor text";
  const editor = { getText: () => editorText, setText: (text) => { editorText = text; },
    render: (width) => [truncateToWidth("synthetic editor", width, "")], invalidate() {}, handleInput(data) { editorInputs.push(data); } };
  const editorContainer = new Container(); editorContainer.addChild(editor); tui.addChild(editorContainer); tui.setFocus(editor);
  const receiver = Object.assign(Object.create(InteractiveMode.prototype), {
    ui: tui, editor, editorContainer, keybindings: new KeybindingsManager(bindings),
    extensionDialogs: [], programStatus: { setBlocked() {} },
  });
  const ui = { select: () => assert.fail("no navigation menus"), custom(factory, options) {
    assert.notEqual(options?.overlay, true, "approval must be inline");
    assert.deepEqual(editorContainer.children, [editor], "queued approval cannot replace an active dialog");
    const entry = { view: undefined, completions: 0 };
    calls.push(entry);
    return receiver.showExtensionCustom((activeTui, theme, keys, done) => {
      entry.view = factory(activeTui, theme, keys, (result) => { entry.completions++; done(result); });
      beforeMount?.(entry.view);
      return entry.view;
    }, options);
  } };
  return { tui, receiver, calls, editorInputs, terminal, view: () => calls.at(-1)?.view,
    start(label = "synthetic tool", { signal, timeout = 1000, sessionManager, wrapper = ui } = {}) {
      return requestApproval({ mode: "tui", hasUI: true, signal, sessionManager, ui: wrapper }, label, "synthetic decline", timeout, args);
    }, ui,
    render(columns = 80, rows = 24) {
      terminal.columns = columns; terminal.rows = rows; tui.renderNow();
      const view = calls.at(-1).view;
      assert.equal(tui.getFocusedComponent(), view, "inline dialog owns keyboard focus");
      assert.deepEqual(editorContainer.children, [view]);
      assert.equal(tui.hasOverlay(), false);
      const lines = view.render(columns);
      assert.ok(lines.length <= 18, "inline approval never fills a large terminal");
      assert.ok(lines.every((line) => visibleWidth(line) <= columns));
      return lines.map(stripTerminalSequences);
    },
    choose(choice) { if (choice === "Allow") tui.handleTerminalInput("\x1b[B"); tui.handleTerminalInput("\r"); },
    cleanup() {
      assert.deepEqual(editorContainer.children, [editor]);
      assert.equal(editorText, "preserved synthetic editor text");
      assert.equal(tui.getFocusedComponent(), editor);
      assert.equal(tui.hasOverlay(), false);
      for (const call of calls) assert.equal(call.completions, 1, "each visible dialog completes once");
      tui.stopped = true; tui.cancelRenderTimer();
    },
  };
}

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
  for (const outcome of ["allow", "block", "cancelled", "timeout", "abort"]) {
    const f = fixture(Renderer), abort = new AbortController();
    const pending = f.start("synthetic tool", { signal: abort.signal, timeout: outcome === "timeout" ? 80 : 1000 });
    await tick();
    const initial = f.render();
    assert.ok(initial.some((line) => line.includes("→ Block")));
    assert.ok(initial.some((line) => line.trim() === "Allow"));
    assert.ok(initial.at(-3).includes("h/l"));
    if (outcome === "allow") { f.render(40, 24); f.choose("Allow"); }
    if (outcome === "block") f.choose("Block");
    if (outcome === "cancelled") f.tui.handleTerminalInput("\x1b");
    if (outcome === "abort") abort.abort();
    assert.equal(await pending, outcome === "abort" ? "cancelled" : outcome);
    f.cleanup();
    f.tui.handleTerminalInput("\x1b[B"); f.tui.handleTerminalInput("\r");
    assert.deepEqual(f.editorInputs, ["\x1b[B", "\r"], "stale input returns to the editor");
    f.view().handleInput("j"); f.view().handleInput("\r");
    assert.equal(f.calls[0].completions, 1);
  }
  {
    const f = fixture(Renderer), pending = f.start();
    await tick(); f.render();
    const key = (data) => f.tui.handleTerminalInput(data);
    key("j"); assert.equal(f.view().selected, 1);
    for (const width of [80, 40, 120]) {
      f.render(width, 24);
      const evidence = collectApprovalEvidence(f.view(), key, width);
      assert.ok(evidence.endsWith(escapedEvidence(args).replaceAll("\n", "")), "native composition and resize preserve every evidence character");
      assert.equal(f.view().selected, 1, "h/l never change Allow/Block");
    }
    assert.ok(f.render(120).join("\n").includes("FULL_ARGUMENT_TAIL"));
    key("k"); key("j"); key("\r");
    assert.equal(await pending, "allow"); f.cleanup();
  }
  {
    const f = fixture(Renderer), pending = f.start("idle", { timeout: 150 });
    await tick(); f.render();
    await sleep(90); f.tui.handleTerminalInput("l");
    await sleep(90); assert.equal(f.view().closed, false, "real paging extends the visible idle window");
    f.tui.handleTerminalInput("j");
    await sleep(90); assert.equal(f.view().closed, false, "real selection also extends the idle window");
    f.tui.handleTerminalInput("\r"); assert.equal(await pending, "allow"); f.cleanup();
  }
  for (const owner of ["sessionManager", "ui"]) {
    const f = fixture(Renderer), manager = owner === "sessionManager" ? {} : undefined;
    const settings = (signal, timeout = 600) => ({ signal, timeout, sessionManager: manager,
      wrapper: owner === "sessionManager" ? { ...f.ui } : f.ui });
    const abortA = new AbortController();
    const a = f.start("A", settings(abortA.signal));
    await tick(); f.render();
    const b = f.start("B", settings(undefined));
    await sleep(120); assert.equal(f.calls.length, 1);
    abortA.abort(); assert.equal(await a, "cancelled");
    await tick(); assert.equal(f.calls.length, 2);
    assert.ok(f.view().remainingMs() > 500, "queued B receives a fresh visible idle window");
    f.render(); f.choose("Allow"); assert.equal(await b, "allow"); f.cleanup();

    const held = fixture(Renderer), firstAbort = new AbortController();
    const first = held.start("held A", { signal: firstAbort.signal });
    await tick(); held.render();
    const expired = held.start("never mounted B", { timeout: 30 });
    held.tui.handleTerminalInput("l");
    assert.equal(await expired, "timeout");
    assert.equal(held.calls.length, 1, "expired waiter cannot dismiss an active dialog");
    firstAbort.abort(); assert.equal(await first, "cancelled"); held.cleanup();
  }
  {
    const f = fixture(Renderer, { "tui.select.confirm": "ctrl+y", "tui.select.cancel": "q", "tui.select.down": "ctrl+n" });
    const pending = f.start();
    await tick(); assert.ok(f.render(120).join("\n").includes("ctrl+y"));
    f.tui.handleTerminalInput("\x0e"); assert.equal(f.view().selected, 1);
    f.tui.handleTerminalInput("\r"); assert.equal(f.calls[0].completions, 0, "Enter cannot confirm after remapping");
    f.tui.handleTerminalInput("\x19"); assert.equal(await pending, "allow");
    const cancel = f.start(); await tick(); f.render(); f.tui.handleTerminalInput("q");
    assert.equal(await cancel, "cancelled"); f.cleanup();
  }
  {
    const abort = new AbortController();
    const f = fixture(Renderer, {}, () => abort.abort());
    const pending = f.start("cancelled before mounting", { signal: abort.signal });
    assert.equal(await pending, "cancelled"); await tick(); f.cleanup();
  }
}
console.log("approval UI tests passed: inline focus/cleanup, h/l pager, full resized evidence, idle refresh and injected bindings in both compositors");
