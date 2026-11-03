import type { Api, AssistantMessage, Context, Model, ModelsSimpleStreamOptions, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { retryAfterMs } from "./retry.js";

export type ResolvedActivityModel = { model: Model<Api>; thinking: ModelThinkingLevel };

/** Exact registry references only. Bare ids must name exactly one registered chat model. */
export async function resolveModelForCall(ctx: ExtensionContext, value: string,
  thinking: ModelThinkingLevel = "off"): Promise<ResolvedActivityModel> {
  const ref = value?.trim();
  if (!ref || /\s/.test(ref)) throw new Error("An explicit activity model is required");
  const slash = ref.indexOf("/");
  let model: Model<Api> | undefined;
  if (slash >= 0) {
    const provider = ref.slice(0, slash);
    const id = ref.slice(slash + 1);
    if (!provider || !id) throw new Error(`Invalid activity model: ${value}`);
    model = ctx.modelRegistry.find(provider, id);
  } else {
    const matches = ctx.modelRegistry.getAll().filter((candidate) => candidate.id === ref);
    if (matches.length > 1) throw new Error(`Ambiguous activity model: ${ref}; use provider/model`);
    model = matches[0];
  }
  if (!model) throw new Error(`Model not found: ${ref}`);
  return { model, thinking };
}

/** Explicit test seam. Production always uses the registry, including virtual dispatch and auth. */
export type ActivityCompletion = (model: Model<Api>, context: Context,
  options?: ModelsSimpleStreamOptions) => Promise<AssistantMessage>;
export type ModelCallObservation = {
  kind: "attempt" | "provider-dispatch" | "provider-request" | "http-response" | "response" | "retry";
  operation: "judge" | "summary";
  attempt: number;
  provider?: string;
  model?: string;
  api?: string;
  evidence?: "payload" | "stream-start" | "http-response" | "injected";
  response?: { stopReason: AssistantMessage["stopReason"]; usage: AssistantMessage["usage"] };
  cause?: string;
  httpStatus?: number;
  retryAfterMs?: number;
};
export type ModelCallObserver = (event: ModelCallObservation) => void;

export function observeModelCall(observer: ModelCallObserver | undefined, event: ModelCallObservation): void {
  try {
    const returned: unknown = observer?.(event);
    if (returned instanceof Promise) void returned.catch(() => {});
  } catch {
    // Observers must not affect authorization, routing or output.
  }
}

/** Count only request evidence, not streamSimple invocations or setup-error messages.
 * Pi has no universal transport-start hook. Payload dispatches are separate from
 * request evidence; response/start observations are not guaranteed wire counts.
 */
export async function completeActivityModel(ctx: ExtensionContext, resolved: ResolvedActivityModel,
  context: Context, options: ModelsSimpleStreamOptions, operation: "judge" | "summary", attempt: number,
  observer?: ModelCallObserver, injected?: ActivityCompletion): Promise<AssistantMessage> {
  const base = { operation, attempt };
  observeModelCall(observer, { ...base, kind: "attempt" });
  let observed = false;
  let responseObserved = false;
  const identity = (model: Model<Api>) => ({ provider: model.provider, model: model.id, api: model.api });
  const request = (model: Model<Api>, evidence: ModelCallObservation["evidence"], anotherResponse = false) => {
    if (observed && !anotherResponse) return;
    observed = true;
    observeModelCall(observer, { ...base, kind: "provider-request", ...identity(model), evidence });
  };
  const callOptions: ModelsSimpleStreamOptions = { ...options,
    reasoning: resolved.thinking === "off" ? undefined : resolved.thinking,
    onPayload: (_payload, model) => {
      observeModelCall(observer, { ...base, kind: "provider-dispatch", ...identity(model), evidence: "payload" });
      return undefined;
    },
    onResponse: (httpResponse, model) => {
      // Each HTTP response proves a request, including any adapter-owned retries.
      // A delayed first response upgrades existing start evidence without recounting it.
      const alreadyStarted = observed && !responseObserved;
      responseObserved = true;
      if (!alreadyStarted) request(model, "http-response", true);
      // Only numeric scheduling metadata escapes this hook, never response headers.
      // Preserve the server's full minimum wait; the retry loop owns the deadline.
      observeModelCall(observer, { ...base, kind: "http-response", ...identity(model),
        httpStatus: httpResponse.status, retryAfterMs: retryAfterMs(httpResponse) });
    },
  };
  let response: AssistantMessage;
  if (injected) {
    request(resolved.model, "injected");
    response = await injected(resolved.model, context, callOptions);
  } else {
    const stream = ctx.modelRegistry.streamSimple(resolved.model, context, callOptions);
    for await (const event of stream) {
      if (event.type === "start") {
        const partial = event.partial;
        request({ provider: partial.provider, id: partial.model, api: partial.api } as Model<Api>, "stream-start");
      }
    }
    response = await stream.result();
  }
  observeModelCall(observer, { ...base, kind: "response", provider: observed ? response.provider : undefined,
    model: observed ? response.model : undefined, api: observed ? response.api : undefined,
    response: structuredClone({ stopReason: response.stopReason, usage: response.usage }) });
  return response;
}
