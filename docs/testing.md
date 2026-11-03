# Testing

## Offline checks

Tests target Pi 1.5.0 with jiti. Use an existing host installation. No dependency
install, acclass checkout, engine/model download or live provider is needed.

```sh
npm test             # synthetic tests, tool fixtures and package inventory
npm run test:unit    # activity/test/*.test.mjs
npm run test:tools   # tool fixtures, live-tool SKIPs and inventory
npm run test:sdk     # standalone SDK fixture
npm run pack:check   # exact npm pack dry-run inventory; no archive
```

The runner uses an isolated synthetic HOME/agent directory, disables host
background network work and clears live-test overrides. Tests use stub models,
inert SDK/MCP tools, local sockets and synthetic installation files. Proposed
hazardous commands are never executed. Fixed inert shell fixtures and local test
processes can run. No real activity logs, user MCP servers or live downloads are
used. Only reviewed source, docs and synthetic config belong in the package.
The installer, tests, tools, engines, models and private data are excluded.

For a host outside `npm root -g`, set `PI_GLOBAL` to its installed package root.
For individual tests and explicit manual tools:

```sh
export PI_GLOBAL="${PI_GLOBAL:-$(npm root -g)/@earendil-works/pi-coding-agent}"
JITI="$PI_GLOBAL/node_modules/.bin/jiti"
if [ ! -x "$JITI" ]; then JITI="$(dirname "$(dirname "$PI_GLOBAL")")/.bin/jiti"; fi
export NODE_PATH="$(dirname "$(dirname "$PI_GLOBAL")"):$PI_GLOBAL/node_modules${NODE_PATH:+:$NODE_PATH}"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--conditions=import"
```

## Main regression coverage

- `acclass-setup.test.mjs`: synthetic manifest, installer and installation bytes;
  consent before downloads; HTTPS-only bounded fetches; pinned installer hash
  rejection before writes or spawn; the 1 MiB installer cap; private scratch files;
  existing-install validation, cancellation and judge fallback. Fetch and spawn
  mocks keep all checks offline. A test-only dependency supplies a synthetic hash.
  Upstream acclass owns installer-internal and CLI tests.
- `managed-runtime.test.mjs`: brief exclusive first-start config, one setup offer
  per runtime, no download on decline/no UI, reload retry, current-model selection,
  explicit null, shutdown cancellation and internal adapter injection.
- `config-loader`, `config-models`, `config-policy`, `standalone`: one global file,
  ignored local/project files, managed settings, registry resolution and defaults.
  The published example is intentionally brief, not a full defaults dump.
- `review-policy`, `inline-policy-gate`, `review-policy-options`: inline instruction
  validation, prompt composition, changed guidance invalidating pending allows and
  auto OFF retaining guards. Historical test filenames do not imply prompt-file
  support.
- Gate, guard and `judge-last` fixtures: actual native effects versus fallible
  predictions, unknown custom/MCP effects, constrained review, exact-call/context
  binding, cancellation and fail-closed technical stops. Guards have no human
  override; ordinary eligible calls can receive informed exact-call approval.
- Approval/UI/renderer SDK fixtures: complete paged evidence, inactivity timeout,
  serialized dialogs, resize/keybinding behavior, unchanged native renderers,
  preserved refusal reasons and no mutation after blocked admission.
- Interaction, delegation and summary fixtures: questionnaire provenance,
  inherited-context claims/lifecycle, branch restoration, complete human inputs
  and exact-source caches. Offline verdicts establish contracts, not model accuracy.
- Privacy/audit fixtures: synthetic private paths, scrubbing, storage failures and
  fixed-category aggregate output. Never use private captures to repair tests.

The standalone SDK fixture uses the installed host's real registry and native
provenance, a keyless synthetic provider and inert local MCP/codemode tools. It
checks blocked/cancelled admission, provider hooks, persistence, reload and branch
restoration. It does not authenticate to a provider or exercise a real backend.

Classifier/judge requests and nested admissions can overlap; approval dialogs
serialize. Pi 1.5.0 serializes top-level `prepareToolCall` admission. These tests
make no top-level parallel speedup claim and do not patch the host scheduler.

## Optional real inference

These commands require a separately available compatible nine-head Q8 install.
They do not test the managed download path. No live download/install validation
has been performed for v1.0.0. Release endpoint availability was not checked.

```sh
"$JITI" tools/test_activity_engine_e2e.mjs --live
node tools/test_activity_mcp_live.mjs --live
"$JITI" tools/bench_activity_runtime.mjs --live
```

Manual tools can use `ACCLASS_TEST_BINARY` and `ACCLASS_TEST_MODEL` instead of
`~/.acclass/bin/acclass` and `~/.acclass/model`. `ACCLASS_TEST_EXTENSION_ROOT`
selects another package source root. These are test-tool overrides, not public
Activity config. Missing/incompatible artifacts fail, not substitute fixtures.
The reviewer remains deterministic; MCP uses its own inert local server. These
checks establish inference/routing behavior, not live reviewer correctness or
real-MCP safety.

Benchmark inputs are fixed synthetic calls. `ACCLASS_BENCH_REPEATS` is `1..100`
(default 10). `ACCLASS_BENCH_OUT` must be a private `.json` path outside every Git
worktree. Reports/stdout can contain host paths and artifact identities; keep them
private. Warm-cache latency is descriptive, not a production performance claim.

## Optional live reviewer

Run only after explicit approval to send synthetic context through existing local
Pi credentials. No real captures, secret contents or candidate execution are used.

```sh
ACCLASS_TEST_JUDGE='provider/model-id' ACCLASS_TEST_JUDGE_THINKING=off \
  "$JITI" tools/test_activity_judge_live.mjs --live
ACCLASS_PERMISSION_JUDGE='provider/model-id' ACCLASS_PERMISSION_JUDGE_THINKING=off \
  "$JITI" activity/test/live-permissions.mjs --live
```

The first requires real Q8 inference and permits at most eight Activity model
dispatches. Permission checks need no classifier and permit at most 128 dispatches,
including summaries and retries. These are **not wire-request caps**: routers and
adapters can add work. Models must resolve in the tool's registry; external routing
extensions are not loaded automatically. Thinking is separate from exact model IDs.
`ACCLASS_PERMISSION_SUMMARY`/`ACCLASS_PERMISSION_SUMMARY_THINKING` optionally select
a summary model/effort; otherwise they follow the selected judge/effort.

For bounded permission batches, `ACCLASS_PERMISSION_START` is inclusive (zero-based),
`ACCLASS_PERMISSION_END` is exclusive and `ACCLASS_PERMISSION_MAX_DISPATCHES` is
positive, capped at 128. Track earlier requests against the user's total budget.
A batch is not a full-suite pass. Failed/unavailable reviews and summaries are
technical failures, not semantic denials. Mocked verdicts do not prove model
obedience; live smoke checks do not guarantee future safety.

## Aggregate audit

`node tools/audit_activity.mjs [private-review-files...]` emits fixed-category
metadata counts only. Its default folder is
`~/.local/share/pi-activity/private`. `npm test` uses synthetic files, never that
real folder. Unknown counts, costs and verification remain unknown, not zero.
Keep all real captures/reports outside every Git worktree and do not send them
to a model provider. See [privacy](privacy.md) and [events](events.md).
