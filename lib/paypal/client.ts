import { audit } from "../audit";
import { paypalMock } from "../mode";

/**
 * Single choke point for every PayPal REST call:
 *  - OAuth2 client-credentials token (cached until ~1 min before expiry)
 *  - PayPal-Request-Id idempotency key on every mutating call
 *  - Every request/response written to AuditEvent with debug id + duration
 *  - Mock mode returns simulated responses (still audited, labelled MOCK)
 */

export const PAYPAL_BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";

let tokenCache: { token: string; exp: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (paypalMock()) return "MOCK-TOKEN";
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  if (!res.ok) throw new PayPalError(`OAuth failed: ${res.status} ${await res.text()}`, res.status);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
    public debugId?: string | null,
  ) {
    super(message);
  }
  /** PayPal error "name"/issue — e.g. AUTHORIZATION_EXPIRED, INSUFFICIENT_FUNDS */
  get issue(): string | undefined {
    const b = this.body as { name?: string; details?: { issue?: string }[] } | undefined;
    return b?.details?.[0]?.issue ?? b?.name;
  }
}

export type CallCtx = {
  contractId?: string | null;
  milestoneId?: string | null;
  actor: string;
  /** Idempotency key. Deterministic keys (e.g. `capture-<milestone>`) make retries safe. */
  requestId?: string;
  summary: string;
};

type MockFn<T> = () => T;

export async function paypalFetch<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  ctx: CallCtx,
  mock: MockFn<T>,
): Promise<T> {
  const started = Date.now();
  const action = `${method} ${path}`;

  if (paypalMock()) {
    const response = mock();
    await audit({
      contractId: ctx.contractId,
      milestoneId: ctx.milestoneId,
      actor: ctx.actor,
      kind: "PAYPAL_API",
      action: `[MOCK] ${action}`,
      summary: `[MOCK] ${ctx.summary}`,
      requestId: ctx.requestId,
      resourceId: extractId(response),
      httpStatus: 201,
      durationMs: Date.now() - started,
      request: body,
      response,
    });
    return response;
  }

  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (ctx.requestId && method !== "GET") headers["PayPal-Request-Id"] = ctx.requestId;

  let res: Response;
  try {
    res = await fetch(`${PAYPAL_BASE}${path}`, {
      method,
      headers,
      body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch (err) {
    await audit({
      contractId: ctx.contractId,
      milestoneId: ctx.milestoneId,
      actor: ctx.actor,
      kind: "ERROR",
      action,
      summary: `Network error: ${(err as Error).message}`,
      requestId: ctx.requestId,
      request: body,
    });
    throw err;
  }

  const debugId = res.headers.get("paypal-debug-id");
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  await audit({
    contractId: ctx.contractId,
    milestoneId: ctx.milestoneId,
    actor: ctx.actor,
    kind: res.ok ? "PAYPAL_API" : "ERROR",
    action,
    summary: res.ok ? ctx.summary : `FAILED (${res.status}): ${ctx.summary}`,
    requestId: ctx.requestId,
    paypalDebugId: debugId,
    resourceId: extractId(json),
    httpStatus: res.status,
    durationMs: Date.now() - started,
    request: body,
    response: json,
  });

  if (!res.ok) {
    const msg = (json as { message?: string })?.message ?? text;
    throw new PayPalError(`PayPal ${action} → ${res.status}: ${msg}`, res.status, json, debugId);
  }
  return json as T;
}

function extractId(v: unknown): string | null {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.id === "string") return o.id;
    const bh = o.batch_header as { payout_batch_id?: string } | undefined;
    if (bh?.payout_batch_id) return bh.payout_batch_id;
  }
  return null;
}

export function mockId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}
