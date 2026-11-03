// Carry activity mode state into a fresh session. Forks and resumes already
// contain their branch state; an existing entry in the new branch takes priority.
import { SessionManager, type SessionEntry, type SessionStartEvent } from "@earendil-works/pi-coding-agent";

export function carryStateFromPreviousSession(
  event: SessionStartEvent,
  branch: readonly SessionEntry[],
  customType: string,
  previousState?: unknown,
): unknown | undefined {
  if (event.reason !== "new") return undefined;
  if (branch.some((entry) => entry.type === "custom" && entry.customType === customType)) return undefined;
  // Pi need not flush an empty session to disk before /new.
  if (!event.previousSessionFile) return previousState;
  try {
    const previousBranch = SessionManager.open(event.previousSessionFile).getBranch();
    for (let i = previousBranch.length - 1; i >= 0; i--) {
      const entry = previousBranch[i]!;
      if (entry.type === "custom" && entry.customType === customType) return entry.data;
    }
  } catch {
    return previousState;
  }
  return previousState;
}
