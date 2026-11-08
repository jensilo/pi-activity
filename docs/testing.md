# Testing

## Offline checks

The tests target Pi 1.5.0 and use your installed Pi with jiti. They need no dependency
install, acclass checkout, engine or model download, or live provider.

```sh
npm test             # synthetic tests, tool fixtures and package inventory
npm run test:unit    # activity/test/*.test.mjs
npm run test:tools   # tool fixtures, live-tool SKIPs and inventory
npm run test:sdk     # standalone SDK fixture
npm run pack:check   # exact npm pack dry-run inventory; no archive
```

- The runner uses a synthetic HOME and agent directory. It turns off background
  network work and clears live-test overrides.
- Tests use stub models, inert SDK and MCP tools, local sockets and synthetic
  installation files.
- Tests never run proposed hazardous commands. Fixed inert shell fixtures and local
  test processes can run.
- Tests use no real logs, user MCP servers or live downloads.
- The package excludes the installer, tests, tools, engines and models.

`npm test` finds Pi in this order: `PI_GLOBAL`, the managed install in `~/.pi/agent`, then
`npm root -g`. For single tests and manual tools, set `PI_GLOBAL` to the Pi package root.
For a managed install:

```sh
export PI_GLOBAL="$HOME/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)/node_modules/@earendil-works/pi-coding-agent"
JITI="$PI_GLOBAL/node_modules/.bin/jiti"
if [ ! -x "$JITI" ]; then JITI="$(dirname "$(dirname "$PI_GLOBAL")")/.bin/jiti"; fi
export NODE_PATH="$(dirname "$(dirname "$PI_GLOBAL")"):$PI_GLOBAL/node_modules${NODE_PATH:+:$NODE_PATH}"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--conditions=import"
```

## Test groups

`activity/test/run.sh` finds the test files automatically.

| Tests | Check |
| --- | --- |
| `acclass-setup` | Consent before downloads, HTTPS and size limits, rejection of a wrong installer hash, scratch files, existing installations, cancellation, judge fallback. Fetch and spawn are mocks. |
| `managed-runtime` | First-start configuration, one question per runtime, no download after decline or without UI, `/reload`, model selection, shutdown cancellation |
| `config-*`, `standalone` | One global file, ignored local and project files, settings, model lookup, defaults |
| `review-policy*`, `inline-policy-gate` | Judge instructions, prompt composition, auto mode off keeps guards |
| Gate, guard, `judge-last` | Native effects and predictions, unknown custom and MCP effects, exact-call approval, cancellation, blocks after technical failures, no override of guards |
| Approval, UI, renderer | Paged dialog, timer, one dialog at a time, resize, keys, unchanged tool rendering, refusal reasons |
| Interaction, delegation, summary | Questionnaire sources, parent context, branch restore, summary caches |
| Privacy, audit | Synthetic paths, scrubbing, storage failures, aggregate output |
| `panel`, `display`, `host-ui` | Terminal sizes, tabs, keys, Unicode, resize, the host footer and overlay |
| `ui-accounting`, `guard-wait` | Command routing, widgets, cleanup, overlapping waits, restore, interruptions |

The standalone SDK fixture uses Pi's real model registry and tool sources, a keyless
synthetic provider and inert local tools. It checks blocked and cancelled calls,
provider hooks, storage, reload and branch restore. It uses no real provider or backend.

These tests check behaviour, not model accuracy or speed. Pi 1.5.0 runs top-level tool
checks one at a time. The tests do not change this.

## Optional real inference

These commands need a compatible Q8 installation. They do not test the managed
download. The managed download was tested live once, for v1.0.0 on Linux x86_64. See
[the v1.0.0 release notes](release-v1.0.0.md).

```sh
"$JITI" tools/test_activity_engine_e2e.mjs --live
node tools/test_activity_mcp_live.mjs --live
"$JITI" tools/bench_activity_runtime.mjs --live
```

| Variable | Effect |
| --- | --- |
| `ACCLASS_TEST_BINARY`, `ACCLASS_TEST_MODEL` | Replace `~/.acclass/bin/acclass` and `~/.acclass/model` |
| `ACCLASS_TEST_EXTENSION_ROOT` | Selects another package source root |
| `ACCLASS_BENCH_REPEATS` | `1..100`, default 10 |
| `ACCLASS_BENCH_OUT` | `.json` report path outside every Git worktree |

- These variables work for test tools only.
- Missing or incompatible files make the test fail.
- The judge is a fixed stub here, and MCP uses an inert local server. The results say
  nothing about judge quality or real MCP safety.
- Benchmarks use fixed synthetic calls. Reports can contain host paths, so do not
  publish them. Warm-cache latency is not a production performance value.

## Optional live judge

Run these only after you agree to send synthetic context through your Pi login.

```sh
ACCLASS_TEST_JUDGE='provider/model-id' ACCLASS_TEST_JUDGE_THINKING=off \
  "$JITI" tools/test_activity_judge_live.mjs --live
ACCLASS_PERMISSION_JUDGE='provider/model-id' ACCLASS_PERMISSION_JUDGE_THINKING=off \
  "$JITI" activity/test/live-permissions.mjs --live
```

| Command | Needs | Model calls |
| --- | --- | --- |
| `test_activity_judge_live` | Real Q8 inference | At most 8 |
| `live-permissions` | No classifier | At most 128, including summaries and retries |

Routers and adapters can add requests beyond these limits. The tool's registry must
know the model. The tool does not load external routing extensions.

| Variable | Effect |
| --- | --- |
| `ACCLASS_PERMISSION_SUMMARY`, `ACCLASS_PERMISSION_SUMMARY_THINKING` | Summary model and thinking level. Default: same as the judge. |
| `ACCLASS_PERMISSION_START` | First case, zero-based, inclusive |
| `ACCLASS_PERMISSION_END` | Last case, exclusive |
| `ACCLASS_PERMISSION_MAX_DISPATCHES` | Positive, at most 128 |

A batch does not test the full suite. A failed judge or summary call is a technical
failure, not a block. A passed live check does not guarantee future safety.

## Audit tool

`node tools/audit_activity.mjs [private-review-files...]` prints fixed-category counts.
Its default folder is `~/.local/share/pi-activity/private`. `npm test` uses synthetic
files and never reads that folder. Unknown values stay unknown, not zero. See
[privacy](privacy.md) and [events](events.md).
