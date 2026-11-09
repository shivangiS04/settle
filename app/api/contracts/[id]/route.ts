import { NextResponse } from "next/server";
import * as z from "zod/v4";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/session";
import { valueToCents } from "@/lib/utils";

const EditSchema = z.object({
  title: z.string().min(1),
  summary: z.string(),
  milestones: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string(),
        amount: z.number().positive(),
        dueDate: z.string().nullable(),
        criteria: z
          .array(
            z.object({
              text: z.string().min(3),
              checkType: z.enum(["VISUAL", "FUNCTIONAL", "CONTENT", "CODE", "WORD_COUNT"]),
              minWords: z.number().int().positive().nullable(),
            }),
          )
          .min(1)
          .max(5),
      }),
    )
    .min(1),
});

/** Edit a DRAFT. Any edit resets both acceptances — each party must accept the final text. */
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  try {
    const { user } = await requireUser();
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: params.id } });
    if (c.status !== "DRAFT") throw new Error("Only drafts can be edited");
    if (user.id !== c.clientId && user.id !== c.freelancerId) throw new Error("Not a party to this contract");
    const body = EditSchema.parse(await req.json());

    await prisma.$transaction([
      prisma.milestone.deleteMany({ where: { contractId: c.id } }),
      prisma.contract.update({
        where: { id: c.id },
        data: {
          title: body.title,
          summary: body.summary,
          clientAcceptedAt: null,
          freelancerAcceptedAt: null,
          milestones: {
            create: body.milestones.map((m, i) => ({
              idx: i,
              title: m.title,
              description: m.description,
              amountCents: valueToCents(m.amount),
              currency: c.currency,
              dueDate: m.dueDate ? new Date(m.dueDate) : null,
              criteria: { create: m.criteria.map((cr, j) => ({ idx: j, text: cr.text, checkType: cr.checkType, minWords: cr.minWords })) },
            })),
          },
        },
      }),
    ]);
    await audit({
      contractId: c.id,
      actor: `user:${user.id}`,
      kind: "HUMAN_ACTION",
      action: "contract.edit",
      summary: `${user.name} edited the draft — acceptances reset`,
      request: body,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
