import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  sliceByColumn,
  stripTerminalSequences,
  TuiMainScreen,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  formatFooter,
  formatJudgeStatus,
  layoutActivityStatus,
} from "../display.ts";
import { ActivityObservations } from "../observations.ts";
import { ActivityPanel } from "../panel.ts";
import { nativeToolInfo } from "./nine-head-fixtures.mjs";

// Test-only installed host internals. No AgentSession, config, auth, real terminal,
// activity captures, files, or providers are opened or created by these fixtures.
const require = createRequire(import.meta.url);
const host =
  process.env.PI_GLOBAL ??
  dirname(dirname(require.resolve("@earendil-works/pi-coding-agent")));
const { FooterComponent } = await import(
  pathToFileURL(join(host, "dist/modes/interactive/components/footer.js")).href
);
const { Theme, setThemeInstance } = await import(
  pathToFileURL(join(host, "dist/modes/interactive/theme/theme.js")).href
);
const theme = new Theme(
  {
    dim: 244,
    muted: 244,
    accent: 39,
    warning: 214,
    error: 196,
    text: 255,
    thinkingXhigh: 141,
  },
  { selectedBg: 0 },
  "256color",
  { name: "synthetic-host-ui" },
);
setThemeInstance(theme);
const plain = stripTerminalSequences;

function footerFixture(statuses) {
  const session = {
    state: {},
    getContextUsage: () => ({ contextWindow: 1000, percent: 0 }),
    sessionManager: {
      getCwd: () => "/synthetic/host-ui",
      getSessionName: () => undefined,
      getEntryCount: () => 0,
      getSessionId: () => "synthetic-host-ui",
      getLeafId: () => "synthetic-leaf",
      getEntries: () => [],
    },
  };
  const footerData = {
    getGitBranch: () => undefined,
    getAvailableProviderCount: () => 0,
    getExtensionStatuses: () => statuses,
  };
  return new FooterComponent(session, footerData);
}

const empty = new ActivityObservations({ now: () => 1000 });
empty.beginTurn();
const left = formatFooter(empty.view(), {
  auto: true,
  readOnly: false,
  remoteReadOnly: false,
});
const right = formatJudgeStatus(
  [{ id: "synthetic-judge", startedAt: 1000, expiresAt: 16000, retries: 0 }],
  2000,
).replace(/^⚖️/, "⚖️ judge");
assert.equal(right, "⚖️ judge 1s elapsed · 14s left");

// Historical mechanism: the layout helper pads correctly, but the installed
// FooterComponent normalizes status whitespace before merging and truncating it.
{
  const width = 110;
  const status = layoutActivityStatus(
    theme.fg("muted", left),
    theme.fg("accent", right),
    width,
  );
  assert.equal(visibleWidth(status), width);
  assert.ok(plain(status).startsWith(left));
  assert.ok(plain(status).endsWith(right));
  assert.match(plain(status), / {2,}/);
  const footer = footerFixture(new Map([["activity-judge", status]]));
  const rendered = footer.render(width).map(plain);
  assert.equal(
    rendered.length,
    3,
    "installed host adds one merged extension-status line",
  );
  assert.equal(
    rendered[2],
    `${left} ${right}`,
    "host sanitation removes the right-alignment padding",
  );
  assert.ok(visibleWidth(rendered[2]) < width);
  assert.equal(
    visibleWidth(rendered[2].slice(0, rendered[2].indexOf("⚖️"))),
    visibleWidth(left) + 1,
  );
  footer.dispose();
}

// Alphabetically earlier statuses consume the same shared line. Both activity
// counters and deadline fit alone, but the actual host clips the deadline after
// prepending the unrelated status, regardless of insertion order.
{
  const width = 110;
  const status = layoutActivityStatus(left, right, width);
  const other = `synthetic busy:${"x".repeat(55)}`;
  const footer = footerFixture(
    new Map([
      ["activity-judge", status],
      ["a-synthetic-status", other],
    ]),
  );
  const alone = plain(
    footerFixture(new Map([["activity-judge", status]]))
      .render(width)
      .at(-1),
  );
  assert.ok(alone.includes("14s left"));
  const actual = plain(footer.render(width).at(-1));
  assert.equal(
    actual,
    plain(
      truncateToWidth(
        `${other} ${left} ${right}`,
        width,
        theme.fg("dim", "..."),
      ),
    ),
  );
  assert.ok(
    actual.startsWith(other),
    "installed host sorts status keys rather than preserving insertion order",
  );
  assert.ok(
    !actual.includes("14s left"),
    "shared status truncation loses the live deadline",
  );
  assert.ok(actual.endsWith("..."));
  assert.ok(visibleWidth(actual) <= width);
  footer.dispose();
}

let now = 1000;
const observations = new ActivityObservations({
  now: () => now,
  maxHistory: 80,
});
observations.beginTurn();
for (let n = 0; n < 50; n++) {
  now++;
  const event = {
    toolCallId: `synthetic-host-${n}`,
    toolName: "bash",
    input: { command: `printf synthetic-${n} 界 é 👩‍💻` },
  };
  observations.gate(event, "allow", {
    info: nativeToolInfo("bash"),
    reason: "base:local-read",
    gateMs: 10,
    explanation: "Synthetic host layout fixture.",
  });
  observations.toolResult({ ...event, isError: false }, nativeToolInfo("bash"));
}
const view = observations.view();
const baseline = structuredClone(view);
const overlayOptions = { anchor: "center", width: 110, maxHeight: "80%" };

function overlayFixture(initialTab, options = overlayOptions) {
  const writes = [];
  const terminal = {
    columns: 40,
    rows: 8,
    write(data) {
      writes.push(data);
    },
    hideCursor() {},
    showCursor() {},
    start() {
      assert.fail("synthetic host fixture must never start a terminal");
    },
    stop() {
      assert.fail("synthetic host fixture must never stop a real terminal");
    },
  };
  const tui = new TuiMainScreen(terminal);
  // Include synthetic scrollback so overlay bounds must be screen-relative,
  // rather than accidentally correct only when all base lines fit on screen.
  tui.addChild({
    render(width) {
      return Array.from({ length: terminal.rows + 7 }, () => ".".repeat(width));
    },
    invalidate() {},
  });
  let panelLines,
    panelWidth,
    closes = 0;
  const panel = new ActivityPanel(
    tui,
    theme,
    () => {
      closes++;
    },
    () => view,
    { initialTab },
  );
  const component = {
    render(width) {
      panelWidth = width;
      panelLines = panel.render(width);
      return panelLines;
    },
    invalidate() {
      panel.invalidate();
    },
    handleInput(data) {
      panel.handleInput(data);
    },
  };
  const handle = tui.showOverlay(component, options);
  return {
    terminal,
    tui,
    panel,
    writes,
    closes: () => closes,
    render(columns, rows) {
      terminal.columns = columns;
      terminal.rows = rows;
      tui.renderNow();
      const state = tui.captureRenderState();
      const bounds = tui.renderedOverlayLayouts.find(
        (layout) => layout.entry.component === component,
      );
      assert.ok(
        bounds,
        "actual host compositor must lay out the mounted overlay",
      );
      return { state, bounds, panelLines: panelLines.map(plain), panelWidth };
    },
    dispose() {
      handle.hide();
      panel.dispose();
      // Cancel render requests without starting/stopping the terminal. Queued
      // nextTick callbacks see stopped=true and cannot create a render timer.
      tui.stopped = true;
      tui.cancelRenderTimer();
    },
  };
}

const boundsEvidence = [];
function checkComposed(
  fixture,
  columns,
  rows,
  expectedWidth = Math.min(110, columns),
) {
  const { state, bounds, panelLines, panelWidth } = fixture.render(
    columns,
    rows,
  );
  const height = Math.floor(rows * 0.8);
  assert.equal(
    panelWidth,
    expectedWidth,
    "host supplies current clamped width to the component",
  );
  assert.equal(bounds.width, expectedWidth);
  assert.equal(bounds.height, height);
  assert.equal(
    panelLines.length,
    height,
    "all panel chrome fits before host maxHeight clipping",
  );
  assert.equal(bounds.row, Math.floor((rows - height) / 2));
  assert.equal(bounds.col, Math.floor((columns - expectedWidth) / 2));
  assert.ok(bounds.col >= 0 && bounds.col + bounds.width <= columns);
  assert.ok(bounds.row >= 0 && bounds.row + bounds.height <= rows);
  assert.ok(panelLines.every((line) => visibleWidth(line) === expectedWidth));
  assert.ok(panelLines[0].startsWith("╭") && panelLines[0].endsWith("╮"));
  assert.ok(panelLines[0].includes("Activity"));
  assert.ok(panelLines[1].includes("["), "tab chrome is retained");
  assert.ok(panelLines[2].startsWith("├") && panelLines[2].endsWith("┤"));
  assert.ok(
    panelLines.at(-2).includes("q"),
    "close hint survives host height cap",
  );
  assert.ok(
    panelLines.at(-1).startsWith("╰") && panelLines.at(-1).endsWith("╯"),
    "bottom border survives host compositor",
  );
  assert.equal(state.previousViewportTop, 7);
  const screen = state.previousLines.slice(-rows).map(plain);
  assert.equal(screen.length, rows);
  assert.ok(
    screen.every((line) => visibleWidth(line) <= columns),
    "actual composed terminal lines are bounded",
  );
  for (let row = 0; row < rows; row++) {
    if (row < bounds.row || row >= bounds.row + height) {
      assert.equal(screen[row], ".".repeat(columns));
    } else {
      const actual = screen[row];
      assert.equal(
        plain(sliceByColumn(actual, bounds.col, expectedWidth)),
        panelLines[row - bounds.row],
      );
      assert.equal(
        plain(sliceByColumn(actual, 0, bounds.col)),
        ".".repeat(bounds.col),
      );
      assert.equal(
        plain(sliceByColumn(actual, bounds.col + expectedWidth, columns)),
        ".".repeat(columns - bounds.col - expectedWidth),
      );
    }
  }
  assert.ok(
    fixture.writes.some((data) => data.includes("\x1b[?2026h")),
    "actual regular TUI renderer wrote only to the synthetic sink",
  );
  return {
    width: bounds.width,
    height: bounds.height,
    col: bounds.col,
    row: bounds.row,
  };
}

// One interaction survives width and height changes, plus scroll and tab input.
for (const initialTab of ["overview", "history", "diagnostics"]) {
  const fixture = overlayFixture(initialTab);
  try {
    for (const rows of [8, 24, 60]) {
      // Stay at the previous 24-column width for a height-only resize first.
      if (rows !== 8) checkComposed(fixture, 24, rows);
      for (const columns of [40, 180, 24]) {
        const bounds = checkComposed(fixture, columns, rows);
        if (initialTab === "overview")
          boundsEvidence.push(
            `${columns}x${rows}:${bounds.width}x${bounds.height}@${bounds.col},${bounds.row}`,
          );
        for (const key of ["G", "g", "g", "\t", "\u001b[Z"]) {
          fixture.panel.handleInput(key);
          checkComposed(fixture, columns, rows);
        }
        assert.equal(fixture.closes(), 0);
      }
    }
  } finally {
    fixture.dispose();
  }
}

// Previous callback mistake: clamping once at creation stores numeric 36. The
// compositor cannot infer the intended preferred width after the terminal widens.
{
  const fixture = overlayFixture("overview", {
    ...overlayOptions,
    width: Math.min(110, 40 - 4),
  });
  try {
    checkComposed(fixture, 40, 24, 36);
    checkComposed(fixture, 180, 24, 36);
    checkComposed(fixture, 24, 24, 24);
  } finally {
    fixture.dispose();
  }
}

// No fixed horizontal margins: even a one-column terminal keeps the close hint
// on screen rather than declaring an offscreen overlay rectangle.
const tinyEvidence = [];
{
  const fixture = overlayFixture("overview");
  try {
    for (const columns of [4, 3, 2, 1]) {
      const { state, bounds, panelLines, panelWidth } = fixture.render(
        columns,
        8,
      );
      assert.equal(panelWidth, columns);
      assert.equal(bounds.col, 0);
      assert.equal(bounds.width, columns);
      assert.equal(bounds.height, 6);
      assert.ok(panelLines.every((line) => visibleWidth(line) <= columns));
      assert.ok(panelLines.at(-1).includes("q"));
      assert.ok(
        state.previousLines.every((line) => visibleWidth(line) <= columns),
      );
      assert.ok(
        bounds.col + bounds.width <= columns,
        "tiny overlay bounds stay entirely on screen",
      );
      tinyEvidence.push(`${columns}:col=${bounds.col},width=${bounds.width}`);
    }
  } finally {
    fixture.dispose();
  }
}
assert.deepEqual(
  view,
  baseline,
  "actual host composition and all panel navigation are read-only",
);
console.log(
  "host-ui tests passed: installed FooterComponent collapses alignment and clips deadline behind other statuses; actual TuiMainScreen overlays retain bounded chrome through resize, scrolling and tabs",
);
console.log(
  `host-ui bounds: ${boundsEvidence.join("; ")}; fixed numeric36 remains36 at180`,
);
console.log(`host-ui tiny-terminal bounds: ${tinyEvidence.join("; ")}`);
