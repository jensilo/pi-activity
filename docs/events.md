# Events and limits

Activity uses Pi extension hooks. It does not trace shell commands or processes.
Only `tool_call` can block a call. Display, storage and telemetry cannot block or
allow a call.

## Hooks

| Hook | What Activity does |
| --- | --- |
| `session_start`, `session_tree` | Restores the state of the selected branch. Cancels pending work. |
| `before_agent_start`, `agent_settled` | Opens and closes the activity window. Adds pending guard messages before input. |
| `turn_end`, `session_compact` | Sends guard messages before queued work and after compaction. |
| `cache_warming_decision` | Pauses cache warming while a guard message is pending. |
| `tool_call` | Checks the call before it runs. Can block it. |
| `tool_execution_start` | Records the submission. This event does not prove that the tool ran. |
| `tool_result` | Counts the run. Does not keep the output. |
| `tool_execution_end` | Adds the duration. This event alone does not show a rejection or a cancellation. |
| `user_bash` | Records your shell command. Does not prove that it ran. Guards and the judge do not check it. |
| `message_end` | Matches shell results on this branch. Does not keep the output. |
| `session_shutdown` | Cancels pending work, saves state, stops the daemon that Activity started, and flushes logs. |

## Counts

The footer shows `files:N(T) sh:N(T) MCP:N(T) blk:N(T)`. `N` is the current turn.
`T` is the session total.

| Count | Includes |
| --- | --- |
| `files` | Successful file writes and edits |
| `sh` | Confirmed shell runs, including errors |
| `MCP` | Confirmed runs of tools that Pi identifies as MCP, including errors |
| `blk` | Final blocks. Each block counts once, from any route: local rules, judge or dialog. |

Other custom tools appear in History. Activity does not label them as MCP.

Counting rules:

- Activity checks nested tool calls by their real arguments and call IDs.
- The built-in outer codemode wrapper skips the check. Activity still checks the
  calls inside it. A replacement tool with the same name does not skip the check.
- A failed validation, lookup or start does not count as a run.
- A duplicate result counts once.
- Abandoned work shows as interrupted, not as a success.
- A call that goes to the judge is not a block until the final decision.
- A duration from `tool_execution_end` does not change the counts. A missing
  duration stays unknown.
- Activity ignores late results from a replaced session or tree.
- A user shell result without confirmation from Pi shows as "execution unknown".

## History

`/bash-history` and `/mcp-history` accept `turn` or `complete`.

- Activity sanitizes and truncates previews and explanations. It marks each
  truncation.
- It keeps them in memory and in optional session snapshots for the branch.
- MCP arguments, MCP results and reasoning traces never appear in previews.
- Old snapshots, retention limits and interrupted observations can leave gaps.
  Missing data does not mean zero.

## `activity:decision`

`pi.events` emits this event once for each final decision on a checked call.

| Field | Content |
| --- | --- |
| `version` | `1` |
| `packageVersion` | Loaded Activity version |
| `callId` | Tool call ID |
| `category` | Fixed tool category |
| `modes` | Effective modes |
| `verdict` | `allow` or `block` |
| `route` | How Activity reached the verdict |
| `reason` | Fixed reason code. An unknown reason is `unknown`. |
| `classifier` | Optional: input type, status, probabilities, predictions, applied labels, timings |
| `judge` | Optional: outcome, duration, attempts, retries, observed requests and dispatches, fallback use |

The event has no arguments, outputs, user text, free-form explanations or reasoning
traces. The event does not approve a call and cannot override a guard. Consumers
must accept unknown future fields and versions. The TypeScript type is
`DecisionObservation` in `activity/observations.ts`.

## `activity:state`

```ts
{ readOnly: boolean, auto: boolean, guards: { remoteReadOnly: boolean } }
```

These are the effective modes, including guards set in the configuration file.

- Activity does not prove that a child process or backend has the same protection.
- Under an active guard, the judge checks delegation calls with guard constraints,
  like other custom calls.
- A subagent extension must forward `--read-only` and `--remote-read-only`. It must
  also prevent per-call guard opt-outs.
- `herdr:blocked` is an optional notification for UI consumers. It does not
  authorize anything.

## Classifier telemetry

The classifier status is disabled, skipped, failed or complete. The nine labels are
independent:

`local_state_change`, `outbound`, `egress`, `remote_state_change`,
`delegated_execution`, `exposes_secrets`, `destructive`, `host_control_change`,
`fetched_or_generated_execution`.

- Raw predictions and applied labels are separate values.
- Selected-label support is not calibrated confidence or measured accuracy.
- A negative prediction for a custom or MCP tool does not prove that the backend is
  safe. Activity does not verify tool metadata.

## Judge telemetry

Activity counts these separately: judge starts, retries, fallback use, observed
requests, answers, generated summaries, summary cache hits and approval choices.

- The configured model and the model that gets the request can differ for virtual
  models.
- A dispatch or payload hook does not prove that a request reached the network.
- Activity counts a stream start or HTTP response only if the adapter exposes it.
- Adapters can retry and route requests without a hook. This can add traffic.
- Unknown counts and costs show as unknown, not as zero.
- Timing samples are limited. They do not guarantee performance.

## Approval counts

An Allow counts as an override only if both conditions are true:

1. The call is still valid after the checks for cancellation, mode and session.
2. The arguments still match what the dialog showed.

A tool failure after Allow is an execution error, not a second block. A summary is
generated text. It never counts as your consent. A questionnaire record needs a
trusted source, the exact pending input and valid answers.

## Limits

- There is no OS sandbox. Activity cannot prove what a backend does.
- Accuracy on real MCP tools is not validated.
- A hostile extension runs in the same Pi process as Activity.
- Pi does not expose every cancelled nested signal to every hook. Pi still applies
  its own cancellation when a tool runs.
- Activity does not record tool outputs or model reasoning traces.
- Judge and summary calls can send private task context to the model provider.

See [privacy](privacy.md) and [configuration](../README.md#configuration).
