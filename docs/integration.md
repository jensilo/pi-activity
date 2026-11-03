# Integration

## Parent task context

Activity works alone. A launcher extension can give Activity the rules of a parent
task. A launcher is an extension that starts a child Pi session.

On every `session_start`, Activity emits `activity:policy-context:request`. No
launcher, environment flag or special task format is required.

If no extension answers, Activity uses its normal local rules. It then treats user
messages as messages from you. Activity cannot detect that another agent started
this session unless an extension or `PI_SUBAGENT_TASK=1` says so.

## Contract

The types and helpers are in `activity/delegation.ts`.

```ts
interface PolicyContextRequest {
  readonly version: 1;
  readonly sessionId: string;
  readonly cwd: string; // canonical realpath of requesting session
  respond(result: Promise<PolicyContextResult>): void;
}
interface PolicyContextResult {
  readonly context: DelegatedPolicyContext | null;
  readonly error?: string;
}
interface DelegatedPolicyContext {
  readonly version: 1;
  readonly task: string;
  readonly cwd: string; // must equal request.cwd
  readonly sources: readonly {
    readonly role: "user" | "instruction" | "assignment";
    readonly text: string;
  }[];
  readonly restrictions: Readonly<{ readOnly: boolean; remoteReadOnly: boolean }>;
}
```

To answer a request:

1. Call `respond(promise)` during the event, before any `await`. A later call has no
   effect.
2. To skip a request, do not call `respond`.
3. Make the last source an `assignment`. Its text must equal `task`.
4. Set both `restrictions` values. `false` adds no restriction. `true` turns the
   guard on, and the session cannot turn it off.

After a claim, Activity stops all tools if any of these occurs. It does not use
local rules or open an approval dialog.

- The result has a null context or an `error`, even an empty one.
- The promise rejects, or the result has no answer within 6 seconds.
- The data is malformed, or has an unsupported version or invalid sources.
- `cwd` does not match.
- More than one extension claims the request.

Activity validates the structure only. It cannot check that the content is true.
Your extension must claim a request only if it started this session itself. A global
hint does not prove this. If several launchers are installed, they must agree on
which one claims. Activity has no registry or priority order.

## Example

`ownedLaunch` is data from your launcher. Never read human consent from the child
prompt or from a tool result.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PolicyContextRequest, DelegatedPolicyContext }
  from "@jensilo/pi-activity/activity/delegation.js";

export function registerAdapter(pi: ExtensionAPI, ownedLaunch?: {
  sessionId: string;
  cwd: string;
  readBoundContext(): Promise<DelegatedPolicyContext>;
}) {
  pi.events.on("activity:policy-context:request", (data: unknown) => {
    const request = data as PolicyContextRequest;
    if (!ownedLaunch) return; // root/unowned: abstain, not respond(null)
    request.respond(Promise.resolve().then(async () => {
      if (request.version !== 1 || request.sessionId !== ownedLaunch.sessionId ||
          request.cwd !== ownedLaunch.cwd) throw new Error("Launch binding changed");
      return { context: await ownedLaunch.readBoundContext() };
    })); // synchronous claim; asynchronous work inside the promise
  });
}
```

- You can copy these types instead of importing the package.
- Your extension can use any private channel to its launcher. It must check that the
  data belongs to this launch, and limit input size and read time.
- If the channel can be read only once, record the claim before you read it.
- If your extension has no channel of its own, do not claim. This also applies if
  another launcher sets `PI_SUBAGENT_TASK=1`.

## Consumer API

`obtainDelegatedContext(pi, ctx, signal?)` returns
`{context: DelegatedContextSnapshot | null, error?: string}`.

1. Keep the frozen snapshot only in the session that asked for it.
2. Pass a session signal. Abort it on shutdown or session change.
3. Discard pending requests from the old session.
4. Call `validateDelegatedContext(ctx, snapshot, cwd = ctx.cwd)` before each use.

After a cancellation, session change, `cwd` change or timeout, a late result has no
effect. An invalid snapshot or a dropped parent guard stops the tools. Activity does
not ask you in this case. Never restore a snapshot from logs or summaries.

## Task origin

A session is `human` or `agent`. This value controls how Activity reads user
messages.

- A valid snapshot marks local user messages as agent tasks.
- `PI_SUBAGENT_TASK=1` marks them as agent tasks without an extension. Activity reads
  this variable once at start.
- Text that starts with `Task:` does not change the origin.
- Confirmed questionnaire answers stay human input in both kinds of session.

Source helpers take `origin: "human" | "agent"`. The default is `human`. Pass the
resolved origin to `judgeSafety`, `reviewContext`, summary preparation and
restoration, and `collectUserMessages` if no snapshot sets it.

Activity's own entry point uses one origin for the whole session. The origin and the
prompt version are part of the summary cache key.

| Source role | Meaning |
| --- | --- |
| `user` | Input from the human in the parent session |
| `instruction` | Instructions with authority |
| `assignment` | The task from the parent agent. This is **not** human consent. |

Ordinary work inside the assignment needs no new permission from you. An assignment
cannot give consent for sensitive effects.

A nested launcher sends the same request. It keeps the roles and guards of its parent,
and labels its own assignments as agent-authored. With only `PI_SUBAGENT_TASK=1`, it
must not invent human consent from a parent.

## Limits

- All extensions share one process and one OS user. Activity trusts the extension
  that answers.
- Activity gives the context to the judge, not to the child agent prompt.
- The context is fixed at launch. If the parent changes a rule later, the child does
  not see it.
- Only text passes to the child. Parent images and questionnaire records do not.
- Activity does not sort or deduplicate sources across sessions.
- After a one-time channel is used, `/reload` cannot read it again. Restart the child
  task.
- With auto mode off, Activity skips its ordinary checks. Active guards still apply.
- This is not an OS isolation layer or a permission framework.

## Managed acclass setup

`activity/acclass-setup.ts` holds the release URLs for acclass v1.0.0. In print and
JSON sessions, Activity does not ask and downloads nothing.

If you accept the install question:

1. Activity downloads `release.json` (the manifest), validates it, and hashes its
   exact bytes.
2. Activity downloads the installer. It compares the installer with the pinned
   SHA-256 hash before it writes or runs the file:

   ```text
   14a829520e50eea719fe1c11a1fb7cecbc6e5b4342933be79776bda9d65eef09
   ```

3. Activity writes the installer with mode `0600` into a new `0700` directory in the
   installation root.
4. Activity runs
   `sh <file> --manifest <url> --manifest-sha256 <digest> --model <variant> --home <root>`.
5. The installer checks the manifest hash, then the size and hash of each asset.
6. Activity removes its directory and verifies the installation.

If a step fails, the judge checks the calls that need review.

The manifest has no signature. The hashes show that files did not change after
Activity got the manifest over HTTPS. They do not prove who published the release.

### Download limits

| Limit | Value |
| --- | --- |
| Protocol | HTTPS only, for downloads and for each redirect |
| Credentials | None in URLs. None in requests. |
| Redirects | At most 5, each checked by Activity |
| Time | 30 seconds for each download |
| Manifest size | 2 MiB |
| Installer size | 1 MiB |
| Installation time | 15 minutes |

### Installer and daemon environment

The installer and the daemon get a fixed environment. It has no provider credentials
and no loader hooks. The daemon gets only `HOME`, `PATH`, `LANG` and valid numeric
values of `RAYON_NUM_THREADS` and `CANDLE_NUM_THREADS`.

If you cancel, Activity sends SIGTERM to the installer process group. It sends
SIGKILL after 2 seconds. A forced kill or a crash can leave `.lock`, `.staging-*` or
`.activity-*` in `~/.acclass`. Activity does not remove them. If no installer is
running, remove them by hand. A `.lock` stops new installations until you do this.

### Check before each classification

Before each classification, Activity:

1. Checks that the installed version has no symlinks or special files, that the
   current user owns it, and that group and others cannot write to it.
2. Hashes every installed file and compares it with `INSTALLATION.json`.
3. Compares the model hashes and sizes with the kept `release.json`.
4. Resolves `current` to the real version path.

On the first classification, Activity starts the daemon or reuses a compatible one.
The socket is `~/.acclass/run/<version>-<variant>/ac.sock`, in a `0700` directory.

If a check fails, the judge checks the call. Activity does not repair an installation
and does not use unchecked files. It has no hash cache. It cannot protect against a
malicious process of the same user that changes files during the check. Activity does
not include models or engine binaries.

### Setup API

- `AcclassSettings`, `DEFAULT_ACCLASS`: enabled, with the `q8` variant.
- `ensureAcclass(settings, consent?, signal?)` returns `{ status, config, message? }`.
  - `ready`: `config` has verified real paths.
  - `disabled`, `declined`, `unavailable`: `config` is `{ provider: "none" }`. Use the
    judge.
  - Without consent, nothing downloads. A corrupt installation fails before the
    question.
- `verifyInstallation(home?, variant?)` hashes the active installation and checks its
  files, release, model and socket location. It throws on failure. `home` is the
  installation root (default `~/.acclass`), not the user's HOME. Call it before each
  use.
- `createAcclassSetup({ home?, fetch?, spawn?, installerSha256? })` is for offline
  tests only. Production code uses the pinned hash.

The setup module does not edit Pi configuration or manage the daemon. Its caller must
use the judge after a failed setup, and verify the installation again before use.

## Panel API

Use `ActivityPanel` in TUI mode only:

```typescript
import { ActivityPanel } from "./panel.js";

await ctx.ui.custom<void>(
  (tui, theme, _keys, done) => {
    return new ActivityPanel(tui, theme, done, observationView, {
      initialTab: "overview", // "history" or "diagnostics"
      category: "all", // "sh", "files", "mcp"; History only
      scope: "turn", // "session"; History only
      modes: () => currentModes(),
      droppedRecords: () => ({
        actions: actionDrops(),
        metadata: metadataDrops(),
      }),
    });
  },
  {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: 110,
      maxHeight: "80%",
    },
  },
);
```

- The host limits the width to the terminal width. Do not calculate a width once at
  opening.
- `getView` must return a sanitized `ObservationView`, not raw runtime data.
- `telemetry.guardWait` and `selected.telemetry.guardWait` are optional:
  `{ wallMs, coverage: "complete" | "partial" | "unavailable" }`. `guardWaitPending` is
  an optional number.
- The panel reads the mode and drop-count callbacks on each render. It has no timers
  or subscriptions. The parent requests a render when observations change.
- For RPC or notifications, use `renderDashboard(view, { details: true })` and
  `renderHistory(view, options)`.
- `renderOverview`, `renderDiagnostics` and `renderHistoryRow` return wrapped lines.
  With `wrap: false`, they return unwrapped lines.
