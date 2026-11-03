import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ActivityObservations } from "../observations.ts";
import { ActivityPanel } from "../panel.ts";
import { nativeToolInfo } from "./nine-head-fixtures.mjs";

// Synthetic retained data only. Never capture or inspect real activity.
let now = 1000;
const observations = new ActivityObservations({
  now: () => now,
  maxHistory: 80,
  previewChars: 180,
});
observations.beginTurn();
for (let n = 0; n < 70; n++) {
  now++;
  const event = {
    toolCallId: `synthetic-${n}`,
    toolName: "bash",
    input: {
      command: `printf fixture-${n} token=SYNTHETIC_SECRET ${"界 é 👩‍💻 ".repeat(25)}`,
    },
  };
  observations.gate(event, n % 7 === 0 ? "block" : "allow", {
    info: nativeToolInfo("bash"),
    reason: n % 7 === 0 ? "read-only" : "base:local-read",
    gateMs: 10,
    explanation: `Synthetic explanation ${n}: Authorization: Bearer SYNTHETIC_SECRET ${"retained unicode 界 é 👩‍💻 ".repeat(10)}`,
  });
  if (n % 7)
    observations.toolResult(
      {
        ...event,
        isError: n % 11 === 0,
        details: { output: "NEVER_CAPTURE_OUTPUT" },
      },
      nativeToolInfo("bash"),
    );
}
const mcp = {
  toolCallId: "synthetic-mcp",
  toolName: "catalog",
  input: { payload: "NEVER_CAPTURE_MCP_ARGUMENTS" },
};
observations.gate(mcp, "allow", {
  info: {
    sourceInfo: { source: "mcp", serverName: "fixture-server" },
    namespace: { name: "fixture-group" },
  },
});
observations.executionEnd({ ...mcp, isError: true });
const view = observations.view();
view.omitted = 9;
view.telemetry.guardWait = { wallMs: 150, coverage: "partial" };
view.selected.telemetry.guardWait = { wallMs: 75, coverage: "complete" };
view.guardWaitPending = 2;
const baseline = structuredClone(view);
let styles = 0,
  renders = 0;
const theme = {
  fg(color, text) {
    styles++;
    return `\u001b[${color === "warning" ? 33 : color === "accent" ? 36 : 90}m${text}\u001b[39m`;
  },
};
function fixture(options = {}, rows = 24, customView = view) {
  const tui = {
    terminal: { rows },
    requestRender() {
      renders++;
    },
  };
  let closes = 0;
  const panel = new ActivityPanel(
    tui,
    theme,
    () => {
      closes++;
    },
    () => customView,
    {
      modes: () => ({ auto: true, readOnly: true, remoteReadOnly: false }),
      droppedRecords: () => ({ actions: 3, metadata: 1 }),
      ...options,
    },
  );
  return { panel, tui, closes: () => closes };
}
const state = (panel) => panel.states[panel.tab];
const plain = (lines) => lines.map(stripTerminalSequences);
const snapshot = (panel, width = 80) => plain(panel.render(width));

// Exact height cap includes ALL chrome, even when there is no room for content.
for (const rows of [0, ...Array.from({ length: 24 }, (_, n) => n + 1), 60]) {
  for (const width of [0, 1, 8, 24, 40, 80, 110])
    for (const initialTab of ["overview", "history", "diagnostics"]) {
      const { panel } = fixture({ initialTab }, rows);
      const max = Math.floor(rows * 0.8);
      const check = () => {
        const lines = snapshot(panel, width);
        assert.ok(
          lines.length <= max,
          `height overflow ${width}x${rows} ${initialTab}`,
        );
        assert.ok(
          lines.every((line) => visibleWidth(line) <= width),
          `width overflow ${width}x${rows} ${initialTab}`,
        );
        if (!width || !max) assert.deepEqual(lines, []);
        else {
          assert.equal(
            lines.length,
            max,
            "fixed card height prevents jumping as tabs change",
          );
          const footer = lines.at(width >= 8 && max >= 6 ? -2 : -1);
          assert.ok(
            footer.includes("q"),
            `footer missing ${width}x${rows} ${initialTab}`,
          );
        }
        return lines;
      };
      const original = check();
      for (const key of [
        "G",
        "\u0002",
        "\u0006",
        "\u0004",
        "\u0015",
        "\u001b[5~",
        "\u001b[6~",
        "g",
        "g",
        "j",
        "k",
        "\r",
      ]) {
        panel.handleInput(key);
        check();
      }
      if (width >= 8 && max >= 6) {
        const current = check();
        assert.equal(current[0], original[0], "title never scrolls");
        assert.equal(current[1], original[1], "tabs never scroll");
        assert.ok(
          current.at(-1).endsWith("╯"),
          "bottom border remains visible",
        );
      }
    }
}

// The normal landing view exposes actual wait without scrolling past speed metrics.
for (const width of [80, 110]) {
  const { panel } = fixture();
  const landing = snapshot(panel, width).join("\n");
  assert.ok(landing.includes("Safety"));
  assert.ok(landing.includes("Actual guard wait"));
  assert.ok(landing.includes("Session:150ms (partial)"));
}

// Every movement binding uses the bounded viewport, not terminal height.
for (const initialTab of ["overview", "diagnostics"]) {
  const { panel } = fixture({ initialTab });
  snapshot(panel);
  const s = state(panel),
    page = s.scroll.viewportHeight,
    max = Math.max(0, s.lines.length - page);
  for (const key of ["j", "\u001b[B"]) {
    const before = s.scroll.scrollTop;
    panel.handleInput(key);
    assert.equal(s.scroll.scrollTop, before + 1);
  }
  for (const key of ["k", "\u001b[A"]) {
    const before = s.scroll.scrollTop;
    panel.handleInput(key);
    assert.equal(s.scroll.scrollTop, before - 1);
  }
  panel.handleInput("\u0004");
  assert.equal(s.scroll.scrollTop, Math.min(max, Math.floor(page / 2)));
  panel.handleInput("\u0015");
  assert.equal(s.scroll.scrollTop, 0);
  panel.handleInput("\u0006");
  assert.equal(s.scroll.scrollTop, Math.min(max, page));
  panel.handleInput("\u0002");
  assert.equal(s.scroll.scrollTop, 0);
  panel.handleInput("\u001b[6~");
  assert.equal(s.scroll.scrollTop, Math.min(max, page));
  panel.handleInput("\u001b[5~");
  assert.equal(s.scroll.scrollTop, 0);
  panel.handleInput("G");
  assert.equal(s.scroll.scrollTop, Math.max(0, s.lines.length - page));
  panel.handleInput("g");
  assert.ok(s.scroll.scrollTop > 0, "one g is not top");
  panel.handleInput("g");
  assert.equal(s.scroll.scrollTop, 0);
  panel.handleInput("\u001b[F");
  assert.equal(s.scroll.scrollTop, Math.max(0, s.lines.length - page));
  panel.handleInput("\u001b[H");
  assert.equal(s.scroll.scrollTop, 0);
}

// History page bindings move in body lines, with selection following the cursor.
{
  const { panel } = fixture({ initialTab: "history", scope: "session" });
  snapshot(panel, 110);
  const s = state(panel),
    page = s.scroll.viewportHeight;
  for (const [down, up, distance] of [
    ["\u0004", "\u0015", Math.floor(page / 2)],
    ["\u0006", "\u0002", page],
    ["\u001b[6~", "\u001b[5~", page],
  ]) {
    panel.handleInput(down);
    assert.equal(s.scroll.scrollTop, distance);
    panel.handleInput(up);
    assert.equal(s.scroll.scrollTop, 0);
  }
  const selected = panel.selected;
  panel.handleInput("\u001b[B");
  snapshot(panel, 110);
  assert.notEqual(panel.selected, selected);
  panel.handleInput("\u001b[A");
  snapshot(panel, 110);
  assert.equal(panel.selected, selected);
}

// Tab switching restores each tab's own viewport, including reverse cycling.
{
  const { panel } = fixture();
  snapshot(panel);
  panel.handleInput("j");
  panel.handleInput("j");
  const overviewTop = state(panel).scroll.scrollTop;
  for (const [key, expected] of [
    ["l", "history"],
    ["\t", "diagnostics"],
    ["\u001b[Z", "history"],
    ["\u001b[D", "overview"],
    ["h", "diagnostics"],
    ["\u001b[C", "overview"],
  ]) {
    panel.handleInput(key);
    snapshot(panel);
    assert.equal(panel.tab, expected);
  }
  assert.equal(state(panel).scroll.scrollTop, overviewTop);
  panel.handleInput("h");
  snapshot(panel);
  panel.handleInput("\u0006");
  const diagnosticsTop = state(panel).scroll.scrollTop;
  panel.handleInput("l");
  snapshot(panel);
  panel.handleInput("h");
  snapshot(panel);
  assert.equal(state(panel).scroll.scrollTop, diagnosticsTop);
  panel.handleInput("g");
  panel.handleInput("l");
  panel.handleInput("h");
  panel.handleInput("g");
  assert.equal(
    state(panel).scroll.scrollTop,
    diagnosticsTop,
    "gg prefix does not carry across tabs",
  );
}

// Enter expands only the selected history entry and never dismisses the card.
{
  const { panel, closes } = fixture({
    initialTab: "history",
    scope: "session",
  });
  snapshot(panel, 110);
  let content = plain(state(panel).lines).join("\n");
  assert.ok(
    content.indexOf("catalog") < content.indexOf("bash"),
    "newest first",
  );
  assert.ok(
    !content.includes("Synthetic explanation"),
    "collapsed entries are compact",
  );
  assert.ok(content.includes("execution unknown"));
  assert.ok(content.includes("9 older entries omitted"));
  assert.ok(content.includes("Coverage incomplete"));
  panel.handleInput("\r");
  snapshot(panel, 110);
  content = plain(state(panel).lines).join("\n");
  assert.ok(content.includes("MCP server:fixture-server"));
  assert.ok(content.includes("namespace:fixture-group"));
  assert.ok(content.includes("execution:unknown"));
  assert.equal(closes(), 0);
  const key = panel.selected;
  panel.handleInput("\r");
  snapshot(panel, 110);
  assert.equal(panel.expanded.has(key), false);
  panel.handleInput("j");
  snapshot(panel, 110);
  assert.notEqual(panel.selected, key, "j selects the next compact entry");
  panel.handleInput("\r");
  snapshot(panel, 24);
  const selected = panel.selected;
  const s = state(panel);
  const start = s.owners.indexOf(selected);
  let end = start;
  while (s.owners[end + 1] === selected) end++;
  assert.ok(
    end - start > 20,
    "long Unicode retained previews wrap, not silently clip",
  );
  const seen = new Set();
  for (let i = 0; i <= end - start; i++) {
    snapshot(panel, 24).forEach((line) => seen.add(line));
    panel.handleInput("j");
  }
  assert.ok(
    [...seen].some((line) => line.includes("界")),
    "wrapped preview rows are reachable by line scrolling",
  );
  assert.ok(
    [...seen].some((line) => line.includes("truncated:")) &&
      [...seen].some((line) => line.includes("omitted")),
    "retention disclosure is reachable across wrapped rows",
  );
  assert.ok(![...seen].join("\n").includes("SYNTHETIC_SECRET"));
  assert.equal(closes(), 0);
  snapshot(panel);
  panel.handleInput("G");
  snapshot(panel);
  assert.equal(
    state(panel).scroll.scrollTop,
    state(panel).lines.length - state(panel).scroll.viewportHeight,
  );
  panel.handleInput("g");
  panel.handleInput("g");
  snapshot(panel);
  assert.equal(state(panel).scroll.scrollTop, 0);
}

// Filter scope and stable selection while new observations arrive.
{
  const custom = structuredClone(view);
  custom.history[0].turn = custom.selected.id - 1;
  const { panel } = fixture(
    { initialTab: "history", category: "sh", scope: "turn" },
    24,
    custom,
  );
  snapshot(panel);
  assert.ok(!plain(state(panel).lines).join("\n").includes("catalog"));
  const selected = panel.selected;
  custom.history.push({
    ...custom.history[1],
    id: "later-synthetic",
    startedAt: 9000,
  });
  snapshot(panel);
  assert.equal(
    panel.selected,
    selected,
    "incoming data must not steal selection",
  );
  panel.handleInput("\r");
  snapshot(panel);
  assert.ok(panel.expanded.has(selected));
  custom.history = custom.history.slice(0, 1);
  snapshot(panel);
  assert.equal(
    panel.expanded.size,
    0,
    "expansion state is bounded to retained entries",
  );
}

// Incoming entries and height-only resize keep a retained selection visible.
{
  const custom = structuredClone(view);
  custom.coverage = "complete";
  custom.unresolved = 0;
  custom.omitted = 0;
  custom.history = Array.from({ length: 20 }, (_, n) => ({
    id: `visibility-${n}`,
    turn: custom.selected.id,
    startedAt: n,
    tool: "bash",
    category: "sh",
    status: "blocked",
    executionConfirmed: false,
    counted: false,
    user: false,
    nested: false,
  }));
  const { panel, tui } = fixture({ initialTab: "history" }, 24, custom);
  snapshot(panel, 110);
  for (let n = 0; n < 11; n++) panel.handleInput("j");
  const selected = panel.selected;
  custom.history.push({
    ...custom.history[0],
    id: "newest-visibility",
    startedAt: 99,
  });
  const checkVisible = () => {
    const rendered = snapshot(panel, 110);
    const s = state(panel);
    assert.equal(panel.selected, selected);
    assert.ok(
      panel.cursor >= s.scroll.scrollTop &&
        panel.cursor < s.scroll.scrollTop + s.scroll.viewportHeight,
    );
    assert.ok(
      rendered.some((line) => line.includes("> + [agent] bash blocked")),
      "retained selection stays on screen",
    );
  };
  checkVisible();
  tui.terminal.rows = 20;
  checkVisible();
}

// Resize preserves the logical row at the viewport top; invalidation reapplies theme.
{
  const { panel, tui } = fixture({ initialTab: "diagnostics" }, 24);
  snapshot(panel, 110);
  panel.handleInput("\u0006");
  snapshot(panel, 110);
  const s = state(panel);
  const logicalText = s.logical[s.sources[s.scroll.scrollTop]].text;
  snapshot(panel, 40);
  assert.equal(s.logical[s.sources[s.scroll.scrollTop]].text, logicalText);
  tui.terminal.rows = 8;
  assert.equal(snapshot(panel, 40).length, Math.floor(8 * 0.8));
  tui.terminal.rows = 60;
  assert.equal(snapshot(panel, 40).length, 48);
  const before = styles;
  panel.invalidate();
  snapshot(panel, 40);
  assert.ok(styles > before);
}

// Kitty printables work, release events do not, and close is idempotent.
for (const key of ["q", "\u001b", "\u0003", "\u001b[113u"]) {
  const { panel, closes } = fixture();
  snapshot(panel);
  panel.handleInput("\r");
  assert.equal(closes(), 0);
  panel.handleInput("\u001b[106u");
  assert.equal(state(panel).scroll.scrollTop, 1);
  panel.handleInput(key);
  panel.handleInput(key);
  assert.equal(closes(), 1);
}
{
  const { panel, closes } = fixture();
  snapshot(panel);
  panel.handleInput("\u001b[113;1:3u");
  assert.equal(closes(), 0);
  panel.dispose();
  panel.handleInput("q");
  assert.equal(closes(), 0);
}
assert.deepEqual(
  view,
  baseline,
  "all navigation and rendering must be read-only",
);
assert.ok(styles > 0 && renders > 0);
const privacy = plain(
  fixture({ initialTab: "history" }).panel.render(110),
).join("\n");
for (const forbidden of [
  "SYNTHETIC_SECRET",
  "NEVER_CAPTURE_OUTPUT",
  "NEVER_CAPTURE_MCP_ARGUMENTS",
])
  assert.ok(!privacy.includes(forbidden));
console.log(
  "panel tests passed: exact dimensions, fixed chrome, tabs, keys, wrapped Unicode, expansion, resize and privacy",
);
