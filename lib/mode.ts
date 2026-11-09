/**
 * Mock mode is a demo safety net: if PayPal or LLM credentials are absent (or
 * SETTLE_MOCK_MODE=1) the wrappers return realistic simulated responses. Every
 * simulated call is still written to the audit trail and labelled "MOCK".
 */
export function paypalMock() {
  return process.env.SETTLE_MOCK_MODE === "1" || !process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET;
}

/** Which LLM backs the agents: LLM_PROVIDER wins; otherwise whichever key is set (Claude preferred). */
export function llmProvider(): "anthropic" | "gemini" | "mock" {
  if (process.env.SETTLE_MOCK_MODE === "1") return "mock";
  const want = process.env.LLM_PROVIDER?.toLowerCase();
  if (want === "gemini" && process.env.GEMINI_API_KEY) return "gemini";
  if (want === "anthropic" && process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY) return "gemini";
  return "mock";
}

export function llmMock() {
  return llmProvider() === "mock";
}
export function isMockMode() {
  return paypalMock() || llmMock();
}

/** Human-readable name of the active model, for UI copy (never hardcode a vendor in the UI). */
export function llmLabel() {
  const p = llmProvider();
  if (p === "gemini") return `Gemini (${process.env.GEMINI_MODEL || "gemini-3.5-flash"})`;
  if (p === "anthropic") return `Claude (${process.env.ANTHROPIC_MODEL || "claude-opus-5-5"})`;
  return "mock heuristics";
}
