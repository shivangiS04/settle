import Anthropic from "@anthropic-ai/sdk";

export type LlmErrorKind = "busy" | "auth" | "refused" | "invalid_output" | "other";

const USER_MESSAGES: Record<LlmErrorKind, string> = {
  busy: "The AI is busy — please retry in a few seconds.",
  auth: "The AI service isn't configured correctly (the API key was rejected). Please tell the app owner.",
  refused: "The AI declined to answer this request. Try rephrasing it.",
  invalid_output: "The AI couldn't produce a valid answer — please retry.",
  other: "Something went wrong talking to the AI — please retry in a few seconds.",
};

/** Typed LLM failure. `message` is for logs/audit; `userMessage` is safe to show in the UI. */
export class LlmError extends Error {
  readonly userMessage: string;
  constructor(
    readonly kind: LlmErrorKind,
    detail: string,
    readonly provider: string,
  ) {
    super(`[${provider}] ${kind}: ${detail}`);
    this.name = "LlmError";
    this.userMessage = USER_MESSAGES[kind];
  }
}

/** Maps Anthropic SDK errors (already retried by the SDK, honoring retry-after) onto LlmError. */
export function fromAnthropicError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new LlmError("auth", e.message, "anthropic");
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError)
    return new LlmError("busy", (e as Error).message, "anthropic");
  if (e instanceof Anthropic.APIError && (e.status === 529 || e.status === 503)) return new LlmError("busy", e.message, "anthropic");
  return new LlmError("other", (e as Error)?.message ?? String(e), "anthropic");
}

/** For route handlers: LLM failures → 503 with a friendly message; anything else → 400 with its message. */
export function errorPayload(e: unknown): { body: { error: string; code?: string }; status: number } {
  if (e instanceof LlmError) return { body: { error: e.userMessage, code: `llm_${e.kind}` }, status: e.kind === "busy" ? 503 : 502 };
  return { body: { error: (e as Error)?.message ?? "Unexpected error" }, status: 400 };
}
