// Optional private JSONL capture. Scrub before queuing; never fall back to raw text.
import { constants } from "node:fs";
import { types } from "node:util";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LogSanitizer, privateStoragePath, type RedactionConfig } from "./privacy.js";

export interface ReviewLogConfig {
  enabled: boolean;
  path: string;
  maxBytes: number;
  /** Number of rotated files in addition to the active file. */
  maxFiles?: number;
}
export interface LogConfig {
  enabled: boolean;
  path: string;
  /** full = sanitized action capture; redacted = metadata only. Never raw. */
  mode: string;
  maxBytes?: number;
  maxFiles?: number;
}

export function rotatedLogPath(path: string, index: number): string {
  return path.endsWith(".jsonl") ? `${path.slice(0, -6)}.${index}.jsonl` : `${path}.${index}`;
}
async function regularFile(path: string) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe activity log file");
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

class PrivateJsonlLogger {
  private queue: Promise<void> = Promise.resolve();
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private sanitizer?: LogSanitizer;
  private path?: string;
  private pendingBytes = 0;
  /** Includes invalid redaction configuration, unsafe paths, overflow and disk errors. */
  droppedRecords = 0;

  constructor(private readonly cfg: Pick<ReviewLogConfig, "enabled" | "path"> & Partial<ReviewLogConfig>,
    private readonly redaction: RedactionConfig = { literalsFile: null }, defaultBytes = 2_097_152) {
    this.maxBytes = Number.isSafeInteger(cfg.maxBytes) ? Math.max(1024, cfg.maxBytes!) : defaultBytes;
    this.maxFiles = Number.isSafeInteger(cfg.maxFiles) && cfg.maxFiles! >= 0 && cfg.maxFiles! <= 100 ? cfg.maxFiles! : 7;
  }

  /** Runtime scaffolding has optional undefined metadata fields. Omit these
   * explicitly; current action JSON has already passed strict serialization. */
  logTelemetry(record: Record<string, unknown>): void {
    if (this.cfg.enabled !== true) return;
    const active = new Set<object>();
    const defined = (value: unknown): unknown => {
      if (!value || typeof value !== "object" || types.isProxy(value)) return value;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) return value;
      if (active.has(value)) throw new Error("Cyclic telemetry");
      active.add(value);
      try {
        if (Array.isArray(value)) {
          const descriptors = Object.getOwnPropertyDescriptors(value);
          const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
          if (keys.length !== value.length || keys.some((key) => typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new Error("Invalid telemetry array");
          return Array.from({ length: value.length }, (_, index) => {
            const descriptor = descriptors[String(index)];
            if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("Accessor in telemetry array");
            return defined(descriptor.value);
          });
        }
        const result: Record<string, unknown> = Object.create(null);
        for (const key of Reflect.ownKeys(value)) {
          if (typeof key !== "string") throw new Error("Symbol in telemetry");
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if (!("value" in descriptor)) throw new Error("Accessor in telemetry");
          if (descriptor.enumerable && descriptor.value !== undefined) result[key] = defined(descriptor.value);
        }
        return result;
      } finally { active.delete(value); }
    };
    try { this.log(defined(record) as Record<string, unknown>); }
    catch { this.droppedRecords++; }
  }

  log(record: Record<string, unknown>): void {
    if (this.cfg.enabled !== true) return;
    let line: string;
    try {
      this.path ??= privateStoragePath(this.cfg.path);
      this.sanitizer ??= new LogSanitizer(this.redaction);
      const safe = this.sanitizer.sanitize(record);
      safe.logDroppedRecords = this.droppedRecords;
      line = JSON.stringify(safe) + "\n";
      if (Buffer.byteLength(line) > this.maxBytes && "action" in safe) {
        // Retain operational metadata, not a misleading clipped action.
        safe.action = null;
        safe.cmd = "[omitted:oversize]";
        safe.captureStatus = "omitted-oversize";
        line = JSON.stringify(safe) + "\n";
      }
      if (Buffer.byteLength(line) > this.maxBytes || this.pendingBytes + Buffer.byteLength(line) > 2 * this.maxBytes) {
        this.droppedRecords++;
        return;
      }
    } catch {
      this.droppedRecords++;
      return;
    }
    const bytes = Buffer.byteLength(line);
    this.pendingBytes += bytes;
    this.queue = this.queue.then(() => this.append(line, bytes)).catch(() => { this.droppedRecords++; })
      .finally(() => { this.pendingBytes -= bytes; });
  }

  private async append(line: string, bytes: number): Promise<void> {
    const path = this.path!;
    // Recheck before writing if a directory has since become a Git worktree.
    privateStoragePath(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const directory = await lstat(dirname(path));
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error("Activity log directory must be private");
    const lock = `${path}.lock`;
    let acquired = false;
    // Shared files can be written by parallel Pi/subagent processes. Bounded,
    // exclusive rotation; never steal an orphan lock from a possibly live writer.
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await delay(10);
      }
    }
    if (!acquired) throw new Error("Activity log is locked");
    try {
      const current = await regularFile(path);
      if (current && current.size + bytes > this.maxBytes) {
        for (let index = this.maxFiles; index >= 1; index--) {
          const target = rotatedLogPath(path, index);
          await regularFile(target);
          if (index === this.maxFiles) await rm(target, { force: true });
          const previous = index === 1 ? path : rotatedLogPath(path, index - 1);
          if (await regularFile(previous)) await rename(previous, target);
        }
        if (this.maxFiles === 0) await rm(path);
      }
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe activity log file");
        await file.chmod(0o600);
        await file.writeFile(line);
      } finally { await file.close(); }
    } finally { await rm(lock, { recursive: true }); }
  }

  async flush(): Promise<void> { await this.queue; }
}

/** Metadata only; the gate never passes arguments, user text or explanations. */
export class ReviewLogger extends PrivateJsonlLogger {}
export class CommandLogger extends PrivateJsonlLogger {
  constructor(cfg: LogConfig, redaction?: RedactionConfig) { super(cfg, redaction, 8_388_608); }
}
