/** Optional Activity-owned inherited policy contract. Never read launcher transports here. */
import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const POLICY_CONTEXT_EVENT = "activity:policy-context:request";
export const POLICY_CONTEXT_TIMEOUT_MS = 6_000;
export interface DelegatedPolicySource {
  readonly role: "user" | "instruction" | "assignment";
  readonly text: string;
}
export interface DelegatedPolicyContext {
  readonly version: 1;
  /** Supplier attests the actual launcher's task origin/binding; no CLI syntax is required. */
  readonly task: string;
  readonly cwd: string;
  readonly sources: readonly DelegatedPolicySource[];
  readonly restrictions: Readonly<{ readOnly: boolean; remoteReadOnly: boolean }>;
}
export interface PolicyContextResult {
  readonly context: DelegatedPolicyContext | null;
  readonly error?: string;
}
export interface PolicyContextRequest {
  readonly version: 1;
  readonly sessionId: string;
  readonly cwd: string;
  /** Claim synchronously during emit, before asynchronous work. Abstain by not calling. */
  respond(result: Promise<PolicyContextResult>): void;
}
// Stable across Pi/jiti's .js/.ts import aliases; provenance, not a hostile-extension sandbox.
const snapshotBrand = Symbol.for("@jensilo/pi-activity.delegated-context");
export interface DelegatedContextSnapshot {
  readonly context: DelegatedPolicyContext;
  readonly sessionId: string;
  readonly manager: ExtensionContext["sessionManager"];
  readonly signal?: AbortSignal;
  readonly [snapshotBrand]: true;
}
export type DelegatedContextResult = { readonly context: DelegatedContextSnapshot | null; readonly error?: string };
export class DelegatedContextError extends Error {
  constructor() { super("Missing, invalid, or stale delegated policy context; restart the delegated task."); }
}

function validContext(value: unknown, cwd: string): value is DelegatedPolicyContext {
  const c = value as DelegatedPolicyContext | null;
  return !!c && c.version === 1 && typeof c.task === "string" &&
    typeof c.cwd === "string" && c.cwd === realpathSync(cwd) && Array.isArray(c.sources) &&
    c.sources.every((s) => s && ["user", "instruction", "assignment"].includes(s.role) && typeof s.text === "string") &&
    c.sources.at(-1)?.role === "assignment" && c.sources.at(-1)?.text === c.task &&
    typeof c.restrictions?.readOnly === "boolean" && typeof c.restrictions?.remoteReadOnly === "boolean";
}

/** Check before each review and after awaits. Absence has no inherited authority. */
export function validateDelegatedContext(
  ctx: ExtensionContext, snapshot?: DelegatedContextSnapshot | null, cwd = ctx.cwd,
): DelegatedContextSnapshot | undefined {
  if (!snapshot) return undefined;
  try {
    if (snapshot[snapshotBrand] !== true || !Object.isFrozen(snapshot) || snapshot.signal?.aborted ||
        snapshot.manager !== ctx.sessionManager || snapshot.sessionId !== ctx.sessionManager.getSessionId() ||
        !validContext(snapshot.context, ctx.cwd) || realpathSync(cwd) !== snapshot.context.cwd) {
      throw new DelegatedContextError();
    }
    return snapshot;
  } catch { throw new DelegatedContextError(); }
}

/** Call on every session_start. No synchronous claim = ordinary LOCAL policy, even with an old hint.
 * Once claimed, every failure is closed. Never persist or log inherited sources.
 */
export async function obtainDelegatedContext(
  pi: Pick<ExtensionAPI, "events">, ctx: ExtensionContext, signal?: AbortSignal,
): Promise<DelegatedContextResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const manager = ctx.sessionManager;
    const cwd = realpathSync(ctx.cwd);
    const current = () => {
      if (!sessionId || signal?.aborted || manager !== ctx.sessionManager ||
          sessionId !== ctx.sessionManager.getSessionId() || cwd !== realpathSync(ctx.cwd)) throw new DelegatedContextError();
    };
    current();
    let pending: Promise<DelegatedPolicyContext> | undefined;
    let claims = 0;
    let accepting = true;
    const request: PolicyContextRequest = Object.freeze({ version: 1, sessionId, cwd,
      respond(value: Promise<PolicyContextResult>) {
        // Observe rejected promises even from invalid/late suppliers, without installing late data.
        const response = Promise.resolve().then(() => {
          if (!value || typeof value.then !== "function") throw new DelegatedContextError();
          return value;
        }).then((result) => {
          if (!result || result.error !== undefined || !validContext(result.context, cwd)) throw new DelegatedContextError();
          const c = result.context;
          return Object.freeze({ version: 1 as const, task: c.task, cwd: c.cwd,
            sources: Object.freeze(c.sources.map((s) => Object.freeze({ role: s.role, text: s.text }))),
            restrictions: Object.freeze({ readOnly: c.restrictions.readOnly, remoteReadOnly: c.restrictions.remoteReadOnly }),
          });
        });
        void response.catch(() => {});
        if (!accepting) return;
        claims++;
        pending = response;
      },
    });
    try { pi.events.emit(POLICY_CONTEXT_EVENT, request); }
    finally { accepting = false; }
    if (claims > 1) throw new DelegatedContextError();
    current();
    if (!pending) return Object.freeze({ context: null });
    const unavailable = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new DelegatedContextError());
      timer = setTimeout(abort, POLICY_CONTEXT_TIMEOUT_MS);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    const context = await Promise.race([pending, unavailable]);
    current();
    const snapshot = Object.freeze(Object.defineProperty({ context, sessionId, manager, signal },
      snapshotBrand, { value: true })) as DelegatedContextSnapshot;
    validateDelegatedContext(ctx, snapshot);
    return Object.freeze({ context: snapshot });
  } catch {
    return Object.freeze({ context: null, error: new DelegatedContextError().message });
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
