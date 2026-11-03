// Activity has one personal configuration file. Never read project or local layers.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ACCLASS } from "./acclass-setup.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

export function activityConfigPath(): string {
  return join(getAgentDir(), "config", "activity.json");
}

/** Exclusive creation preserves all existing user configuration, including invalid files. */
export function ensureDefaultActivityConfig(): void {
  const path = activityConfigPath();
  mkdirSync(join(getAgentDir(), "config"), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, JSON.stringify({ acclass: DEFAULT_ACCLASS }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export function loadConfig<T>(name: string, defaults: T): T {
  if (name !== "activity") throw new Error(`Invalid config name: ${name}`);
  const path = activityConfigPath();
  if (!existsSync(path)) return defaults;
  let supplied: unknown;
  try { supplied = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Invalid extension config JSON in ${path}`, { cause: error }); }
  if (!isPlainObject(supplied)) throw new Error("activity config must be an object");
  return deepMerge(defaults, supplied);
}
