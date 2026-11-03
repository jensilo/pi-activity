import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClassifierConfig } from "./classifier.js";
import type { ActionEvidenceTelemetry } from "./action-classifier.js";
import { HEADS, type Head, type Primitives } from "./policy.js";

/** Support for the selected label, NOT calibrated correctness confidence. */
export function selectedLabelSupport(probs: Record<Head, number>, preds: Primitives) {
  const byHead = {} as Record<Head, number>;
  for (const head of HEADS) {
    const score = probs[head];
    if (!Number.isFinite(score) || score < 0 || score > 1 || typeof preds[head] !== "boolean") return undefined;
    byHead[head] = preds[head] ? score : 1 - score;
  }
  const values = Object.values(byHead);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { byHead, min, max, mean: values.reduce((sum, value) => sum + value, 0) / values.length, spread: max - min };
}

/** Configured settings only. Backend selection is not attested by the daemon protocol. */
export function configuredClassifierIdentity(cfg: ClassifierConfig) {
  let thresholds: Record<Head, number> | undefined;
  try {
    const raw = JSON.parse(readFileSync(join(cfg.model, "thresholds.json"), "utf8"));
    if (HEADS.every((head) => Number.isFinite(raw[head]) && raw[head] >= 0 && raw[head] <= 1)) {
      thresholds = Object.fromEntries(HEADS.map((head) => [head, raw[head]])) as Record<Head, number>;
    }
  } catch {
    // Missing artifact metadata does not change gating or fabricate thresholds.
  }
  return { configuredModel: cfg.model, configuredQuant: cfg.quant, configuredThresholds: thresholds,
    ...(cfg.device === undefined ? {} : { configuredDevice: cfg.device }),
    daemonIdentityVerified: false };
}

export type ClassifierTelemetry = {
  probs: Record<Head, number>;
  preds: Primitives;
  appliedHeads: readonly Head[];
  /** Raw preds/probs are model predictions, not verified backend facts. */
  actionEvidence?: ActionEvidenceTelemetry;
  support: ReturnType<typeof selectedLabelSupport> | null;
  identity: ReturnType<typeof configuredClassifierIdentity>;
};
