#!/usr/bin/env node
// Dry-run only. Never publish or write a package archive.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.equal(manifest.publishConfig?.access, "public", "scoped package must publish as public");
assert.deepEqual(manifest.pi.extensions, ["./activity/index.ts"]);
// Keep this reviewed list explicit: a new runtime/doc file needs review.
const expected = [
  "package.json", "README.md", "LICENSE", "activity.example.json", "activity.schema.json",
  "activity/acclass-setup.ts", "activity/action-classifier.ts", "activity/approval.ts",
  "activity/blocked-message.ts", "activity/carry.ts", "activity/classifier.ts",
  "activity/config.ts", "activity/context.ts", "activity/delegation.ts", "activity/display.ts",
  "activity/evidence-provider.ts", "activity/index.ts", "activity/interactions.ts",
  "activity/judge.ts", "activity/logger.ts", "activity/model-policy.ts",
  "activity/observations.ts", "activity/panel.ts", "activity/policy.ts", "activity/privacy.ts",
  "activity/read-classifier.ts", "activity/retry.ts", "activity/review-policy.ts",
  "activity/summary.ts", "activity/telemetry.ts", "activity/version.ts",
  "docs/events.md", "docs/integration.md", "docs/privacy.md", "docs/release-v1.0.0.md",
  "docs/testing.md", "docs/ui.md",
].sort();
const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: root, encoding: "utf8", timeout: 30_000,
  env: { ...process.env, npm_config_update_notifier: "false" },
});
assert.equal(result.status, 0, "npm pack dry-run must succeed");
const packages = JSON.parse(result.stdout);
assert.equal(packages.length, 1);
assert.deepEqual(packages[0].files.map((file) => file.path).sort(), expected,
  "artifact must contain only reviewed runtime source, docs, manifest, license and synthetic configuration");
console.log(`Package inventory passed (${expected.length} reviewed-source paths; no installer, tests, tools, logs, dependencies, engine binaries or models).`);
