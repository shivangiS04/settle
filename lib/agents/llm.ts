import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import { audit } from "../audit";
import { llmMock, llmProvider } from "../mode";
import { geminiGenerate, geminiText, toGeminiParts, GEMINI_MODEL, type GContent } from "./gemini";
import { REPAIR_PROMPT } from "./prompts";
import { LlmError, fromAnthropicError, type LlmErrorKind } from "./errors";
export { LlmError } from "./errors";

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

let _client: Anthropic | null = null;
export function anthropic() {
  // The SDK retries 408/409/429/5xx itself with exponential backoff and honors retry-after.
  if (!_client) _client = new Anthropic({ maxRetries: 3 });
  return _client;
}

type AgentName = "contract" | "verifier" | "mediator" | "assistant";

export type StructuredArgs<T> = {
  agent: AgentName;
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[] | string;
  /** Shape sent to the API as a JSON schema (structured outputs). Keep it constraint-light. */
  schema: z.ZodType<T>;
  /** Business rules checked after parsing (e.g. 2–5 criteria). Failures trigger a repair round. */
  validate?: (v: T) => string[];
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  ctx: { contractId?: string | null; milestoneId?: string | null; summary: string };
  mock: () => T;
  /** What to log as the "input" in the audit trail (images are elided). */
  auditInput?: unknown;
};

/**
 * Structured call with: JSON-schema constrained output, Zod validation, business-rule
 * validation, and up to 2 repair rounds that feed the exact errors back to the model.
 * Every decision is written to the audit trail as AGENT_DECISION.
 */
export async function structuredCall<T>(args: StructuredArgs<T>): Promise<{ value: T; model: string; attempts: number }> {
  const started = Date.now();
  if (llmMock()) {
    const value = args.mock();
    await audit({
      contractId: args.ctx.contractId,
      milestoneId: args.ctx.milestoneId,
      actor: `agent:${args.agent}`,
      kind: "AGENT_DECISION",
      action: `[MOCK] ${args.agent}.decide`,
      summary: `[MOCK] ${args.ctx.summary}`,
      durationMs: Date.now() - started,
      request: args.auditInput ?? (typeof args.content === "string" ? args.content : "[multimodal input]"),
      response: value,
    });
    return { value, model: "mock", attempts: 1 };
  }

  const provider = llmProvider();
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: args.content }];
  const gContents: GContent[] = [{ role: "user", parts: toGeminiParts(args.content) }];
  let lastErr = "";
  let failKind: LlmErrorKind = "invalid_output";
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let text = "";
      let modelUsed = "";
      let truncated = false;
      let usage: unknown = null;
      if (provider === "gemini") {
        const res = await geminiGenerate({ system: args.system, contents: gContents, responseJsonSchema: z.toJSONSchema(args.schema) });
        const cand = res.candidates?.[0];
        if (!cand?.content || res.promptFeedback?.blockReason) {
          lastErr = `Gemini returned no content (${res.promptFeedback?.blockReason ?? cand?.finishReason ?? "unknown"})`;
          failKind = res.promptFeedback?.blockReason ? "refused" : "invalid_output";
          break;
        }
        text = geminiText(res);
        modelUsed = res.modelVersion ?? GEMINI_MODEL;
        truncated = cand.finishReason === "MAX_TOKENS";
        usage = res.usageMetadata;
      } else {
        const res = await anthropic()
          .beta.messages.create({
            model: MODEL,
            max_tokens: 16000,
            system: args.system,
            messages,
            thinking: { type: "adaptive" },
            output_config: { effort: args.effort ?? "medium", format: zodOutputFormat(args.schema) },
            // Server-side refusal fallback: if a safety classifier declines, the API reruns on a fallback model.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          })
          .catch((e) => {
            throw fromAnthropicError(e);
          });
        if (res.stop_reason === "refusal") {
          lastErr = `Model declined (${res.stop_details?.category ?? "unknown"})`;
          failKind = "refused";
          break;
        }
        text = res.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        modelUsed = res.model;
        truncated = res.stop_reason === "max_tokens";
        usage = res.usage;
      }

      const errors: string[] = [];
      let parsed: T | undefined;
      try {
        const json = JSON.parse(text);
        const r = args.schema.safeParse(json);
        if (r.success) parsed = r.data;
        else errors.push(...r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
      } catch (e) {
        errors.push(`Invalid JSON: ${(e as Error).message}${truncated ? " (output was truncated)" : ""}`);
      }
      if (parsed !== undefined && args.validate) errors.push(...args.validate(parsed));

      if (!errors.length && parsed !== undefined) {
        await audit({
          contractId: args.ctx.contractId,
          milestoneId: args.ctx.milestoneId,
          actor: `agent:${args.agent}`,
          kind: "AGENT_DECISION",
          action: `${args.agent}.decide`,
          summary: `${args.ctx.summary}${attempt > 1 ? ` (after ${attempt - 1} repair round${attempt > 2 ? "s" : ""})` : ""}`,
          durationMs: Date.now() - started,
          request: { model: modelUsed, input: args.auditInput ?? (typeof args.content === "string" ? args.content : "[multimodal input]") },
          response: { output: parsed, usage },
        });
        return { value: parsed, model: modelUsed, attempts: attempt };
      }

      lastErr = errors.join("; ");
      await audit({
        contractId: args.ctx.contractId,
        milestoneId: args.ctx.milestoneId,
        actor: `agent:${args.agent}`,
        kind: "ERROR",
        action: `${args.agent}.repair`,
        summary: `Attempt ${attempt} failed validation — sending repair prompt: ${lastErr.slice(0, 300)}`,
        response: text.slice(0, 4000),
      });
      // Append-only repair turn: show the model its own output and the exact errors.
      messages.push({ role: "assistant", content: text || "(empty)" });
      messages.push({ role: "user", content: REPAIR_PROMPT(errors) });
      gContents.push({ role: "model", parts: [{ text: text || "(empty)" }] });
      gContents.push({ role: "user", parts: [{ text: REPAIR_PROMPT(errors) }] });
    }
  } catch (e) {
    // Rate limit / overload / bad key after retries + model fallbacks: audit, then surface a typed error.
    const err = e instanceof LlmError ? e : new LlmError("other", (e as Error)?.message ?? String(e), provider);
    await audit({
      contractId: args.ctx.contractId,
      milestoneId: args.ctx.milestoneId,
      actor: `agent:${args.agent}`,
      kind: "ERROR",
      action: `${args.agent}.llm_${err.kind}`,
      summary: `${args.agent} agent could not reach the LLM (${err.kind}): ${err.message.slice(0, 300)}`,
    });
    throw err;
  }
  await audit({
    contractId: args.ctx.contractId,
    milestoneId: args.ctx.milestoneId,
    actor: `agent:${args.agent}`,
    kind: "ERROR",
    action: `${args.agent}.${failKind}`,
    summary: `${args.agent} agent gave up: ${lastErr.slice(0, 300)}`,
  });
  throw new LlmError(failKind, `${args.agent} agent failed to produce valid output: ${lastErr}`, provider);
}
