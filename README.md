# Pi Activity

Pi extension for activity monitoring and contextual tool safety review. It is a
guardrail, not an OS sandbox or a safety guarantee.

## Install and first start

Tested with Pi 1.5.0.

Review the source, then install one copy with Pi's package manager:

```sh
pi install git:github.com/jensilo/pi-activity@v1.0.0
```

Use host Git authentication, never credentials in the URL. Run `/reload` after
installation. Do not also load Activity through `-e` or a discovery symlink.
Remove it with `pi remove git:github.com/jensilo/pi-activity@v1.0.0`.

### First start

The first time Pi starts with Activity:

1. Activity creates the configuration file shown below, if the file does not
   exist. It does not change an existing file.
2. Activity looks for acclass in `~/.acclass`. If a valid installation is there,
   Activity uses it and downloads nothing.
3. If not, Activity asks you once whether to install acclass. It uses the network
   only if you accept. It downloads the installer, checks the installer against a
   pinned SHA-256 hash, and runs it.

If you decline, the setup fails, or Pi has no UI, Activity sends the tool calls
that need review to the LLM judge. These calls are never allowed without a check.
Activity does not repair an unsafe or corrupt installation; it uses the judge
instead. To get the install offer again, run `/reload`.

The judge uses your current chat model and its normal Pi login. It needs no
separate setup.

## Configuration reference

Only `<agent-dir>/config/activity.json` is read. The usual path is
`~/.pi/agent/config/activity.json`; `PI_CODING_AGENT_DIR` selects the agent directory.
No local override or project configuration is read. Supplied objects merge with
built-in defaults; arrays replace them. Configuration is reread for each admission.

**v1.0.0 is a clean break:** there is no backward compatibility or automatic
migration. Old classifier/path settings and judge prompt-file settings are rejected.

This is the complete first-start file and [example](activity.example.json):

```json
{
  "acclass": { "enabled": true, "variant": "q8" }
}
```

| Setting | Meaning / default |
| --- | --- |
| `acclass.enabled` | `true`; allow managed local classification. `false` uses judge review where needed. |
| `acclass.variant` | `q8`; only `q8`, `q5` and `fp32` are supported. |
| `auto.judgeModel` | Omit to use `ctx.model`, the current registered chat model. An exact `provider/model-id` selects another registered model; explicit `null` disables the judge. |
| `auto.judgeThinking` | `off`; effort is separate from the model ID. Colons in IDs are literal. |
| `auto.judgeInstructions` | Empty inline string by default; optional trusted safety guidance, at most 32 KiB UTF-8. No prompt files are read. |
| `auto.summaryModel`, `auto.summaryThinking` | Follow the effective judge and its thinking level when omitted; a null summary model also follows the judge. |
| `auto.fallbackJudgeModel` | `null`; no implicit escalation. |
| `guards.readOnly`, `guards.remoteReadOnly` | `false`; configured `true` is a floor that session toggles cannot disable. |
| `policy.readAllowlist`, `policy.trustedTools`, `policy.questionnaireSources` | Empty lists; additional read roots, exact ordinary-review exemptions and reviewed questionnaire source paths. They do not waive active guards or authenticate arbitrary text as consent. |
| `log.enabled`, `reviewLog.enabled` | `false`; separate private, opt-in JSONL logs. Pi session storage remains independent. |

To switch models, set `acclass.variant` to `q5` or `fp32`, then `/reload` and
accept the download offer. To disable acclass, set `acclass.enabled` to `false`;
subsequent calls use the judge where review is needed. No uninstall is required.

The [schema](activity.schema.json) owns the advanced reference for display,
history, session persistence, log rotation and redaction. Do not copy all defaults
into the configuration file. Judge instructions affect judge reviews, not
deterministic fast paths; they cannot change active guards, verdict format,
consent provenance or the safety-only remit. Do not put secrets in them.

acclass paths, daemon settings and download hosting are managed, not public config
knobs. `activity/acclass-setup.ts` owns the release URLs and installer hash pin.
Installer and manifest downloads require HTTPS, omit credentials, limit redirects
and cap response sizes. The installer runs in a private child environment. See
[managed setup](docs/integration.md#managed-acclass-setup) for limits and API details.
The daemon also receives no provider credentials or loader hooks; only valid
numeric thread limits are forwarded. The pinned installer hash and asset hashes
check integrity. The manifest is unsigned: its hash is a transport-based pin,
**not signed publisher provenance**.

Before each classification, the managed provider verifies every installed file
against `INSTALLATION.json` and checks model hashes against the retained release
manifest. It resolves `current` to physical version paths. On first classification
it starts or reuses the compatible daemon on the private, version/variant-specific
`~/.acclass/run/<version>-<variant>/ac.sock`. Verification failure goes to the judge,
not unchecked artifacts. Models and engine binaries are not bundled in Activity.

## Use and safety limits

- `/activity`: Overview, newest-first History and Diagnostics. `/activity details`
  opens Diagnostics. `/bash-history [turn|complete]` and
  `/mcp-history [turn|complete]` filter History. See [UI controls](docs/ui.md).
- `/read-only`, `/remote-read-only`, `/auto-mode`: `on`, `off` or `toggle`.
  Startup flags are `--read-only`, `--remote-read-only` and `--auto`.
- Read-only forbids local and remote mutation. Remote-read-only forbids remote
  mutation. Both stack and cannot be waived by a judge or human Allow dialog.
- `PI_ACTIVITY_AUTO_MODE=off` skips ordinary auto review, never active guards.
  This is an explicit bypass, not evidence of safety.
- The activity row shows turn/session counts and actual admission wait. The
  normal Pi footer and native/custom tool renderers stay unchanged. A proposed
  edit preview is not evidence of execution.

The judge reviews safety, not workflow compliance. Ordinary task-related work,
including needed network access and normal authentication, is allowed unless a
concrete serious hazard or applicable protected boundary requires otherwise.
The coding agent must still follow workflow and file-assignment instructions.
Classifier predictions are fallible evidence; negative custom/MCP predictions
never authorize those calls without review.

The judge returns strict `decision`/`reason` JSON. `block` returns without UI.
`ask_user` and eligible technical review failures can offer complete exact-call
approval in ordinary interactive auto-mode. Allow applies only to the unchanged
call and context. Active guards, invalid configuration, cancellation and stale
calls have no approval override. Without usable review or eligible approval,
calls that need review fail closed. See [approval controls](docs/ui.md#approval).

Activity works standalone. An optional trusted extension can supply inherited
policy context through the [integration contract](docs/integration.md).
Assignments are never human consent; invalid claimed context fails closed.

## Privacy and checks

Logging is off by default, but required authorization receipts and summaries
remain private Pi session data. Judge/summary calls send task context to their
selected provider/router. Read [privacy](docs/privacy.md) before enabling logs.
Never copy real captures, credentials or business data into this repository.

```sh
npm test
npm run pack:check
```

Offline checks use synthetic fixtures, not real logs, providers or live downloads.
The package includes runtime TypeScript and docs; not the installer, engine
binaries, models, tests or tools. Distribution uses Pi's Git package flow, not npm
publishing. `private: true` prevents accidental npm publication. See
[testing](docs/testing.md), [events](docs/events.md) and the
[v1.0.0 release notes](docs/release-v1.0.0.md) for coverage and limits.
