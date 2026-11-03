# Privacy

## What the session file stores

`log.enabled: false` and `reviewLog.enabled: false` turn off the JSONL logs only. Pi
still stores its conversation and tool events. Activity adds these records to the
session file for the branch:

| Record | Content |
| --- | --- |
| `activity-state` | Optional: saved modes |
| `activity-observations` | Optional: limited totals, sanitized previews and verdict explanations. No full MCP arguments or results. No reasoning traces. |
| `activity-tool-outcome` | Ran or blocked, with input hashes. No tool output. |
| `activity-human-answer` | Validated questionnaire text and its source |
| `activity.user-summary-cache` | Validated summaries, with source identity and versions |

- `session.persistModes` and `session.persistActivity` control the optional records
  and the summary cache. They do not control the approval records that Activity needs.
- These records contain private text. They are not anonymous. Summaries keep exact
  permission scopes, targets and conditions.
- A blocked call did not run. A failed result can have partial effects.
- Redaction is best effort.
- A changed source, branch, session or summary version invalidates a summary. A
  changed model does not.
- Pending work is never restored as completed.
- Keep Pi sessions outside every Git worktree.

## What goes to the model provider

Judge and summary calls send limited task context to the provider or router of that
model. Turning off logs does not stop this. Read your provider's privacy terms.
Activity never uploads logs.

## JSONL logs

Both logs are off by default.

| Log | Setting | Content |
| --- | --- | --- |
| Action log | `log.enabled`, `log.mode: "redacted"` (default) | Decision metadata only |
| Action log | `log.enabled`, `log.mode: "full"` | Also sanitized Bash commands, paths, evaluated custom and MCP arguments, and available metadata |
| Review log | `reviewLog.enabled` | Metadata only, in every mode |

The logs never contain:

- tool output or file contents
- raw user history
- provider response text or model reasoning traces
- the bodies of built-in file writes and edits

The outer codemode wrapper logs metadata only. Activity logs the calls inside it
separately. A logging or UI failure cannot allow a call or change its route.

### Scrubbing

- Activity scrubs all records before it writes them. You cannot turn this off.
- `redaction.literalsFile` adds exact strings, from a JSON array of nonempty strings.
- If this file is missing, malformed or unsafe, Activity turns off logging. It does
  not write raw data.
- Scrubbing is best effort. It does not anonymize business data. Do not publish
  scrubbed logs.

### Storage

- The default folder is `~/.local/share/pi-activity/private/`.
- Files have mode `0600`. Folders have mode `0700`.
- Activity refuses a path inside a Git worktree, also if a symlink leads there.
- A log path must be a regular file, not a symlink.
- Size limits apply to each file and to queued data. An oversized action record
  becomes marked metadata. Activity drops oversized metadata and queue overflow.
- Drop counts last for the current process only.
- Writers share a directory lock. Stop all writers before you remove a leftover lock.

## Audit tool

`node tools/audit_activity.mjs` reads review logs from the default folder, or from
files that you name. It prints fixed-category counts only. It never prints action
samples, user text, call IDs or reviewer reasons. `npm test` uses synthetic files and
never reads your log folder.

Do not send logs to a model provider. Do not copy logs, runtime arguments, credentials
or business data into this repository.
