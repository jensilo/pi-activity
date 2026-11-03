# UI

## Activity panel

`/activity` opens a read-only panel. The panel cannot change safety settings.

| Tab | Content |
| --- | --- |
| Overview | Active modes, coverage, final blocks, reported errors, the three most frequent block reasons, counts, guard wait and speed. No commands, paths, tool names, provider IDs or explanations. |
| History | Recent calls, newest first. Press Enter to expand a call. Details are sanitized previews, explanations, reasons, sources, routes, classifier labels and timings. |
| Diagnostics | All metrics: classifier inputs, latency, model records, judge outcomes and retries, summaries, approvals, turn telemetry and all nine labels. |

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
  the judge and your approval. It does not include tool run time, model thinking or
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

The row sits below the editor. Counts are on the left. The judge clock and deadline
are on the right. On a narrow terminal, the row shortens the reason first. On a very
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

## Approval

Activity opens a dialog in these cases:

- The judge answers `ask_user`.
- The judge fails for a technical reason, such as a timeout.

Activity does not open a dialog in these cases. The call stays blocked.

- The judge answers `block`.
- A guard is active.
- The judge configuration or the judge answer is invalid.
- The turn is cancelled, or the call is stale.
- The session is RPC, JSON or print.

If the terminal is too small, the dialog says "Resize terminal to approve". You
cannot approve until the dialog fits.

### What you see

The dialog shows the tool, the working directory, the reason and all arguments, in
pages. It uses at most 18 rows. **Block** is selected first.

Activity shows backslashes, terminal commands and invisible direction controls as
escaped text. It does not run or remove them. Activity keeps the data in memory. It
creates no argument file and no reusable permission.

| Keys | Action |
| --- | --- |
| `j` / `k`, Up / Down | Select Allow or Block |
| `h` / `l`, Left / Right | Previous / next page |
| Home / End | First / last page |
| Enter | Confirm |
| Esc, Ctrl+C | Cancel |

Your Pi selection and cancellation keys also apply. The hints show them.

### Timer

- Dialogs open one at a time in each session. A call waits in the queue for at most
  30 seconds.
- An open dialog closes after 30 seconds without input.
- Each key press or paste in the dialog resets the timer. Redraws, resizes, terminal
  reports, key releases and Pi global shortcuts do not reset it.
- There is no total limit while you use the dialog.
- A cancelled turn or a session change closes the dialog.

### Results

| Result | Effect |
| --- | --- |
| Allow | The unchanged call runs. |
| Block | The call does not run. The agent learns that you declined. It must not retry the same call. |
| Timeout | The agent gets the same refusal as for a judge `block`. Telemetry records `timeout`. It does not count as your refusal. |
| Cancel, no UI | The call does not run. It does not count as your refusal. |

A refusal starts with **Blocked — tool was not run.** and the reason. It tells the
agent to find a safe alternative or do other unblocked work. It also tells the agent
not to bypass guards or retry the same call, and to ask you only if no safe path
remains.

Allow has these limits:

- It applies to this exact call only. It cannot override a guard.
- It cannot repair a tool failure after the call starts.
- Activity freezes the arguments after Allow. Later handlers cannot change them.
  Extensions that transform arguments must run before Activity.
- It does not protect against a hostile extension in the same process.
