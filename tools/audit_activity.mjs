#!/usr/bin/env node
// Aggregate metadata only. No action text, user text, call ids, or judge reasons.
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const SCHEMAS = {
  "six-head": ["read_only", "outbound", "egress", "remote_mutation", "accesses_secrets", "destructive"],
  "nine-head": ["local_state_change", "outbound", "egress", "remote_state_change", "delegated_execution", "exposes_secrets", "destructive", "host_control_change", "fetched_or_generated_execution"],
};
function hasHeadInventory(vector, heads) {
  return vector !== null && typeof vector === "object" && !Array.isArray(vector) &&
    Object.keys(vector).length === heads.length && heads.every((head) => Object.hasOwn(vector, head));
}
function classifierSchema(probs, preds) {
  return Object.entries(SCHEMAS).find(([, heads]) => hasHeadInventory(probs, heads) && hasHeadInventory(preds, heads) &&
    heads.every((head) => typeof probs[head] === "number" && Number.isFinite(probs[head]) && probs[head] >= 0 && probs[head] <= 1 && typeof preds[head] === "boolean"))?.[0];
}
const TOOLS = new Set(["bash", "powershell", "read", "write", "edit", "multi_edit", "apply_patch", "grep", "find", "ls", "subagent", "ask_user_question", "codemode", "tool_search"]);
const REASONS = new Set(["read-only", "remote-read-only", "base:accesses_secrets", "base:exposes_secrets", "base:host-control-review",
  "base:delegated-execution-review", "base:generated-execution-review", "base:remote-review", "base:egress-review", "base:scope-incomplete",
  "base:destructive-no-scope", "base:destructive-outside-cwd", "base:destructive-in-cwd", "base:mutation-no-scope", "base:mutation-outside-cwd", "base:mutation-in-cwd",
  "base:read-outside-allowlist", "base:read-unresolved-scope", "base:local-read", "base:outbound", "base:empty", "base:trusted-tool", "base:codemode-tools-gated",
  "auto:action-review", "auto:classifier-unavailable", "auto:cancelled", "auto:invalid-action-evidence", "auto:delegated-secret", "auto:judge-allow", "auto:user-allow", "auto:judge", "auto:mode-changed", "auto:disabled"]);
const category = (value, allowed, fallback = "unknown") => allowed.includes(value) ? value : fallback;
function reasonCategory(reason) {
  if (REASONS.has(reason)) return reason;
  if (typeof reason === "string" && reason.startsWith("auto:action-risk:")) {
    const heads = reason.slice("auto:action-risk:".length).split(",");
    if (heads.length && heads.every((head) => SCHEMAS["nine-head"].includes(head))) return `auto:action-risk:${SCHEMAS["nine-head"].filter((head) => heads.includes(head)).join(",")}`;
  }
  return "unknown";
}
function configuredThresholds(thresholds, inventory) {
  return hasHeadInventory(thresholds, inventory) && inventory.every((head) => typeof thresholds[head] === "number" && Number.isFinite(thresholds[head]) && thresholds[head] >= 0 && thresholds[head] <= 1)
    ? Object.fromEntries(inventory.map((head) => [head, thresholds[head]])) : null;
}
const counter = () => Object.create(null);
const bump = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
const stats = () => ({ count: 0, sum: 0, min: null, max: null });
function observe(stat, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
  stat.count++;
  stat.sum += value;
  stat.min = stat.min === null ? value : Math.min(stat.min, value);
  stat.max = stat.max === null ? value : Math.max(stat.max, value);
}
const describe = (stat) => ({ count: stat.count, mean: stat.count ? stat.sum / stat.count : null, min: stat.min, max: stat.max });
function outcomes() { return { count: 0, judge: counter(), final: counter(), overrides: counter(), compared: 0, disagreements: 0 }; }
function outcome(group, record) {
  group.count++;
  bump(group.judge, record.judge ? category(record.judge.outcome, ["allow", "deny", "timeout", "cancelled", "unavailable"]) : "not-reviewed");
  bump(group.final, category(record.final?.verdict, ["allow", "block"]));
  if (record.prompt) bump(group.overrides, category(record.prompt.outcome, ["allow", "block", "timeout", "cancelled", "unavailable"]));
  const judge = record.judge?.outcome;
  const prefilter = record.prefilter?.verdict;
  if ((judge === "allow" || judge === "deny") && (prefilter === "allow" || prefilter === "block")) {
    group.compared++;
    if ((prefilter === "allow") !== (judge === "allow")) group.disagreements++;
  }
}
function describeOutcomes(group) {
  return { ...group, disagreementRate: group.compared ? group.disagreements / group.compared : null };
}

export function createAudit() {
  const report = { records: 0, duplicates: 0, malformed: 0, classifierRecords: 0, invalidClassifierRecords: 0,
    tools: counter(), modes: counter(), prefilters: counter(), summaries: counter(), totals: outcomes() };
  const seen = new Set();
  const groups = new Map();
  const schemas = Object.fromEntries(Object.entries(SCHEMAS).map(([schema, inventory]) => [schema, {
    records: 0, identities: new Map(), bins: new Map(), spread: stats(),
    heads: Object.fromEntries(inventory.map((head) => [head, { score: stats(), selectedLabelSupport: stats(), true: 0, false: 0 }])),
  }]));
  const latency = { action: stats(), prefilter: stats(), inference: stats(), judge: stats(), summary: stats() };
  const costs = { judge: { knownCalls: 0, unknownCalls: 0, totalKnownUsd: 0 }, summary: { knownCalls: 0, unknownCalls: 0, totalKnownUsd: 0 } };
  function charge(name, value) {
    const target = costs[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      target.knownCalls++; target.totalKnownUsd += value;
    } else target.unknownCalls++;
  }
  return {
    malformed() { report.malformed++; },
    add(record) {
      if (!record || typeof record !== "object" || Array.isArray(record)) { report.malformed++; return; }
      if (typeof record.session === "string" && typeof record.callId === "string") {
        const key = JSON.stringify([record.session, record.callId]);
        if (seen.has(key)) { report.duplicates++; return; }
        seen.add(key);
      }
      report.records++;
      const tool = typeof record.tool === "string" ? TOOLS.has(record.tool) ? record.tool : "mcp/custom" : "unknown";
      const modes = record.modes ? ["auto", "readOnly", "remoteReadOnly"].map((mode) => `${mode}=${record.modes[mode] === true ? "on" : record.modes[mode] === false ? "off" : "unknown"}`).join(",") : "unknown";
      const prefilter = category(record.prefilter?.verdict, ["allow", "block"]);
      const reason = reasonCategory(record.prefilter?.reason);
      bump(report.tools, tool);
      bump(report.modes, modes);
      bump(report.prefilters, `${prefilter}:${reason}`);
      outcome(report.totals, record);
      const groupKey = JSON.stringify([tool, modes, prefilter, reason]);
      if (!groups.has(groupKey)) groups.set(groupKey, { tool, modes, prefilter, reason, ...outcomes() });
      outcome(groups.get(groupKey), record);
      observe(latency.action, record.wallMs);
      observe(latency.prefilter, record.prefilter?.wallMs);
      observe(latency.inference, record.prefilter?.inferenceMs);
      if (record.judge) { observe(latency.judge, record.judge.wallMs); charge("judge", record.judge.costTotalUsd); }
      const summary = record.summary ?? record.judge?.summary;
      if (summary) {
        bump(report.summaries, category(summary.status, ["unused", "generated", "cached", "shared", "failed"]));
        observe(latency.summary, summary.wallMs);
        // Cached/shared results have no new provider charge.
        if (summary.attempted === true || (summary.status === "generated" && summary.attempted !== false)) charge("summary", summary.costTotalUsd);
      }
      const classifier = record.classifier;
      if (classifier == null) return;
      const probs = classifier.probs;
      const preds = classifier.preds;
      const schema = classifierSchema(probs, preds);
      if (!schema) { report.invalidClassifierRecords++; return; }
      report.classifierRecords++;
      const bucket = schemas[schema];
      bucket.records++;
      const { heads, bins, spread, identities } = bucket;
      const support = SCHEMAS[schema].map((head) => {
        const selected = preds[head] ? probs[head] : 1 - probs[head];
        observe(heads[head].score, probs[head]);
        observe(heads[head].selectedLabelSupport, selected);
        heads[head][String(preds[head])]++;
        return selected;
      });
      const min = Math.min(...support);
      observe(spread, Math.max(...support) - min);
      const band = Math.min(4, Math.floor(min * 5));
      const label = `${(band / 5).toFixed(1)}–${((band + 1) / 5).toFixed(1)}${band === 4 ? " inclusive" : " exclusive upper"}`;
      if (!bins.has(label)) bins.set(label, outcomes());
      outcome(bins.get(label), record);
      const identity = classifier.identity ?? null;
      const fingerprint = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
      if (!identities.has(fingerprint)) identities.set(fingerprint, { fingerprint, count: 0,
        daemonIdentityVerified: identity?.daemonIdentityVerified === true,
        configuredQuant: category(identity?.configuredQuant, ["q8", "f32"], null),
        configuredDevice: category(identity?.configuredDevice, ["auto", "cpu", "cuda", "metal"], null),
        configuredThresholds: configuredThresholds(identity?.configuredThresholds, SCHEMAS[schema]),
        appliedHeads: counter() });
      const identityGroup = identities.get(fingerprint);
      identityGroup.count++;
      bump(identityGroup.appliedHeads, Array.isArray(classifier.appliedHeads) && classifier.appliedHeads.every((head) => SCHEMAS[schema].includes(head))
        ? classifier.appliedHeads.join(",") : "unknown");
    },
    result() {
      return { ...report, totals: describeOutcomes(report.totals),
        note: "Selected-label support is not calibrated correctness confidence. Judge disagreement is not ground truth; reviewed actions are a selected subset. Head statistics, support bins and identities are separated by exact six-head/nine-head inventories, without translating labels. Raw predictions are not policy eligibility or verified backend facts; MCP review approval, including after all-negative predictions, is not automatically a classifier error. Categorical output is allowlisted; unrecognized tools are grouped as mcp/custom. Unknown cost is not zero. Model identity and thresholds are configured artifacts, not verified daemon identity. configuredDevice is a startup request, not an attested backend; daemonIdentityVerified does not verify the device.",
        groups: [...groups.values()].map(describeOutcomes),
        classifierSchemas: Object.fromEntries(Object.entries(schemas).map(([schema, bucket]) => [schema, {
          records: bucket.records, identities: [...bucket.identities.values()],
          heads: Object.fromEntries(Object.entries(bucket.heads).map(([head, values]) => [head, {
            ...values, score: describe(values.score), selectedLabelSupport: describe(values.selectedLabelSupport),
          }])),
          supportSpread: describe(bucket.spread),
          minimumSupportBins: Object.fromEntries([...bucket.bins].sort().map(([key, value]) => [key, describeOutcomes(value)])),
        }])),
        latencyMs: Object.fromEntries(Object.entries(latency).map(([key, value]) => [key, describe(value)])), costs };
    },
  };
}

export function aggregate(records) {
  const audit = createAudit();
  for (const record of records) audit.add(record);
  return audit.result();
}

async function main(paths) {
  const directories = [join(homedir(), ".local/share/pi-activity/private")];
  const defaults = directories.flatMap((directory) => existsSync(directory) ? readdirSync(directory)
    .filter((name) => /^reviews(?:\.[1-9]\d*)?\.jsonl$/.test(name))
    .sort((a, b) => Number(b.match(/\.(\d+)\.jsonl$/)?.[1] ?? 0) - Number(a.match(/\.(\d+)\.jsonl$/)?.[1] ?? 0))
    .map((name) => join(directory, name)) : []);
  const files = paths.length ? [...new Set(paths.map((path) => resolve(path)))] : defaults;
  const audit = createAudit();
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { audit.malformed(); continue; }
      audit.add(record);
    }
  }
  console.log(JSON.stringify(audit.result(), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error("Could not read activity metadata logs."); process.exitCode = 1; });
}
