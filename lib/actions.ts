import { prisma } from "./db";
import { audit } from "./audit";
import { executeToolkitCall } from "./agents/toolkit";
import { safeJson } from "./utils";

/**
 * The ONLY place agent-proposed actions are executed — after a human clicked Confirm.
 * Escrow money movements (approve / mediated split) are confirmed in their own flows and
 * also recorded as ProposedActions, so the audit trail has one shape for "why money moved".
 */
export async function confirmAction(actionId: string, user: { id: string; name: string }) {
  const pa = await prisma.proposedAction.findUniqueOrThrow({ where: { id: actionId } });
  if (pa.requestedFor && pa.requestedFor !== user.id) throw new Error("This action is waiting for someone else's confirmation");
  if (pa.status !== "PENDING") throw new Error(`Action is already ${pa.status}`);

  // Claim it first so a double-click can't execute twice.
  const claimed = await prisma.proposedAction.updateMany({ where: { id: pa.id, status: "PENDING" }, data: { status: "EXECUTING", confirmedBy: user.id } });
  if (claimed.count === 0) throw new Error("Action is already being executed");

  await audit({
    contractId: pa.contractId,
    milestoneId: pa.milestoneId,
    actor: `user:${user.id}`,
    kind: "HUMAN_ACTION",
    action: "proposed_action.confirm",
    summary: `${user.name} confirmed: ${pa.title} (proposed by ${pa.source})`,
    resourceId: pa.id,
  });

  try {
    const params = safeJson<Record<string, unknown>>(pa.paramsJson, {});
    let result: unknown;
    if (pa.type === "TOOLKIT_CALL") {
      result = await executeToolkitCall(String(params.tool), (params.args ?? {}) as Record<string, unknown>, {
        contractId: pa.contractId,
        milestoneId: pa.milestoneId,
        actor: `user:${user.id}`,
      });
    } else if (pa.type === "SEND_REMINDER") {
      // In-app delivery: shows on the recipient's home page and in the contract audit trail.
      result = { delivered: "in-app", to: params.toUserId };
      await audit({
        contractId: pa.contractId,
        milestoneId: pa.milestoneId,
        actor: `user:${user.id}`,
        kind: "HUMAN_ACTION",
        action: "reminder.sent",
        summary: `Reminder sent: "${String(params.message).slice(0, 300)}"`,
      });
    } else {
      throw new Error(`Action type ${pa.type} is executed by its own flow`);
    }
    await prisma.proposedAction.update({ where: { id: pa.id }, data: { status: "EXECUTED", executedAt: new Date(), resultJson: JSON.stringify(result) } });
    return result;
  } catch (e) {
    await prisma.proposedAction.update({ where: { id: pa.id }, data: { status: "FAILED", resultJson: JSON.stringify({ error: (e as Error).message }) } });
    await audit({ contractId: pa.contractId, milestoneId: pa.milestoneId, actor: "system", kind: "ERROR", action: "proposed_action.failed", summary: `${pa.title} failed: ${(e as Error).message}` });
    throw e;
  }
}

export async function rejectAction(actionId: string, user: { id: string; name: string }) {
  const pa = await prisma.proposedAction.findUniqueOrThrow({ where: { id: actionId } });
  if (pa.requestedFor && pa.requestedFor !== user.id) throw new Error("Not your action");
  if (pa.status !== "PENDING") throw new Error(`Action is already ${pa.status}`);
  await prisma.proposedAction.update({ where: { id: pa.id }, data: { status: "REJECTED", confirmedBy: user.id } });
  await audit({ contractId: pa.contractId, milestoneId: pa.milestoneId, actor: `user:${user.id}`, kind: "HUMAN_ACTION", action: "proposed_action.reject", summary: `${user.name} rejected: ${pa.title}` });
}
