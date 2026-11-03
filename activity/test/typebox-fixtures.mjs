// Use Pi's actual installed Type API, not a hand-written approximation.
import { Type } from "typebox";

export function actionSchema() {
  return Type.Object({
    key: Type.String({ description: "Lookup key", default: "catalog" }),
    payload: Type.Optional(Type.Readonly(Type.Object({
      text: Type.String({ default: "safe ☃" }),
      options: Type.Optional(Type.Array(Type.Unsafe({ type: "string", default: "inert", "x-item": { kept: true } }))),
    }, { default: { text: "safe ☃", options: ["inert"] }, additionalProperties: false }))),
  }, { additionalProperties: true, "x-public-extension": { nested: [false, null, { kept: "full" }] } });
}
