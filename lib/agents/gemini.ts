/**
 * Minimal Google Gemini client (REST, no SDK) — the free-tier alternative to Claude.
 * Get a free key at https://aistudio.google.com/apikey and set GEMINI_API_KEY.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { LlmError } from "./errors";

export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
/** Tried in order when a model is overloaded (503), missing (404) or rate-limited past retries. */
const FALLBACKS = Array.from(new Set([GEMINI_MODEL, "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-flash-lite-latest"]));
const BASE = "https://generativelanguage.googleapis.com/v1beta";

export type GPart = {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  thought?: boolean;
  thoughtSignature?: string;
};
export type GContent = { role: "user" | "model"; parts: GPart[] };

export type GResponse = {
  candidates?: { content?: GContent; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
  usageMetadata?: Record<string, number>;
};

/** Converts our Anthropic-style content (text + base64 images) into Gemini parts. */
export function toGeminiParts(content: Anthropic.Beta.BetaContentBlockParam[] | string): GPart[] {
  if (typeof content === "string") return [{ text: content }];
  const parts: GPart[] = [];
  for (const b of content) {
    if (b.type === "text") parts.push({ text: b.text });
    else if (b.type === "image" && b.source.type === "base64") parts.push({ inline_data: { mime_type: b.source.media_type, data: b.source.data } });
  }
  return parts;
}

/** Gemini's JSON-schema support rejects meta keys like $schema; drop them recursively. */
function clean(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(clean);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) if (k !== "$schema" && k !== "$id") out[k] = clean(v);
    return out;
  }
  return schema;
}

export async function geminiGenerate(body: {
  system: string;
  contents: GContent[];
  responseJsonSchema?: unknown;
  tools?: { name: string; description: string; parameters: unknown }[];
}): Promise<GResponse> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const req: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: body.system }] },
    contents: body.contents,
    generationConfig: body.responseJsonSchema
      ? { responseMimeType: "application/json", responseJsonSchema: clean(body.responseJsonSchema), maxOutputTokens: 16000 }
      : { maxOutputTokens: 8000 },
  };
  if (body.tools?.length) {
    req.tools = [{ functionDeclarations: body.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: clean(t.parameters) })) }];
  }
  // Free tier: on 429 / RESOURCE_EXHAUSTED / 503 retry with exponential backoff (max 3 tries, honoring
  // retry-after), then fall through to the next model in the chain. Bad keys fail fast as `auth`.
  let lastErr = "";
  for (const model of FALLBACKS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let r: Response;
      try {
        r = await fetch(`${BASE}/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        lastErr = `${model}: ${(e as Error).message}`;
        break; // timeout/network → next model
      }
      if (r.ok) {
        const j = (await r.json()) as GResponse;
        j.modelVersion = j.modelVersion ?? model;
        return j;
      }
      const text = await r.text();
      lastErr = `${model} ${r.status}: ${text.slice(0, 300)}`;
      if (r.status === 401 || r.status === 403 || /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(text)) {
        throw new LlmError("auth", lastErr, "gemini");
      }
      if (r.status === 404) break; // model not available on this key → next model
      const busy = r.status === 429 || r.status === 503 || r.status === 500 || /RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded/i.test(text);
      if (!busy) {
        throw new LlmError("other", lastErr, "gemini"); // a real 400 (bad request) won't fix itself on retry
      }
      if (attempt < 3) await sleep(retryDelayMs(r, text, attempt));
    }
  }
  throw new LlmError("busy", `all Gemini models failed: ${lastErr}`, "gemini");
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Honors Retry-After / RetryInfo.retryDelay when present (capped), else exponential backoff with jitter. */
function retryDelayMs(r: Response, body: string, attempt: number) {
  const header = Number(r.headers.get("retry-after"));
  const info = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  const hinted = header > 0 ? header * 1000 : info ? Number(info[1]) * 1000 : 0;
  const backoff = 1000 * 2 ** attempt + Math.random() * 500;
  return Math.min(Math.max(hinted, backoff), 10_000);
}

export function geminiText(res: GResponse) {
  return (res.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("");
}
