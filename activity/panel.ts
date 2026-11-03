import {
  decodeKittyPrintable,
  isKeyRelease,
  Key,
  matchesKey,
  ScrollView,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import {
  renderDiagnostics,
  renderHistoryRow,
  renderOverview,
  type DisplayTheme,
} from "./display.js";
import type { Modes, ObservationView } from "./observations.js";
import { ACTIVITY_VERSION } from "./version.js";

export type ActivityTab = "overview" | "history" | "diagnostics";
export type ActivityPanelOptions = {
  initialTab?: ActivityTab;
  category?: "all" | "sh" | "files" | "mcp";
  scope?: "turn" | "session";
  modes?: () => Modes;
  droppedRecords?: () => { actions: number; metadata: number };
};
type PanelTUI = { terminal?: { rows?: number }; requestRender(): void };
type LogicalRow = { text: string; owner?: string };
type TabState = {
  scroll: ScrollView;
  logical: LogicalRow[];
  lines: string[];
  sources: number[];
  starts: number[];
  owners: (string | undefined)[];
  width: number;
};
const tabs: ActivityTab[] = ["overview", "history", "diagnostics"];
const labels = {
  overview: "Overview",
  history: "History",
  diagnostics: "Diagnostics",
};
const size = (n: number): number =>
  Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
const clamp = (n: number, max: number): number =>
  Math.max(0, Math.min(n, Math.max(0, max)));

/** One read-only interaction. No policy setters, runtime arguments, timers or private imports. */
export class ActivityPanel implements Component {
  private tab: ActivityTab;
  private readonly states: Record<ActivityTab, TabState>;
  private selected?: string;
  private readonly expanded = new Set<string>();
  private cursor = 0;
  private cursorOffset = 0;
  private headerCursor?: number;
  private lastWidth = 80;
  private pendingG = false;
  private closed = false;

  constructor(
    private readonly tui: PanelTUI,
    private readonly theme: DisplayTheme,
    private readonly done: () => void,
    private readonly getView: () => ObservationView,
    private readonly options: ActivityPanelOptions = {},
  ) {
    this.tab = options.initialTab ?? "overview";
    this.states = Object.fromEntries(
      tabs.map((tab) => {
        const state: TabState = {
          logical: [],
          lines: [],
          sources: [],
          starts: [],
          owners: [],
          width: -1,
          scroll: new ScrollView(
            { render: () => state.lines, invalidate() {} },
            { scrollbar: "hidden", overscroll: "contain" },
          ),
        };
        return [tab, state];
      }),
    ) as Record<ActivityTab, TabState>;
  }

  invalidate(): void {
    // Theme-dependent strings are regenerated on every render; keep navigation state.
    for (const state of Object.values(this.states)) state.scroll.invalidate();
  }

  dispose(): void {
    this.closed = true;
  }

  private history(view: ObservationView): LogicalRow[] {
    const scope = this.options.scope ?? "turn",
      category = this.options.category ?? "all";
    const occurrences = new Map<string, number>();
    const entries = view.history
      .map((call) => {
        const base = `${call.turn}:${call.id}:${call.startedAt}`;
        const occurrence = occurrences.get(base) ?? 0;
        occurrences.set(base, occurrence + 1);
        return { call, key: `${base}:${occurrence}` };
      })
      .filter(
        ({ call }) =>
          (scope === "session" || call.turn === view.selected.id) &&
          (category === "all" || call.category === category),
      )
      .reverse();
    const retained = new Set(entries.map(({ key }) => key));
    for (const key of this.expanded)
      if (!retained.has(key)) this.expanded.delete(key);
    if (!this.selected || !retained.has(this.selected)) {
      this.selected = entries[0]?.key;
      this.cursorOffset = 0;
      this.headerCursor = undefined;
    }
    const rows: LogicalRow[] = [
      {
        text: `Newest first · ${scope} · ${category} · ${entries.length} matching retained entries`,
      },
      {
        text: this.theme.fg(
          "muted",
          "Sanitized histories remain private session data.",
        ),
      },
    ];
    if (view.coverage === "incomplete" || view.unresolved)
      rows.push({
        text: this.theme.fg(
          "warning",
          `Coverage ${view.coverage} · unresolved:${view.unresolved}; unobserved activity is not inferred.`,
        ),
      });
    if (view.omitted)
      rows.push({
        text: this.theme.fg(
          "warning",
          `${view.omitted} older entries omitted from retained history (all categories).`,
        ),
      });
    if (!entries.length)
      rows.push({ text: "No observed activity matching this filter." });
    for (const { call, key } of entries)
      for (const text of renderHistoryRow(call, {
        width: this.states.history.width,
        theme: this.theme,
        selected: key === this.selected,
        expanded: this.expanded.has(key),
        wrap: false,
      }))
        rows.push({ text, owner: key });
    return rows;
  }

  private layout(
    width: number,
    height: number,
  ): { bordered: boolean; inner: number; body: number } {
    const bordered = width >= 8 && height >= 6;
    const chrome = bordered ? 5 : height >= 2 ? 2 : height;
    return {
      bordered,
      inner: Math.max(0, width - (bordered ? 2 : 0)),
      body: Math.max(0, height - chrome),
    };
  }

  private body(width: number, height: number): TabState {
    const state = this.states[this.tab],
      previousWidth = state.width;
    const oldTop = state.scroll.scrollTop,
      oldSource = state.sources[oldTop];
    const oldText =
      oldSource === undefined ? undefined : state.logical[oldSource]?.text;
    const oldOwner =
      oldSource === undefined ? undefined : state.logical[oldSource]?.owner;
    const oldFragment =
      oldSource === undefined ? 0 : oldTop - state.starts[oldSource];
    state.width = width;
    const view = this.getView();
    const options = {
      width,
      theme: this.theme,
      modes: this.options.modes?.(),
      droppedRecords: this.options.droppedRecords?.(),
      wrap: false,
    };
    const logical: LogicalRow[] =
      this.tab === "history"
        ? this.history(view)
        : (this.tab === "overview"
            ? renderOverview(view, options)
            : renderDiagnostics(view, options)
          ).map((text) => ({ text }));
    state.logical = logical;
    state.lines = [];
    state.sources = [];
    state.starts = [];
    state.owners = [];
    logical.forEach((row, source) => {
      state.starts[source] = state.lines.length;
      const parts = width ? wrapTextWithAnsi(row.text, width) : [""];
      for (const part of parts.length ? parts : [""]) {
        state.lines.push(truncateToWidth(part, width, ""));
        state.sources.push(source);
        state.owners.push(row.owner);
      }
    });
    state.scroll.updateLayout(state.lines.length, height, () =>
      this.tui.requestRender(),
    );
    if (
      previousWidth >= 0 &&
      previousWidth !== width &&
      oldSource !== undefined
    ) {
      // Anchor the same logical row on resize, rather than the old wrapped row number.
      const match =
        logical[oldSource]?.text === oldText &&
        logical[oldSource]?.owner === oldOwner
          ? oldSource
          : logical.findIndex(
              (row) => row.text === oldText && row.owner === oldOwner,
            );
      const source = match >= 0 ? match : clamp(oldSource, logical.length - 1);
      const start = state.starts[source] ?? 0;
      const end = state.starts[source + 1] ?? state.lines.length;
      state.scroll.scrollTo(
        start + Math.min(oldFragment, Math.max(0, end - start - 1)),
      );
    }
    if (this.tab === "history") {
      const start = state.owners.indexOf(this.selected);
      if (this.headerCursor !== undefined)
        this.cursor = clamp(this.headerCursor, Math.max(0, start - 1));
      else if (this.selected && start >= 0) {
        let end = start;
        while (state.owners[end + 1] === this.selected) end++;
        this.cursor = start + Math.min(this.cursorOffset, end - start);
      } else this.cursor = clamp(this.cursor, state.lines.length - 1);
      if (height > 0) this.keepCursorVisible(state);
    }
    return state;
  }

  render(totalWidth: number): string[] {
    this.lastWidth = size(totalWidth);
    const width = this.lastWidth,
      height = Math.floor(size(this.tui.terminal?.rows ?? 24) * 0.8);
    if (!width || !height) return [];
    const { bordered, inner, body } = this.layout(width, height);
    const state = this.body(inner, body);
    const fit = (text: string, available: number) =>
      truncateToWidth(text, available, "");
    const pad = (text: string, available: number) => {
      const clipped = fit(text, available);
      return (
        clipped + " ".repeat(Math.max(0, available - visibleWidth(clipped)))
      );
    };
    const border = (text: string) => this.theme.fg("muted", text);
    const row = (text: string) =>
      bordered
        ? border("│") + pad(text, inner) + border("│")
        : pad(text, width);
    const tabText = tabs
      .map((tab) => {
        const label = inner >= 40 ? labels[tab] : labels[tab][0];
        return this.theme.fg(
          tab === this.tab ? "accent" : "dim",
          tab === this.tab ? `[${label}]` : label,
        );
      })
      .join("  ");
    const before = state.scroll.scrollTop,
      after = Math.max(0, state.lines.length - before - body);
    const hints =
      inner < 8
        ? "q"
        : inner < 24
          ? "q close · h/l tabs"
          : inner < 64
            ? `q close · h/l tabs · j/k scroll${this.tab === "history" ? " · Enter" : ""}`
            : `q/Esc close · h/l/Tab tabs · j/k · ^d/u · ^f/b · gg/G${this.tab === "history" ? " · Enter expand" : ""}`;
    const footer = this.theme.fg(
      "dim",
      `${hints}${inner >= 40 ? ` · ↑${before} ↓${after}` : ""}`,
    );
    if (height === 1) return [row(footer)];
    const content = state.scroll.render(inner).slice(before, before + body);
    while (content.length < body) content.push("");
    if (!bordered)
      return [
        row(inner >= 24 ? `Activity · ${tabText}` : tabText),
        ...content.map(row),
        row(footer),
      ];
    const title = fit(
      this.theme.fg("accent", ` Activity v${ACTIVITY_VERSION} `),
      inner,
    );
    return [
      border("╭") +
        title +
        border("─".repeat(Math.max(0, inner - visibleWidth(title))) + "╮"),
      row(tabText),
      border(`├${"─".repeat(inner)}┤`),
      ...content.map(row),
      row(footer),
      border(`╰${"─".repeat(inner)}╯`),
    ];
  }

  private syncCursor(state: TabState, target: number): void {
    this.cursor = clamp(target, state.lines.length - 1);
    const owner = state.owners[this.cursor];
    this.headerCursor = owner ? undefined : this.cursor;
    if (owner) {
      this.selected = owner;
      this.cursorOffset = this.cursor - state.owners.indexOf(owner);
    }
  }

  private keepCursorVisible(state: TabState): void {
    if (this.cursor < state.scroll.scrollTop)
      state.scroll.scrollTo(this.cursor);
    else if (
      this.cursor >=
      state.scroll.scrollTop + state.scroll.viewportHeight
    )
      state.scroll.scrollTo(
        this.cursor - Math.max(0, state.scroll.viewportHeight - 1),
      );
  }

  handleInput(data: string): void {
    if (this.closed || isKeyRelease(data)) return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      matchesKey(data, "q")
    ) {
      this.closed = true;
      this.done();
      return;
    }
    const printable = decodeKittyPrintable(data) ?? data;
    const previousG = this.pendingG;
    this.pendingG = false;
    let direction = 0;
    if (
      matchesKey(data, "h") ||
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.shift(Key.tab))
    )
      direction = -1;
    else if (
      matchesKey(data, "l") ||
      matchesKey(data, Key.right) ||
      matchesKey(data, Key.tab)
    )
      direction = 1;
    if (direction) {
      this.tab =
        tabs[(tabs.indexOf(this.tab) + direction + tabs.length) % tabs.length];
      this.tui.requestRender();
      return;
    }
    // Refresh before movement, including a terminal resize or new observation.
    this.render(this.lastWidth);
    const state = this.states[this.tab];
    let delta = 0,
      page = false;
    if (
      printable === "G" ||
      matchesKey(data, Key.shift("g")) ||
      matchesKey(data, Key.end)
    ) {
      state.scroll.scrollToEnd();
      if (this.tab === "history")
        this.syncCursor(state, state.lines.length - 1);
    } else if (matchesKey(data, "g") || matchesKey(data, Key.home)) {
      if (previousG || matchesKey(data, Key.home)) {
        state.scroll.scrollToStart();
        if (this.tab === "history") {
          this.selected = state.owners.find((owner) => owner !== undefined);
          this.syncCursor(state, 0);
        }
      } else {
        this.pendingG = true;
        return;
      }
    } else if (matchesKey(data, "j") || matchesKey(data, Key.down)) delta = 1;
    else if (matchesKey(data, "k") || matchesKey(data, Key.up)) delta = -1;
    else if (matchesKey(data, Key.ctrl("d"))) {
      delta = Math.max(1, Math.floor(state.scroll.viewportHeight / 2));
      page = true;
    } else if (matchesKey(data, Key.ctrl("u"))) {
      delta = -Math.max(1, Math.floor(state.scroll.viewportHeight / 2));
      page = true;
    } else if (
      matchesKey(data, Key.ctrl("f")) ||
      matchesKey(data, Key.pageDown)
    ) {
      delta = Math.max(1, state.scroll.viewportHeight);
      page = true;
    } else if (
      matchesKey(data, Key.ctrl("b")) ||
      matchesKey(data, Key.pageUp)
    ) {
      delta = -Math.max(1, state.scroll.viewportHeight);
      page = true;
    } else if (
      matchesKey(data, Key.enter) &&
      this.tab === "history" &&
      this.selected
    ) {
      if (this.expanded.has(this.selected)) this.expanded.delete(this.selected);
      else this.expanded.add(this.selected);
      this.cursorOffset = 0;
      this.headerCursor = undefined;
      this.render(this.lastWidth);
      this.keepCursorVisible(state);
    } else return;
    if (delta) {
      if (this.tab === "history") {
        this.syncCursor(state, this.cursor + delta);
        if (page) state.scroll.scrollBy(delta);
        this.keepCursorVisible(state);
      } else state.scroll.scrollBy(delta);
    }
    this.tui.requestRender();
  }
}
