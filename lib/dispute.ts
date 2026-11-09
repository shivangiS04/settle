import { prisma } from "./db";
import { audit } from "./audit";
import { transitionMilestone } from "./state";
import { runMediation } from "./agents/mediator";
import { settleMilestone } from "./escrow";
import { centsToValue, splitFee } from "./utils";

export async function openDispute(milestoneId: string, userId: string, reason: string, statement: string) {
  const m = await prisma.milestone.findUniqueOrThrow({ where: { id: milestoneId } });
  if (!["SUBMITTED", "VERIFIED"].includes(m.status)) throw new Error(`Cannot dispute while ${m.status}`);
  const d = await prisma.dispute.create({ data: { milestoneId, reason, clientStatement: statement } });
  await audit({ contractId: m.contractId, milestoneId, actor: `user:${userId}`, kind: "HUMAN_ACTION", action: "dispute.open", summary: `Client disputed: "${reason.slice(0, 200)}"` });
  await transitionMilestone(milestoneId, "DISPUTED", `user:${userId}`, "Client opened a dispute");
  return d;
}

export async function addFreelancerStatement(disputeId: string, userId: string, statement: string) {
  const d = await prisma.dispute.update({ where: { id: disputeId }, data: { freelancerStatement: statement }, include: { milestone: true } });
  await audit({
    contractId: d.milestone.contractId,
    milestoneId: d.milestoneId,
    actor: `user:${userId}`,
    kind: "HUMAN_ACTION",
    action: "dispute.statement",
    summary: `Freelancer responded: "${statement.slice(0, 200)}"`,
  });
  return d;
}

export async function requestMediation(disputeId: string) {
  const d = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId }, include: { proposals: true } });
  if (d.status === "AGREED" || d.status === "ESCALATED") throw new Error(`Dispute is ${d.status}`);
  if (d.round >= 1 && d.proposals.some((p) => p.round === d.round && (!p.clientResponse || !p.freelancerResponse)))
    throw new Error("Both parties must respond to the current proposal first");
  return runMediation(disputeId);
}

/**
 * A party accepts or counters the latest proposal.
 * Both accept → the second acceptance is the human confirmation that executes the partial settlement.
 * Round 2 is final: a counter there escalates (funds stay held, flagged for ops).
 */
export async function respondToProposal(
  proposalId: string,
  user: { id: string; name: string },
  side: "CLIENT" | "FREELANCER",
  response: "ACCEPT" | "COUNTER",
  counterPct?: number,
  note?: string,
) {
  const p = await prisma.mediationProposal.findUniqueOrThrow({ where: { id: proposalId }, include: { dispute: { include: { milestone: true } } } });
  const d = p.dispute;
  const m = d.milestone;
  if (p.round !== d.round || d.status !== "PROPOSED") throw new Error("This proposal is no longer open");
  if (response === "COUNTER") {
    if (counterPct == null || counterPct < 0 || counterPct > 100) throw new Error("Counter must be a % between 0 and 100");
  }
  const data =
    side === "CLIENT"
      ? { clientResponse: response, clientCounterPct: response === "COUNTER" ? counterPct : null, clientCounterNote: note ?? null }
      : { freelancerResponse: response, freelancerCounterPct: response === "COUNTER" ? counterPct : null, freelancerCounterNote: note ?? null };
  const updated = await prisma.mediationProposal.update({ where: { id: p.id }, data });
  await audit({
    contractId: m.contractId,
    milestoneId: m.id,
    actor: `user:${user.id}`,
    kind: "HUMAN_ACTION",
    action: `mediation.${response.toLowerCase()}`,
    summary: `${user.name} (${side.toLowerCase()}) ${response === "ACCEPT" ? `accepted the ${p.freelancerPct}% / ${100 - p.freelancerPct}% split` : `countered with ${counterPct}% to freelancer${note ? `: "${note}"` : ""}`} (round ${p.round})`,
  });

  if (!updated.clientResponse || !updated.freelancerResponse) return { state: "WAITING" as const };

  if (updated.clientResponse === "ACCEPT" && updated.freelancerResponse === "ACCEPT") {
    await prisma.dispute.update({ where: { id: d.id }, data: { status: "AGREED", agreedFreelancerPct: p.freelancerPct } });
    const freelancerCents = Math.round((m.amountCents * p.freelancerPct) / 100);
    const { feeCents, netCents } = splitFee(freelancerCents);
    const pa = await prisma.proposedAction.create({
      data: {
        contractId: m.contractId,
        milestoneId: m.id,
        source: "agent:mediator",
        type: "PARTIAL_SETTLE",
        title: `Settle "${m.title}": ${p.freelancerPct}% to freelancer`,
        paramsJson: JSON.stringify({ freelancerPct: p.freelancerPct, freelancerCents, refundCents: m.amountCents - freelancerCents, feeCents, netCents }),
        rationale: p.reasoning,
        confirmedBy: "both-parties",
      },
    });
    await transitionMilestone(m.id, "MEDIATED", "agent:mediator", `Both parties accepted ${p.freelancerPct}% to freelancer`);
    await audit({
      contractId: m.contractId,
      milestoneId: m.id,
      actor: "system",
      kind: "HUMAN_ACTION",
      action: "proposed_action.confirmed",
      summary: `Mediator's proposal confirmed by both parties → capture ${centsToValue(freelancerCents)}, release ${centsToValue(m.amountCents - freelancerCents)} ${m.currency} to client`,
    });
    try {
      const s = await settleMilestone(m.id, freelancerCents, "system:mediation", `Mediated settlement: ${p.freelancerPct}% to freelancer`);
      await prisma.proposedAction.update({
        where: { id: pa.id },
        data: { status: "EXECUTED", executedAt: new Date(), resultJson: JSON.stringify({ captureId: s.captureId, payoutBatchId: s.payoutBatchId }) },
      });
    } catch (e) {
      await prisma.proposedAction.update({ where: { id: pa.id }, data: { status: "FAILED", resultJson: JSON.stringify({ error: (e as Error).message }) } });
      throw e;
    }
    return { state: "SETTLED" as const };
  }

  if (p.round >= 2) {
    await prisma.dispute.update({ where: { id: d.id }, data: { status: "ESCALATED" } });
    await prisma.milestone.update({ where: { id: m.id }, data: { riskFlag: "DISPUTE_ESCALATED" } });
    await audit({
      contractId: m.contractId,
      milestoneId: m.id,
      actor: "system",
      kind: "STATE_CHANGE",
      action: "dispute.escalated",
      summary: "No agreement after 2 mediation rounds — escalated to Settle ops. Funds remain held by the PayPal authorization.",
    });
    return { state: "ESCALATED" as const };
  }

  // Someone countered in round 1 → mediator reconsiders with the counters.
  await runMediation(d.id);
  return { state: "NEXT_ROUND" as const };
}
