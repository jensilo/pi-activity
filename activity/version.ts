import { readFileSync } from "node:fs";

/** Identity of this loaded extension, not whichever package is later on disk. */
export const ACTIVITY_VERSION: string = (() => {
  try {
    const value = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    return typeof value === "string" ? value : "unknown";
  } catch { return "unknown"; }
})();
export const OBSERVATION_VERSION = 1;
export const OBSERVATION_ENTRY_TYPE = "activity-observations";
