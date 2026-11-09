import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/session";
import { authorizeFunding, createFundingOrder, payoutMilestone, reauthorizeMilestone, settleMilestone } from "@/lib/escrow";
import { transitionMilestone } from "@/lib/state";
import { centsToValue, splitFee } from "@/lib/utils";

export const runtime = "nodejs";
export const maxDuration = 120;

type Ctx = { params: { id: string; action: string } };

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
