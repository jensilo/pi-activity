// Synthetic inline judge instructions only; no files, credentials or provider calls.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REVIEW_POLICY } from "../review-policy.ts";
import { DEFAULT_CONFIG, loadActivityConfig } from "../index.ts";

const root = mkdtempSync(join(tmpdir(), "activity-review-policy-"));
const saved = process.env.PI_CODING_AGENT_DIR;
try {
  process.env.PI_CODING_AGENT_DIR = root;
  mkdirSync(join(root, "config"));
  const write = (auto) => writeFileSync(join(root, "config/activity.json"), JSON.stringify({ auto }));
  assert.ok(DEFAULT_REVIEW_POLICY.length <= 1700, "default ordinary policy stays short");
  for (const meaning of [/Default ALLOW/, /outside the current directory/, /authentication is not credential disclosure/,
    /unread documents/, /commit-only request does not authorize pushing/, /consent already given/]) {
    assert.match(DEFAULT_REVIEW_POLICY, meaning);
  }
  assert.equal(DEFAULT_CONFIG.auto.judgeInstructions, "");
  for (const text of ["", "  ", "\ufeff# Synthetic instructions\r\nPreserve café 🦊 and whitespace.  \n", "missing-policy.md"]) {
    write({ judgeInstructions: text });
    assert.equal(loadActivityConfig(root).auto.judgeInstructions, text, "inline text is preserved; a path-like string is not read");
  }
  // The limit applies to UTF-8 bytes, not JavaScript code units.
  for (const text of ["x".repeat(32768), "é".repeat(16384), "🦊".repeat(8192)]) {
    assert.equal(Buffer.byteLength(text, "utf8"), 32768);
    write({ judgeInstructions: text });
    assert.equal(loadActivityConfig(root).auto.judgeInstructions, text, "exactly 32768 UTF-8 bytes are accepted");
    write({ judgeInstructions: text + "x" });
    assert.throws(() => loadActivityConfig(root), /activity\.auto\.judgeInstructions.*32768.*UTF-8 bytes/,
      "32769 UTF-8 bytes are rejected");
  }
  for (const invalid of [null, false, 1, [], {}, ["policy.md"]]) {
    write({ judgeInstructions: invalid });
    assert.throws(() => loadActivityConfig(root), /activity\.auto\.judgeInstructions/);
  }
  for (const stale of [null, false, "policy.md", [], ["policy.md"], {}]) {
    write({ judgePromptFiles: stale, judgeInstructions: "Replacement text." });
    assert.throws(() => loadActivityConfig(root), /activity\.auto\.judgePromptFiles/, "every old file-loader key is rejected, even alongside inline text");
  }
  assert.equal(DEFAULT_CONFIG.auto.judgeInstructions, "", "loading cannot mutate defaults");
  console.log("review policy tests passed: short default policy, exact inline text, type validation and removed file-key rejection");
} finally {
  if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved;
  rmSync(root, { recursive: true, force: true });
}
