import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ActivityObservations } from "../observations.ts";
import { HEADS } from "../policy.ts";
import { formatDuration, formatFooter, formatJudgeStatus, layoutActivityStatus, prioritizeJudgeStatus, renderDashboard, renderDiagnostics, renderHistory, renderHistoryRow, renderOverview, supportBar } from "../display.ts";
import { ACTIVITY_VERSION } from "../version.ts";
import { nativeToolInfo } from "./nine-head-fixtures.mjs";

const observations = new ActivityObservations({ previewChars: 40, maxHistory: 3, now: () => 1000 });
observations.beginTurn();
for (const [id, name, info] of [["sh", "bash", nativeToolInfo("bash")], ["file", "write", nativeToolInfo("write")], ["mcp", "catalog", { sourceInfo: { source: "mcp" } }]]) {
  const event = { toolCallId: id, toolName: name, input: { command: "token=SYNTHETIC_SECRET " + "界".repeat(80), path: "/synthetic/private/file", payload: "MCP_DO_NOT_CAPTURE" } };
  observations.gate(event, "allow", { explanation: "Authorization: Bearer SYNTHETIC_SECRET; " + "review ".repeat(100), info, prefilter: "review" });
  observations.toolResult({ ...event, isError: false }, info);
}
const view = observations.view();
assert.equal(formatFooter(view, { auto: true, readOnly: true, remoteReadOnly: true }), "🛡️ 🔏 🌐 · files:1(1) sh:1(1) MCP:1(1) blk:0(0)");
for (const auto of [false, true]) for (const readOnly of [false, true]) for (const remoteReadOnly of [false, true]) {
  const footer = formatFooter(view, { auto, readOnly, remoteReadOnly });
  assert.equal(footer.includes("🛡️"), auto); assert.equal(footer.includes("🔏"), readOnly); assert.equal(footer.includes("🌐"), remoteReadOnly);
  const icons = [auto ? "🛡️" : "", readOnly ? "🔏" : "", remoteReadOnly ? "🌐" : ""].filter(Boolean).join(" ");
  assert.equal(footer, `${icons ? icons + " " : ""}· files:1(1) sh:1(1) MCP:1(1) blk:0(0)`);
}
assert.equal(formatDuration(217), "217ms");
assert.equal(formatDuration(36_637), "36.6s");
assert.equal(formatDuration(123_456), "2m 3s");
assert.equal(formatDuration(NaN), "unavailable");
const activityLeft = formatFooter(view, { auto: true, readOnly: false, remoteReadOnly: false });
const clockRight = "⚖️ judge 1s elapsed · 14s left";
for (const width of [0, 1, 8, 18, 24, 40, 80, 110, 200]) {
  const pinned = layoutActivityStatus(activityLeft, clockRight, width, "synthetic reason ".repeat(40));
  assert.ok(visibleWidth(pinned) <= width);
  if (width >= visibleWidth(activityLeft) + visibleWidth(clockRight) + 3) {
    assert.ok(pinned.startsWith(activityLeft), "full counters stay fixed on the left");
    assert.ok(pinned.indexOf("⚖️") > pinned.indexOf("blk:"), "judge stays to the right of counters");
    assert.ok(pinned.includes(clockRight), "reason clipping preserves elapsed and deadline");
    assert.equal((pinned.match(/s elapsed/g) ?? []).length, 1);
  }
}
const roomy = layoutActivityStatus(activityLeft, clockRight, 140);
assert.ok(roomy.startsWith(activityLeft)); assert.ok(roomy.endsWith(clockRight));
assert.equal(visibleWidth(roomy), 140, "judge is right-aligned when there is spare space");
assert.equal(layoutActivityStatus(activityLeft, "", 200), activityLeft);
const styledFooter = layoutActivityStatus(`\u001b[33m${activityLeft}\u001b[39m`, `\u001b[36m${clockRight}\u001b[39m`, 110, "界".repeat(40));
assert.ok(visibleWidth(styledFooter) <= 110, "footer sizing is ANSI and Unicode aware");
const live = [{ id: "one", startedAt: 1000, expiresAt: 16000, retries: 2 }, { id: "two", startedAt: 500, expiresAt: 12000, retries: 1 }];
assert.equal(formatJudgeStatus(live, 5000), "⚖️ 4s elapsed · 7s left · retry 1 · ×2");
assert.equal(formatJudgeStatus([{ id: "x", startedAt: 1000, retries: 0 }], 4500), "⚖️ 3s elapsed");
assert.equal(formatJudgeStatus([], 5000), "");
assert.equal(formatJudgeStatus(live, 90000).includes("· 0s left"), true);
for (const width of [0, 1, 8, 18, 24, 40, 80, 120]) {
  const merged = prioritizeJudgeStatus("Judge 7s left", formatFooter(view, { auto: true, readOnly: true, remoteReadOnly: true }), width);
  assert.ok(visibleWidth(merged) <= width);
  if (width >= 13) assert.ok(merged.startsWith("Judge 7s left"));
  for (const details of [false, true]) {
    const lines = renderDashboard(view, { width, details });
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `dashboard overflow at ${width}`);
  }
  assert.ok(renderHistory(view, { width, scope: "session" }).every((line) => visibleWidth(line) <= width));
}
let themeCalls = 0;
const theme = { fg: (_color, text) => { themeCalls++; return `\u001b[36m${text}\u001b[39m`; } };
const narrowIncomplete = renderDashboard({ ...view, coverage: "incomplete" }, { width: 24 });
assert.ok(narrowIncomplete.some((line) => line.includes("Coverage incomplete")), "narrow dashboards must not clip the coverage disclosure");
const detailed = renderDashboard(view, { width: 100, theme, details: true }).join("\n");
assert.ok(themeCalls > 0);
assert.ok(detailed.includes(`Activity v${ACTIVITY_VERSION}`));
assert.ok(detailed.includes("support scores, not accuracy"));
for (const head of HEADS) assert.ok(detailed.includes(head));
assert.ok(detailed.includes("Requests")); assert.ok(detailed.includes("≥0 observed"), "unwired provider request counts are lower bounds, not guessed from starts");
assert.equal(supportBar(undefined), "N/A"); assert.equal(supportBar(2), "N/A"); assert.equal(supportBar(0.5, 4), "██░░");
const history = renderHistory(view, { width: 120, scope: "session" }).join("\n");
assert.ok(history.includes("truncated:")); assert.ok(history.includes("chars omitted"));
assert.ok(history.includes("explanation truncated:"));
assert.ok(!history.includes("SYNTHETIC_SECRET")); assert.ok(!history.includes("MCP_DO_NOT_CAPTURE"));
const mcpHistory = renderHistory(view, { category: "mcp", scope: "session", width: 120 }).join("\n");
assert.ok(mcpHistory.includes("catalog")); assert.ok(!mcpHistory.includes("$ "));
observations.toolResult({ toolCallId: "more", toolName: "bash", isError: true }, nativeToolInfo("bash"));
assert.ok(renderHistory(observations.view(), { width: 120, scope: "session", maxEntries: 1 }).join("\n").includes("2 matching entries omitted"));
assert.ok(renderHistory(observations.view(), { width: 120, scope: "session" }).join("\n").includes("1 older entries omitted"));
observations.setClassifierEnabled(false);
assert.ok(renderDashboard(observations.view(), { width: 100, details: true }).join("\n").includes("N/A (disabled)"));
// Rich dashboard defaults expose aggregate failures, latencies and exactness.
const rich = new ActivityObservations({ now: () => 2000, judgeRequestsObserved: true, summaryRequestsObserved: true,
  judgeModel: "fixture/judge", summaryModel: "fixture/summary" }); rich.beginTurn();
for (let n = 0; n < 4; n++) rich.evaluation(`display-head-${n}`, {
  inputType: "shell", status: "success", inferenceMs: n + 1, wallMs: (n + 1) * 2,
  probs: Object.fromEntries(HEADS.map((head) => [head, [0.8, 0.4, 0.6, 0.2][n]])),
  preds: Object.fromEntries(HEADS.map((head) => [head, n % 2 === 0])), appliedHeads: n < 2 ? HEADS : [],
});
rich.judgeStarted("display-judge", 10000); rich.judgeRequest("display-judge", false, rich.scope(), { model: "fixture/actual-judge" });
rich.judgeFinished("display-judge", "deny", 10);
rich.summaryRequest(rich.scope(), { model: "fixture/actual-summary" }); rich.summary("restored"); rich.summary("failed", 2);
rich.approvalPrompt(); rich.approvalPrompt(); rich.approval("allow", true);
const routes = ["local-allow", "judge-allow", "user-override", "final-block"];
for (const [n, route] of routes.entries()) {
  const e = { toolCallId: `display-route-${n}`, toolName: "catalog" };
  rich.gate(e, route === "final-block" ? "block" : "allow", { route, gateMs: 11, reviewMs: 8, reason: "judge-deny",
    info: { sourceInfo: { source: "mcp", server: "fixture-server" } }, signals: { probs: { outbound: 0.7 }, preds: { outbound: true }, appliedHeads: ["outbound"] } });
  if (route !== "final-block") rich.toolResult({ ...e, isError: n === 0 });
}
const richView = rich.view();
const defaults = renderDashboard(richView, { width: 160 }).join("\n");
for (const text of ["Errors / final blocks", "judge-deny", "Inference", "End-to-end", "Review", "Mean", "Median", "p95", "Samples",
  "fixture/judge", "fixture/summary", "fixture/actual-judge", "fixture/actual-summary", "1 exact", "prompts shown:2", "effective overrides:1", "restored:1", "failed:1"]) assert.ok(defaults.includes(text), `missing dashboard requirement: ${text}`);
const richDetails = renderDashboard(richView, { width: 160, details: true, theme }).join("\n");
assert.ok(richDetails.includes("raw n:4 +:2 (50%) -:2 (50%)"));
assert.ok(richDetails.includes("mean positive P(+):70%"), "positive means exclude negative predictions");
assert.ok(richDetails.includes("applied n:2 +:1 (50%) -:1 (50%)"));
assert.ok(richDetails.includes("applied mean positive P(+):80%"));
const partialLabels = structuredClone(richView);
for (const h of Object.values(partialLabels.telemetry.classifier.heads)) h.applied = 10;
const partialDetails = renderDashboard(partialLabels, { width: 160, details: true }).join("\n");
assert.ok(partialDetails.includes("applied n:10 known labels:2 +:1 (50%) -:1 (50%)"), "legacy applied labels are not fabricated as negatives");
const richHistory = renderHistory(richView, { width: 160, scope: "session" }).join("\n");
for (const route of routes) assert.ok(richHistory.includes(`route:${route}`));
for (const text of ["gate:11ms review:8ms", "execution:unknown", "MCP server:fixture-server", "source:mcp", "outbound:+ P(+):70% applied"]) assert.ok(richHistory.includes(text));
for (const width of [0, 1, 8, 24, 40, 80, 120]) {
  assert.ok(renderDashboard(richView, { width, details: true, theme }).every((line) => visibleWidth(line) <= width));
  assert.ok(renderHistory(richView, { width, scope: "session", theme }).every((line) => visibleWidth(line) <= width));
}
const lowerBound = new ActivityObservations(); lowerBound.judgeStarted("lower"); lowerBound.judgeRequest("lower");
const unknownRequests = renderDashboard(lowerBound.view(), { width: 160 }).join("\n");
assert.ok(unknownRequests.includes("≥1 observed")); assert.ok(unknownRequests.includes("lower bounds"));
// Tab renderers retain information by wrapping; the RPC renderers remain compatible.
const tabView = structuredClone(richView);
tabView.telemetry.guardWait = { wallMs: 123, coverage: "partial" };
tabView.selected.telemetry.guardWait = { wallMs: 45, coverage: "complete" };
tabView.guardWaitPending = 2;
tabView.coverage = "incomplete";
tabView.omitted = 5;
const modeLabels = { auto: true, readOnly: false, remoteReadOnly: true };
const overviewColors = [];
const overview = renderOverview(tabView, { width: 110, modes: modeLabels,
  theme: { fg(color, text) { overviewColors.push(color); return text; } }, droppedRecords: { actions: 3, metadata: 2 } }).join("\n");
for (const text of ["Safety", "Auto safety:on", "Read-only:off", "Remote-read-only:on", "Coverage incomplete", "Final blocks:1",
  "reported errors:1", "judge-deny:1", "older entries omitted", "actions=3, metadata=2", "Turn:45ms (complete)", "Session:123ms (partial)", "pending:2",
  "bounded samples", "overlap gate work", "do not add them"]) assert.ok(overview.includes(text), `overview missing ${text}`);
assert.ok(!overviewColors.includes("success"), "observed zero errors are not an all-safe badge");
assert.ok(overview.indexOf("Block reasons") < overview.indexOf("Activity · turn"));
assert.ok(overview.indexOf("Actual guard wait") < overview.indexOf("Speed"));
for (const forbidden of ["fixture/judge", "fixture-server", "catalog", "Authorization", "SYNTHETIC_SECRET"]) assert.ok(!overview.includes(forbidden));
// Aggregate reasons are projected to fixed categories even if a caller supplies an unsafe key.
const badAggregate = structuredClone(tabView);
badAggregate.telemetry.activity.blocksByReason["RAW_OPERATIONAL_SENTINEL"] = 2;
assert.ok(!renderOverview(badAggregate, { width: 110 }).join("\n").includes("RAW_OPERATIONAL_SENTINEL"));
assert.ok(renderOverview(badAggregate, { width: 110 }).join("\n").includes("unknown:2"));
const missingWait = structuredClone(tabView);
delete missingWait.telemetry.guardWait;
missingWait.selected.telemetry.guardWait = { wallMs: 0, coverage: "unavailable" };
const unavailable = renderOverview(missingWait, { width: 110 }).join("\n");
assert.ok(unavailable.includes("Turn:unavailable · Session:unavailable"));
assert.ok(unavailable.includes("Safety modes: unavailable"));
const diagnostics = renderDiagnostics(tabView, { width: 110, modes: modeLabels }).join("\n");
for (const text of ["Classifier", "Turn telemetry", "Nine independent heads", "not accuracy or calibrated confidence", "Median/p95: bounded samples",
  "Requests: exact with provider hooks", "observed lower bounds", "1 exact", "fixture/actual-judge", "Approval prompts shown:2", "raw n:4", "applied n:2",
  "Summary generated", "restored:1", "failed:1", "fallback requests", "Guard wait turn", "Work totals ms"]) assert.ok(diagnostics.includes(text), `diagnostics missing ${text}`);
for (const head of HEADS) assert.ok(diagnostics.includes(head));
assert.ok(!diagnostics.includes("Recent history"), "private history is a separate tab");
assert.ok(!diagnostics.includes("N/A"));
assert.ok(!diagnostics.includes("catalog"));
const disabledRetained = structuredClone(tabView);
disabledRetained.telemetry.classifier.enabled = false;
const retainedMetrics = renderDiagnostics(disabledRetained, { width: 110 }).join("\n");
assert.ok(retainedMetrics.includes("Classifier currently disabled"));
assert.ok(retainedMetrics.includes("raw n:4"), "turning the classifier off must not hide retained head metrics");
for (const head of HEADS) assert.ok(retainedMetrics.includes(head));
const expanded = renderHistoryRow(richView.history[0], { width: 110, expanded: true, selected: true }).join("\n");
for (const text of ["> −", "source:mcp", "MCP server:fixture-server", "route:local-allow", "reason:judge-deny", "gate:11ms review:8ms", "execution:unknown", "outbound:+"]) assert.ok(expanded.includes(text));
assert.equal(renderHistoryRow(richView.history[0], { width: 110 }).length, 1, "compact row only until expanded");
const unicodeCall = { ...richView.history[0], tool: "synthetic-unicode", preview: { text: "prefix " + "界 é 👩‍💻 ".repeat(20) + " suffix", omittedChars: 7 },
  explanation: { text: "synthetic retained explanation", omittedChars: 3 } };
const wrappedPreview = renderHistoryRow(unicodeCall, { width: 24, expanded: true }).join("\n");
assert.ok(wrappedPreview.includes("prefix")); assert.ok(wrappedPreview.includes("suffix"));
assert.ok(wrappedPreview.includes("7 chars")); assert.ok(wrappedPreview.replace(/\s+/g, " ").includes("0 columns clipped"));
for (const width of [0, 1, 8, 24, 40, 80, 110]) {
  for (const lines of [renderOverview(tabView, { width, theme }), renderDiagnostics(tabView, { width, theme }),
    renderHistoryRow(unicodeCall, { width, theme, expanded: true })]) {
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `tab renderer overflow at ${width}`);
  }
}
const allRetained = renderHistoryRow(view.history[0], { width: 24, expanded: true, theme }).map(stripTerminalSequences).join("\n");
assert.ok(!allRetained.includes("SYNTHETIC_SECRET")); assert.ok(!allRetained.includes("MCP_DO_NOT_CAPTURE"));
assert.ok(allRetained.includes("truncated:"));
const literalNA = { ...unicodeCall, preview: { text: "printf N/A", omittedChars: 0 }, explanation: { text: "Synthetic N/A explanation", omittedChars: 0 } };
const literalDetails = renderHistoryRow(literalNA, { width: 110, expanded: true }).join("\n");
assert.ok(literalDetails.includes("printf N/A")); assert.ok(literalDetails.includes("Synthetic N/A explanation"));
const literalModel = structuredClone(tabView);
literalModel.telemetry.judge.models.configured = "fixture/N/A";
assert.ok(renderDiagnostics(literalModel, { width: 110 }).join("\n").includes("fixture/N/A"), "availability labels must not rewrite retained identifiers or previews");
console.log("display tests passed: legacy text views, safety overview, actual wait, full diagnostics, wrapped history and privacy");
