import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const contractId = u.searchParams.get("contractId");
  const milestoneId = u.searchParams.get("milestoneId");
  if (!contractId && !milestoneId) return NextResponse.json({ error: "contractId or milestoneId required" }, { status: 400 });
  const events = await prisma.auditEvent.findMany({
    where: milestoneId ? { milestoneId } : { contractId: contractId! },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  const actions = await prisma.proposedAction.findMany({
    where: milestoneId ? { milestoneId } : { contractId: contractId! },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ events, actions });
}
