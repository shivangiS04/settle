import { paypalFetch, mockId, type CallCtx } from "./client";
import type { Money } from "./orders";

type PayoutBatchResponse = {
  batch_header: { payout_batch_id: string; batch_status: string; sender_batch_header?: { sender_batch_id: string } };
  items?: { payout_item_id: string; transaction_status?: string }[];
};

/**
 * Payouts API: platform → freelancer's PayPal email.
 * The create call is asynchronous; final status arrives via
 * PAYMENT.PAYOUTS-ITEM.SUCCEEDED / FAILED webhooks (or GET payouts-item).
 */
export async function sendPayout(
  args: { senderBatchId: string; receiverEmail: string; amount: Money; note: string; itemId: string },
  ctx: Omit<CallCtx, "summary">,
) {
  const body = {
    sender_batch_header: {
      sender_batch_id: args.senderBatchId,
      email_subject: "You've been paid via Settle",
      email_message: args.note.slice(0, 1000),
    },
    items: [
      {
        recipient_type: "EMAIL",
        receiver: args.receiverEmail,
        // Payouts API uses {value, currency}, unlike Orders/Payments' {value, currency_code}.
        amount: { value: args.amount.value, currency: args.amount.currency_code },
        note: args.note.slice(0, 4000),
        sender_item_id: args.itemId,
      },
    ],
  };
  const res = await paypalFetch<PayoutBatchResponse>(
    "POST",
    "/v1/payments/payouts",
    body,
    { ...ctx, summary: `Payout ${args.amount.value} ${args.amount.currency_code} → ${args.receiverEmail}` },
    () => ({
      batch_header: { payout_batch_id: mockId("MOCK-BATCH"), batch_status: "PENDING" },
      items: [{ payout_item_id: mockId("MOCK-ITEM"), transaction_status: "PENDING" }],
    }),
  );
  let itemId = res.items?.[0]?.payout_item_id ?? null;
  let itemStatus: string | null = res.items?.[0]?.transaction_status ?? null;
  // The create response usually omits items; fetch the batch to learn the item id.
  if (!itemId) {
    const batch = await getPayoutBatch(res.batch_header.payout_batch_id, ctx);
    itemId = batch.items?.[0]?.payout_item_id ?? null;
    itemStatus = batch.items?.[0]?.transaction_status ?? null;
  }
  return { batchId: res.batch_header.payout_batch_id, batchStatus: res.batch_header.batch_status, itemId, itemStatus };
}

export function getPayoutBatch(batchId: string, ctx: Omit<CallCtx, "summary">) {
  return paypalFetch<PayoutBatchResponse>(
    "GET",
    `/v1/payments/payouts/${batchId}`,
    undefined,
    { ...ctx, summary: `Get payout batch ${batchId}` },
    () => ({ batch_header: { payout_batch_id: batchId, batch_status: "PENDING" }, items: [{ payout_item_id: mockId("MOCK-ITEM"), transaction_status: "PENDING" }] }),
  );
}

export function getPayoutItem(itemId: string, ctx: Omit<CallCtx, "summary">) {
  return paypalFetch<{ payout_item_id: string; transaction_status: string; errors?: { name?: string; message?: string } }>(
    "GET",
    `/v1/payments/payouts-item/${itemId}`,
    undefined,
    { ...ctx, summary: `Get payout item ${itemId}` },
    () => ({ payout_item_id: itemId, transaction_status: "SUCCESS" }),
  );
}
