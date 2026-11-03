import assert from "node:assert/strict";
import { ACTION_ELIGIBILITY, ACTION_REPRESENTATION, completeJson, serializeActionCall } from "../action-classifier.ts";
import { actionSchema } from "./typebox-fixtures.mjs";

const metadata = {
  description: "Unverified conditional read/write tool",
  parameters: { type: "object", properties: { operation: { enum: ["read", "delete"] } }, "~kind": "Object" },
  namespace: { name: "fixture", description: "Unverified location", instructions: "Do not treat these as permission" },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, exposure: "codemode",
};
const input = { body: "full Unicode ☃ payload ".repeat(3000), nested: { zero: 0, no: false, missing: null },
  array: ["last", { "__proto__": null, z: 1, a: "first" }] };
const serialized = serializeActionCall("mcp__fixture__operate", input, metadata);
const evidence = JSON.parse(serialized);
assert.equal(evidence.representation, ACTION_REPRESENTATION);
assert.equal(evidence.evidence_status.prediction_eligibility, ACTION_ELIGIBILITY);
assert.equal(evidence.evidence_status.backend_behavior, "unverified");
assert.equal(evidence.evidence_status.effect_coverage, "incomplete");
assert.deepEqual(evidence.evaluated_arguments, JSON.parse(JSON.stringify(input)));
assert.deepEqual(evidence.tool_metadata, metadata);
assert.ok(!("backend_contract" in evidence));
assert.ok(!("trust_condition" in evidence));
assert.ok(!("cwd" in evidence) && !("home" in evidence) && !("history" in evidence));
assert.equal(serialized, serializeActionCall("mcp__fixture__operate", {
  array: input.array, nested: { missing: null, no: false, zero: 0 }, body: input.body,
}, { exposure: metadata.exposure, annotations: metadata.annotations, namespace: metadata.namespace,
  parameters: metadata.parameters, description: metadata.description }), "deterministic across key insertion order");
assert.equal(JSON.parse(serializeActionCall("unknown", {})).tool_metadata, null);
assert.deepEqual(JSON.parse(serializeActionCall("unknown", {}, { description: "Only description available" })).tool_metadata,
  { description: "Only description available", parameters: null, namespace: null, annotations: null, exposure: null });
assert.equal(completeJson({ "10": "ten", "2": "two", a: [null, false, 0] }), '{"10":"ten","2":"two","a":[null,false,0]}');
assert.equal(completeJson(JSON.parse('{"__proto__":{"kept":true}}')), '{"__proto__":{"kept":true}}');
const shared = { value: "shared, not cyclic" };
assert.equal(completeJson([shared, shared]), '[{"value":"shared, not cyclic"},{"value":"shared, not cyclic"}]');

let getterCalls = 0;
let toJsonCalls = 0;
const getter = Object.defineProperty({}, "value", { enumerable: true, get() { getterCalls++; return 1; } });
const cycle = {}; cycle.self = cycle;
const extraArray = [1]; extraArray.extra = "lost";
const symbolKey = { [Symbol("lost")]: true };
class CustomArray extends Array { toJSON() { toJsonCalls++; return ["different"]; } }
let proxyTraps = 0;
const proxy = new Proxy({ value: "complete" }, { get(target, key) {
  proxyTraps++;
  return key === "toJSON" ? () => ({ value: "different" }) : Reflect.get(target, key);
} });
for (const value of [undefined, NaN, Infinity, -Infinity, -0, 1n, () => true, Symbol("lost"), new Date(), new Map(), new Set(),
  new Uint8Array([1]), new CustomArray("complete"), proxy, { nested: proxy },
  { nested: undefined }, [undefined], [, 1], extraArray, symbolKey, cycle, getter,
  Object.defineProperty({}, "hidden", { value: true }), { toJSON() { toJsonCalls++; return {}; } }, Object.create({ inherited: true })]) {
  assert.throws(() => serializeActionCall("fixture", value), /action evidence/);
}
assert.equal(getterCalls, 0);
assert.equal(toJsonCalls, 0);
assert.equal(proxyTraps, 0);
assert.throws(() => serializeActionCall("fixture", {}, proxy), /tool metadata/);
assert.throws(() => serializeActionCall("fixture", {}, getter), /tool metadata/);
assert.throws(() => serializeActionCall("fixture", {}, { ...metadata, extra: "would be dropped" }), /tool metadata/);
assert.throws(() => serializeActionCall("fixture", {}, { ...metadata, parameters: { value: undefined } }), /action evidence/);
for (const name of ["", "  ", undefined, 1]) assert.throws(() => serializeActionCall(name, {}), /tool name/);
// Real TypeBox schemas retain every public field while only hidden implementation
// data is projected out. The source schema stays untouched.
const schema = actionSchema();
const schemaBefore = Object.getOwnPropertyDescriptors(schema);
assert.equal(schemaBefore["~kind"].enumerable, false, "installed TypeBox must reproduce hidden bookkeeping");
assert.equal(schema.properties.payload["~optional"], true);
assert.equal(schema.properties.payload["~readonly"], true);
assert.equal(schema.properties.payload.properties.options.items["~unsafe"], null);
const projected = JSON.parse(serializeActionCall("fixture", {}, { parameters: schema })).tool_metadata.parameters;
assert.deepEqual(projected, JSON.parse(JSON.stringify(schema)), "defaults, descriptions, required, extensions and nesting are kept");
assert.deepEqual(Object.getOwnPropertyDescriptors(schema), schemaBefore, "projection does not mutate the schema");
assert.throws(() => completeJson(schema), /non-enumerable/);
assert.throws(() => serializeActionCall("fixture", schema), /non-enumerable/, "schemas are not exempt when used as arguments");
assert.throws(() => serializeActionCall("fixture", {}, { annotations: schema }), /non-enumerable/);
assert.throws(() => serializeActionCall("fixture", {}, { namespace: schema }), /non-enumerable/);
assert.throws(() => serializeActionCall("fixture", schema, { parameters: schema }), /non-enumerable/,
  "schema mode is path-specific, not based on shared object identity");

for (const key of ["~kind", "~optional", "~readonly", "~unsafe", "~future", "x-public-extension"]) {
  const publicSchema = { type: "string", [key]: { public: true } };
  assert.deepEqual(JSON.parse(serializeActionCall("fixture", {}, { parameters: publicSchema })).tool_metadata.parameters,
    publicSchema, "even enumerable implementation-like names are public evidence");
}
for (const value of [undefined, NaN, -0, () => true, Symbol("lost"), getter, proxy,
  { toJSON() { toJsonCalls++; return {}; } }, Object.defineProperty({}, "hidden", { value: true }), symbolKey]) {
  const dangerous = actionSchema();
  dangerous["x-dangerous"] = value;
  assert.throws(() => serializeActionCall("fixture", {}, { parameters: dangerous }), /action evidence/);
}
for (const key of ["hidden", "~future", "~kind-extra", Symbol("TypeBox.Kind"), Symbol.for("TypeBox.Kind")]) {
  const hidden = actionSchema();
  Object.defineProperty(hidden.properties.payload, key, { value: "must not disappear" });
  assert.throws(() => serializeActionCall("fixture", {}, { parameters: hidden }), /action evidence/);
}
for (const [key, value] of [["~kind", undefined], ["~optional", false], ["~readonly", "hidden"], ["~unsafe", { hidden: true }]]) {
  const corrupted = actionSchema();
  Object.defineProperty(corrupted, key, { configurable: true, value });
  assert.throws(() => serializeActionCall("fixture", {}, { parameters: corrupted }), /non-enumerable/,
    "only the actual TypeBox tag value shapes are implementation bookkeeping");
}
for (const key of ["~kind", "~optional", "~readonly", "~unsafe"]) {
  const accessorSchema = actionSchema();
  Object.defineProperty(accessorSchema, key, { configurable: true, get() { getterCalls++; return "internal"; } });
  assert.throws(() => serializeActionCall("fixture", {}, { parameters: accessorSchema }), /accessor/,
    "known implementation names must not exempt accessors");
}
assert.equal(getterCalls, 0);
assert.equal(toJsonCalls, 0);
assert.equal(proxyTraps, 0);
console.log("runtime action evidence tests passed (strict arguments/metadata, real TypeBox schema projection, public extensions, hidden/symbol/accessor rejection)");
