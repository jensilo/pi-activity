import { createHmac, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { types } from "node:util";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { completeJson } from "./action-classifier.js";

export type RedactionConfig = { literalsFile: string | null };
const processKey = randomBytes(32);
const UUID = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\b/gi;
const SHELL_WORD = String.raw`(?:'[^']*'|"(?:\\.|[^"\\])*"|\\[\s\S]|[^\s;&|"'\\])+`;
const SECRET_NAME = String.raw`[\w.-]*(?:password|passwd|secret|token|api[_-]?key|account[_-]?key|storage[_-]?key|shared[_-]?access[_-]?key|connection[_-]?string|authorization|credential|cookie|sas)[\w.-]*`;
const PRIVATE_FLAGS = String.raw`(?:--(?:password|passwd|client-secret|secret|token|access-token|api-key|account-key|connection-string|sas-token|value|subscription|tenant|resource-group|name|vault-name|account-name|server|database|username|user|client-id|app-id)|-[pugn])`;
const secretAssignment = new RegExp(String.raw`(\b${SECRET_NAME}\s*=\s*)(${SHELL_WORD})`, "gi");
const secretJsonValue = new RegExp(String.raw`(["']${SECRET_NAME}["']\s*:\s*)(${SHELL_WORD})`, "gi");
const privateFlag = new RegExp(String.raw`(^|[\s;])(${PRIVATE_FLAGS})(=|\s+)(${SHELL_WORD})`, "gi");
const connectionValue = /\b((?:Server|Data Source|Database|Initial Catalog|User ID|UID|Password|PWD|AccountName|AccountKey|SharedAccessKey(?:Name)?|SharedAccessSignature|Endpoint|EntityPath|EndpointSuffix)\s*=\s*)([^;\r\n]*)/gi;
const secretKeys = /password|passwd|secret|(?:access|refresh|bearer|id|session)?token$|apikey|accountkey|storagekey|sharedaccesskey|connectionstring|authorization|credential|cookie|privatekey|certificate|^headers$/i;
const identifierKeys = /^(?:subscription(?:id)?|tenant(?:id)?|resourcegroup(?:name)?|resourceid|clientid|appid|objectid|accountname|vaultname|servername|databasename|username)$/i;
const pathKeys = /^(?:cwd|path|file|filepath|filename|configuredmodel)$/i;
const headKeys = new Set(["exposes_secrets", "accesses_secrets"]);
const publicRepresentations = new Set(["runtime-action-evidence-json/1", "bash-command/1", "file-path/1", "activity-redaction/1", "acclass-daemon/1"]);

/** Require absolute storage outside Git worktrees, including symlinked parents.
 * This is an accidental-publication guard, not a filesystem sandbox. */
export function privateStoragePath(path: string): string {
  if (!isAbsolute(path)) throw new Error("Activity storage must be absolute and outside Git worktrees");
  const missing: string[] = [];
  let parent = dirname(path);
  while (!existsSync(parent)) {
    missing.unshift(basename(parent));
    parent = dirname(parent);
  }
  const physical = resolve(realpathSync(parent), ...missing);
  for (let current = physical;; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) throw new Error("Activity storage cannot be inside a Git worktree");
    if (dirname(current) === current) break;
  }
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error("Activity storage must be a regular file");
  return join(physical, basename(path));
}

/** Best-effort local scrubbing only. Arbitrary business text remains sensitive. */
export class LogSanitizer {
  private readonly literals: string[];

  constructor(cfg: RedactionConfig = { literalsFile: null }) {
    this.literals = [];
    if (cfg.literalsFile !== null) {
      const path = privateStoragePath(cfg.literalsFile);
      if (!lstatSync(path).isFile() || lstatSync(path).size > 65_536) throw new Error("Invalid private redaction dictionary");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string" || !value.length)) throw new Error("Invalid private redaction dictionary");
      this.literals = [...new Set<string>(raw)].sort((a, b) => b.length - a.length);
    }
  }

  sanitize(record: Record<string, unknown>): Record<string, unknown> {
    // Validate even subtrees that redaction will remove. Never invoke getters,
    // proxies or toJSON, or silently accept non-JSON secret-bearing values.
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Activity log record must be an object");
    completeJson(record);
    const counts: Record<string, number> = Object.create(null);
    const mark = (category: string) => { counts[category] = (counts[category] ?? 0) + 1; return `[redacted:${category}]`; };
    const pseudonym = (value: string) => createHmac("sha256", processKey).update(value.toLowerCase()).digest("hex").slice(0, 16);
    const pathValue = (value: string): string => {
      const special = value.match(/(?:^|\/)(\.env(?:\.[^/]*)?|auth\.json|credentials(?:\.json)?|id_rsa|id_ed25519|shadow)$/)?.[1];
      const suffix = special?.startsWith(".env") ? ".env" : special;
      mark("path");
      return `[redacted:path${suffix ? `:${suffix}` : ""}:${pseudonym(value)}]`;
    };
    const text = (value: string): string => {
      if (publicRepresentations.has(value)) return value;
      for (const literal of this.literals) {
        if (value.includes(literal)) value = value.split(literal).join(mark("literal"));
      }
      value = value.replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g, () => mark("private-key"));
      value = value.replace(/\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/g, () => mark("token"));
      value = value.replace(/\b((?:Proxy-)?Authorization\s*[:=]\s*)(?:["'](?:\\.|[^"'\\])*["']|SharedAccessSignature\s+[^\s"']+|(?:Bearer|Basic)\s+[^\s"';&]+|[^\s"';&]+)/gi,
        (_all, prefix) => `${prefix}${mark("authorization")}`);
      value = value.replace(privateFlag, (_all, prefix, flag, separator) => `${prefix}${flag}${separator}${mark("cli-value")}`);
      value = value.replace(secretAssignment, (_all, prefix) => `${prefix}${mark("secret")}`);
      value = value.replace(secretJsonValue, (_all, prefix) => `${prefix}${mark("secret")}`);
      value = value.replace(connectionValue, (_all, prefix) => `${prefix}${mark("connection-string")}`);
      value = value.replace(/([?&](?:sig|signature|token|key|secret)=)[^&\s"'<>;]+/gi, (_all, prefix) => `${prefix}${mark("query-credential")}`);
      value = value.replace(/\b(?:https?|amqps?|sb|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi, (url) => `${url.split(":")[0]}://${mark("url")}`);
      value = value.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, () => mark("email"));
      value = value.replace(/\/(?:subscriptions|resourceGroups)\/[^\s"'<>;,]+/gi, () => mark("azure-resource"));
      value = value.replace(UUID, (uuid) => { mark("uuid"); return `[uuid:${pseudonym(uuid)}]`; });
      // Keep known secret basenames, not private project/user directory names.
      value = value.replace(/(?:~\/|\/(?:[\w.-]+\/))[^\s"'<>()[\]{};,|]*/g, pathValue);
      value = value.replace(/(?:^|(?<=[\s"'=]))(?:\.\.?\/|[\w.-]+\/)[\w./-]+/g, pathValue);
      return value;
    };
    const active = new Set<object>();
    const visit = (value: unknown, key = "", insideAction = false): unknown => {
      if (value === null || typeof value === "boolean") return value;
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string") return pathKeys.test(key) && !value.startsWith("[") ? pathValue(value) : text(value);
      if (!value || typeof value !== "object" || types.isProxy(value) || active.has(value)) throw new Error("Unsupported activity log value");
      const array = Array.isArray(value);
      const prototype = Object.getPrototypeOf(value);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("Non-plain activity log value");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((name) => typeof name !== "string")) throw new Error("Symbol property in activity log value");
      active.add(value);
      try {
        if (array) {
          const dataKeys = keys.filter((name) => name !== "length") as string[];
          if (dataKeys.length !== value.length || dataKeys.some((name) => !/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= value.length)) throw new Error("Sparse or extended activity log array");
          return Array.from({ length: value.length }, (_, index) => {
            const descriptor = descriptors[String(index)];
            if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("Accessor in activity log array");
            return visit(descriptor.value, key, insideAction);
          });
        }
        const result: Record<string, unknown> = Object.create(null);
        for (const [name, descriptor] of Object.entries(descriptors)) {
          if (!descriptor.enumerable) continue;
          if (!("value" in descriptor)) throw new Error("Accessor in activity log value");
          // Reviewer/error scaffolding is not capture. An identically named
          // proposed argument is still action evidence, subject to scrubbing.
          if (!insideAction && ["reviewReason", "errorMessage", "failure", "explanation"].includes(name)) continue;
          const normalized = name.replace(/[-_. ]/g, "");
          const sensitive = !headKeys.has(name) && (secretKeys.test(normalized) || identifierKeys.test(normalized));
          result[text(name)] = sensitive ? mark("field") : visit(descriptor.value, name, insideAction || (key === "" && name === "action"));
        }
        return result;
      } finally { active.delete(value); }
    };
    const sanitized = visit(record) as Record<string, unknown>;
    sanitized.privacy = { representation: "activity-redaction/1", identifierScope: "process", redactions: counts, sensitive: true };
    return sanitized;
  }
}
