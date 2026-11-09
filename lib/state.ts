import { prisma } from "./db";
import { audit } from "./audit";

export const MILESTONE_STATES = [
  "DRAFT",
  "AGREED",
  "FUNDED",
  "SUBMITTED",
  "VERIFIED",
  "APPROVED",
  "DISPUTED",
  "MEDIATED",
  "SETTLED",
] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];

const TRANSITIONS: Record<MilestoneState, MilestoneState[]> = {
  DRAFT: ["AGREED"],
  AGREED: ["FUNDED"],
  FUNDED: ["SUBMITTED", "SETTLED"], // SETTLED here = voided/refunded before delivery
  SUBMITTED: ["VERIFIED", "SUBMITTED", "APPROVED", "DISPUTED"], // client may decide before the verifier finishes
  VERIFIED: ["APPROVED", "DISPUTED", "SUBMITTED"], // resubmission allowed
  APPROVED: ["SETTLED"],
  DISPUTED: ["MEDIATED", "DISPUTED"],
  MEDIATED: ["SETTLED"],
  SETTLED: [],
};

export function canTransition(from: string, to: MilestoneState) {
  return (TRANSITIONS[from as MilestoneState] ?? []).includes(to);
}

/**
 * Moves a milestone through the state machine. Idempotent: transitioning to the
 * current state (e.g. on webhook replay) is a no-op and returns false.
 */
export async function transitionMilestone(
  milestoneId: string,
  to: MilestoneState,
  actor: string,
  reason: string,
  extra: Record<string, unknown> = {},
) {
  const m = await prisma.milestone.findUniqueOrThrow({ where: { id: milestoneId } });
  if (m.status === to && to !== "SUBMITTED" && to !== "DISPUTED") return false;
  if (!canTransition(m.status, to)) {
    await audit({
      contractId: m.contractId,
      milestoneId,
      actor,
      kind: "ERROR",
      action: "state.transition.rejected",
      summary: `Illegal transition ${m.status} → ${to} (${reason})`,
    });
    throw new Error(`Illegal transition ${m.status} → ${to}`);
  }
  await prisma.milestone.update({
    where: { id: milestoneId },
    data: { status: to, stateChangedAt: new Date(), ...extra },
  });
  await audit({
    contractId: m.contractId,
    milestoneId,
    actor,
    kind: "STATE_CHANGE",
    action: `state.${m.status}->${to}`,
    summary: `${m.title}: ${m.status} → ${to} — ${reason}`,
  });
  await recomputeContractStatus(m.contractId);
  return true;
}

export async function recomputeContractStatus(contractId: string) {
  const c = await prisma.contract.findUnique({ where: { id: contractId }, include: { milestones: true } });
  if (!c) return;
  let status = c.status;
  if (c.status === "DRAFT") return;
  const ms = c.milestones;
  if (ms.length && ms.every((m) => m.status === "SETTLED")) status = "COMPLETED";
  else if (ms.some((m) => !["DRAFT", "AGREED"].includes(m.status))) status = "ACTIVE";
  else status = "AGREED";
  if (status !== c.status) await prisma.contract.update({ where: { id: contractId }, data: { status } });
}
