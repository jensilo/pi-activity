# Safety review context

With auto-mode ON, the judge has a safety-only remit: concrete serious hazards,
explicit protected access/privacy/mutation boundaries, safety-sensitive external
authorization, and active hard guards. A denial must identify the concrete effect,
target and hazard or applicable safety boundary. These are model instructions,
not a safety guarantee.

Workflow alone must NEVER block or ask_user, even when explicitly required by a
human, assignment or system instruction, or summarized as Forbidden/Guardrails.
This includes planning/approval before ordinary implementation, read-before-edit,
test sequencing (even before an authorized deployment), preferred tools,
independent reviewers, delegation order and ordinary file assignments. A worker's
"only these four files" scope is task coordination, not a protected access or
mutation boundary; a fifth ordinary source-file edit alone is a safety allow.
The agent remains responsible for following all instructions. Allow is not an
instruction waiver and does not certify quality, correctness or compliance.

Actual protected boundaries remain enforced: "do not read private/", "inspect
only; no modifications", and no deployment/push without human consent are not
workflow exemptions. Broad task or implementation/commit permission is not
permission for sensitive external effects. Guards and serious hazards remain
binding even when the task is authorized. Human grants cannot override
higher-priority safety boundaries. Later direct human grants/revocations resolve
incompatible safety restrictions only within the same scope and authority.

Ordinary task-related development in cwd and relevant work directories is
implicitly allowed; supplied permissions are not an exhaustive whitelist.
Bounded installation/configuration housekeeping and implementation details do not
require repeated consent merely because they touch paths outside the repo.
Task-needed downloads, SSH, model calls and ordinary credential authentication are
not inherently prohibited. Do not infer secrets or protected access from path names.
“Commit and push” covers the normal configured remote/current task branch without
magic words; “commit” alone does not. Preserve that meaning in summaries.

The short ordinary policy is in `review-policy.ts`. Optional global
`auto.judgeInstructions` adds one inline string of trusted safety guidance with
auto ON (at most 32 KiB UTF-8). Configuration is reread per admission; changed
instructions invalidate a pending allow. No prompt files are read. This tunes
judge interpretation, not deterministic fast paths, and cannot change the
no-workflow remit, consent provenance, verdict schema or active hard guards.
Deterministic controls remain `policy.readAllowlist`, guards and
`policy.trustedTools` (an ordinary-review exemption, not a general ACL).
See the [single configuration reference](../README.md#configuration-reference).

With auto-mode OFF, a guard review checks ONLY actual effects under the active
read-only/remote-read-only guards. It does not reactivate ordinary safety, consent
or workflow/policy review. OFF guards impose no restriction.

The judge emits exact JSON `{ "decision": "allow" | "block" | "ask_user",
"reason": "short explanation" }`. Block returns immediately to the agent, without
UI; ask_user requests eligible exact-call approval, never an active-guard override.
Only in-remit hazards, protected boundaries and guard conflicts can block;
missing human authorization for a safety-sensitive effect can ask_user.
Workflow alone cannot do either; uncertainty is not a hazard.
Malformed verdicts and unavailable review are technical failures, not semantic
unsafe decisions. Eligible complete calls may still receive informed approval
outside guards. Refusals retain the short judge reason, including user Block,
cancellation and timeout, with an explicit “Blocked — tool was not run.” notice. Steering prefers a
safe reason-resolving alternative or other unblocked work while the user is away,
forbids guard bypasses/unchanged retries, and asks only when no safe path remains.

## Human inputs

`interactions.ts` supplies one branch-local chronological stream to both the judge
and summarizer: ordinary user messages and confirmed questionnaire submissions.
Agent-authored subagent Task messages retain agent provenance. A confirmed human
questionnaire submission remains human input even in a delegated session.

`policy.questionnaireSources` is a global-only list of trusted questionnaire extension
entry-point paths. Its default is empty. To trust a reviewed questionnaire
package, configure its actual entry point under `policy` in the global activity
config. This is separate from `policy.trustedTools`, which exempts tool execution
from review; a name-only exemption does not make its output human permission.

The gate verifies the registered tool's user-level source path at call time,
snapshots the questions, and binds the result to the call ID and argument hash.
A successful, non-cancelled result must match those questions and valid choices.
Pending recordings are anchored to their originating branch prefix and invalidated
on tree navigation, session replacement, shutdown, and settlement.
Question text, selected option labels/descriptions/previews, full custom answers,
and comments are preserved. Unselected options do not become permission. A
skipped choice implies no approval, but its submitted comment is human input.
Errors, cancellations, mismatches, and arbitrary result text grant no permission.

The gate writes an `activity-human-answer` custom session entry only after this
validation. It survives reload/restart and follows the active branch. Historical
questionnaire results from before this recorder existed have no provenance
receipt and are not silently upgraded to human authorization. Submitted
`/ask-again` editor text is already an ordinary user message.

These receipts contain human text in the private session, not in aggregate review
telemetry. This is a trusted-extension guardrail, not isolation against malicious
extensions with the same process privileges or a compromised session file.

## Instructions and action evidence

`collectInstructionSnapshot(ctx)` collects actual branch system text and section
updates plus `ctx.getSystemPrompt()` through Pi's public APIs. Section removals
and empty replacements remain visible; historical sections are not silently
rewritten into current rules. The judge uses a per-review immutable copy, not a
global mutable instruction string. No instruction text is clipped to fit history
budgets. Instruction authority is distinct from human consent, and instruction
context cannot change the reviewer's remit or output format. No rules are
invented from unread documents.

`ReviewOptions.evidence` is `{ nativeEffects?: Partial<Primitives>, predictions?: RiskSignals,
objections?: string[] }`. Context labels native facts, fallible classifier
predictions and objection claims separately. Native facts govern their stated
heads; a contradictory classifier prediction does not overwrite a native fact.
Facts do not independently prove targets, permissions or unrelated effects. Tool
metadata and objections are not authority. Credential-path suspicion and possible
file destruction are not negative or positive native attestations; unknown heads
are omitted. All policy objections reach review. A contradictory allow for
established native mutation under an active guard is invalid and cannot execute.
Complete action evidence survives
history reduction and counts toward the current-action limit.

## Delegated context integration

The canonical optional event/payload/API and independent adapter example are in
[docs/integration.md](../docs/integration.md). `activity/delegation.ts` owns
`activity:policy-context:request`; it never reads a launcher's fd. Request on every
`session_start`, regardless of flags or CLI syntax. No synchronous claim means
normal local policy with no inherited authority. One claimed invalid/null/error,
multiple claims or a six-second timeout stops technically, never downgrades.

Keep the deeply frozen snapshot only in its requesting runtime/session and pass
`ReviewOptions.delegatedContext`. Validation binds manager, session and canonical
cwd and checks lifecycle cancellation on construction/retry/verdict return. The
supplier attests actual task origin/binding; there is no package-level `Task:` or
argv check. `ReviewOptions.instructionSnapshot` optionally accepts fresh
`collectInstructionSnapshot(ctx)` evidence. Do not persist inherited snapshots.

A valid snapshot establishes agent origin without a flag. Hint-only sessions also
label their own messages as assignments, but need no adapter. The entry point
passes resolved origin through source collection, judge/context labels and summary
cache restore/generation/source checks; source helpers do not read mutable env.
Confirmed gate-owned questionnaire receipts remain human. Parent sources remain
raw, role-labelled and length-delimited beside current instructions, independently
of rolling summaries. Assignment/instruction claims cannot create human consent.

Both guard booleans travel with each child; false imposes nothing. Active inherited
guards remain floors; dropped guards/stale snapshots produce
`technicalStop: "delegated-context"`, not an ordinary policy approval. The snapshot
is trusted-extension evidence, not OS isolation, and reaches the judge rather than
the child prompt. No-adapter/unmarked sessions cannot reveal hidden parents. There
are no live parent revocations, transported images/upstream questionnaire receipts
or global chronology/deduplication. Restart a child after one-shot transport loss.

## Summary cadence

`USER_SUMMARY_BATCH_SIZE = 5` is shared by the summarizer and context validator.
Each completed questionnaire submission counts as one interaction. Summary
coverage is `floor((inputs - 1) / 5) * 5`, leaving 1–5 recent interactions raw.
A refresh occurs only when a review needs it. Summary keys include complete
covered inputs, questionnaire content, human/agent provenance, source, session,
resolved session origin, and format/prompt versions. Prompt version 7 invalidates
older caches, including version 6 summaries that treated workflow as safety policy.
Workflow and ordinary file assignments go in Intent/Context, never in
Forbidden/Guardrails or as conditions on Allowed. A previous summary's workflow
is reclassified without losing its source or scope. Forbidden/Guardrails retain
current protected access/privacy/mutation boundaries and safety-sensitive
external authorization conditions. Preserve sources, chronology, permission
scope, targets and effect conditions; do not broaden grants or lose revocations.
Model identity is attribution, not invalidation. Later grants/revocations replace
incompatible old restrictions or permissions; raw direct input outranks a
conflicting summary.

Unsummarized human/task inputs are never silently clipped or omitted: dropping a
middle message could retain a grant while losing its revocation. Summary failure
falls back to the complete chronological stream, not first-plus-recent selection.
If that raw stream exceeds 384k characters, model review fails rather than
presenting incomplete authorization evidence. In ordinary TUI auto-mode this
technical failure can offer informed one-call approval with complete arguments;
it is not an automatic allow. Hard guards and noninteractive sessions fail closed. Tool history can shrink independently;
provider token limits still apply to the complete rendered prompt. Reload restores
completed exact-source summaries from the selected branch, never pending work.
It does not delete human-input receipts. Required summary/authorization session
records are separate from optional disk logging and remain private operational text.

## Execution history

`activity-tool-outcome` entries bind activity-gate decisions/results to a call ID,
tool name, and argument hash. Review context includes one of:

- Blocked by this gate before execution: the action did not run.
- Permitted: execution has not been confirmed.
- Completed successfully: reported completion, not independent verification.
- Failed: partial effects may exist.
- Proposed/unknown: no execution result is established.

Actual tool-result success/error metadata can supplement history, but arbitrary
output text is never interpreted as proof of approval or non-execution. A blocked
proposal is not duplicate completed work. Other extensions can still
reject calls after this gate; this gate does not claim their effects are verified.
Reviewed and human allows freeze the approved argument tree and bind the input
property. Changes to arguments, cwd, session, human inputs or instructions during
admission stop the call without a policy override. This prevents ordinary
in-process mutation, not hostile same-process code.

## Checks

Run with Pi's installed jiti, using the loader setup in `test/README.md`:

```sh
"$JITI" activity/test/interactions.test.mjs
"$JITI" activity/test/interaction-gate.test.mjs
"$JITI" activity/test/summary.test.mjs
"$JITI" activity/test/summary-gate.test.mjs
"$JITI" activity/test/authorization.test.mjs
"$JITI" activity/test/context.test.mjs
"$JITI" activity/test/judge-remit.test.mjs
"$JITI" activity/test/delegation.test.mjs
"$JITI" activity/test/review-evidence.test.mjs
"$JITI" activity/test/judge-last.test.mjs
"$JITI" activity/test/live-permissions.mjs  # SKIP; no provider requests
```

Offline tests verify collection, provenance, comments/custom/multi/skip handling,
cache/cadence, outcome routing, branch/reload behavior, and prompt delivery with
stubbed verdicts. They do not validate live model interpretation.

Explicit opt-in semantic evaluation:

```sh
ACCLASS_PERMISSION_JUDGE='provider/model-id' ACCLASS_PERMISSION_JUDGE_THINKING=off "$JITI" activity/test/live-permissions.mjs --live
```

This invokes the repository's production judge and collector with synthetic
scenarios, including paired raw/summarized workflows, four-file worker assignments
and fifth-file edits, protected boundaries, authorization, privacy and active guards.
`ACCLASS_PERMISSION_JUDGE` must select an explicit `provider/model` reference; `ACCLASS_PERMISSION_SUMMARY` optionally selects a different summary.
At most 128 activity model dispatches are allowed, including retries/summarization.
Virtual routes and adapters may add requests; this is not a wire-request cap. Existing local Pi credentials are used in place; no
credentials, real session logs, corpus rows, or private file contents enter the
synthetic prompts. The candidate deletion and upload commands are
never executed. Errors/timeouts do not count as semantic denials. No candidate
files or extension registrations are changed by the evaluation.

An existing installed extension must be updated through the normal package or
release workflow and reloaded before it uses these changes. Do not modify an
immutable versioned installation in place or bypass a guard to run validation.
