import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/session";
import { authorizeFunding, createFundingOrder, payoutMilestone, reauthorizeMilestone, settleMilestone } from "@/lib/escrow";
import { transitionMilestone } from "@/lib/state";
import { centsToValue, splitFee } from "@/lib/utils";
import { runVerification } from "@/lib/agents/verifier";
import { assertPublicUrl } from "@/lib/verifier/browse";
import { parseRepo } from "@/lib/verifier/github";

export const runtime = "nodejs";
export const maxDuration = 120;

type Ctx = { params: { id: string; action: string } };

/** Long-lived Node server (Render) → fire-and-forget is fine; the UI polls for the result. */
const running = new Set<string>();
function startVerification(milestoneId: string, deliveryId: string) {
  if (running.has(deliveryId)) return;
  running.add(deliveryId);
  runVerification(milestoneId, deliveryId)
    .catch((e) => console.error("[verifier]", e))
    .finally(() => running.delete(deliveryId));
}

export async function POST(req: Request, { params }: Ctx) {
  const { id, action } = params;
  const body = await req.json().catch(() => ({}));
  try {
    const { role, user } = await requireUser();
    const actor = `user:${user.id}`;
    const m = await prisma.milestone.findUniqueOrThrow({ where: { id }, include: { contract: true } });
    const isClient = role === "CLIENT" && m.contract.clientId === user.id;
    const isFreelancer = role === "FREELANCER" && m.contract.freelancerId === user.id;
    const needClient = () => {
      if (!isClient) throw new Error("Only the client can do this");
    };
    const needFreelancer = () => {
      if (!isFreelancer) throw new Error("Only the freelancer can do this");
    };

    switch (action) {
      case "order": {
        needClient();
        const order = await createFundingOrder(id, actor);
        return NextResponse.json({ id: order.id });
      }
      case "authorize": {
        needClient();
        const res = await authorizeFunding(id, String(body.orderId), actor);
        return NextResponse.json({ ok: true, authorizationId: res.authorizationId });
      }
      case "reauthorize": {
        needClient();
        const auth = await reauthorizeMilestone(id, actor);
        return NextResponse.json({ ok: true, authorizationId: auth.id });
      }
      case "approve": {
        // The client's click IS the human confirmation. We still record it as a ProposedAction
        // so every money movement has the same explainable shape in the audit trail.
        needClient();
        if (!["VERIFIED", "SUBMITTED"].includes(m.status)) throw new Error(`Cannot approve from ${m.status}`);
        const { feeCents, netCents } = splitFee(m.amountCents);
        const pa = await prisma.proposedAction.create({
          data: {
            contractId: m.contractId,
            milestoneId: id,
            source: "user",
            type: "CAPTURE_AND_PAYOUT",
            title: `Release ${centsToValue(m.amountCents)} ${m.currency} for "${m.title}"`,
            paramsJson: JSON.stringify({ freelancerCents: m.amountCents, feeCents, netCents }),
            rationale: "Client approved the delivery.",
            status: "PENDING",
            requestedFor: user.id,
            confirmedBy: user.id,
          },
        });
        await audit({
          contractId: m.contractId,
          milestoneId: id,
          actor,
          kind: "HUMAN_ACTION",
          action: "milestone.approve",
          summary: `Client approved "${m.title}" → capture ${centsToValue(m.amountCents)}, fee ${centsToValue(feeCents)}, payout ${centsToValue(netCents)} ${m.currency}`,
        });
        await transitionMilestone(id, "APPROVED", actor, "Client approved delivery");
        const settled = await settleMilestone(id, m.amountCents, actor, "Client approved delivery");
        await prisma.proposedAction.update({
          where: { id: pa.id },
          data: { status: "EXECUTED", executedAt: new Date(), resultJson: JSON.stringify({ captureId: settled.captureId, payoutBatchId: settled.payoutBatchId }) },
        });
        return NextResponse.json({ ok: true });
      }
      case "submit": {
        needFreelancer();
        if (!["FUNDED", "VERIFIED", "SUBMITTED"].includes(m.status)) throw new Error(`Cannot submit while ${m.status}`);
        const type = String(body.type ?? "").toUpperCase();
        const content = String(body.content ?? "").trim();
        if (!["URL", "GITHUB", "TEXT"].includes(type)) throw new Error("type must be URL, GITHUB or TEXT");
        if (!content) throw new Error("Delivery content is required");
        if (type === "URL") await assertPublicUrl(content);
        if (type === "GITHUB") parseRepo(content);
        if (content.length > 100_000) throw new Error("Delivery too large");
        const d = await prisma.delivery.create({ data: { milestoneId: id, type, content, note: String(body.note ?? "").slice(0, 2000) } });
        await audit({
          contractId: m.contractId,
          milestoneId: id,
          actor,
          kind: "HUMAN_ACTION",
          action: "delivery.submit",
          summary: `Freelancer submitted a ${type} delivery${type !== "TEXT" ? `: ${content}` : ` (${content.length} chars)`}`,
        });
        await transitionMilestone(id, "SUBMITTED", actor, `${type} delivery submitted`);
        startVerification(id, d.id);
        return NextResponse.json({ ok: true, deliveryId: d.id });
      }
      case "verify": {
        // Re-run the verifier on the latest delivery (either party may ask).
        if (!isClient && !isFreelancer) throw new Error("Not a party to this contract");
        const d = await prisma.delivery.findFirst({ where: { milestoneId: id }, orderBy: { createdAt: "desc" } });
        if (!d) throw new Error("No delivery to verify");
        if (!["SUBMITTED", "VERIFIED"].includes(m.status)) throw new Error(`Cannot verify while ${m.status}`);
        startVerification(id, d.id);
        return NextResponse.json({ ok: true });
      }
      case "retry-payout": {
        if (m.payoutStatus !== "FAILED") throw new Error("Payout is not in a failed state");
        await payoutMilestone(id, actor);
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: `Unknown action ${action}` }, { status: 404 });
    }
  } catch (e) {
    console.error(`[milestone:${action}]`, e);
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
