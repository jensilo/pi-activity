# UI

## Activity panel

`/activity` opens a read-only panel. The panel cannot change safety settings.

| Tab | Content |
| --- | --- |
| Overview | Active modes, coverage, final blocks, reported errors, the three most frequent block reasons, counts, guard wait and speed. No commands, paths, tool names, provider IDs or explanations. |
| History | Recent calls, newest first. Press Enter to expand a call. Details are sanitized previews, explanations, reasons, sources, routes, classifier labels and timings. |
| Diagnostics | All metrics: classifier inputs, latency, model records, judge outcomes and retries, summaries, turn telemetry and all nine labels. Old sessions may also show historical tool approval counts. |

Sanitized History remains private session data. Do not publish it.

This mockup uses invented values:

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

A History entry looks like `> + [agent] bash blocked`. Enter changes `+` to `−` and
shows the details. The panel marks truncated data and omitted older entries.

### Controls

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

Each tab keeps its scroll position. New entries do not move your History selection.

### Size

The panel uses at most 80% of the terminal height. Only the body scrolls. Short
terminals get a compact header and footer. If only one row fits, the panel shows the
close hint. The keys work at every size.

### How to read the values

- **Coverage** describes what Activity observed. It does not mean that all activity
  was safe. Incomplete coverage is never a green badge.
- **Final blocks** are calls that did not run. A call that goes to the judge is not
  a block until the final decision.
- **Reported errors** do not prove that a tool ran.
- **Guard wait** is the time that the agent waited for Activity's tool checks.
  Overlapping checks count once. It includes the classifier, foreground summaries,
  and the judge. It does not include tool run time, model thinking or
  your own shell commands. Missing values show **unavailable**. Partial values show
  **partial**.
- **Median and p95** use a limited set of samples. **Mean and count** use all
  observed measurements.
- **Judge and classifier times** overlap with guard wait. Do not add them.
- **Provider request counts** are exact or lower bounds. The panel shows which. The
  configured model and the actual request model are separate values.
- **Labels** are independent. Selected-label support is not accuracy or calibrated
  confidence.
- **Diagnostics** keeps classifier metrics after you turn off the classifier.

## Guard banner

The banner appears above the editor when a guard is active.

| Active guard | Text meaning |
| --- | --- |
| Read-only | Local and remote changes are blocked. |
| Remote-read-only | Remote changes are blocked. Local changes may be allowed. |
| Both | Local and remote changes are blocked. |

- The banner updates when you change a guard. It disappears when both guards are off.
- On restart or resume, Activity restores guards from the selected session branch.
  Guards set in the configuration file still apply.
- `display.enabled: false` hides the banner. The guards still work.
- Startup flags turn a guard on once. `/reload` and `/new` do not apply them again.

Activity also tells the model when a guard changes:

1. Activity collects changes until your next input or the next safe point in the turn.
2. It sends one short hidden message. The message states the current modes,
   including OFF when an earlier guard ends.
3. After compaction, it sends the message again if the summary removed it.

Activity does not edit the system prompt or earlier messages. Cache warming pauses
while a message is pending.

## Activity row

The row sits below the editor. Counts are on the left. Judge elapsed time is on the right. On a narrow terminal, the row shortens the reason first. On a very
narrow terminal, it can also shorten the counts.

The row does not replace Pi's footer or the widgets of other extensions. Hosts
without the TUI show plain status text.

## Tool results

Activity does not change how tools render. Execution errors and successful results
stay unchanged.

When Activity blocks a call:

- The tool result says **Blocked — tool was not run.**
- A separate message shows **↑ 🛡️ Blocked (source): reason**, then **Model guidance:**.
  The model gets the same text. Pi keeps the message for resume.
- Nested calls and cancelled or stale calls get the full reason in the tool result,
  without a separate message.

Pi can show an edit preview before Activity blocks the edit. A preview does not
prove that the edit ran.

There is no tool approval dialog. If the judge cannot complete a required review,
the call stays blocked. The guidance line at the end of a block tells the agent what
it may do next, and follows why auto mode refused: a judged objection points to a
safe alternative or other unblocked work; a technical failure judged nothing, so the
call may be retried or approached differently; and an action auto mode cannot check
stays blocked until it is configured. The separate acclass installation consent
dialog is unchanged.

A judge's `allow` applies only to the exact reviewed call and cannot override a
guard. Activity freezes the reviewed arguments. Extensions that transform arguments
must run before Activity. This is not isolation from hostile same-process code.
