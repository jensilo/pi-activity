# Integration

## Optional inherited policy context

Activity works standalone. It requests context on **every `session_start`**, after
extension factories register, using `activity:policy-context:request`. There is no
required launcher, environment flag, CLI `Task:` format or legacy-hook fallback.
No synchronous claim means ordinary **local** policy, without inherited grants or
unseen parent restrictions. Activity cannot detect hidden delegation without a
supplier or hint; an unmarked session has ordinary Pi user-message semantics.

## Contract

Canonical exported types and consumer helpers: `activity/delegation.ts`.

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

A supplier **synchronously claims** by calling `respond(promise)` during event
emission, before awaiting any work. Abstain by **not calling `respond`**. Exactly
one claim is permitted. Claimed null, error (even empty), rejection, malformed
payload, unsupported version, cwd mismatch, invalid sources, conflicting/multiple
claims or a **6-second** timeout fail closed: tools stop, not local fallback or an
ordinary approval dialog. Asynchronous claims are too late and ignored. The last
source must be `assignment` with text exactly equal to `task`. Both restriction
booleans are required; false imposes nothing. True restrictions are inherited
floors, not locally removable settings.

The supplier attests that the task and sources genuinely belong to its launcher
and to the requesting session/cwd. Activity validates structure, not the truth of
an extension's assertions. A supplier must abstain unless it owns this launch's
transport; a global hint alone is not ownership. Multiple cooperating suppliers
must arrange that only the actual owner claims; there is no registry or priority.

## Tiny independent adapter

This example uses an independent launcher adapter. `ownedLaunch` represents data
obtained and bound by **your** trusted launcher; never extract supposed human
consent from the child prompt or an arbitrary tool result.

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

Use structural copies of these types if you do not import the package. The event
and payload are sufficient; no specific launcher extension is required.
An adapter may own any suitable private transport. It must validate launch binding
and limit input size and read time. Capture ownership before consuming a one-shot
selector. Without its own transport, abstain even if another launcher sets
`PI_SUBAGENT_TASK=1`.

## Consumer lifecycle and provenance

`obtainDelegatedContext(pi, ctx, signal?)` returns
`{context: DelegatedContextSnapshot | null, error?: string}`. Retain the copied,
deeply frozen snapshot **only in the requesting runtime/session**. Supply a
session-lifecycle signal; abort it on shutdown/replacement and discard old pending
acquisitions. Activity's entry point does this before installation. No late result
can install context after cancellation, session-manager/session/canonical-cwd
change or timeout. `validateDelegatedContext(ctx, snapshot, cwd = ctx.cwd)` rechecks
binding before fastpaths, each review/retry and verdict return. Invalid/stale
supplied snapshots or dropped inherited guards produce a technical stop, not an
authorization question. Never restore inherited snapshots from logs or summaries.

A valid supplied snapshot marks local user-role messages as **agent tasks**, even
without a flag. The legacy `PI_SUBAGENT_TASK=1` hint is captured once at extension
activation and can mark assignments as agent-authored **without requiring a
supplier**. Text beginning `Task:` alone never marks origin. Source helpers take
explicit `origin: "human" | "agent"` (default `human`); callers of `judgeSafety`,
`reviewContext`, summary preparation/restoration and `collectUserMessages` must
pass their resolved origin when no supplied snapshot establishes it. Activity's
entry point passes the same session origin throughout review and stale-call
identity. Origin/provenance and prompt version are part of summary cache identity;
restoration and post-generation source checks use that same origin. Confirmed
gate-owned questionnaire receipts remain human input in either kind of session.

Inherited sources retain their roles: `user` is parent human input, `instruction`
is instruction authority, and `assignment` is **not human consent**. Ordinary
scoped work does not need a new human grant, but assignment claims cannot create
explicit consent for sensitive effects. Nested launchers request the same generic
hook, preserve upstream roles and guard floors, and label their own assignments
as agent-authored. Hint-only nesting must not invent parent human consent.

## Trust and limits

Extensions share process/OS privileges; this is trusted-supplier provenance, not
PKI, a permission framework or protection against hostile installed extensions.
The snapshot goes to the policy judge, not the child agent prompt. It is launch-time
only: no live parent revocations. Only text travels; parent images and upstream
questionnaire receipts are not transported. Named upstream section updates retain
their owning-session labels, but no global chronology/deduplication is imposed.
After a one-shot transport is consumed, reload cannot recover it: restart the
child task. Auto OFF still skips ordinary policy review while active guards
remain binding. No claim of complete chain authority or OS isolation is made.

## Managed acclass setup

`activity/acclass-setup.ts` owns the v1.0.0 manifest and installer URLs. After
consent, Activity validates the manifest and hashes its exact bytes. It then
downloads the installer and checks this pinned SHA-256 before any write or run:

```text
14a829520e50eea719fe1c11a1fb7cecbc6e5b4342933be79776bda9d65eef09
```

Both downloads require HTTPS without URL credentials, omit request credentials,
allow at most five manual redirects and have a 30-second limit each. The manifest
cap is 2 MiB; the installer cap is 1 MiB. A failure uses the LLM judge fallback.

The verified installer is written with mode `0600` in a private `0700` scratch
directory. Activity runs `sh <file> --manifest <url> --manifest-sha256 <digest>`
with the selected model and installation root. The installer rechecks the manifest
pin and verifies asset sizes and hashes. The manifest is unsigned; this pin is not
an independent publisher signature.

The child has a fixed environment with no provider credentials or loader hooks.
Installation has a 15-minute limit. Cancellation sends SIGTERM to the process
group, then SIGKILL after a two-second grace period. Activity removes its scratch
directory after success or failure. A forced kill or crash can leave upstream
`.lock` or `.staging-*` data. Inspect these outside this repository. Activity does
not remove possibly active locks or silently repair corrupt installations.

### Setup API

- `AcclassSettings`, `DEFAULT_ACCLASS`: enabled by default, with the `q8` variant.
- `ensureAcclass(settings, consent?, signal?)`: returns `{ status, config,
  message? }`. Ready configurations use verified physical paths. Other statuses
  (`disabled`, `declined`, `unavailable`) return `{ provider: "none" }` for judge
  fallback. Missing consent means no download. Existing corrupt artifacts fail
  before consent; they are not repaired.
- `verifyInstallation(home?, variant?)`: rehashes the active installation and
  checks its inventory, release, model and private socket location. Throws on
  failure. `home` is the installation root (`~/.acclass` by default), not the
  user's HOME. Recheck before provider use. There is no hash cache or protection
  against malicious same-user races.
- `createAcclassSetup({ home?, fetch?, spawn?, installerSha256? })`: offline test
  seams only. The factory fixes the root; its verifier takes only the variant.
  The hash override permits synthetic installer bytes. Production uses the pin.

The setup module does not edit Pi configuration or manage the daemon lifecycle.
Its caller must honor fallback results and reverify before managed provider use.
Tests never run the downloaded installer. Upstream acclass owns its internal tests.
