import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { getKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { requestApproval } from "../approval.ts";
import { approvalFixture, collectApprovalEvidence, escapedEvidence } from "./approval-fixture.mjs";

// Synthetic memory-only UI. No files, captures, config or providers.
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const longArguments = `${"synthetic 界 é 👩‍💻  ".repeat(180)}\nTAIL_AFTER_2000`;
function fixture({ rows = 24 } = {}) {
  const views = [], completions = [];
  const ctx = { mode: "tui", hasUI: true, ui: { theme: { fg: (_color, text) => text },
    select: () => assert.fail("no extra navigation menu items") } };
  const adapter = approvalFixture(ctx, (_done, view) => {
    views.push(view);
    if (rows !== 24) { view.tui.terminal.rows = rows; view.render(80); }
  });
  ctx.ui.custom = async (...args) => { const result = await adapter(...args); completions.push(result); return result; };
  return { views, completions, ui: ctx.ui, view: () => views.at(-1),
    start(label = "synthetic tool", { signal, timeout = 1000, sessionManager, args = longArguments, wrapper = ctx.ui } = {}) {
      return requestApproval({ ...ctx, signal, sessionManager, ui: wrapper }, label, "synthetic decline", timeout, args);
    },
    choose(choice) { const view = views.at(-1); if (choice === "Allow") view.handleInput("j"); view.handleInput("\r"); },
  };
}

for (const choice of ["Allow", "Block"]) {
  const f = fixture(), pending = f.start();
  await tick();
  const rendered = f.view().render(80).map(stripTerminalSequences);
  assert.ok(rendered.some((line) => line.includes("→ Block")));
  assert.ok(rendered.some((line) => line.trim() === "Allow"));
  assert.ok(!rendered.some((line) => /View details|Next page|Previous page|Back$/u.test(line)));
  assert.ok(rendered.at(-3).includes("h/l"));
  f.choose(choice);
  assert.equal(await pending, choice.toLowerCase());
  assert.equal(getEventListeners(f.view().signal, "abort").length, 0);
  assert.equal(f.completions.length, 1);
  f.view().handleInput("j"); f.view().handleInput("\r");
  assert.equal(f.completions.length, 1, "stale input cannot complete another dialog");
}
for (const args of ["small synthetic argument", longArguments, "  leading and trailing  ",
  "\\n\x1b[31m\x00\u202e\ud800\tEND"]) {
  const f = fixture(), pending = f.start("synthetic tool", { args });
  await tick();
  const evidence = collectApprovalEvidence(f.view());
  assert.ok(evidence.endsWith(escapedEvidence(args).replaceAll("\n", "")), "all evidence stays inspectable, including whitespace and Unicode");
  assert.ok(!/[\x00-\x09\x0b-\x1f\u202e]/u.test(evidence));
  for (const width of [12, 24, 40, 80, 120]) {
    const lines = f.view().render(width);
    assert.ok(lines.length <= 18);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `no overflow at width ${width}`);
    assert.ok(collectApprovalEvidence(f.view(), undefined, width).endsWith(escapedEvidence(args).replaceAll("\n", "")), "resizing preserves all exact evidence");
  }
  f.choose("Allow");
  assert.equal(await pending, "allow");
}
{
  const f = fixture(), pending = f.start();
  await tick();
  const view = f.view();
  view.handleInput("j");
  assert.equal(view.selected, 1);
  view.handleInput("l"); assert.equal(view.page, 1); assert.equal(view.selected, 1);
  view.handleInput("h"); assert.equal(view.page, 0); assert.equal(view.selected, 1);
  view.handleInput("\x1b[C"); assert.equal(view.page, 1);
  view.handleInput("\x1b[D"); assert.equal(view.page, 0);
  view.handleInput("k"); assert.equal(view.selected, 0);
  view.handleInput("\r"); assert.equal(await pending, "block");
}
// The default is a 30-second idle window, not a fixed total deadline.
{
  const f = fixture(), pending = f.start("synthetic", { timeout: undefined });
  await tick();
  f.view().handleInput("\x1b");
  assert.equal(await pending, "cancelled");
  const ctx = { mode: "tui", hasUI: true, ui: f.ui };
  const defaultPending = requestApproval(ctx, "synthetic", "declined", undefined, "synthetic arguments");
  await tick();
  assert.ok(f.view().remainingMs() > 29_000);
  f.view().handleInput("\x1b");
  assert.equal(await defaultPending, "cancelled");
}
{
  const f = fixture(), pending = f.start("synthetic", { timeout: 140 });
  await tick();
  for (const key of ["l", "j", "h", "x"]) {
    await sleep(80);
    f.view().handleInput(key);
    assert.equal(f.view().closed, false, "each real keypress refreshes inactivity even after the original deadline");
    assert.ok(f.view().remainingMs() > 110);
  }
  f.view().handleInput("\r");
  assert.equal(await pending, "allow");
}
{
  const f = fixture(), pending = f.start("synthetic", { timeout: 120 });
  await tick();
  for (let i = 0; i < 4; i++) {
    await sleep(25);
    f.view().render(80);
    f.view().invalidate();
    f.view().handleInput("\x1b[106;1:3u"); // Kitty key release.
    f.view().handleInput("\x1b[6;20R"); // Cursor-position report.
  }
  assert.equal(await pending, "timeout", "rendering and protocol reports cannot keep an AFK request alive");
}
{
  const f = fixture(), pending = f.start("synthetic", { timeout: 30 });
  await tick();
  const until = performance.now() + 40;
  while (performance.now() < until) { /* Hold timer delivery to test deadline precedence. */ }
  f.view().handleInput("x");
  assert.equal(await pending, "timeout", "a key arriving after expiry cannot resurrect approval");
}
for (const [width, rows] of [[1, 24], [8, 24], [80, 2]]) {
  const f = fixture({ rows }), pending = f.start();
  await tick(); f.view().render(width); f.choose("Allow");
  assert.equal(await pending, "block", "unreadable controls cannot authorize");
}
{
  const ctx = { mode: "tui", hasUI: true, ui: { custom(factory) {
    return new Promise((resolve) => {
      const view = factory({ terminal: { columns: 80, rows: 24 }, requestRender() {} },
        { fg: (_color, text) => text }, getKeybindings(), resolve);
      view.handleInput("j"); view.handleInput("\r");
    });
  } } };
  assert.equal(await requestApproval(ctx, "synthetic", "declined"), "block", "Allow cannot authorize before the first render");
}
{
  const f = fixture(), pending = f.start();
  await tick();
  f.view().handleInput("j");
  f.view().tui.terminal.columns = 8;
  f.view().tui.terminal.rows = 2;
  f.view().handleInput("\r");
  assert.equal(await pending, "block", "a resize before the next render cannot authorize unreadable controls");
}
{
  const f = fixture(), abort = new AbortController();
  const pending = f.start("synthetic", { signal: abort.signal });
  await tick(); abort.abort(); f.choose("Allow");
  assert.equal(await pending, "cancelled", "turn cancellation wins over Allow");
}
for (const mode of ["rpc", "json", "print"]) {
  assert.equal(await requestApproval({ mode, hasUI: true, ui: { custom: () => assert.fail("non-TUI must not prompt") } }, "synthetic", "declined"), "unavailable");
}
assert.equal(await requestApproval({ mode: "tui", hasUI: false }, "synthetic", "declined"), "unavailable");
{
  const abort = new AbortController(); abort.abort();
  assert.equal(await requestApproval({ mode: "tui", hasUI: true, signal: abort.signal,
    ui: { custom: () => assert.fail("pre-aborted requests must not prompt") } }, "synthetic", "declined"), "cancelled");
}
assert.equal(await requestApproval({ mode: "tui", hasUI: true,
  ui: { custom: async () => { throw new Error("synthetic UI failure"); } } }, "synthetic", "declined", 20), "unavailable");
assert.equal(await requestApproval({ mode: "tui", hasUI: true,
  ui: { custom: async () => new Promise(() => {}) } }, "synthetic", "declined", 20), "timeout", "broken UI remains bounded");

for (const owner of ["sessionManager", "ui"]) {
  const f = fixture(), manager = owner === "sessionManager" ? {} : undefined;
  const settings = (signal, timeout) => ({ signal, timeout, sessionManager: manager,
    wrapper: owner === "sessionManager" ? { ...f.ui } : f.ui });
  const abortA = new AbortController();
  const a = f.start("A", settings(abortA.signal, 600));
  await tick();
  const b = f.start("B", settings(undefined, 400));
  await sleep(150); f.view().handleInput("l");
  assert.equal(f.views.length, 1);
  abortA.abort(); assert.equal(await a, "cancelled");
  await tick();
  assert.equal(f.views.length, 2);
  assert.ok(f.view().remainingMs() > 350, "B starts a fresh visible idle window after queue waiting");
  f.choose("Allow"); assert.equal(await b, "allow");

  for (const outcome of ["cancelled", "timeout"]) {
    const held = fixture(), abortFirst = new AbortController(), abortQueued = new AbortController();
    const shared = owner === "sessionManager" ? {} : undefined;
    const options = (signal, timeout = 1000) => ({ signal, timeout, sessionManager: shared,
      wrapper: owner === "sessionManager" ? { ...held.ui } : held.ui });
    const first = held.start("held A", options(abortFirst.signal));
    await tick();
    const queued = held.start("never opened B", options(abortQueued.signal, outcome === "timeout" ? 20 : 1000));
    held.view().handleInput("l");
    if (outcome === "cancelled") abortQueued.abort();
    assert.equal(await queued, outcome, "active-dialog keys cannot extend a queued request");
    const later = held.start("later C", options(undefined));
    await tick(); assert.equal(held.views.length, 1, "released waiter cannot let C overtake A");
    abortFirst.abort(); assert.equal(await first, "cancelled");
    await tick(); assert.equal(held.views.length, 2);
    assert.ok(collectApprovalEvidence(held.view()).includes("later C"));
    held.choose("Allow"); assert.equal(await later, "allow");
  }
}
{
  const f = fixture(), abort = new AbortController();
  const first = f.start("held A", { signal: abort.signal });
  await tick();
  const queued = f.start("expired B", { timeout: 25 });
  const until = performance.now() + 40;
  while (performance.now() < until) { /* Delay timers while the queue deadline expires. */ }
  abort.abort();
  assert.equal(await first, "cancelled");
  assert.equal(await queued, "timeout");
  assert.equal(f.views.length, 1, "an elapsed queue deadline cannot be renewed before its timer callback runs");
}
{
  const left = fixture(), right = fixture();
  const a = left.start("independent A"), b = right.start("independent B");
  await tick(); assert.equal(left.views.length, 1); assert.equal(right.views.length, 1);
  right.choose("Allow"); assert.equal(await b, "allow");
  left.choose("Block"); assert.equal(await a, "block");
}
console.log("approval tests passed: inline Pi controls, direct h/l paging, exact inert evidence, resettable idle timeout and session-local queues");
