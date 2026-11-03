/** Bounded, request-local retries. No shared queue: healthy calls remain concurrent. */
export const MAX_TRANSIENT_RETRIES = 5;
export const TOTAL_RETRY_MS = 30_000;
export const MAX_RETRY_DELAY_MS = 2_000;
const BASE_RETRY_DELAY_MS = 100;

export class RetryDeadlineError extends Error {
  constructor() { super("request timed out: total retry deadline exceeded"); this.name = "RetryDeadlineError"; }
}

/** Stop waiting even if a dependency ignores cancellation. The dependency must
 * also receive this signal to release its own transport resources. */
export async function abortableTask<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("request cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const running = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); });
    const result = await Promise.race([running, aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("request cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function headerValue(headers: unknown, key: string): unknown {
  if (!headers || typeof headers !== "object") return undefined;
  if ("get" in headers && typeof headers.get === "function") return headers.get(key);
  return Object.entries(headers).find(([name]) => name.toLowerCase() === key)?.[1];
}

/** Server Retry-After is a minimum wait; only the total deadline bounds it. */
export function retryAfterMs(error: unknown, now = Date.now()): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const raw = error as { retryAfterMs?: unknown; retryAfter?: unknown; headers?: unknown; response?: { headers?: unknown } };
  if (typeof raw.retryAfterMs === "number" && Number.isFinite(raw.retryAfterMs) && raw.retryAfterMs >= 0) {
    return raw.retryAfterMs;
  }
  const value = raw.retryAfter ?? headerValue(raw.headers, "retry-after") ?? headerValue(raw.response?.headers, "retry-after");
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const seconds = Number(text);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(text) - now;
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** Equal jitter preserves exponential spacing while avoiding synchronized peers. */
export function retryDelayMs(retry: number, error?: unknown, random = Math.random): number {
  const exponential = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** Math.max(0, retry - 1));
  const jittered = exponential * (0.5 + Math.min(1, Math.max(0, random())) * 0.5);
  return Math.max(jittered, retryAfterMs(error) ?? 0);
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "EAGAIN"]);

/** Positive transient evidence only; malformed contracts, auth and config do not retry. */
export function transientFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const raw = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  const message = typeof raw.message === "string" ? raw.message : "";
  if (error instanceof SyntaxError || /insufficient[_ ]quota|quota exceeded|billing|out of budget|usage[_ -]?limit|available balance|invalid (?:api key|configuration)|unauthorized|forbidden|schema|identity|incompatible|malformed/i.test(message)) return false;
  const status = raw.status ?? raw.statusCode;
  if (typeof status === "number") return status === 408 || status === 429 || (status >= 500 && status <= 599);
  if (typeof raw.code === "string") return TRANSIENT_CODES.has(raw.code);
  if (raw.cause && raw.cause !== error && typeof raw.cause === "object") {
    const causeCode = (raw.cause as { code?: unknown }).code;
    if (typeof causeCode === "string" && TRANSIENT_CODES.has(causeCode)) return true;
  }
  return /\b(?:408|429|500|502|503|504|520|524)\b|rate[_ -]?limit|too many requests|service(?: is)?(?: temporarily)? unavailable|overloaded|server[_ -]?(?:busy|error)|internal[_ -]?(?:server[_ -]?)?error|model is at capacity|connection[_ -]?(?:reset|refused|lost|error)|socket hang up|fetch failed|network[_ -]?error|upstream[_ -]?(?:request[_ -]?failed|stream[_ -]?read[_ -]?error)|stream (?:was interrupted|disconnected before completion)|request timed out/i.test(message);
}

export async function retryOperation<T>(
  operation: (signal: AbortSignal, remainingMs: number, attempt: number) => Promise<T>,
  options: {
    signal?: AbortSignal;
    expiresAt?: number;
    shouldRetry: (error: unknown) => boolean;
    onRetry?: (error: unknown, retry: number, delayMs: number) => void;
  },
): Promise<T> {
  const expiresAt = Math.min(options.expiresAt ?? Infinity, Date.now() + TOTAL_RETRY_MS);
  const deadline = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(new RetryDeadlineError()), Math.max(0, expiresAt - Date.now()));
  const check = () => {
    signal.throwIfAborted();
    if (Date.now() >= expiresAt) {
      deadline.abort(new RetryDeadlineError());
      signal.throwIfAborted();
    }
  };
  try {
    for (let index = 0; ; index++) {
      check();
      try {
        const result = await abortableTask(() => operation(signal, Math.max(1, expiresAt - Date.now()), index + 1), signal);
        check(); // Delayed timers must not make a late success authoritative.
        return result;
      } catch (error) {
        check();
        if (index >= MAX_TRANSIENT_RETRIES || !options.shouldRetry(error)) throw error;
        const delay = retryDelayMs(index + 1, error);
        options.onRetry?.(error, index + 1, delay);
        const retryAt = Date.now() + delay;
        do {
          await abortableDelay(Math.max(0, Math.min(retryAt, expiresAt) - Date.now()), signal);
          check(); // An oversized server floor expires the budget, never retries early.
        } while (Date.now() < retryAt); // Timers may round a fractional delay down.
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
