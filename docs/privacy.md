# Privacy

## Session state is not optional logging

Activity appends branch-local Pi custom records needed to preserve authorization,
tool outcomes, summaries and state. `log.enabled: false` and
`reviewLog.enabled: false` disable the separate JSONL loggers, **not Pi session
storage**. Pi also stores its normal conversation and tool events independently.
Do not assume logging-off means no private session data exists.

- `activity-state`: optional persisted modes.
- `activity-observations`: optional bounded aggregate snapshots and sanitized
  history previews/verdict explanations. No full MCP argument/result dumps or
  reasoning traces. Redaction is best effort; these records remain private.
- `activity-tool-outcome`: execution/blocked receipts with input hashes, not tool
  output. Blocked means no execution; failed results may have partial effects.
- `activity-human-answer`: validated human questionnaire text and provenance.
- `activity.user-summary-cache`: completed validated rolling summaries, with
  covered source identity/provenance and format/prompt versions.

Authorization receipts and summaries contain **private operational text**. They
are not anonymized analytics or training material. Summaries preserve exact
permission scopes, targets and conditions. Model identity is attribution only:
changing a judge/summarizer model does not invalidate an otherwise exact-source
summary. Changed source, branch/session, provenance or summary versions do.
Pending work is never restored as completed. `session.persistModes` and
`session.persistActivity` control their optional snapshots and summary cache,
not the required authorization receipts. Keep Pi sessions private outside every Git worktree.

Configured reviewer/summarizer calls send bounded task context to that model's
provider/router. Activity never uploads logs. Review your provider's privacy
terms separately; disabling logs does not make external review local.

## Opt-in private JSONL logs

Both loggers are off by default. Enabling `log.enabled` alone produces decision
metadata in `redacted` mode; it does not enable action capture. These mode names
are retained for compatibility:

- `redacted`: metadata-only action decisions.
- `full`: **sanitized**, not raw, action capture. Includes Bash commands, paths,
  evaluated custom/MCP arguments and available metadata. Never includes built-in
  write/edit bodies. The genuine outer codemode wrapper is metadata-only;
  evaluated nested actions are handled independently.
- Review logs are metadata-only regardless of action-log mode.

Neither logger captures tool output, referenced file contents, raw user history,
provider response text, or model reasoning traces. Histories keep bounded
sanitized previews and verdict explanations, with explicit truncation, in memory
and optional branch-local session snapshots. Logging and UI failures
must not authorize an action or change routing.

All modes scrub before writing. Baseline scrubbing cannot be disabled. A private
`redaction.literalsFile` adds exact strings from a JSON array of nonempty strings.
Missing, malformed or unsafe configured dictionaries disable logging without a
raw fallback. Scrubbing is best effort, **not anonymization of arbitrary business
data**. Even scrubbed captures remain strictly private and must not be published.

Default files are under `~/.local/share/pi-activity/private/`, outside this package.
Files use `0600`, directories `0700`; unsafe Git-worktree/symlink storage is refused.
Use only paths outside every Git worktree, including ignored directories. Limits
bound each file and queued data: oversized actions become marked metadata,
oversized metadata/queue overflow is dropped. Drops are process-local telemetry,
not guaranteed permanent accounting. Shared writers use a bounded directory
lock; stop all relevant writers before manually removing an orphan lock.

## Audit and publication boundary

`node tools/audit_activity.mjs` locally reads review logs from the private default
folder, or explicit files, and emits fixed-category aggregate counts. It never
prints action samples, user text, call IDs or free-form reviewer reasons. Do not
send private logs to a model provider. Tests invoke it only against synthetic
fixtures in isolated homes; `npm test` never audits your real log folder.

Never copy real logs, runtime arguments, credentials, business data or sanitized
captures into this worktree, its ignored directories, drafts or package artifacts.
Only reviewed source, synthetic fixtures and reviewed aggregate metadata may be
committed/released. Inspect exact staged files and package inventory; ignore rules
are not protection. There is no automatic evaluation/training ingestion. Later
exports need deliberate private sanitization and independent review outside this
repository. Activity log cleanup does not authorize modifying Pi sessions, MCP
records, provider data or research archives.
