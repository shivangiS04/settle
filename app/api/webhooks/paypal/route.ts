import { NextResponse } from "next/server";
import { ingestEvent, verifyWebhookSignature, type PayPalWebhookEvent } from "@/lib/paypal/webhooks";
import { audit } from "@/lib/audit";
import { paypalMock } from "@/lib/mode";

export const runtime = "nodejs";

/** PayPal → Settle. Verify signature, dedupe by event id, then drive the state machine. */
export async function POST(req: Request) {
  const raw = await req.text();
  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!event?.id || !event?.event_type) return NextResponse.json({ error: "not a PayPal event" }, { status: 400 });

  let verified = false;
  try {
    verified = paypalMock() ? req.headers.get("x-settle-simulated") === "1" : await verifyWebhookSignature(req.headers, event);
  } catch (e) {
    await audit({ actor: "paypal:webhook", kind: "ERROR", action: event.event_type, summary: `Signature verification error: ${(e as Error).message}` });
    return NextResponse.json({ error: "verification error" }, { status: 500 }); // 5xx → PayPal retries
  }
  if (!verified) {
    await audit({ actor: "paypal:webhook", kind: "ERROR", action: event.event_type, summary: `Rejected webhook ${event.id}: signature verification FAILED` });
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const result = await ingestEvent(event, true);
  return NextResponse.json({ ok: true, result });
}
