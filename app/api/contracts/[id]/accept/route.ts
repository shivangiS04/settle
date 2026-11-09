import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/session";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const { user } = await requireUser();
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: params.id } });
    if (c.status !== "DRAFT") throw new Error("Contract is already agreed");
    const isClient = user.id === c.clientId;
    if (!isClient && user.id !== c.freelancerId) throw new Error("Not a party to this contract");

    const now = new Date();
    const updated = await prisma.contract.update({
      where: { id: c.id },
      data: isClient ? { clientAcceptedAt: now } : { freelancerAcceptedAt: now },
    });
    await audit({
      contractId: c.id,
      actor: `user:${user.id}`,
      kind: "HUMAN_ACTION",
      action: "contract.accept",
      summary: `${user.name} (${isClient ? "client" : "freelancer"}) accepted the terms`,
    });

    if (updated.clientAcceptedAt && updated.freelancerAcceptedAt) {
      await prisma.contract.update({ where: { id: c.id }, data: { status: "AGREED" } });
      await prisma.milestone.updateMany({ where: { contractId: c.id }, data: { status: "AGREED", stateChangedAt: now } });
      await audit({
        contractId: c.id,
        actor: "system",
        kind: "STATE_CHANGE",
        action: "contract.DRAFT->AGREED",
        summary: "Both parties accepted — contract AGREED; milestones ready to fund",
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
