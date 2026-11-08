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

If you decline, the setup fails, or Pi has no UI, the judge checks the calls that
need review. Activity does not repair a corrupt installation; it uses the judge
instead. To get the install question again, run `/reload`.

## How Activity checks a call

1. **Guards.** A guard blocks calls that make changes. The judge and you cannot
   override a guard.
2. **acclass.** This local classifier predicts the effects of a call. Activity uses
   the prediction to skip the judge for harmless calls. A harmless prediction does
   not clear a custom or MCP tool; the judge still checks it.
3. **Judge.** An LLM checks the call for safety and answers `allow`, `block` or
   `ask_user`. It uses your current chat model and Pi login, so it needs no setup.
   It does not check whether the agent follows your workflow.
4. **You.** If the judge answers `ask_user`, Activity shows you the exact call.
   Allow applies to that call only. After `block`, you see no dialog.

If no judge and no dialog are available, the call does not run.
See [approval controls](docs/ui.md#approval).

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

The first start creates this [file](activity.example.json):

```json
{
  "acclass": { "enabled": true, "variant": "q8" }
}
```

Add only the settings that you want to change:

| Setting | Default | Effect |
| --- | --- | --- |
| `acclass.enabled` | `true` | `false` turns off acclass. The judge checks calls that need review. |
| `acclass.variant` | `q8` | Model: `q8`, `q5` or `fp32`. After a change, run `/reload` and accept the download. |
| `auto.judgeModel` | your chat model | `provider/model-id` selects another model. `null` turns off the judge. |
| `auto.judgeThinking` | `off` | Thinking level of the judge. |
| `auto.judgeInstructions` | empty | Your safety guidance for the judge, up to 32 KiB. It cannot change guards. Do not put secrets in it. |
| `auto.fallbackJudgeModel` | `null` | Model to use if the judge fails. |
| `auto.summaryModel`, `auto.summaryThinking` | as judge | Model and thinking level for summaries. |
| `guards.readOnly`, `guards.remoteReadOnly` | `false` | `true` keeps the guard on. A session command cannot turn it off. |
| `policy.readAllowlist` | empty | More folders to treat as readable. |
| `policy.trustedTools` | empty | Tools that skip the judge. Guards still apply. |
| `policy.questionnaireSources` | empty | Trusted questionnaire source paths. |
| `log.enabled`, `reviewLog.enabled` | `false` | Write JSONL logs. |

The [schema](activity.schema.json) lists all other settings. Do not copy the
defaults into your file.

## Privacy

- Logs are off by default.
- Pi still stores your approvals and summaries in the session file.
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
