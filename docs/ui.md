# Read-only activity panel

`ActivityPanel` is a standalone Pi TUI component with three tabs:

- **Overview:** labelled safety modes, observation coverage, final blocks and reported errors, the three most frequent fixed block-reason categories, turn/session counts, actual guard wait, then secondary speed measurements. All remaining reason categories are in Diagnostics. No commands, paths, tool names, provider IDs or explanations appear here.
- **History:** newest-first retained entries, selectable by line, with Enter expansion. Expanded entries show only already-sanitized previews, explanations, fixed reasons, provenance, verdict routes, classifier signals and timing receipts. Unknown execution is labelled, not inferred from admission or an execution-end event.
- **Diagnostics:** the detailed dashboard metrics, including classifier input counts, latency counts and samples, model receipts, judge outcomes and retries, summaries, approvals, turn telemetry and all nine independent heads. History previews belong to History, not Diagnostics.

This panel never changes safety policy. Sanitized histories remain private session data, not publication-safe examples.

## Synthetic mockup

Illustrative synthetic values only. This is not a real activity capture.

```text
╭ Activity v1.0.0 ───────────────────────────────────────────────────────────╮
│[Overview]  History  Diagnostics                                            │
├───────────────────────────────────────────────────────────────────────────┤
│Safety                                                                     │
│Auto safety:on · Read-only:on · Remote-read-only:off                         │
│Coverage incomplete · unresolved:1; observed activity only.                 │
│Final blocks:1 · reported errors:1 · session                                │
│Block reasons (fixed categories): read-only:1                               │
│                                                                           │
│Activity · turn 2 (active) / session                                        │
│Turn files:1 sh:2 MCP:0 final blocks:1 reported errors:0                     │
│Session files:3 sh:5 MCP:1 final blocks:1 reported errors:1                  │
│Actual guard wait · wall time                                              │
│Turn:75ms (complete) · Session:150ms (partial) · pending:2                   │
│Overlapping guard waits counted once; not a sum of gate latencies.          │
│                                                                           │
│Speed · secondary · ms                                                     │
│q close · h/l tabs · j/k scroll · ↑0 ↓4                                     │
╰───────────────────────────────────────────────────────────────────────────╯
```

A compact History entry is `> + [agent] bash blocked`. Enter changes `+` to `−` and reveals retained detail. Wide characters, emoji and combining characters wrap using Pi's terminal-column primitives. Wrapped detail can be traversed one line at a time; it is not silently clipped to a single preview row. Retention truncation and older-entry omissions are disclosed separately.

## Controls

| Keys                         | Action                                                                  |
| ---------------------------- | ----------------------------------------------------------------------- |
| `h` / `l`, Left / Right      | Previous / next tab, wrapping at the ends                               |
| Tab / Shift+Tab              | Next / previous tab                                                     |
| `j` / `k`, Down / Up         | One body line; in History, selection follows the entry owning that line |
| Ctrl+D / Ctrl+U              | Half a body viewport down / up                                          |
| Ctrl+F / Ctrl+B, PgDn / PgUp | One body viewport down / up                                             |
| `gg` / `G`, Home / End       | Top / bottom                                                            |
| Enter                        | Expand / collapse the selected History entry only                       |
| `q`, Esc, Ctrl+C             | Close                                                                   |

Enter does not dismiss Overview or Diagnostics. Each tab restores its own scroll position. A tab change clears an unfinished `g` prefix. New observations do not steal a retained History selection or push it offscreen. Height-only resizing also keeps the selection visible. Expansion state is discarded when its entries are no longer retained.

## Layout and theme

The complete card, including borders, title, tabs and footer, is bounded by `floor(tui.terminal.rows * 0.8)`. Only the body scrolls. There is no minimum size that can exceed this budget.

At normal sizes the card has rounded borders and fixed title, tabs and hints. Short terminals use a compact unbordered header and footer; if only one row fits, close hints take priority. A zero-row budget or zero width returns no lines. A one-column terminal keeps a one-column close hint. Full content and tab labels necessarily need more space, but the same keys still work.

Resizing anchors the top visible logical row where possible, then clamps the viewport to its new bounds. ANSI-aware wrapping, truncation and padding keep every line within the supplied width. `invalidate()` regenerates theme-dependent content without resetting navigation. Styles use Pi's semantic colors and bold headings. The selected history header uses the active-row background when supplied by the theme; blocks and errors have distinct highlighting. Incomplete coverage is not shown as a green all-safe badge.

## Interpretation

- Coverage describes observations, not a guarantee that all activity was safe. Unresolved receipts and dropped private-log counts remain visible.
- Final blocks differ from prefilter reviews. Reported errors do not by themselves prove tool execution.
- Actual guard wait is monotonic elapsed time with at least one Pi tool-admission handler pending, counted once across overlaps. It includes classifier, foreground summary, judge and approval work inside that admission interval. Tool execution, ordinary model thinking and unguarded user-shell execution are excluded. Durations use milliseconds, seconds or minutes as appropriate. Missing or unavailable measurements display **unavailable**; partial measurements are labelled **partial**. The UI never substitutes summed gate, judge or classifier times for this value.
- Median and p95 cover bounded retained samples. Mean and count cover all observed measurements.
- Judge and classifier work overlaps gate measurements. Their totals are not additive guard wait.
- Provider request counts distinguish exact hooked receipts from observed lower bounds. Configured models and actual request models are separate.
- The nine heads are independent. Selected-label support is not accuracy or calibrated confidence. Raw predictions and applied labels remain distinct, including unknown legacy labels. Turning the classifier off does not hide its retained Diagnostics metrics.

## Guard banner

The `activity-guard` live widget appears above the editor as soon as a guarded
session starts. It shows the active mode(s) and one short explanation:

- **Read-only:** local and remote changes are blocked.
- **Remote-read-only:** remote changes are blocked; local changes may be allowed.
- **Read-only + remote-read-only:** local and remote changes are blocked.

Toggles update the same widget, or remove it when both guards are off. It restores
from the selected session branch on restart/resume; global guard floors still
apply. `display.enabled: false` hides the banner without changing enforcement.
Flags and startup slash commands use the same update path. Startup flags enable
modes once; `/reload` and `/new` do not reapply them over subsequent user toggles.

The UI banner is separate from short, hidden chat-level LLM instructions. Pending
changes coalesce until submission or the next queued/tool continuation. Once sent,
instructions remain unchanged: later state changes append a new authoritative
mode note, including OFF when earlier guard instructions must be revoked. Queued
steering/follow-up submissions receive updates at a safe turn boundary. Compaction
reannounces current guards if their instruction was summarized away. Guard changes
never edit the system prompt or earlier messages, preserving the existing request
prefix rather than guaranteeing provider cache hits. Cache warming pauses while
the model-visible mode instruction is pending. Shutdown removes this widget only.

## Activity row

The passive `activity-status` widget sits below the editor. Counts stay on the left; the live judge clock and deadline are right-aligned. Elapsed time appears once. The reason is shortened before the clock or counters; exceptionally narrow widths can also shorten counters. The row renders at the host-supplied width on every resize.

A dedicated widget is necessary because Pi's built-in status line collapses alignment spaces and concatenates other extensions' statuses before clipping. This implementation neither replaces the global footer nor clears other extensions' widgets/statuses. Activity-owned status keys are cleared while the widget is active. Non-TUI/limited-host fallback remains plain status text without a positional layout guarantee. Shutdown removes the activity widget.

## Standard tool results

Activity does not register tool renderers or replace tool definitions. Built-in
and custom tools retain their own call/result rendering, including Pi's standard
pending edit preview and successful diff layout.

- Activity refusal: the native error-result text says **Blocked — tool was not
  run.** A separate Activity message preserves the full reason and model guidance.
- Execution errors and successful results are unchanged; Activity does not label,
  reformat or otherwise rewrite them.

The native block notice is ordinary result text. Pi controls its error color and
background. Custom tools retain control of their own rendering. Pi may show a
proposed edit preview even when admission is later blocked; a preview is not
evidence that an edit executed. Stored results retain their existing text on replay.

The Activity-owned `activity-blocked` message uses Pi's `toolErrorBg` as one
coherent block; it does not intercept tool rendering. The block starts with
**↑ 🛡️ Blocked (source): reason**, in the error color, without repeating the
native execution notice. A blank line separates the reason from a muted
**Model guidance:** section. All guidance remains visible to the operator and
unchanged in model context. Call identity appears in the UI when expanded.
Pi delivers these messages after all tool results in the turn, before model
continuation, and persists them for resume. Nested callers and cancelled/stale
work keep the full native reason instead; they do not enqueue a separate message.
The extension factory's optional `"native"` third argument is retained for isolated
policy tests and comparison previews; it is not a configuration setting.

## Approval

Ordinary auto-mode `ask_user` decisions and eligible technical review failures open
a compact inline dialog built from Pi's UI controls, not an overlay or the read-only
activity panel. Judge `block` returns immediately without UI. All refusals retain
the short original reason; user Block also explicitly records that the user declined
and prohibits an unchanged retry. Approval timeout means unavailable approval, not
human denial: the agent receives exactly the same refusal as immediate judge
`block`: **Blocked — tool was not run.**, followed by the reason and short steering to prefer a
safe reason-resolving alternative or other unblocked work while the user is away.
It forbids guard bypasses and unchanged retries and asks for help only when no safe
path remains, without timeout or 30-second steering. The UI still shows its 30-second inactivity window
and telemetry records `timeout`. Cancellation and missing UI are not human denial;
stale-call, guard and technical-stop diagnostics remain visible.
Only **Block** and **Allow** are selectable. Complete tool/cwd, review reason and
arguments are shown directly in a paged evidence area, with the page count and
key hints below the choices. The dialog uses at most 18 rows. Everything stays
in memory; no argument file or reusable permission is created. Backslashes,
terminal commands and invisible direction controls are escaped as inert text,
not executed or silently stripped. Invisible side padding keeps evidence inset
without vertical borders and preserves leading/trailing spaces.
Block is initially selected; paging preserves the selected decision.

- j/k or Up/Down: select Allow/Block.
- h/l or Left/Right: previous/next evidence page; Home/End: first/last page.
- Enter: confirm the selected choice; Esc/Ctrl+C: cancel.
- Pi's configured selection and cancellation bindings apply; hints reflect them.

Approval dialogs are serialized per session. Queue waiting is bounded by 30
seconds. Once visible, an approval gets a fresh 30-second **inactivity** window.
Each real keypress or paste delivered to the focused dialog resets it, including
paging, selection and otherwise ignored printable input. Redraws, resize events,
terminal reports and key-release packets do not reset it. Pi-owned global
shortcuts, such as fullscreen Page Up/Down, are intercepted before dialog input
and do not reset the timer. There is no total-time limit while actively interacting.
Turn cancellation and session changes close the interaction. Unreadably small
terminals cannot approve. Allow admits only
the unchanged proposed call; it cannot waive hard guards or repair a later tool
execution failure. Inputs are recursively frozen after Allow, so later admission
handlers cannot silently change approved arguments. Extension argument transformers
must run before Activity. This is not isolation from hostile same-process extensions.
RPC/JSON/print sessions never open approval dialogs.

## Parent integration

```typescript
import { ActivityPanel } from "./panel.js";

await ctx.ui.custom<void>(
  (tui, theme, _keys, done) => {
    return new ActivityPanel(tui, theme, done, observationView, {
      initialTab: "overview", // "history" or "diagnostics"
      category: "all", // "sh", "files", "mcp"; History only
      scope: "turn", // "session"; History only
      modes: () => currentModes(),
      droppedRecords: () => ({
        actions: actionDrops(),
        metadata: metadataDrops(),
      }),
    });
  },
  {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: 110,
      maxHeight: "80%",
    },
  },
);
```

The host clamps the preferred width to the current terminal width, including after resizing. Avoid calculating a one-time numeric width from the terminal at opening. No fixed horizontal margins are imposed on tiny terminals.

Use this path only in TUI mode. Keep `renderDashboard(view, { details: true })` and `renderHistory(view, options)` for RPC/notification fallback. `renderOverview`, `renderDiagnostics` and `renderHistoryRow` also expose stateless wrapped lines. Their `wrap: false` option returns logical lines for components that handle wrapping themselves.

`getView` must return an already-sanitized `ObservationView`, not raw runtime data. Guard wait comes from optional `telemetry.guardWait` and `selected.telemetry.guardWait` values of `{ wallMs, coverage: "complete" | "partial" | "unavailable" }`; `guardWaitPending` is an optional fixed numeric aggregate. Mode and drop-count callbacks are read afresh on render. The parent requests a render when observations change; the panel creates no timers or subscriptions.

## Synthetic tests

`activity/test/panel.test.mjs` exercises widths 0, 1, 8, 24, 40, 80 and 110; terminal rows 0 through 24 and 60; all tabs and navigation bindings; expansion, filters, Unicode wrapping, resizing, invalidation and retained privacy. `activity/test/display.test.mjs` covers stateless tab renderers and legacy text-view compatibility. `activity/test/host-ui.test.mjs` exercises the installed host's actual footer sanitizer and regular-mode overlay compositor with synthetic data, including resize and tiny-terminal geometry. `activity/test/ui-accounting.test.mjs` covers command routing, widget placement, cleanup and admission-token integration. `activity/test/guard-wait.test.mjs` covers overlapping waits, monotonic clocks, restoration, legacy data and interruptions. All are automatically discovered by `activity/test/run.sh`.
