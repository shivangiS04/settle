/**
 * Mock mode is a demo safety net: if PayPal or Anthropic credentials are absent (or
 * SETTLE_MOCK_MODE=1) the wrappers return realistic simulated responses. Every
 * simulated call is still written to the audit trail and labelled "MOCK".
 */
export function paypalMock() {
  return process.env.SETTLE_MOCK_MODE === "1" || !process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET;
}
export function llmMock() {
  return process.env.SETTLE_MOCK_MODE === "1" || !process.env.ANTHROPIC_API_KEY;
}
export function isMockMode() {
  return paypalMock() || llmMock();
}
