import { types } from "node:util";
import type { ReviewToolMetadata } from "./context.js";

export const ACTION_REPRESENTATION = "runtime-action-evidence-json/1";
export const ACTION_ELIGIBILITY = "positive-risk-signals-only";

export type ActionEvidenceTelemetry = {
  representation: typeof ACTION_REPRESENTATION;
  eligibility: typeof ACTION_ELIGIBILITY;
  backendBehavior: "unverified";
  effectCoverage: "incomplete";
  classification: "complete" | "unavailable" | "invalid";
};

export function actionEvidenceTelemetry(classification: ActionEvidenceTelemetry["classification"]): ActionEvidenceTelemetry {
  return { representation: ACTION_REPRESENTATION, eligibility: ACTION_ELIGIBILITY,
    backendBehavior: "unverified", effectCoverage: "incomplete", classification };
}

// TypeBox 1.x stores these implementation tags as non-enumerable data properties.
// Enumerable fields with these names remain public schema data and must be kept.
function isTypeBoxBookkeeping(key: string, descriptor: PropertyDescriptor): boolean {
  if (descriptor.enumerable || !("value" in descriptor)) return false;
  if (key === "~kind") return typeof descriptor.value === "string";
  if (key === "~unsafe") return descriptor.value === null;
  return (key === "~optional" || key === "~readonly") && descriptor.value === true;
}

/** One encoder for strict JSON and schema projection. Only the designated schema
 * subtree may omit known hidden TypeBox data properties. Never invoke getters/toJSON. */
function encodeJson(value: unknown, schemaPath?: readonly string[]): string {
  const active = new Set<object>();
  function encode(value: unknown, pathToSchema?: readonly string[]): string {
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value);
    if (!value || typeof value !== "object") throw new Error("unsupported non-JSON value in action evidence");
    if (types.isProxy(value)) throw new Error("proxy in action evidence");
    if (active.has(value)) throw new Error("cyclic action evidence");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error("non-plain object or array in action evidence");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) throw new Error("symbol property in action evidence");
    const schema = pathToSchema?.length === 0;
    const dataKeys = (keys as string[]).filter((key) => {
      if (array && key === "length") return false;
      return !(schema && !array && isTypeBoxBookkeeping(key, descriptors[key]));
    });
    if (dataKeys.some((key) => !descriptors[key].enumerable || !("value" in descriptors[key]))) {
      throw new Error("accessor or non-enumerable property in action evidence");
    }
    active.add(value);
    try {
      if (array) {
        if (dataKeys.length !== value.length || dataKeys.some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
          throw new Error("sparse array or extra array property in action evidence");
        }
        return "[" + Array.from({ length: value.length }, (_, i) => encode(descriptors[String(i)].value,
          schema ? pathToSchema : undefined)).join(",") + "]";
      }
      return "{" + dataKeys.sort().map((key) => JSON.stringify(key) + ":" + encode(descriptors[key].value,
        schema ? pathToSchema : pathToSchema?.[0] === key ? pathToSchema.slice(1) : undefined)).join(",") + "}";
    } finally {
      active.delete(value);
    }
  }
  return encode(value, schemaPath);
}

/** Complete, deterministic JSON. Reject values JSON.stringify would silently change or omit.
 * No getters/toJSON are invoked. Object keys are sorted; array order is preserved. */
export function completeJson(value: unknown): string {
  return encodeJson(value);
}

/** Runtime observations only. Never invent a backend contract or derive effects from a tool name.
 * Missing metadata fields are explicitly unknown (null), not MCP default guarantees. */
export function serializeActionCall(tool: string, evaluatedArguments: unknown, metadata?: ReviewToolMetadata): string {
  if (typeof tool !== "string" || !tool.trim()) throw new Error("missing action tool name");
  const fields = ["description", "parameters", "namespace", "annotations", "exposure"] as const;
  let observedMetadata: Record<string, unknown> | null = null;
  if (metadata !== undefined) {
    if (types.isProxy(metadata)) throw new Error("proxy in tool metadata");
    const prototype = Object.getPrototypeOf(metadata);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("non-plain tool metadata");
    const descriptors = Object.getOwnPropertyDescriptors(metadata);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !fields.includes(key as typeof fields[number]))) {
      throw new Error("unsupported tool metadata field");
    }
    observedMetadata = Object.fromEntries(fields.map((key) => {
      const descriptor = descriptors[key];
      if (descriptor && (!descriptor.enumerable || !("value" in descriptor))) throw new Error("unsupported tool metadata property");
      return [key, descriptor?.value ?? null];
    }));
  }
  return encodeJson({
    representation: ACTION_REPRESENTATION,
    evidence_status: { backend_behavior: "unverified", effect_coverage: "incomplete", metadata_trust: "unverified",
      prediction_eligibility: ACTION_ELIGIBILITY },
    tool_name: tool,
    evaluated_arguments: evaluatedArguments,
    tool_metadata: observedMetadata,
  }, ["tool_metadata", "parameters"]);
}
