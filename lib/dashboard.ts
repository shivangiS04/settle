import { prisma } from "./db";

export type CriterionRow = { id: string; criterion: string; checkType: string; passed: boolean | null; confidence: number | null; evidence: string; screenshotUrl: string | null };
export type MilestoneRow = {
  id: string;
  contractId: string;
  title: string;
  status: string;
  amount: number;
  held: number;
  paidOut: number;
  refunded: number;
  fees: number;
  score: number | null;
  riskFlag: string | null;
  lastPaypalEvent: string | null;
  stateChangedAt: string;
  authorizationId: string | null;
  payoutStatus: string | null;
  criteria: CriterionRow[];
};
export type ContractRow = {
  id: string;
  title: string;
  client: string;
  freelancer: string;
  status: string;
  currency: string;
  amount: number;
  held: number;
  paidOut: number;
  refunded: number;
  fees: number;
  score: number | null;
  riskFlag: string | null;
  lastPaypalEvent: string | null;
  stateChangedAt: string;
  milestones: MilestoneRow[];
};

const HOLDING = new Set(["FUNDED", "SUBMITTED", "VERIFIED", "APPROVED", "DISPUTED", "MEDIATED"]);

export async function loadDashboard(): Promise<ContractRow[]> {
  const contracts = await prisma.contract.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      client: true,
      freelancer: true,
      milestones: {
        orderBy: { idx: "asc" },
        include: {
          criteria: { orderBy: { idx: "asc" } },
          verifications: { orderBy: { createdAt: "desc" }, take: 1, include: { results: true } },
        },
      },
    },
  });

  return contracts.map((c) => {
    const ms: MilestoneRow[] = c.milestones.map((m) => {
      const v = m.verifications[0];
      const held = HOLDING.has(m.status) && m.authStatus === "CREATED" ? m.amountCents / 100 : 0;
      return {
        id: m.id,
        contractId: c.id,
        title: m.title,
        status: m.status,
        amount: m.amountCents / 100,
        held,
        paidOut: m.payoutStatus === "SUCCESS" || m.payoutStatus === "PENDING" ? m.payoutCents / 100 : 0,
        refunded: m.releasedCents / 100,
        fees: m.feeCents / 100,
        score: m.verifierScore,
        riskFlag: m.riskFlag,
        lastPaypalEvent: m.lastPaypalEvent,
        stateChangedAt: m.stateChangedAt.toISOString(),
        authorizationId: m.authorizationId,
        payoutStatus: m.payoutStatus,
        criteria: m.criteria.map((cr) => {
          const r = v?.results.find((x) => x.criterionId === cr.id);
          return {
            id: cr.id,
            criterion: cr.text,
            checkType: cr.checkType,
            passed: r ? r.passed : null,
            confidence: r ? r.confidence : null,
            evidence: r?.evidence ?? "Not verified yet",
            screenshotUrl: r?.screenshotUrl ?? null,
          };
        }),
      };
    });
    const sum = (k: "amount" | "held" | "paidOut" | "refunded" | "fees") => Math.round(ms.reduce((s, m) => s + m[k], 0) * 100) / 100;
    const scored = ms.filter((m) => m.score != null);
    const latestEvent = c.milestones
      .filter((m) => m.lastPaypalEventAt)
      .sort((a, b) => b.lastPaypalEventAt!.getTime() - a.lastPaypalEventAt!.getTime())[0];
    const active = ms.filter((m) => m.status !== "SETTLED");
    return {
      id: c.id,
      title: c.title,
      client: c.client.name,
      freelancer: c.freelancer.name,
      status: c.status,
      currency: c.currency,
      amount: sum("amount"),
      held: sum("held"),
      paidOut: sum("paidOut"),
      refunded: sum("refunded"),
      fees: sum("fees"),
      score: scored.length ? Math.round((scored.reduce((s, m) => s + (m.score ?? 0), 0) / scored.length) * 10) / 10 : null,
      riskFlag: ms.find((m) => m.riskFlag)?.riskFlag ?? null,
      lastPaypalEvent: latestEvent?.lastPaypalEvent ?? null,
      stateChangedAt: (active.length ? active : ms).map((m) => m.stateChangedAt).sort()[0] ?? c.updatedAt.toISOString(),
      milestones: ms,
    };
  });
}
