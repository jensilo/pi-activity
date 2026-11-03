import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, parseKey, SelectList, truncateToWidth, visibleWidth,
  type Component, type TUI } from "@earendil-works/pi-tui";

export type Approval = "allow" | "block" | "timeout" | "cancelled" | "unavailable";

// Inline dialogs share the editor area. Serialize them within each session.
const approvalTurns = new WeakMap<object, Promise<void>>();
function reserveApproval(owner: object): { ready: Promise<void>; release(): void } {
  const ready = approvalTurns.get(owner) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const tail = ready.then(() => held);
  approvalTurns.set(owner, tail);
  void tail.then(() => { if (approvalTurns.get(owner) === tail) approvalTurns.delete(owner); });
  return { ready, release };
}

async function waitForApprovalTurn(ready: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  let onAbort!: () => void;
  const aborted = new Promise<false>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([ready.then(() => true), aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

// Escape terminal commands and invisible direction controls, not their evidence.
function inertText(text: string): string {
  return text.replace(/[\\\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff\ud800-\udfff]/gu,
    (char) => char === "\\" ? "\\\\" : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function evidenceLines(text: string, width: number): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return text.split("\n").flatMap((line) => {
    const parts: string[] = [];
    let part = "", columns = 0;
    const append = (segment: string): void => {
      const size = visibleWidth(segment);
      if (size > width) {
        for (const char of [...segment].map((c) => `\\u{${c.codePointAt(0)!.toString(16)}}`).join("")) append(char);
        return;
      }
      if (columns + size > width) {
        parts.push(part);
        part = "";
        columns = 0;
      }
      part += segment;
      columns += size;
    };
    for (const { segment } of segmenter.segment(line)) append(segment);
    parts.push(part);
    return parts;
  });
}

/** Compact inline evidence pager with Pi's standard selection control. */
class ApprovalView implements Component {
  private readonly choices: SelectList;
  private readonly refresh: ReturnType<typeof setInterval>;
  private readonly onAbort: () => void;
  private closed = false;
  private reviewable = false;
  private width = -1;
  private lines: string[] = [];
  private page = 0;
  private pageSize = 1;
  private selected = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly done: (result: Approval) => void,
    private readonly text: string,
    private readonly signal: AbortSignal,
    private readonly abortResult: () => Approval,
    private readonly remainingMs: () => number,
    private readonly resetIdle: () => void,
  ) {
    this.choices = new SelectList([{ value: "block", label: "Block" }, { value: "allow", label: "Allow" }], 2, {
      selectedPrefix: (s) => theme.fg("accent", s), selectedText: (s) => theme.fg("accent", s),
      description: (s) => theme.fg("muted", s), scrollInfo: (s) => theme.fg("dim", s), noMatch: (s) => theme.fg("dim", s),
    });
    this.refresh = setInterval(() => this.tui.requestRender(), 1000);
    this.onAbort = () => this.finish(this.abortResult());
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted) this.onAbort();
  }

  private finish(result: Approval): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.refresh);
    this.signal.removeEventListener("abort", this.onAbort);
    this.done(result);
  }

  dispose(): void { this.finish("cancelled"); }
  invalidate(): void { this.width = -1; this.choices.invalidate(); }

  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.min(18, this.tui.terminal.rows - 6));
    this.reviewable = width >= 12 && height >= 9;
    if (!width || !height) return [];
    const clip = (text: string) => truncateToWidth(text, width, "");
    const controls = this.choices.render(width).map(clip);
    if (!this.reviewable) return [clip("Resize terminal to approve"), ...controls].slice(0, height);
    const bodyWidth = width - 2;
    if (this.width !== bodyWidth) {
      this.lines = evidenceLines(this.text, bodyWidth);
      this.width = bodyWidth;
    }
    this.pageSize = Math.max(1, height - 8);
    const pageCount = Math.max(1, Math.ceil(this.lines.length / this.pageSize));
    this.page = Math.max(0, Math.min(this.page, pageCount - 1));
    const body = this.lines.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize);
    const seconds = Math.max(0, Math.ceil(this.remainingMs() / 1000));
    const binding = (action: string): string => this.keys.getKeys(action).join("/") || "unbound";
    const border = this.theme.fg("accent", "─".repeat(width));
    return [border, clip(this.theme.fg("warning", `Activity approval needed · ${seconds}s idle`)),
      ...body.map((line) => ` ${line} `), "", ...controls,
      clip(this.theme.fg("dim", `Page ${this.page + 1}/${pageCount} · h/l ←/→ page · j/k ${binding("tui.select.up")}/${binding("tui.select.down")} choose`)),
      clip(this.theme.fg("dim", `${binding("tui.select.confirm")} confirm · ${binding("tui.select.cancel")} cancel · Home/End first/last`)), border];
  }

  handleInput(data: string): void {
    if (this.closed || !data || isKeyRelease(data)) return;
    // Only real keys or pasted text keep approval alive. Terminal reports,
    // redraws, resize notifications and key-release packets are not activity.
    if (parseKey(data) === undefined && data.startsWith("\x1b") && !data.startsWith("\x1b[200~")) return;
    if (this.signal.aborted || this.remainingMs() <= 0) { this.finish(this.abortResult()); return; }
    this.resetIdle();
    if (this.keys.matches(data, "tui.select.cancel") || this.keys.matches(data, "app.interrupt") || matchesKey(data, Key.ctrl("c"))) {
      this.finish("cancelled");
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      const room = this.tui.terminal.columns >= 12 && this.tui.terminal.rows >= 15;
      this.finish(this.selected === 1 && this.reviewable && room ? "allow" : "block");
    } else if (matchesKey(data, "h") || matchesKey(data, Key.left)) {
      this.page = Math.max(0, this.page - 1);
    } else if (matchesKey(data, "l") || matchesKey(data, Key.right)) {
      this.page = Math.min(Math.max(0, Math.ceil(this.lines.length / this.pageSize) - 1), this.page + 1);
    } else if (matchesKey(data, Key.home)) {
      this.page = 0;
    } else if (matchesKey(data, Key.end)) {
      this.page = Math.max(0, Math.ceil(this.lines.length / this.pageSize) - 1);
    } else if (matchesKey(data, "k") || this.keys.matches(data, "tui.select.up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.choices.setSelectedIndex(this.selected);
    } else if (matchesKey(data, "j") || this.keys.matches(data, "tui.select.down")) {
      this.selected = Math.min(1, this.selected + 1);
      this.choices.setSelectedIndex(this.selected);
    }
    if (!this.closed) this.tui.requestRender();
  }
}

/** Ephemeral exact-call approval; timeoutMs bounds queue wait and visible inactivity. */
export async function requestApproval(
  ctx: ExtensionContext,
  label: string,
  reason: string,
  timeoutMs = 30_000,
  fullArguments?: string,
): Promise<Approval> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return "unavailable";
  const timer = new AbortController();
  let expiresAt = performance.now() + timeoutMs;
  let timeout = setTimeout(() => timer.abort(), timeoutMs);
  const turn = reserveApproval(ctx.sessionManager ?? ctx.ui);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timer.signal]) : timer.signal;
  const abortResult = (): Approval => ctx.signal?.aborted ? "cancelled" : "timeout";
  const resetIdle = (): void => {
    clearTimeout(timeout);
    expiresAt = performance.now() + timeoutMs;
    timeout = setTimeout(() => timer.abort(), timeoutMs);
  };
  let view: ApprovalView | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (!await waitForApprovalTurn(turn.ready, signal) || signal.aborted || performance.now() >= expiresAt) return abortResult();
    // Waiting siblings cannot reset their queue budget with another dialog's keys.
    resetIdle();
    const evidence = `Tool call:\n${inertText(label)}\nReview:\n${inertText(reason)}${fullArguments === undefined ? "" : `\nFull arguments (backslashes and controls escaped):\n${inertText(fullArguments)}`}`;
    const aborted = new Promise<Approval>((resolve) => {
      onAbort = () => resolve(abortResult());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const result = await Promise.race([ctx.ui.custom<Approval>((tui, theme, keys, done) => {
      view = new ApprovalView(tui, theme, keys, done, evidence, signal, abortResult,
        () => expiresAt - performance.now(), resetIdle);
      return view;
    }), aborted]);
    if (signal.aborted || performance.now() >= expiresAt) return abortResult();
    return result === "allow" || result === "block" || result === "timeout" || result === "cancelled" ? result : "cancelled";
  } catch {
    return ctx.signal?.aborted ? "cancelled" : timer.signal.aborted ? "timeout" : "unavailable";
  } finally {
    clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    view?.dispose();
    turn.release();
  }
}
