import { paypalFetch, mockId, type CallCtx } from "./client";
import type { Authorization, Money } from "./orders";

export type Capture = {
  id: string;
  status: string; // COMPLETED | PENDING | ...
  amount: Money;
  final_capture?: boolean;
  seller_receivable_breakdown?: { paypal_fee?: Money; net_amount?: Money };
};

/**
 * Capture an authorization. Omit `amount` to capture the full authorized amount.
 * With `finalCapture: true` PayPal automatically voids any un-captured remainder,
 * which is how a mediated partial settlement returns the rest to the client.
 */
export function captureAuthorization(
  authorizationId: string,
  opts: { amount?: Money; finalCapture: boolean; invoiceId?: string; note?: string },
  ctx: Omit<CallCtx, "summary">,
) {
  const body: Record<string, unknown> = { final_capture: opts.finalCapture };
  if (opts.amount) body.amount = opts.amount;
  if (opts.invoiceId) body.invoice_id = opts.invoiceId;
  if (opts.note) body.note_to_payer = opts.note.slice(0, 255);
  return paypalFetch<Capture>(
    "POST",
    `/v2/payments/authorizations/${authorizationId}/capture`,
    body,
    {
      ...ctx,
      summary: opts.amount
        ? `Capture ${opts.amount.value} ${opts.amount.currency_code} of ${authorizationId} (final_capture=${opts.finalCapture})`
        : `Capture full authorization ${authorizationId}`,
    },
    () => ({ id: mockId("MOCK-CAP"), status: "COMPLETED", amount: opts.amount ?? { currency_code: "USD", value: "0.00" }, final_capture: opts.finalCapture }),
  );
}

export function voidAuthorization(authorizationId: string, ctx: Omit<CallCtx, "summary">) {
  return paypalFetch<Record<string, never>>(
    "POST",
    `/v2/payments/authorizations/${authorizationId}/void`,
    undefined,
    { ...ctx, summary: `Void authorization ${authorizationId} — funds released to client` },
    () => ({}) as Record<string, never>,
  );
}

/** Reauthorize after the 3-day honor period (allowed once, within the 29-day validity). */
export function reauthorize(authorizationId: string, amount: Money, ctx: Omit<CallCtx, "summary">) {
  return paypalFetch<Authorization>(
    "POST",
    `/v2/payments/authorizations/${authorizationId}/reauthorize`,
    { amount },
    { ...ctx, summary: `Reauthorize ${authorizationId} (honor period expired)` },
    () => ({
      id: mockId("MOCK-AUTH"),
      status: "CREATED",
      amount,
      create_time: new Date().toISOString(),
      expiration_time: new Date(Date.now() + 29 * 86400_000).toISOString(),
    }),
  );
}

export function getAuthorization(authorizationId: string, ctx: Omit<CallCtx, "summary">) {
  return paypalFetch<Authorization>(
    "GET",
    `/v2/payments/authorizations/${authorizationId}`,
    undefined,
    { ...ctx, summary: `Get authorization ${authorizationId}` },
    () => ({ id: authorizationId, status: "CREATED", amount: { currency_code: "USD", value: "0.00" } }),
  );
}

export function refundCapture(captureId: string, amount: Money | undefined, ctx: Omit<CallCtx, "summary">) {
  return paypalFetch<{ id: string; status: string }>(
    "POST",
    `/v2/payments/captures/${captureId}/refund`,
    amount ? { amount } : {},
    { ...ctx, summary: `Refund capture ${captureId}` },
    () => ({ id: mockId("MOCK-REFUND"), status: "COMPLETED" }),
  );
}
