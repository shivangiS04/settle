/**
 * Minimal Google Gemini client (REST, no SDK) — the free-tier alternative to Claude.
 * Get a free key at https://aistudio.google.com/apikey and set GEMINI_API_KEY.
 */
import type Anthropic from "@anthropic-ai/sdk";

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
  // Free tier: retry 429/5xx with backoff, then fall through to the next model.
  let lastErr = "";
  for (const model of FALLBACKS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let r: Response;
      try {
        r = await fetch(`${BASE}/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(90_000),
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
      if (r.status === 404 || r.status === 503) break; // missing/overloaded → next model now
      if (r.status === 429 || r.status >= 500) {
        await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
        continue;
      }
      throw new Error(`Gemini ${lastErr}`); // 400s etc. are real errors
    }
  }
  throw new Error(`Gemini unavailable: ${lastErr}`);
}

export function geminiText(res: GResponse) {
  return (res.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("");
}
