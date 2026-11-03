# Events and observation limits

Activity uses Pi extension hooks, not shell/process tracing. The gate returns a
block from `tool_call`; display, persistence and telemetry are advisory and cannot
replace enforcement.

| Hook | Meaning |
| --- | --- |
| `session_start`, `session_tree` | Restore selected branch state, invalidate pending work |
| `before_agent_start`, `agent_settled` | Open/close the observed activity window; append pending guard instructions before input |
| `turn_end`, `session_compact` | Synchronize guard instructions before queued/tool continuations and after compaction |
| `cache_warming_decision` | Pause cache warming while authoritative mode instructions are pending |
| `tool_call` | Proposed complete evaluated call; enforce policy/review before execution |
| `tool_execution_start` | Submission/start event, **not proof execute was entered** |
| `tool_result` | Executed-tool result receipt; count execution, never retain output |
| `tool_execution_end` | Completion event alone cannot distinguish rejection/cancellation |
| `user_bash` | User submission, not confirmed shell execution and not activity-gated |
| `message_end` | Match branch-local Bash result receipts without retaining output |
| `session_shutdown` | Cancel pending consumers, checkpoint, stop supervised backend, flush opted-in logs |

Nested tool calls are observed by their actual evaluated arguments and call IDs.
Only a genuine built-in outer codemode wrapper is exempt; nested actions remain
gated. Failed validation/lookup/start events cannot inflate execution counts.
Duplicate receipts do not double-count; abandoned pending work is interrupted,
not a fabricated success. Host-provided execute durations on `tool_execution_end`
enrich confirmed results, including nested calls, without recounting execution or
errors. Missing durations remain unknown; submission-to-result time is not a
substitute. Late completions from a replaced session/tree are ignored.

## Counts and history

Footer counts show current-turn values with session totals in parentheses:
`files:N(T) sh:N(T) MCP:N(T) blk:N(T)`. Successful file writes/edits count as files;
confirmed Bash and provenance-identified MCP execution include errors. Other
custom tools remain visible in history without being relabelled as MCP. A final gate block counts
once, regardless of local/reviewer/UI route. A prefilter review candidate is not
itself a final block. User Bash result receipts can be synthesized by interceptors;
without host execution provenance they remain "execution unknown" and do not
pretend to prove a shell ran.

`/activity` shows dashboard and telemetry; `/activity details` expands independent
head statistics. `/bash-history` and `/mcp-history` accept `turn` or `complete`.
Previews and verdict explanations are sanitized, explicitly truncated and stored
in optional branch-local session snapshots. MCP arguments/results and reasoning
traces are never history previews. Missing old
snapshots, retention limits and interrupted observations can leave incomplete
coverage. Do not infer historical zero from absent data.

## Decision notifications

`pi.events` emits `activity:decision` once per final gated call. Version 1 contains
`version`, loaded `packageVersion`, `callId`, fixed tool `category`, effective
`modes`, final `verdict`, `route` and a fixed `reason` code. Optional `classifier`
data projects input category/status, nine predictions/scores, applied heads and
timings. Optional `judge` data reports outcomes, durations, attempts/retries,
observed provider requests/dispatches and explicit fallback use.

No arguments, outputs, user text, free-form explanations or reasoning traces are
emitted. Unknown reasons are `unknown`, not arbitrary text. Events are
observational, never approval tokens or a way to waive hard guards. Consumers
must tolerate unknown future fields/versions. The TypeScript projection is
`DecisionObservation` in `activity/observations.ts`.

## State broadcast

`pi.events` emits `activity:state`:

```ts
{ readOnly: boolean, auto: boolean, guards: { remoteReadOnly: boolean } }
```

These are effective modes, including global guard floors. Other extensions may
consume them; Activity does not certify that a child/backend inherits protection.
Delegation receives constrained review under active guards, just like other
custom calls. A cooperating subagent extension must forward `--read-only` and
`--remote-read-only` as appropriate and prevent call-level guard opt-outs.
`herdr:blocked` is an optional blocked-state notification for UI consumers, not an
authorization API.

## Classifier and model telemetry

Classifier results distinguish disabled/skipped/failed/complete evidence. The
nine independent heads are `local_state_change`, `outbound`, `egress`,
`remote_state_change`, `delegated_execution`, `exposes_secrets`, `destructive`,
`host_control_change`, and `fetched_or_generated_execution`. Raw predictions and
applied policy signals are separate. Selected-label support is not calibrated
confidence or measured accuracy. Negative custom/MCP predictions are not proof
that a backend is safe; metadata remains unverified and effects incomplete.

Judge starts, retry/fallback work, observed request evidence, response outcomes,
summary generation/cache hits and approval choices are distinct quantities.
Configured model identity and observed physical dispatch identity need not match
for virtual models. Dispatch/payload hooks do not prove a wire request; stream-start
or HTTP-response evidence is observed only where adapters expose it. Adapter-owned
retries/routing can add traffic without universal hooks. Unknown counts/costs are
not zero. Timing samples/percentiles are bounded observations, not exhaustive
performance guarantees.

An Allow choice counts as an effective override only if the action is still
admitted after cancellation/mode/session-generation checks and its arguments still
match the complete evidence shown. A tool failure after Allow is an execution
error, not a second gate denial. Summaries are generated evidence, never
new human consent. Questionnaire receipts require a trusted source, exact pending
input and valid submitted answers.

## Limits

There is no OS sandbox, backend attestation or validated real-MCP accuracy claim.
A hostile extension runs in the same trusted Pi process. Pi does not expose every
independently cancelled nested signal to every hook; host execution cancellation
still applies. Tool outputs and model reasoning traces are deliberately not
recorded. Review/summary calls can transmit private task context to their selected
provider. See [privacy](privacy.md) and the
[configuration reference](../README.md#configuration-reference).
