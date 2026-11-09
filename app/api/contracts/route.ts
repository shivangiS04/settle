import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/session";
import { extractContract } from "@/lib/agents/contract";
import { valueToCents } from "@/lib/utils";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Paste a thread → Contract Agent → DRAFT contract both parties then review. */
export async function POST(req: Request) {
  try {
    const { user, role } = await requireUser();
    const { thread } = (await req.json()) as { thread?: string };
    if (!thread || thread.trim().length < 20) throw new Error("Paste the conversation (at least a few lines).");
    if (thread.length > 60_000) throw new Error("Thread is too long (max 60k characters).");

    const other = await prisma.user.findFirstOrThrow({ where: { role: role === "CLIENT" ? "FREELANCER" : "CLIENT" } });
    const clientId = role === "CLIENT" ? user.id : other.id;
    const freelancerId = role === "FREELANCER" ? user.id : other.id;

    // Pre-generate the id so the agent's audit event is linked to this contract from the start.
    const contractId = `c_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const { value: x, model } = await extractContract(thread, { contractId });
    const contract = await prisma.contract.create({
      data: {
        id: contractId,
        title: x.title,
        summary: x.summary,
        rawThread: thread,
        currency: x.currency,
        clientId,
        freelancerId,
        extractionJson: JSON.stringify({ ...x, model }),
        milestones: {
          create: x.milestones.map((m, i) => ({
            idx: i,
            title: m.title,
            description: m.description,
            amountCents: valueToCents(m.amount),
            currency: x.currency,
            dueDate: m.due_date ? new Date(m.due_date) : null,
            criteria: {
              create: m.criteria.map((c, j) => ({ idx: j, text: c.text, checkType: c.check_type, minWords: c.min_words ?? null })),
            },
          })),
        },
      },
    });
    await audit({
      contractId: contract.id,
      actor: `user:${user.id}`,
      kind: "HUMAN_ACTION",
      action: "contract.create_draft",
      summary: `${user.name} created a draft from a pasted thread (${x.milestones.length} milestones, ${x.ambiguities.length} open questions)`,
    });
    return NextResponse.json({ id: contract.id });
  } catch (e) {
    console.error("[contracts:create]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
