// Policy: fast prefilter from nine factual heads and scope.
// Blocks based on predictions request contextual safety review, not a final veto.
// Active guards are mandatory constraints; contradictory reviews of established
// native effects are invalid, never permission to waive those constraints.
//
// Scope is a set of categories (cwd|tmp|home|system|other); a command touching
// any sensitive category is sensitive. `none` means no path was identified.

import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";

export const HEADS = [
  "local_state_change", "outbound", "egress", "remote_state_change",
  "delegated_execution", "exposes_secrets", "destructive",
  "host_control_change", "fetched_or_generated_execution",
] as const;
export type Head = (typeof HEADS)[number];

export type Primitives = Record<Head, boolean>;

/** Positive predictions on unverified runtime evidence. Missing heads remain unknown. */
export type RiskSignals = Partial<Record<Head, true>>;

export function positiveRiskSignals(preds: Primitives): RiskSignals {
  return Object.fromEntries(HEADS.filter((head) => preds[head] === true).map((head) => [head, true])) as RiskSignals;
}

/** No fast allow for unverified MCP/custom calls, including all-negative predictions. */
export function actionDecision(signals: RiskSignals, guards: Guards): Decision {
  const positive = HEADS.filter((head) => signals[head] === true);
  return hardGuardDecision(signals, guards) ?? { verdict: "block", guard: "auto",
    reason: positive.length ? `auto:action-risk:${positive.join(",")}` : "auto:action-review" };
}

export type Paths = { inside: string[]; outside: string[] };

export type ScopeKind = "cwd" | "tmp" | "home" | "system" | "other";

/** Scope report as returned by `acclass` (serve classify or the scope CLI). */
export interface ScopeReport {
  /** Detected path inventory is resolved and untruncated, not all effects known. */
  scopeComplete?: boolean;
  scope: string[];
  paths: Paths;
}

export type GuardName = "read-only" | "remote-read-only";

export interface Guards {
  readOnly: boolean;
  remoteReadOnly: boolean;
}

export interface Decision {
  verdict: "allow" | "block";
  /** Machine label: `base:<primitive>` for auto-mode, or the guard name. */
  reason: string;
  guard: GuardName | "auto";
}

const SYSTEM_PREFIXES = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/libexec",
  "/opt",
  "/etc",
  "/private/etc",
  "/dev",
  "/sys",
  "/proc",
  "/boot",
  "/System",
  "/Library",
  "/Applications",
  "/var",
];

/** Expand a leading `~` / `~/` against the home directory. */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return resolve(home, p.slice(2));
  return p;
}

/** Resolve a possibly-relative path against `cwd`, expanding `~`. */
export function resolvePath(p: string, cwd: string, home: string = homedir()): string {
  const expanded = expandHome(p, home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function within(target: string, base: string): boolean {
  const t = resolve(target);
  const b = resolve(base);
  return t === b || t.startsWith(b + sep);
}

function isTmp(p: string): boolean {
  const bases = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/var/folders", "/private/var/folders"];
  return bases.some((b) => within(p, b));
}

function isSystem(p: string): boolean {
  return SYSTEM_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + sep));
}

/** Classify one absolute path into a scope category (mirrors engine/scope.rs). */
export function classifyPath(p: string, cwd: string, home: string): ScopeKind {
  const r = resolve(p);
  // A symlinked project root must still count as the working directory after
  // the target file path is canonicalized.
  const canonicalCwd = canonicalFilePath(cwd, cwd, home);
  const canonicalHome = canonicalFilePath(home, cwd, home);
  if (within(r, canonicalCwd)) return "cwd";
  if (isTmp(r)) return "tmp";
  if (within(r, canonicalHome)) return "home";
  if (isSystem(r)) return "system";
  return "other";
}

/** Resolve existing symlinks, including dangling symlink targets and parents of
 *  new files. If resolution is uncertain, throw so the gate requests review. */
export function canonicalFilePath(path: string, cwd: string, home: string = homedir()): string {
  const visited = new Set<string>();
  function canonicalize(absolute: string): string {
    if (visited.has(absolute)) throw new Error(`symlink cycle while resolving ${path}`);
    visited.add(absolute);
    let existing = absolute;
    const missing: string[] = [];
    while (true) {
      try {
        return resolve(realpathSync(existing), ...missing.reverse());
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        try {
          if (lstatSync(existing).isSymbolicLink()) {
            const target = resolve(dirname(existing), readlinkSync(existing), ...missing.reverse());
            return canonicalize(target);
          }
        } catch (linkError) {
          if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
        }
        if (dirname(existing) === existing) throw err;
        missing.push(basename(existing));
        existing = dirname(existing);
      }
    }
  }
  return canonicalize(resolvePath(path, cwd, home));
}

/** Scope report for a single file path (file tools synthesize primitives). */
export function scopeForPath(path: string, cwd: string, home: string = homedir()): ScopeReport {
  const r = canonicalFilePath(path, cwd, home);
  const kind = classifyPath(r, cwd, home);
  if (kind === "cwd") return { scope: ["cwd"], paths: { inside: [r], outside: [] } };
  if (kind === "tmp") return { scope: ["tmp"], paths: { inside: [], outside: [] } };
  return { scope: [kind], paths: { inside: [], outside: [r] } };
}

/** True for paths that look like secret material, judged by path shape.
 *  The classifier covers command strings; file tools have no command, so this
 *  lightweight check keeps established secret exposure meaningful for them. */
export function looksSecret(path: string): boolean {
  const r = resolve(path);
  const base = basename(r);
  if (base === ".env" || base.startsWith(".env.")) return true;
  if ([".netrc", ".git-credentials", ".npmrc", ".pypirc", ".pgpass"].includes(base)) return true;
  // Credential stores, including pi's own `~/.pi/agent/auth.json` inside the
  // default read allowlist: secrets must override the allowlist, not the scope.
  if (["auth.json", "credentials.json", "secrets.json", "service-account.json"].includes(base)) return true;
  const segs = r.split(sep);
  const has = (s: string) => segs.includes(s);
  if (has(".ssh") && !base.endsWith(".pub") && !["known_hosts", "known_hosts.old", "config", "authorized_keys"].includes(base)) {
    return true;
  }
  if (has(".aws") && base === "credentials") return true;
  if (has(".config") && has("gh") && base === "hosts.yml") return true;
  if (has(".docker") && base === "config.json") return true;
  if (r === "/etc/shadow" || r.startsWith("/etc/shadow/")) return true;
  return false;
}

const READ_FILE_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_FILE_TOOLS = new Set(["write", "edit", "multi_edit", "apply_patch"]);

/** Synthesize primitives for a non-bash file tool from its path. */
export function filePrimitives(tool: string, path: string | undefined): Primitives {
  const read = readOnlyFileTool(tool);
  return {
    local_state_change: !read,
    outbound: false,
    egress: false,
    remote_state_change: false,
    delegated_execution: false,
    exposes_secrets: read && path ? looksSecret(path) : false,
    destructive: WRITE_FILE_TOOLS.has(tool),
    host_control_change: false,
    fetched_or_generated_execution: false,
  };
}

function readOnlyFileTool(tool: string): boolean {
  if (READ_FILE_TOOLS.has(tool)) return true;
  if (WRITE_FILE_TOOLS.has(tool)) return false;
  // Unknown tools are treated as mutating (fail closed).
  return false;
}

function scopesOf(scope: string[]): Set<string> {
  return new Set(scope.filter((s) => s !== "none"));
}

function allInsideCwdOrTmp(scopes: Set<string>): boolean {
  if (scopes.size === 0) return false;
  for (const s of scopes) if (s !== "cwd" && s !== "tmp") return false;
  return true;
}

function isAllowlisted(path: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => within(path, entry));
}

function scopeRule(scopes: Set<string>, kind: string): Decision {
  if (scopes.size === 0) return { verdict: "block", reason: `base:${kind}-no-scope`, guard: "auto" };
  if (!allInsideCwdOrTmp(scopes)) return { verdict: "block", reason: `base:${kind}-outside-cwd`, guard: "auto" };
  return { verdict: "allow", reason: `base:${kind}-in-cwd`, guard: "auto" };
}

/** Base prefilter: ordinary reads, in-scope local edits and destructive
 *  commands, and fetches pass. Secret-bearing, data-egress, remote-mutating,
 *  unresolved or out-of-scope actions request model review. */
export function baseDecision(
  p: Primitives,
  report: ScopeReport,
  opts: { readAllowlist: string[]; cwd: string; home: string },
): Decision {
  const scopes = scopesOf(report.scope);

  if (p.exposes_secrets) return { verdict: "block", reason: "base:exposes_secrets", guard: "auto" };
  // A project path cannot authorize a host operation or distinct worker entry.
  if (p.host_control_change) return { verdict: "block", reason: "base:host-control-review", guard: "auto" };
  if (p.delegated_execution) return { verdict: "block", reason: "base:delegated-execution-review", guard: "auto" };
  if (p.fetched_or_generated_execution) return { verdict: "block", reason: "base:generated-execution-review", guard: "auto" };
  // Remote changes and data egress still require review regardless of local scope.
  if (p.remote_state_change) return { verdict: "block", reason: "base:remote-review", guard: "auto" };
  if (p.egress) return { verdict: "block", reason: "base:egress-review", guard: "auto" };
  if (report.scopeComplete === false) return { verdict: "block", reason: "base:scope-incomplete", guard: "auto" };
  // Destructive commands confined to cwd/tmp are trusted in auto-mode. An
  // unresolved or out-of-scope target still needs contextual review.
  if (p.destructive) return scopeRule(scopes, "destructive");

  if (p.local_state_change) return scopeRule(scopes, "mutation");

  // Read-only: reads of private scopes need the read allowlist.
  if (scopes.has("home") || scopes.has("other")) {
    const privatePaths = report.paths.outside.filter((path) => {
      const kind = classifyPath(path, opts.cwd, opts.home);
      return kind === "home" || kind === "other";
    });
    if (privatePaths.length === 0) return { verdict: "block", reason: "base:read-unresolved-scope", guard: "auto" };
    if (privatePaths.some((path) => !isAllowlisted(path, opts.readAllowlist))) {
      return { verdict: "block", reason: "base:read-outside-allowlist", guard: "auto" };
    }
  }
  return { verdict: "allow", reason: p.outbound ? "base:outbound" : "base:local-read", guard: "auto" };
}

/** Identify review candidates. Native conflicts also constrain verdict consistency;
 * predictions alone do not prove a violation. The guard itself is never waived. */
export function hardGuardDecision(p: Partial<Primitives>, g: Guards): Decision | undefined {
  if (g.readOnly && (p.local_state_change || p.remote_state_change || p.egress || p.destructive || p.host_control_change || p.delegated_execution || p.fetched_or_generated_execution)) {
    return { verdict: "block", reason: "read-only", guard: "read-only" };
  }
  if (g.remoteReadOnly && (p.remote_state_change || (p.outbound && p.delegated_execution))) {
    return { verdict: "block", reason: "remote-read-only", guard: "remote-read-only" };
  }
  return undefined;
}

/** Full prefilter decision: base plus active guards. */
export function decide(
  p: Primitives,
  report: ScopeReport,
  opts: { guards: Guards; readAllowlist: string[]; cwd: string; home: string },
): Decision {
  return hardGuardDecision(p, opts.guards) ?? baseDecision(p, report, opts);
}
