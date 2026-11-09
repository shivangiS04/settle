import { prisma } from "./db";
import { audit } from "./audit";
import { authHealth, settleMilestone } from "./escrow";
import { transitionMilestone } from "./state";
import { getPayoutItem } from "./paypal/payouts";
import { paypalMock } from "./mode";
import { centsToValue, splitFee } from "./utils";

/**
 * Periodic housekeeping (every 60s via instrumentation.ts, or POST /api/cron/tick):
 *  1. Auto-approve: VERIFIED + 100% score + autoApproveAt passed → release funds (policy both parties agreed to).
 *  2. Authorization health: flag honor-period / expiry risk so it shows in the grid.
 *  3. Payout status sync: poll PENDING payout items (fallback when webhooks can't reach us, e.g. localhost).
 */
export async function tick() {
  const now = new Date();
  const out = { autoApproved: 0, flagged: 0, payoutsSynced: 0 };

  const due = await prisma.milestone.findMany({ where: { status: "VERIFIED", verifierScore: 100, autoApproveAt: { lte: now } } });
  for (const m of due) {
    try {
      const { feeCents, netCents } = splitFee(m.amountCents);
      const pa = await prisma.proposedAction.create({
        data: {
          contractId: m.contractId,
          milestoneId: m.id,
          source: "system:auto-approve",
          type: "CAPTURE_AND_PAYOUT",
          title: `Auto-release ${centsToValue(m.amountCents)} ${m.currency} for "${m.title}"`,
          paramsJson: JSON.stringify({ freelancerCents: m.amountCents, feeCents, netCents }),
          rationale: `Verifier scored 100% and the client did not act before ${m.autoApproveAt?.toISOString()}. Auto-approval is part of the accepted contract terms.`,
          confirmedBy: "policy:auto-approve",
        },
      });
      await audit({
        contractId: m.contractId,
        milestoneId: m.id,
        actor: "system:auto-approve",
        kind: "AGENT_DECISION",
        action: "milestone.auto_approve",
        summary: `Auto-approve window elapsed with a 100% verifier score → releasing funds`,
      });
      await transitionMilestone(m.id, "APPROVED", "system:auto-approve", "Auto-approved (100% verified, window elapsed)");
      await settleMilestone(m.id, m.amountCents, "system:auto-approve", "Auto-approved after verification");
      await prisma.proposedAction.update({ where: { id: pa.id }, data: { status: "EXECUTED", executedAt: new Date() } });
      out.autoApproved++;
    } catch (e) {
      console.error("[tick:auto-approve]", e);
    }
  }

  const held = await prisma.milestone.findMany({ where: { status: { in: ["FUNDED", "SUBMITTED", "VERIFIED", "DISPUTED", "MEDIATED"] }, authStatus: "CREATED" } });
  for (const m of held) {
    const h = authHealth(m);
    const flag = h.level === "expired" ? "AUTH_EXPIRED" : h.level === "expiring" ? "AUTH_EXPIRING" : h.level === "honor" ? "HONOR_PERIOD_PASSED" : null;
    const isAuthFlag = (f: string | null) => f === "HONOR_PERIOD_PASSED" || (!!f && f.startsWith("AUTH_"));
    if (flag && m.riskFlag !== flag && (!m.riskFlag || isAuthFlag(m.riskFlag))) {
      await prisma.milestone.update({ where: { id: m.id }, data: { riskFlag: flag } });
      await audit({ contractId: m.contractId, milestoneId: m.id, actor: "system", kind: "STATE_CHANGE", action: "risk.flag", summary: `${m.title}: ${h.message}` });
      out.flagged++;
    }
  }

  if (!paypalMock()) {
    const pending = await prisma.milestone.findMany({ where: { payoutStatus: { in: ["PENDING", "UNCLAIMED", "ONHOLD"] }, payoutItemId: { not: null }, updatedAt: { lte: new Date(now.getTime() - 30_000) } } });
    for (const m of pending) {
      try {
        const item = await getPayoutItem(m.payoutItemId!, { contractId: m.contractId, milestoneId: m.id, actor: "system:payout-sync" });
        const st = item.transaction_status;
        if (st && st !== m.payoutStatus) {
          const failed = ["FAILED", "RETURNED", "BLOCKED", "DENIED"].includes(st);
          await prisma.milestone.update({
            where: { id: m.id },
            data: { payoutStatus: failed ? "FAILED" : st, riskFlag: failed ? "PAYOUT_FAILED" : m.riskFlag === "PAYOUT_FAILED" ? null : m.riskFlag },
          });
          out.payoutsSynced++;
        }
      } catch (e) {
        console.error("[tick:payout-sync]", e);
      }
    }
  }
  return out;
}
