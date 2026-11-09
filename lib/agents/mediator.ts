import * as z from "zod/v4";
import { prisma } from "../db";
import { structuredCall } from "./llm";
import { MEDIATOR_AGENT_SYSTEM } from "./prompts";
import { centsToValue } from "../utils";

export const ProposalSchema = z.object({
  freelancer_pct: z.number(),
  reasoning: z.string(),
  per_criterion: z.array(z.object({ criterion_id: z.string(), note: z.string() })),
});
type Proposal = z.infer<typeof ProposalSchema>;

/** Runs one mediation round and stores the proposal. Money does not move here. */
export async function runMediation(disputeId: string) {
  const d = await prisma.dispute.findUniqueOrThrow({
    where: { id: disputeId },
    include: {
      proposals: { orderBy: { round: "asc" } },
      milestone: {
        include: {
          contract: true,
          criteria: { orderBy: { idx: "asc" } },
          verifications: { orderBy: { createdAt: "desc" }, take: 1, include: { results: true } },
          deliveries: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
  });
  const m = d.milestone;
  const v = m.verifications[0];
  const round = d.round + 1;

  const input = {
    contract: { title: m.contract.title, summary: m.contract.summary },
    milestone: { title: m.title, description: m.description, held_amount: `${centsToValue(m.amountCents)} ${m.currency}` },
    criteria: m.criteria.map((c) => {
      const r = v?.results.find((x) => x.criterionId === c.id);
      return { id: c.id, text: c.text, verifier: r ? { passed: r.passed, confidence: r.confidence, evidence: r.evidence } : "not verified" };
    }),
    verifier_score_pct: v?.scorePct ?? null,
    verifier_summary: v?.summary ?? null,
    delivery: m.deliveries[0] ? { type: m.deliveries[0].type, content: m.deliveries[0].type === "TEXT" ? m.deliveries[0].content.slice(0, 3000) : m.deliveries[0].content } : null,
    dispute_reason: d.reason,
    client_statement: d.clientStatement || "(none)",
    freelancer_statement: d.freelancerStatement || "(none yet)",
    prior_rounds: d.proposals.map((p) => ({
      round: p.round,
      proposed_freelancer_pct: p.freelancerPct,
      client: p.clientResponse === "COUNTER" ? { counter_pct: p.clientCounterPct, note: p.clientCounterNote } : p.clientResponse,
      freelancer: p.freelancerResponse === "COUNTER" ? { counter_pct: p.freelancerCounterPct, note: p.freelancerCounterNote } : p.freelancerResponse,
    })),
    round,
    max_rounds: 2,
  };

  const { value } = await structuredCall<Proposal>({
    agent: "mediator",
    system: MEDIATOR_AGENT_SYSTEM,
    content: `Mediation round ${round} of 2.\n\n<case>\n${JSON.stringify(input, null, 1)}\n</case>`,
    schema: ProposalSchema,
    validate: (p) => (p.freelancer_pct < 0 || p.freelancer_pct > 100 ? ["freelancer_pct must be between 0 and 100"] : []),
    effort: "high",
    ctx: { contractId: m.contractId, milestoneId: m.id, summary: `Mediator Agent round ${round}: proposed split for "${m.title}"` },
    auditInput: input,
    mock: () => {
      const last = d.proposals[d.proposals.length - 1];
      const counters = [last?.clientCounterPct, last?.freelancerCounterPct].filter((x): x is number => x != null);
      const base = v?.scorePct ?? 50;
      const pct = counters.length ? (base + counters.reduce((a, b) => a + b, 0) / counters.length) / 2 : base;
      return {
        freelancer_pct: Math.round(pct / 5) * 5,
        reasoning: `[MOCK] Split anchored on the verifier score (${base}%)${counters.length ? " and moved toward the counter-offers" : ""}. Set ANTHROPIC_API_KEY for Claude's reasoning.`,
        per_criterion: m.criteria.map((c) => ({ criterion_id: c.id, note: v?.results.find((r) => r.criterionId === c.id)?.passed ? "met" : "not met" })),
      };
    },
  });

  const pct = Math.round(Math.min(100, Math.max(0, value.freelancer_pct)) * 10) / 10;
  const notes = value.per_criterion
    .map((n) => `• ${m.criteria.find((c) => c.id === n.criterion_id)?.text ?? n.criterion_id}: ${n.note}`)
    .join("\n");
  const proposal = await prisma.mediationProposal.create({
    data: { disputeId: d.id, round, freelancerPct: pct, reasoning: `${value.reasoning}${notes ? `\n\n${notes}` : ""}` },
  });
  await prisma.dispute.update({ where: { id: d.id }, data: { round, status: "PROPOSED" } });
  return proposal;
}
