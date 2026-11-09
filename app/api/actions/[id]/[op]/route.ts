import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { confirmAction, rejectAction } from "@/lib/actions";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: { id: string; op: string } }) {
  try {
    const { user } = await requireUser();
    if (params.op === "confirm") return NextResponse.json({ ok: true, result: await confirmAction(params.id, user) });
    if (params.op === "reject") {
      await rejectAction(params.id, user);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "unknown op" }, { status: 404 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
