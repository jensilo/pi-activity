import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSafetyVerdict } from "../judge.ts";
import { ReviewLogger } from "../logger.ts";

assert.deepEqual(parseSafetyVerdict('{"decision":"allow","reason":"normal project edit"}'),
  { decision: "allow", reason: "normal project edit" });
assert.deepEqual(parseSafetyVerdict('{"decision":"block","reason":"no clear user goal"}'),
  { decision: "block", reason: "no clear user goal" });
assert.deepEqual(parseSafetyVerdict('{"decision":"ask_user","reason":"approval needed"}'),
  { decision: "ask_user", reason: "approval needed" });
for (const invalid of [
  '{"allow":true,"reason":"legacy schema"}',
  '{"decision":"deny","reason":"x"}',
  '{"decision":"allow","reason":""}',
  '{"decision":"allow","reason":"x","extra":1}',
  '{"decision":"block","decision":"allow","reason":"x"}',
  '{"\\u0064ecision":"block","decision":"allow","reason":"x"}',
  '{"allow":"true","reason":"x"}', '{"allow":true,"reason":""}',
  '{"allow":true,"reason":"x","extra":1}',
  '{"allow":false,"allow":true,"reason":"x"}',
  '{"\\u0061llow":false,"allow":true,"reason":"x"}',
  '```json\n{"allow":true,"reason":"x"}\n```',
  '{"allow":true}', 'not json',
]) assert.equal(parseSafetyVerdict(invalid), undefined, invalid);

const dir = mkdtempSync(join(tmpdir(), "activity-review-log-"));
try {
  const path = join(dir, "reviews.jsonl");
  const logger = new ReviewLogger({ enabled: true, path, maxBytes: 1024 });
  for (let i = 0; i < 80; i++) logger.log({ ts: i, tool: "bash", outcome: "allow", ms: 10 });
  await logger.flush();
  assert.ok(statSync(path).size <= 1024);
  assert.ok(statSync(join(dir, "reviews.1.jsonl")).size <= 1024);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(readFileSync(path, "utf8").trim().split("\n").every((line) => JSON.parse(line).tool === "bash"));
  const tiny = new ReviewLogger({ enabled: true, path: join(dir, "tiny.jsonl"), maxBytes: 1 });
  tiny.log({ ts: 1, tool: "bash" });
  await tiny.flush();
  assert.equal(JSON.parse(readFileSync(join(dir, "tiny.jsonl"), "utf8")).tool, "bash");
  const disabled = new ReviewLogger({ enabled: false, path: join(dir, "disabled.jsonl"), maxBytes: 1024 });
  disabled.log({ ts: 1 });
  await disabled.flush();
  assert.equal((await import("node:fs")).existsSync(join(dir, "disabled.jsonl")), false);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("judge format and bounded review log tests passed");
