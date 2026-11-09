import { paypalFetch, mockId } from "./client";
import { paypalMock } from "../mode";
import { prisma } from "../db";
import { audit } from "../audit";
import { transitionMilestone } from "../state";
import { payoutMilestone } from "../escrow";

export type PayPalWebhookEvent = {
  id: string;
  event_type: string;
  create_time?: string;
  summary?: string;
  resource_type?: string;
  resource: Record<string, unknown> & {
    id?: string;
    status?: string;
    custom_id?: string;
    supplementary_data?: { related_ids?: { order_id?: string; authorization_id?: string; capture_id?: string } };
    payout_item_id?: string;
    payout_batch_id?: string;
    transaction_status?: string;
    payout_item?: { sender_item_id?: string };
    errors?: { name?: string; message?: string };
  };
};

/**
 * Verifies a webhook via POST /v1/notifications/verify-webhook-signature.
 * Uses the transmission headers + our PAYPAL_WEBHOOK_ID; never trust an unverified event.
 */
export async function verifyWebhookSignature(headers: Headers, event: PayPalWebhookEvent) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new Error("PAYPAL_WEBHOOK_ID is not configured");
  const body = {
    auth_algo: headers.get("paypal-auth-algo"),
    cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"),
    transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: event,
  };
  if (!body.transmission_id || !body.transmission_sig) return false;
  const res = await paypalFetch<{ verification_status: string }>(
    "POST",
    "/v1/notifications/verify-webhook-signature",
    body,
    { actor: "paypal:webhook", summary: `Verify signature of ${event.event_type} ${event.id}` },
    () => ({ verification_status: "SUCCESS" }),
  );
  return res.verification_status === "SUCCESS";
}

/**
 * Replay-safe processing: the PayPal event id is the WebhookEvent primary key, so a redelivered
 * event fails the insert and is acknowledged without re-running side effects.
 */
export async function ingestEvent(event: PayPalWebhookEvent, verified: boolean): Promise<"processed" | "duplicate"> {
  try {
    await prisma.webhookEvent.create({
      data: {
        id: event.id,
        eventType: event.event_type,
        resourceId: event.resource?.id ?? event.resource?.payout_item_id ?? null,
        verified,
        payloadJson: JSON.stringify(event),
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      await audit({ actor: "paypal:webhook", kind: "WEBHOOK", action: `${event.event_type} (replay)`, summary: `Duplicate delivery of ${event.id} ignored`, resourceId: event.resource?.id });
      return "duplicate";
    }
    throw e;
  }
  await processEvent(event);
  return "processed";
}

async function findMilestone(ev: PayPalWebhookEvent) {
  const r = ev.resource;
  const rel = r.supplementary_data?.related_ids ?? {};
  const ors = [
    r.custom_id ? { id: r.custom_id } : null,
    r.payout_item?.sender_item_id ? { id: r.payout_item.sender_item_id } : null,
    rel.authorization_id ? { authorizationId: rel.authorization_id } : null,
    rel.order_id ? { paypalOrderId: rel.order_id } : null,
    r.id ? { authorizationId: r.id } : null,
    r.id ? { captureId: r.id } : null,
    r.payout_item_id ? { payoutItemId: r.payout_item_id } : null,
  ].filter(Boolean) as object[];
  return prisma.milestone.findFirst({ where: { OR: ors } });
}

async function processEvent(ev: PayPalWebhookEvent) {
  const m = await findMilestone(ev);
  const base = { contractId: m?.contractId, milestoneId: m?.id, actor: "paypal:webhook", resourceId: ev.resource?.id ?? ev.resource?.payout_item_id ?? null };
  await audit({ ...base, kind: "WEBHOOK", action: ev.event_type, summary: `Webhook ${ev.event_type} (${ev.id})${m ? "" : " — no matching milestone"}`, response: ev.resource });
  if (!m) return;

  await prisma.milestone.update({ where: { id: m.id }, data: { lastPaypalEvent: ev.event_type, lastPaypalEventAt: new Date() } });
  const r = ev.resource;

  switch (ev.event_type) {
    case "PAYMENT.AUTHORIZATION.CREATED": {
      // Usually already handled synchronously by /authorize; this covers the case where the browser died mid-flow.
      if (!m.authorizationId && r.id) {
        const created = new Date();
        await prisma.milestone.update({
          where: { id: m.id },
          data: {
            authorizationId: r.id,
            authStatus: "CREATED",
            authCreatedAt: created,
            honorPeriodEndsAt: new Date(created.getTime() + 3 * 86400_000),
            authExpiresAt: new Date(created.getTime() + 29 * 86400_000),
          },
        });
      }
      if (m.status === "AGREED") await transitionMilestone(m.id, "FUNDED", "paypal:webhook", "Authorization created (webhook)");
      break;
    }
    case "PAYMENT.AUTHORIZATION.VOIDED": {
      await prisma.milestone.update({
        where: { id: m.id },
        data: {
          authStatus: m.capturedCents > 0 ? "PARTIALLY_CAPTURED" : "VOIDED",
          // A void we didn't initiate (e.g. expiry, buyer dispute) while work is in flight is a risk.
          riskFlag: m.status !== "SETTLED" && m.capturedCents === 0 ? "AUTH_VOIDED" : m.riskFlag,
        },
      });
      break;
    }
    case "PAYMENT.CAPTURE.COMPLETED": {
      if (!m.captureId && r.id) await prisma.milestone.update({ where: { id: m.id }, data: { captureId: r.id } });
      break;
    }
    case "PAYMENT.CAPTURE.DENIED":
    case "PAYMENT.CAPTURE.DECLINED": {
      await prisma.milestone.update({ where: { id: m.id }, data: { riskFlag: "CAPTURE_DENIED" } });
      break;
    }
    case "PAYMENT.PAYOUTS-ITEM.SUCCEEDED": {
      await prisma.milestone.update({ where: { id: m.id }, data: { payoutStatus: "SUCCESS", riskFlag: m.riskFlag === "PAYOUT_FAILED" ? null : m.riskFlag } });
      break;
    }
    case "PAYMENT.PAYOUTS-ITEM.FAILED":
    case "PAYMENT.PAYOUTS-ITEM.BLOCKED":
    case "PAYMENT.PAYOUTS-ITEM.RETURNED":
    case "PAYMENT.PAYOUTS-ITEM.DENIED":
    case "PAYMENT.PAYOUTS-ITEM.UNCLAIMED": {
      const status = ev.event_type.split(".").pop()!;
      await prisma.milestone.update({ where: { id: m.id }, data: { payoutStatus: "FAILED", riskFlag: "PAYOUT_FAILED" } });
      await audit({
        ...base,
        kind: "ERROR",
        action: "payout.failed",
        summary: `Payout ${status}: ${r.errors?.message ?? r.errors?.name ?? "no reason given"}. Captured funds are safe on the platform.`,
      });
      // One automatic retry for transient failures; after that a human retries from the dashboard.
      if (status === "FAILED" && m.payoutAttempts < 2) await payoutMilestone(m.id, "system:auto-retry");
      break;
    }
  }
}

/**
 * MOCK mode only: emit the webhook PayPal would have sent, through the same ingest path
 * (dedupe + state machine), after a short delay — so the demo stays webhook-driven.
 */
export function emitMockWebhook(eventType: string, resource: PayPalWebhookEvent["resource"], delayMs = 1500) {
  if (!paypalMock()) return;
  setTimeout(() => {
    ingestEvent({ id: mockId("WH-MOCK"), event_type: eventType, create_time: new Date().toISOString(), resource }, false).catch((e) =>
      console.error("[mock webhook]", e),
    );
  }, delayMs);
}
