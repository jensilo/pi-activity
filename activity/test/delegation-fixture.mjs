// Synthetic independent supplier: no fd, flags, CLI format, session files or captures.
import { realpathSync } from "node:fs";
import { obtainDelegatedContext, POLICY_CONTEXT_EVENT } from "../delegation.ts";
let nextId = 0;
export function syntheticLauncher(cwd, task = "Inspect synthetic source", sources = [], restrictions = { readOnly: false, remoteReadOnly: false }) {
  const wire = { version: 1, task, cwd: realpathSync(cwd), sources: [...sources, { role: "assignment", text: task }], restrictions };
  return {
    emit(name, request) { if (name === POLICY_CONTEXT_EVENT) request.respond(Promise.resolve({ context: wire })); },
    close() {},
  };
}
export async function withDelegation(ctx, task, sources, run, restrictions = { readOnly: false, remoteReadOnly: false }) {
  ctx.cwd ??= process.cwd();
  const sessionId = `delegated-fixture-${nextId++}`;
  ctx.sessionManager.getSessionId ??= () => sessionId;
  const wire = { version: 1, task, cwd: realpathSync(ctx.cwd), sources: [...sources, { role: "assignment", text: task }], restrictions };
  const result = await obtainDelegatedContext({ events: { emit(name, request) {
    if (name !== POLICY_CONTEXT_EVENT) throw new Error("wrong event");
    request.respond(Promise.resolve({ context: wire }));
  } } }, ctx);
  if (result.error) throw new Error(result.error);
  return run(result.context, wire);
}
