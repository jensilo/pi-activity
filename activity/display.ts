import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { HEADS } from "./policy.js";
import { decisionReasonCode, latencyStats, type CallObservation, type Counts, type Latency, type LiveJudge, type ModelUsage, type Modes, type ObservationView, type Telemetry } from "./observations.js";
import { ACTIVITY_VERSION } from "./version.js";

export type DisplayTheme = {
  fg(color: "accent" | "muted" | "dim" | "warning" | "success" | "error", text: string): string;
  bg?(color: "selectedBg", text: string): string;
  bold?(text: string): string;
};
const plain: DisplayTheme = { fg: (_color, text) => text };
const columns = (width: number): number => Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 80;
const fit = (text: string, width: number): string => truncateToWidth(text, columns(width), "");
const percent = (sum: number, samples: number, missing = "N/A"): string => samples ? `${Math.round(sum / samples * 1000) / 10}%` : missing;
function pad(text: string, width: number): string { return text + " ".repeat(Math.max(0, width - visibleWidth(text))); }
export function formatModes(modes: Modes): string {
  return [modes.auto ? "🛡️" : "", modes.readOnly ? "🔏" : "", modes.remoteReadOnly ? "🌐" : ""].filter(Boolean).join(" ");
}
export function formatCounts(turn: Counts, total: Counts): string {
  return `files:${turn.files}(${total.files}) sh:${turn.sh}(${total.sh}) MCP:${turn.mcp}(${total.mcp}) blk:${turn.blocked}(${total.blocked})`;
}
export function formatFooter(view: ObservationView, modes: Modes): string {
  const prefix = formatModes(modes);
  return `${prefix ? prefix + " " : ""}· ${formatCounts(view.selected.counts, view.totals)}`;
}
/** Put the clock first: clipping a long trigger must never hide the live deadline. */
export function formatJudgeStatus(live: readonly LiveJudge[], now = Date.now()): string {
  if (!live.length) return "";
  const selected = [...live].sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.startedAt - b.startedAt)[0];
  const elapsed = `${Math.max(0, Math.floor((now - selected.startedAt) / 1000))}s elapsed`;
  const left = selected.expiresAt === undefined ? "" : ` · ${Math.max(0, Math.ceil((selected.expiresAt - now) / 1000))}s left`;
  return `⚖️ ${elapsed}${left}${selected.retries ? ` · retry ${selected.retries}` : ""}${live.length > 1 ? ` · ×${live.length}` : ""}`;
}
/** Footer owners can reserve space for timing before activity, model names, or utilities. */
export function prioritizeJudgeStatus(judge: string, activity: string, width: number): string {
  const available = columns(width);
  if (!judge) return fit(activity, available);
  if (visibleWidth(judge) >= available) return fit(judge, available);
  const remaining = available - visibleWidth(judge) - 3;
  return remaining > 0 && activity ? `${judge} · ${fit(activity, remaining)}` : judge;
}
/** Counters stay left; the live clock stays right. Clip the reason before either. */
export function layoutActivityStatus(activity: string, judge: string, width: number, reason = ""): string {
  const available = columns(width);
  if (!judge) return fit(activity, available);
  const clockWidth = visibleWidth(judge);
  if (clockWidth >= available) return fit(judge, available);
  const left = fit(activity, Math.max(0, available - clockWidth - 3));
  const rightRoom = Math.max(0, available - visibleWidth(left) - (left ? 3 : 0));
  const right = truncateToWidth(`${judge}${reason ? ` · ${reason}` : ""}`, rightRoom, "…");
  if (!left) return right;
  return left + " ".repeat(Math.max(3, available - visibleWidth(left) - visibleWidth(right))) + right;
}
export function supportBar(score: number | undefined, width = 10, theme: DisplayTheme = plain): string {
  if (score === undefined || !Number.isFinite(score) || score < 0 || score > 1) return "N/A";
  const size = Math.max(0, Math.min(20, columns(width))), filled = Math.round(score * size);
  return theme.fg("accent", "█".repeat(filled)) + theme.fg("dim", "░".repeat(size - filled));
}
function table(rows: readonly string[][], width: number, theme: DisplayTheme): string[] {
  const n = rows[0]?.length ?? 0;
  if (!n) return [];
  const sizes = Array.from({ length: n }, (_, index) => Math.max(...rows.map((row) => visibleWidth(row[index] ?? ""))));
  if (sizes.reduce((sum, size) => sum + size, 0) + (n - 1) * 2 <= width) {
    return rows.map((row, index) => (index === 0 ? theme.fg("muted", row.map((cell, c) => pad(cell, sizes[c])).join("  ").trimEnd())
      : row.map((cell, c) => pad(cell, sizes[c])).join("  ").trimEnd()));
  }
  return rows.slice(1).map((row) => `${row[0]}: ${row.slice(1).map((cell, index) => `${rows[0][index + 1]}=${cell}`).join(" ")}`);
}
function requestCount(count: number, known: boolean): string { return known ? `${count} exact` : `≥${count} observed`; }
function latencyRow(label: string, latency?: Latency, missing = "N/A"): string[] {
  const stats = latencyStats(latency), ms = (value?: number) => value === undefined ? missing : String(Math.round(value));
  return [label, String(stats.count), String(stats.sampleCount), ms(stats.meanMs), ms(stats.medianMs), ms(stats.p95Ms)];
}
function modelRows(judge?: ModelUsage, summary?: ModelUsage, missing = "unknown"): string[][] {
  return [["Models", "Configured", "Actual requests"], ...([ ["Judge", judge], ["Summary", summary] ] as const).map(([name, usage]) =>
    [name, usage?.configured ?? missing, Object.entries(usage?.actual ?? {}).map(([id, count]) => `${id}:${count}`).join(", ") || missing])];
}
function classifierRows(t: Telemetry): string[][] {
  return [["Input", "OK", "Fail", "Skip", "Off"], ...(["shell", "file", "action"] as const).map((input) => {
    const stats = t.classifier.byInput[input];
    return [input, String(stats.success), String(stats.failure), String(stats.skipped), String(stats.disabled)];
  })];
}
export type DashboardOptions = { width?: number; theme?: DisplayTheme; details?: boolean; modes?: Modes; now?: number };
/** Stateless lines remain compatible with notifications and RPC clients. */
export function renderDashboard(view: ObservationView, options: DashboardOptions = {}): string[] {
  const width = columns(options.width ?? 80);
  return dashboardLines(view, options).map((line) => fit(line, width));
}
function dashboardLines(view: ObservationView, options: DashboardOptions, diagnostics = false): string[] {
  const width = columns(options.width ?? 80), theme = options.theme ?? plain;
  const heading = (text: string) => theme.fg("accent", theme.bold?.(text) ?? text);
  const missing = diagnostics ? "unavailable" : 0, missingText = diagnostics ? "unavailable" : "N/A";
  const ratio = (sum: number, samples: number) => percent(sum, samples, missingText);
  const lines: string[] = [heading(`Activity v${ACTIVITY_VERSION}`)];
  const live = formatJudgeStatus(view.liveJudges, options.now);
  if (live) lines.push(theme.fg("warning", live));
  if (options.modes) lines.push(formatModes(options.modes) || theme.fg("dim", "Guards off"));
  if (view.coverage === "incomplete") lines.push(theme.fg("warning", "Coverage incomplete"));
  lines.push(`Turn ${view.selected.id}${view.active ? " (active)" : " (latest)"} · session`);
  lines.push(...table([
    ["Activity", "Turn", "Session"],
    ["files", String(view.selected.counts.files), String(view.totals.files)],
    ["sh", String(view.selected.counts.sh), String(view.totals.sh)],
    ["MCP", String(view.selected.counts.mcp), String(view.totals.mcp)],
    ["blocked", String(view.selected.counts.blocked), String(view.totals.blocked)],
    ["errors", String(view.selected.telemetry.activity?.errors ?? missing), String(view.telemetry.activity?.errors ?? missing)],
  ], width, theme));
  const activityLines = lines.splice(0);
  if (!diagnostics) lines.push(...activityLines);
  const t = view.telemetry, selected = view.selected.telemetry;
  lines.push("", heading("Errors / final blocks · session"));
  lines.push(...table([["Category", "Errors", "Blocks"], ...(["files", "sh", "mcp", "other", "wrapper"] as const).map((category) =>
    [category, String(t.activity?.errorsByCategory[category] ?? missing), String(t.activity?.blocksByCategory[category] ?? missing)])], width, theme));
  const reasons = Object.entries(t.activity?.blocksByReason ?? {});
  if (reasons.length) lines.push(...table([["Block reason", "Count"], ...reasons.map(([reason, count]) => [reason, String(count)])], width, theme));
  if (t.activity?.otherBlockReasons) lines.push(`Other block reasons:${t.activity.otherBlockReasons}`);
  lines.push("", heading("Classifier · session"));
  if (!t.classifier.enabled) lines.push(theme.fg("dim", diagnostics ? "Classifier currently disabled; retained observations follow." : `${missingText} (disabled)`));
  if (t.classifier.enabled || diagnostics) lines.push(...table(classifierRows(t), width, theme));
  lines.push("", heading("Latency ms · observed measurements"));
  lines.push(...table([["Work", "Count", "Samples", "Mean", "Median", "p95"],
    latencyRow("Inference", t.classifier.inference, missingText), latencyRow("End-to-end", t.classifier.endToEnd, missingText),
    latencyRow("Review", t.judge.latency, missingText), latencyRow("Gate", t.gate, missingText), latencyRow("Approval", t.approvals.latency, missingText),
    latencyRow("Summary", t.summaries.latency, missingText)], width, theme));
  lines.push(theme.fg("dim", "Median/p95: bounded samples; mean: all measurements."));
  lines.push("", heading("Judge / summaries · session"));
  lines.push(...table([
    ["Work", "Started", "Requests", "Retries", "ms"],
    ["Judge", String(t.judge.started), requestCount(t.judge.requests, t.judge.requestsKnown), String(t.judge.retries), String(Math.round(t.judge.wallMs))],
    ["Summary", missingText, requestCount(t.summaries.requests, t.summaries.requestsKnown), missingText, String(Math.round(t.summaries.wallMs))],
  ], width, theme));
  lines.push(...table(modelRows(t.judge.models, t.summaries.models, diagnostics ? "unavailable" : "unknown"), width, theme));
  if (t.judge.models?.omitted || t.summaries.models?.omitted) lines.push(`Model receipts omitted judge:${t.judge.models?.omitted ?? 0} summary:${t.summaries.models?.omitted ?? 0}`);
  lines.push(theme.fg("dim", "Requests: exact with provider hooks; otherwise observed lower bounds."));
  lines.push(`Judge allow:${t.judge.outcomes.allow} deny:${t.judge.outcomes.deny} timeout:${t.judge.outcomes.timeout} cancelled:${t.judge.outcomes.cancelled}`);
  lines.push(`unavailable:${t.judge.outcomes.unavailable} interrupted:${t.judge.outcomes.interrupted} fallback requests:${t.judge.fallbacks}`);
  lines.push(`Summary generated:${t.summaries.generated} cached:${t.summaries.cached} shared:${t.summaries.shared} restored:${t.summaries.restored}`);
  lines.push(`failed:${t.summaries.failed} unused:${t.summaries.unused}`);
  lines.push(`Approval prompts shown:${t.approvals.prompts ?? missing} · effective overrides:${t.approvals.effectiveOverrides}`);
  lines.push(`Approval choices ${Object.entries(t.approvals.choices).map(([choice, count]) => `${choice}:${count}`).join(" ")}`);
  if (options.details) {
    if (diagnostics) lines.push("", heading("Activity / coverage"), ...activityLines);
    lines.push("", heading("Turn telemetry"));
    lines.push(`Judge started:${selected.judge.started} requests:${requestCount(selected.judge.requests, selected.judge.requestsKnown)} retries:${selected.judge.retries}`);
    lines.push(`Summary requests:${requestCount(selected.summaries.requests, selected.summaries.requestsKnown)} cached:${selected.summaries.cached} shared:${selected.summaries.shared} restored:${selected.summaries.restored}`);
    lines.push(...table(classifierRows(selected), width, theme));
    lines.push("", heading("Nine independent heads · raw / applied"));
    lines.push("Selected-label support scores, not accuracy or calibrated confidence.");
    if (!t.classifier.enabled && !diagnostics) lines.push(`${missingText} (classifier disabled)`);
    else for (const head of HEADS) {
      const h = t.classifier.heads[head], support = h.samples ? h.supportSum / h.samples : undefined;
      const appliedLabels = h.appliedLabelSamples ?? (h.appliedPositive === undefined ? 0 : h.applied);
      lines.push(head);
      lines.push(`  raw n:${h.samples} +:${h.positive} (${ratio(h.positive, h.samples)}) -:${h.samples - h.positive} (${ratio(h.samples - h.positive, h.samples)})`);
      lines.push(`  mean positive P(+):${h.positiveProbabilitySum === undefined ? missingText : ratio(h.positiveProbabilitySum, h.positiveProbabilitySamples ?? 0)} n:${h.positiveProbabilitySamples ?? 0} support:${ratio(h.supportSum, h.samples)} ${support === undefined ? missingText : supportBar(support, Math.min(10, Math.max(0, width - 60)), theme)}`);
      lines.push(`  applied n:${h.applied}${appliedLabels !== h.applied ? ` known labels:${appliedLabels}` : ""} +:${h.appliedPositive ?? missingText} (${h.appliedPositive === undefined ? missingText : ratio(h.appliedPositive, appliedLabels)}) -:${h.appliedPositive === undefined ? missingText : appliedLabels - h.appliedPositive} (${h.appliedPositive === undefined ? missingText : ratio(appliedLabels - h.appliedPositive, appliedLabels)})`);
      lines.push(`  applied mean positive P(+):${h.appliedPositiveProbabilitySum === undefined ? missingText : ratio(h.appliedPositiveProbabilitySum, h.appliedPositive ?? 0)} support:${ratio(h.appliedSupportSum, h.applied)}`);
    }
    lines.push("", heading("Approval choices"));
    lines.push(Object.entries(t.approvals.choices).map(([choice, count]) => `${choice}:${count}`).join(" "));
    if (!diagnostics) lines.push("", heading("Recent history"), ...renderHistory(view, { width, theme, scope: "turn", maxEntries: 8 }));
  } else lines.push(theme.fg("dim", "Details: independent heads, turn telemetry, history."));
  return lines;
}
export type HistoryOptions = {
  width?: number; theme?: DisplayTheme; scope?: "turn" | "session";
  category?: "all" | "sh" | "files" | "mcp"; maxEntries?: number;
};
function historyLabel(call: CallObservation): string {
  const origin = call.user ? "user" : call.nested ? "nested" : "agent";
  return `[${origin}] ${call.tool} ${call.status}${call.reportedError && call.status === "unknown" ? " (reported error)" : ""}${call.exitCode !== undefined ? `:${call.exitCode}` : ""}${!call.executionConfirmed && ["ok", "error", "unknown", "interrupted"].includes(call.status) ? " (execution unknown)" : ""}`;
}
export function renderHistory(view: ObservationView, options: HistoryOptions = {}): string[] {
  const width = columns(options.width ?? 80), theme = options.theme ?? plain;
  const selected = view.history.filter((call) => ((options.scope ?? "turn") === "session" || call.turn === view.selected.id) &&
    ((options.category ?? "all") === "all" || call.category === options.category));
  const maxEntries = Math.max(1, Math.min(256, Number.isFinite(options.maxEntries) ? Math.floor(options.maxEntries!) : 40));
  const calls = selected.slice(-maxEntries), omitted = selected.length - calls.length;
  const lines: string[] = [];
  if (!calls.length) lines.push("No observed activity.");
  for (const [index, call] of calls.entries()) {
    lines.push(theme.fg(call.status === "blocked" || call.status === "error" ? "warning" : "muted", `${index + 1}. ${historyLabel(call)}`));
    lines.push(...historyDetails(call, width, false));
  }
  if (omitted) lines.push(`${omitted} matching entries omitted from this view.`);
  if (view.omitted) lines.push(`${view.omitted} older entries omitted from retained history (all categories).`);
  if (view.coverage === "incomplete") lines.push("Coverage incomplete; unobserved activity is not inferred.");
  return lines.map((line) => fit(line, width));
}

function historyDetails(call: CallObservation, width: number, wrapping: boolean): string[] {
  const lines: string[] = [];
  if (call.verdict || call.route || call.reason) lines.push(`  Verdict:${call.verdict ?? "unknown"} route:${call.route ?? "unknown"}${call.reason ? ` reason:${call.reason}` : ""}${call.prefilter ? ` prefilter:${call.prefilter}` : ""}`);
  if (call.source || call.server || call.namespace) lines.push(`  source:${call.source ?? "unknown"}${call.server ? ` MCP server:${call.server}` : ""}${call.namespace ? ` namespace:${call.namespace}` : ""}`);
  if (wrapping || call.gateMs !== undefined || call.reviewMs !== undefined || call.submissionDurationMs !== undefined || call.durationMs !== undefined) {
    lines.push(`  gate:${call.gateMs === undefined ? "unknown" : `${Math.round(call.gateMs)}ms`} review:${call.reviewMs === undefined ? "unknown" : `${Math.round(call.reviewMs)}ms`}`);
    lines.push(`  execution:${call.durationMs === undefined ? "unknown" : `${Math.round(call.durationMs)}ms`} submission-to-result:${call.submissionDurationMs === undefined ? "unknown" : `${Math.round(call.submissionDurationMs)}ms`}`);
  }
  if (call.signals) for (const head of HEADS) {
    const p = call.signals.probs?.[head], pred = call.signals.preds?.[head];
    if (p === undefined && pred === undefined) continue;
    lines.push(`  ${head}:${pred === undefined ? "?" : pred ? "+" : "-"} P(+):${p === undefined ? wrapping ? "unavailable" : "N/A" : percent(p, 1)} ${call.signals.appliedHeads?.includes(head) ? "applied" : "raw only"}`);
  }
  for (const key of ["preview", "explanation"] as const) {
    const preview = call[key];
    if (!preview) continue;
    if (key === "explanation") lines.push(`  Verdict: ${call.verdict ?? "unknown"}${call.prefilter === "review" ? " (prefilter review)" : ""}`);
    const room = Math.max(0, width - (key === "preview" ? 4 : 2));
    lines.push(`  ${key === "preview" && call.category === "sh" ? "$ " : ""}${wrapping ? preview.text : fit(preview.text, room)}`);
    const clipped = wrapping ? 0 : Math.max(0, visibleWidth(preview.text) - room);
    if (preview.omittedChars || clipped) lines.push(`  [${key === "explanation" ? "explanation " : ""}truncated: ${preview.omittedChars} chars omitted, ${clipped} columns clipped]`);
  }
  return lines;
}

/** Wrapping keeps retained metrics and previews reachable, including on narrow screens. */
function wrapped(lines: readonly string[], width: number): string[] {
  const size = columns(width);
  if (!size) return lines.map(() => "");
  return lines.flatMap((line) => wrapTextWithAnsi(line, size).map((part) => fit(part, size)));
}
export type OverviewOptions = Pick<DashboardOptions, "width" | "theme" | "modes" | "now"> & {
  droppedRecords?: { actions: number; metadata: number };
  /** The panel wraps logical lines itself to preserve resize anchors. */
  wrap?: boolean;
};
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unavailable";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function guardWaitLabel(t: Telemetry): string {
  const wait = t.guardWait;
  if (!wait || wait.coverage === "unavailable" || !Number.isFinite(wait.wallMs)) return "unavailable";
  return `${formatDuration(wait.wallMs)} (${wait.coverage})`;
}
function safetyModes(modes?: Modes): string {
  if (!modes) return "Safety modes: unavailable";
  return `Auto safety:${modes.auto ? "on" : "off"} · Read-only:${modes.readOnly ? "on" : "off"} · Remote-read-only:${modes.remoteReadOnly ? "on" : "off"}`;
}
function coverageLines(view: ObservationView, theme: DisplayTheme, dropped?: OverviewOptions["droppedRecords"]): string[] {
  const lines = [theme.fg(view.coverage === "incomplete" || view.unresolved ? "warning" : "muted",
    `Coverage ${view.coverage}${view.unresolved ? ` · unresolved:${view.unresolved}` : ""}; observed activity only.`)];
  if (view.omitted) lines.push(theme.fg("warning", `${view.omitted} older entries omitted from retained history (all categories).`));
  if (dropped && (dropped.actions || dropped.metadata)) lines.push(theme.fg("warning", `Private log dropped records: actions=${dropped.actions}, metadata=${dropped.metadata}`));
  return lines;
}
/** Overview is fixed-category aggregates only, never operational text or previews. */
export function renderOverview(view: ObservationView, options: OverviewOptions = {}): string[] {
  const width = columns(options.width ?? 80), theme = options.theme ?? plain;
  const t = view.telemetry, turn = view.selected.telemetry;
  const lines = [theme.fg("accent", theme.bold?.("Safety") ?? "Safety"), theme.fg("warning", safetyModes(options.modes)),
    ...coverageLines(view, theme, options.droppedRecords),
    `Final blocks:${view.totals.blocked} · reported errors:${t.activity?.errors ?? "unavailable"} · session`];
  const reasons = new Map<string, number>();
  for (const [reason, count] of Object.entries(t.activity?.blocksByReason ?? {})) {
    const code = decisionReasonCode(reason);
    reasons.set(code, (reasons.get(code) ?? 0) + count);
  }
  const rankedReasons = [...reasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  lines.push("Block reasons (fixed categories): " + (rankedReasons.slice(0, 3).map(([reason, count]) => `${reason}:${count}`).join(" · ") || (t.activity ? "none observed" : "unavailable")));
  if (rankedReasons.length > 3) lines.push(theme.fg("dim", `${rankedReasons.length - 3} more reason categories in Diagnostics.`));
  if (t.activity?.otherBlockReasons) lines.push(`Other block reasons:${t.activity.otherBlockReasons}`);
  lines.push("", theme.fg("accent", `Activity · turn ${view.selected.id}${view.active ? " (active)" : " (latest)"} / session`));
  for (const [name, counts, metrics] of [["Turn", view.selected.counts, turn], ["Session", view.totals, t]] as const) {
    lines.push(`${name} files:${counts.files} sh:${counts.sh} MCP:${counts.mcp} final blocks:${counts.blocked} reported errors:${metrics.activity?.errors ?? "unavailable"}`);
  }
  lines.push(theme.fg("accent", "Actual guard wait · wall time"),
    `Turn:${guardWaitLabel(turn)} · Session:${guardWaitLabel(t)}${view.guardWaitPending ? ` · pending:${view.guardWaitPending}` : ""}`,
    theme.fg("dim", "Overlapping guard waits counted once; not a sum of gate latencies."));
  const live = formatJudgeStatus(view.liveJudges, options.now);
  if (live) lines.push(theme.fg("warning", live));
  lines.push("", theme.fg("muted", "Speed · secondary · ms"));
  for (const [name, latency] of [["Gate", t.gate], ["Judge", t.judge.latency], ["Classifier", t.classifier.endToEnd]] as const) {
    const stats = latencyStats(latency);
    lines.push(`${name} median:${stats.medianMs === undefined ? "unavailable" : Math.round(stats.medianMs)} p95:${stats.p95Ms === undefined ? "unavailable" : Math.round(stats.p95Ms)} · bounded samples:${stats.sampleCount}`);
  }
  lines.push(theme.fg("dim", "Judge/classifier measurements overlap gate work; do not add them."));
  return options.wrap === false ? lines : wrapped(lines, width);
}

/** Complete retained metrics, grouped separately from expandable private history. */
export function renderDiagnostics(view: ObservationView, options: OverviewOptions = {}): string[] {
  const width = columns(options.width ?? 80), theme = options.theme ?? plain;
  const lines = [theme.fg("accent", "Diagnostics · observed metrics"), safetyModes(options.modes), ...coverageLines(view, theme, options.droppedRecords),
    `Guard wait turn:${guardWaitLabel(view.selected.telemetry)} session:${guardWaitLabel(view.telemetry)} · pending:${view.guardWaitPending ?? "unavailable"}`,
    theme.fg("dim", "Judge/classifier totals overlap gate work, not additive guard wait."),
    `Work totals ms · gate measured:${view.telemetry.gate?.sumMs ?? "unavailable"} judge:${Math.round(view.telemetry.judge.wallMs)} classifier:${Math.round(Object.values(view.telemetry.classifier.byInput).reduce((sum, input) => sum + input.wallMs, 0))}`,
    ...dashboardLines(view, { ...options, width, theme, details: true }, true)];
  return options.wrap === false ? lines : wrapped(lines, width);
}

export type HistoryRowOptions = Pick<HistoryOptions, "width" | "theme"> & { selected?: boolean; expanded?: boolean; wrap?: boolean };
/** Input must come from sanitized ObservationView history, never runtime arguments/results. */
export function renderHistoryRow(call: CallObservation, options: HistoryRowOptions = {}): string[] {
  const width = columns(options.width ?? 80), theme = options.theme ?? plain;
  const label = `${options.selected ? ">" : " "} ${options.expanded ? "−" : "+"} ${historyLabel(call)}`;
  const highlighted = theme.fg(call.status === "blocked" ? "error" : call.status === "error" ? "warning" : options.selected ? "accent" : "muted", label);
  const lines = [options.selected && theme.bg ? theme.bg("selectedBg", highlighted) : highlighted];
  if (options.expanded) lines.push(...historyDetails(call, width, true));
  return options.wrap === false ? lines : wrapped(lines, width);
}
