// Activity reads personal config layers only. Never read project configuration.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_ACCLASS } from "./acclass-setup.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
  const entries = Object.entries(override).map(([key, value]) =>
    [key, Object.hasOwn(base, key) ? deepMerge(base[key], value) : value]);
  // Copy only own keys and define data properties, including for '__proto__'.
  return { ...base, ...Object.fromEntries(entries) } as T;
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

function readConfigLayer(path: string): Record<string, unknown> | undefined {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read extension config in ${path}`, { cause: error });
  }
  let supplied: unknown;
  try { supplied = JSON.parse(text); }
  catch (error) { throw new Error(`Invalid extension config JSON in ${path}`, { cause: error }); }
  if (!isPlainObject(supplied)) throw new Error(`activity config must be an object in ${path}`);
  return supplied;
}

export function loadConfig<T>(name: string, defaults: T): T {
  if (name !== "activity") throw new Error(`Invalid config name: ${name}`);
  const basePath = activityConfigPath();
  let config = defaults;
  for (const path of [basePath, join(dirname(basePath), "activity.local.json")]) {
    const layer = readConfigLayer(path);
    if (layer) config = deepMerge(config, layer);
  }
  return config;
}
