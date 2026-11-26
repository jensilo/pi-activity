# Pi Activity

Pi Activity is an extension for the Pi coding agent. It shows what the agent does
and checks tool calls before they run.

It is a guardrail. It is not an OS sandbox, and it does not guarantee safety.

## Install

From npm:

```sh
pi install npm:@jensilo/pi-activity@1.0.1
```

Or from GitHub:

```sh
pi install git:github.com/jensilo/pi-activity@v1.0.1
```

Then run `/reload` in Pi. Tested with Pi 1.5.0.

- Read the source before you install.
- Install one copy only. Do not also load Activity with `-e` or a symlink.
- For a Git install, use your normal Git login. Do not put credentials in the URL.

To remove it, use the same source: `pi remove npm:@jensilo/pi-activity@1.0.1` or
`pi remove git:github.com/jensilo/pi-activity@v1.0.1`.

## First start

The first time Pi starts with Activity:

1. Activity creates the configuration file, if the file does not exist. It does
   not change an existing file.
2. Activity looks for acclass in `~/.acclass`. If a valid installation is there,
   Activity uses it and downloads nothing.
3. If not, Activity asks you once whether to install acclass. It uses the network
   only if you accept. It downloads the installer, checks the installer against a
   pinned SHA-256 hash, and runs it.

If you decline, setup fails, or Pi has no UI, Activity uses the configured judge
for calls that need review, or blocks them if no judge is available. Activity does
not repair a corrupt installation. To get the install question again, run `/reload`.

## How Activity checks a call

1. **Guards.** A guard blocks calls that make changes. The judge and you cannot
   override a guard.
2. **acclass.** This local classifier predicts the effects of a call. Activity uses
   the prediction to skip the judge for harmless calls. A harmless prediction does
   not clear a custom or MCP tool; the judge still checks it.
3. **Judge.** A Pi chat model or decision classifier checks the call for safety and
   returns `allow` or `block`. It does not check whether the agent follows your workflow.

Calls that need review do not run when the judge is missing, unavailable, or
returns `block`. There is no tool approval dialog. User messages and trusted
questionnaire answers can still supply authorization evidence to the judge.

## Commands

| Command | Effect |
| --- | --- |
| `/activity` | Open the panel: Overview, History, Diagnostics |
| `/activity details` | Open Diagnostics |
| `/bash-history [turn\|complete]` | Show shell calls in History |
| `/mcp-history [turn\|complete]` | Show MCP calls in History |
| `/read-only on\|off\|toggle` | Block local and remote changes |
| `/remote-read-only on\|off\|toggle` | Block remote changes |
| `/auto-mode on\|off\|toggle` | Turn automatic checks on or off |

Startup flags: `--read-only`, `--remote-read-only`, `--auto`.

`PI_ACTIVITY_AUTO_MODE=off` skips the normal checks. Guards stay active. This is a
bypass, not a sign that a call is safe.

See [UI controls](docs/ui.md).

## Configuration

Activity reads one file: `~/.pi/agent/config/activity.json`. `PI_CODING_AGENT_DIR`
changes the agent directory. Activity reads no project configuration, and it
rejects old classifier, path and prompt-file settings.

The first start creates a minimal config:

```json
{
  "acclass": { "enabled": true, "variant": "q8" }
}
```

The [example config](activity.example.json) shows how to disable the judge
explicitly. To use the current chat model in full or short mode, omit
`auto.judgeModel`. To use a classifier, select the classifier backend (or cascade
mode) and set `auto.judgeModel` to its exact `provider/model-id`. Add only the
settings you want to change:

| Setting | Default | Effect |
| --- | --- | --- |
| `acclass.enabled` | `true` | `false` turns off acclass. Calls that need review use the configured judge or block. |
| `acclass.variant` | `q8` | Model: `q8`, `q5` or `fp32`. After a change, run `/reload` and accept the download. |
| `auto.judgeModel` | current model for chat; unconfigured for classifier | A registered chat model or an exact classifier `provider/model-id`, depending on the backend. Set `null` to disable the judge without disabling deterministic checks. |
| `auto.judgeBackend` | `chat` for full/short; `classifier` for cascade | Full and short accept either backend. Cascade accepts only `classifier`. |
| `auto.judgeMode` | `full` | `short` skips summaries and prior calls and packs human context as compact, length-delimited text. `cascade` sends the latest user message first. A block or an allow below 60% triggers a second review with a cached summary of guidance and earlier messages. In auto mode, even a high-confidence allow triggers a second review if the quick pass omitted earlier user input or instructions. All modes preserve complete action arguments. |
| `auto.judgeMaxChars` | 32,000 in short and cascade modes | Character limit on Activity's request content, before provider formatting. Full mode without this setting keeps its history guideline. This is not a token limit. |
| `auto.judgeInstructions` | empty | Your safety guidance for the judge, up to 32 KiB. It cannot change guards. Do not put secrets in it. |
| `auto.fallbackJudgeModel` | `null` | Optional model on the same backend for technical review failures, not to override a valid final decision. |
| `auto.judgeThinking`, `auto.fallbackJudgeThinking` | `off`, then inherits judge thinking | Thinking levels for the chat judge and its fallback. Classifier decisions ignore these settings. |
| `auto.summaryModel`, `auto.summaryThinking` | by mode | Summaries use chat models. Cascade defaults to the current chat model with `low` thinking. Full mode defaults to the chat judge and its thinking level, or raw history if using a classifier without a summary target. Short mode does not summarize. |
| `auto.fallbackSummaryModel` | `null` | Optional chat model to try when the summary model fails. In cascade, the current chat model with `low` thinking is also available as a summary fallback. |
| `guards.readOnly`, `guards.remoteReadOnly` | `false` | `true` keeps the guard on. A session command cannot turn it off. |
| `policy.readAllowlist` | empty | More folders to treat as readable. |
| `policy.trustedTools` | empty | Tools that skip the judge. Guards still apply. |
| `policy.questionnaireSources` | empty | Trusted questionnaire source paths. |
| `log.enabled`, `reviewLog.enabled` | `false` | Write JSONL logs. |

Chat judges return a structured verdict with a reason. Classifier judges return
a typed choice without a generated rationale. Classifier mode never switches to
a chat model for a decision.

Judge and summary calls use the model transport's normal timeouts, if any. Activity
sets no overall deadline. Each can retry transient failures up to five times with
backoff and honors `Retry-After`. Both cascade decision passes share one judge retry
budget. Cancelling the turn stops the review and any pending retry.
Short mode keeps the complete action and prioritizes the latest input, then the first,
then intervening inputs newest-first. If human/task history or system instructions do
not fit, short mode can report a denial but cannot authorize the action.

The [schema](activity.schema.json) lists all other settings. Do not copy the
defaults into your file.

## Privacy

- Logs are off by default.
- Pi still stores user messages, trusted questionnaire evidence and summaries in the session file.
- Judge and summary calls send task context to the model provider.
- Activity runs acclass locally and gives it no provider credentials.

See [privacy](docs/privacy.md).

## Integration

Activity works alone. Another extension can give it the rules of a parent task.
See [integration](docs/integration.md), which also covers how Activity installs
and checks acclass.

## Development

```sh
npm test
npm run pack:check
```

The tests run offline with synthetic data. Never copy real logs, credentials or
business data into this repository. See [testing](docs/testing.md) and
[events](docs/events.md).

## License

[Apache 2.0](LICENSE).
