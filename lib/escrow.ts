import { prisma } from "./db";
import { audit } from "./audit";
import { transitionMilestone } from "./state";
import { centsToValue, splitFee } from "./utils";
import { createAuthorizeOrder, authorizeOrder } from "./paypal/orders";
import { captureAuthorization, reauthorize, voidAuthorization } from "./paypal/payments";
import { PayPalError } from "./paypal/client";
import { sendPayout } from "./paypal/payouts";
import { emitMockWebhook } from "./paypal/webhooks";

const HONOR_DAYS = 3;
const VALID_DAYS = 29;

async function load(milestoneId: string) {
  return prisma.milestone.findUniqueOrThrow({
    where: { id: milestoneId },
    include: { contract: { include: { client: true, freelancer: true } } },
  });
}

/** Step 1 of funding: create an Orders v2 order with intent=AUTHORIZE. */
export async function createFundingOrder(milestoneId: string, actor: string) {
  const m = await load(milestoneId);
  if (m.status !== "AGREED") throw new Error(`Milestone must be AGREED to fund (is ${m.status})`);
  const order = await createAuthorizeOrder(
    {
      milestoneId: m.id,
      contractId: m.contractId,
      title: `${m.contract.title} — ${m.title}`,
      amount: { currency_code: m.currency, value: centsToValue(m.amountCents) },
    },
    // New key per attempt: an abandoned checkout shouldn't block a fresh one.
    { contractId: m.contractId, milestoneId: m.id, actor, requestId: `settle-order-${m.id}-${Date.now()}` },
  );
  await prisma.milestone.update({ where: { id: m.id }, data: { paypalOrderId: order.id } });
  return order;
}

/** Step 2 of funding: buyer approved in the PayPal popup → authorize (hold) the funds. */
export async function authorizeFunding(milestoneId: string, orderId: string, actor: string) {
  const m = await load(milestoneId);
  if (m.authorizationId) return m; // idempotent: double-click / retry
  if (m.paypalOrderId && m.paypalOrderId !== orderId) throw new Error("Order does not belong to this milestone");
  const res = await authorizeOrder(
    orderId,
    { currency_code: m.currency, value: centsToValue(m.amountCents) },
    // Deterministic key → a retried authorize returns the same authorization, never a second hold.
    { contractId: m.contractId, milestoneId: m.id, actor, requestId: `settle-authorize-${orderId}` },
  );
  const auth = res.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) throw new Error("PayPal returned no authorization");
  const created = auth.create_time ? new Date(auth.create_time) : new Date();
  await prisma.milestone.update({
    where: { id: m.id },
    data: {
      paypalOrderId: orderId,
      authorizationId: auth.id,
      authStatus: auth.status,
      authCreatedAt: created,
      honorPeriodEndsAt: new Date(created.getTime() + HONOR_DAYS * 86400_000),
      authExpiresAt: auth.expiration_time ? new Date(auth.expiration_time) : new Date(created.getTime() + VALID_DAYS * 86400_000),
    },
  });
  emitMockWebhook("PAYMENT.AUTHORIZATION.CREATED", { id: auth.id, status: "CREATED", custom_id: m.id, supplementary_data: { related_ids: { order_id: orderId } } });
  await transitionMilestone(m.id, "FUNDED", actor, `Authorization ${auth.id} holds ${centsToValue(m.amountCents)} ${m.currency}`);
  return load(milestoneId);
}

export function authHealth(m: { authorizationId: string | null; authStatus: string | null; honorPeriodEndsAt: Date | null; authExpiresAt: Date | null; status: string }) {
  if (!m.authorizationId || m.status === "SETTLED" || m.authStatus !== "CREATED") return { level: "ok" as const };
  const now = Date.now();
  if (m.authExpiresAt && m.authExpiresAt.getTime() < now) return { level: "expired" as const, message: "Authorization expired — funds are no longer held. Client must re-fund." };
  if (m.authExpiresAt && m.authExpiresAt.getTime() - now < 3 * 86400_000)
    return { level: "expiring" as const, message: `Authorization expires ${m.authExpiresAt.toDateString()}. Settle or re-fund soon.` };
  if (m.honorPeriodEndsAt && m.honorPeriodEndsAt.getTime() < now)
    return {
      level: "honor" as const,
      message: "3-day honor period has passed: capture is still possible but funds are no longer guaranteed. Reauthorize to re-guarantee.",
    };
  return { level: "ok" as const };
}

export async function reauthorizeMilestone(milestoneId: string, actor: string) {
  const m = await load(milestoneId);
  if (!m.authorizationId) throw new Error("No authorization to reauthorize");
  const auth = await reauthorize(
    m.authorizationId,
    { currency_code: m.currency, value: centsToValue(m.amountCents) },
    { contractId: m.contractId, milestoneId: m.id, actor, requestId: `settle-reauth-${m.authorizationId}` },
  );
  const created = auth.create_time ? new Date(auth.create_time) : new Date();
  await prisma.milestone.update({
    where: { id: m.id },
    data: {
      authorizationId: auth.id,
      authStatus: auth.status,
      authCreatedAt: created,
      honorPeriodEndsAt: new Date(created.getTime() + HONOR_DAYS * 86400_000),
      riskFlag: null,
    },
  });
  return auth;
}

/**
 * Settlement: capture `grossCents` of the authorization (final capture → PayPal voids the rest),
 * then pay the freelancer gross minus the platform fee via Payouts.
 * Only ever called by the server after a human confirmed a ProposedAction.
 */
export async function settleMilestone(milestoneId: string, freelancerCents: number, actor: string, reason: string) {
  const m = await load(milestoneId);
  if (!m.authorizationId) throw new Error("Milestone is not funded");
  if (freelancerCents < 0 || freelancerCents > m.amountCents) throw new Error("Invalid settlement amount");
  const ctxBase = { contractId: m.contractId, milestoneId: m.id, actor };

  let captureId = m.captureId;
  let capturedCents = m.capturedCents;

  if (freelancerCents === 0) {
    // Full refund to client: just void the hold.
    if (m.authStatus === "CREATED") {
      await voidAuthorization(m.authorizationId, { ...ctxBase, requestId: `settle-void-${m.authorizationId}` });
      emitMockWebhook("PAYMENT.AUTHORIZATION.VOIDED", { id: m.authorizationId, status: "VOIDED", custom_id: m.id });
    }
    await prisma.milestone.update({
      where: { id: m.id },
      data: { authStatus: "VOIDED", releasedCents: m.amountCents, riskFlag: null },
    });
  } else if (!captureId) {
    const full = freelancerCents === m.amountCents;
    try {
      const cap = await captureAuthorization(
        m.authorizationId,
        {
          amount: full ? undefined : { currency_code: m.currency, value: centsToValue(freelancerCents) },
          finalCapture: true,
          invoiceId: `SETTLE-${m.id}`,
          note: reason,
        },
        { ...ctxBase, requestId: `settle-capture-${m.authorizationId}` },
      );
      captureId = cap.id;
      capturedCents = freelancerCents;
      emitMockWebhook("PAYMENT.CAPTURE.COMPLETED", { id: cap.id, status: "COMPLETED", custom_id: m.id, supplementary_data: { related_ids: { authorization_id: m.authorizationId } } });
      // final_capture=true on a partial capture → PayPal voids the remainder of the authorization.
      if (!full) emitMockWebhook("PAYMENT.AUTHORIZATION.VOIDED", { id: m.authorizationId, status: "VOIDED", custom_id: m.id }, 2500);
    } catch (e) {
      if (e instanceof PayPalError && e.issue === "AUTHORIZATION_EXPIRED") {
        await prisma.milestone.update({ where: { id: m.id }, data: { authStatus: "EXPIRED", riskFlag: "AUTH_EXPIRED" } });
      }
      throw e;
    }
    await prisma.milestone.update({
      where: { id: m.id },
      data: {
        captureId,
        capturedCents,
        releasedCents: m.amountCents - freelancerCents,
        authStatus: full ? "CAPTURED" : "PARTIALLY_CAPTURED",
      },
    });
  }

  if (capturedCents > 0) {
    await payoutMilestone(m.id, actor);
  }
  const fresh = await load(milestoneId);
  if (fresh.status !== "SETTLED") await transitionMilestone(m.id, "SETTLED", actor, reason);
  return load(milestoneId);
}

/** Sends (or retries) the payout for whatever has been captured. Safe to call repeatedly. */
export async function payoutMilestone(milestoneId: string, actor: string) {
  const m = await load(milestoneId);
  if (m.payoutStatus === "SUCCESS" || m.payoutStatus === "PENDING") return m;
  const { feeCents, netCents } = splitFee(m.capturedCents);
  const attempt = m.payoutAttempts + 1;
  try {
    const res = await sendPayout(
      {
        // sender_batch_id is PayPal's own idempotency key for payouts (unique per 30 days)
        senderBatchId: `settle-${m.id}-a${attempt}`,
        receiverEmail: m.contract.freelancer.paypalEmail,
        amount: { currency_code: m.currency, value: centsToValue(netCents) },
        note: `Settle: ${m.contract.title} — ${m.title} (after ${feeCents / 100} ${m.currency} platform fee)`,
        itemId: m.id,
      },
      { contractId: m.contractId, milestoneId: m.id, actor, requestId: `settle-payout-${m.id}-a${attempt}` },
    );
    await prisma.milestone.update({
      where: { id: m.id },
      data: {
        payoutBatchId: res.batchId,
        payoutItemId: res.itemId,
        payoutStatus: res.itemStatus ?? "PENDING",
        payoutAttempts: attempt,
        feeCents,
        payoutCents: netCents,
        riskFlag: null,
      },
    });
    // Sandbox tip: a receiver email containing "fail" simulates a failed payout in MOCK mode.
    const fail = /fail/i.test(m.contract.freelancer.paypalEmail);
    emitMockWebhook(
      fail ? "PAYMENT.PAYOUTS-ITEM.FAILED" : "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      {
        payout_item_id: res.itemId ?? undefined,
        payout_batch_id: res.batchId,
        transaction_status: fail ? "FAILED" : "SUCCESS",
        payout_item: { sender_item_id: m.id },
        ...(fail ? { errors: { name: "RECEIVER_UNREGISTERED", message: "Receiver is unregistered (simulated)" } } : {}),
      },
      3000,
    );
  } catch (e) {
    await prisma.milestone.update({
      where: { id: m.id },
      data: { payoutStatus: "FAILED", payoutAttempts: attempt, riskFlag: "PAYOUT_FAILED", feeCents, payoutCents: netCents },
    });
    await audit({
      contractId: m.contractId,
      milestoneId: m.id,
      actor,
      kind: "ERROR",
      action: "payout.failed",
      summary: `Payout attempt ${attempt} failed: ${(e as Error).message}. Funds are captured and safe; retry from the dashboard.`,
    });
  }
  return load(milestoneId);
}
