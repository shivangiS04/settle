import { NextResponse } from "next/server";
import { tick } from "@/lib/tick";

export const runtime = "nodejs";

/** Manual / external-cron trigger for the housekeeping tick. Protect with CRON_SECRET if set. */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await tick());
}
