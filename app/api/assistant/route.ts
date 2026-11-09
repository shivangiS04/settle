import { NextResponse } from "next/server";
import { errorPayload } from "@/lib/agents/errors";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { runAssistant } from "@/lib/agents/assistant";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const { user } = await requireUser();
    const { messages } = (await req.json()) as { messages: { role: "user" | "assistant"; content: string }[] };
    if (!Array.isArray(messages) || !messages.length || messages[messages.length - 1].role !== "user") throw new Error("Send at least one user message");
    const clean = messages.map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: String(m.content).slice(0, 4000) }));
    const { reply, proposed } = await runAssistant(user, clean);
    const actions = proposed.length ? await prisma.proposedAction.findMany({ where: { id: { in: proposed } } }) : [];
    return NextResponse.json({ reply, actions });
  } catch (e) {
    console.error("[assistant]", e);
    const { body, status } = errorPayload(e);
    return NextResponse.json(body, { status });
  }
}

/** Pending actions waiting on the current user (survives page reloads). */
export async function GET() {
  const { user } = await requireUser();
  const actions = await prisma.proposedAction.findMany({ where: { requestedFor: user.id }, orderBy: { createdAt: "desc" }, take: 20 });
  return NextResponse.json({ actions });
}
