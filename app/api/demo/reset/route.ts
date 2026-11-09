import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { resetAndSeed } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOLDOWN_MS = 60_000;
let inFlight = false;

function demoResetEnabled() {
  return process.env.DEMO_RESET_ENABLED === "1";
}

/**
 * Resets the APP DATABASE to the demo dataset so judges always start clean.
 * Never calls PayPal: real sandbox orders/authorizations/payouts are untouched.
 * Rate limit: once per 60s globally (checked against the persisted audit event, which survives the wipe).
 */
export async function POST() {
  if (!demoResetEnabled()) return NextResponse.json({ error: "Demo reset is disabled" }, { status: 404 });
  if (inFlight) return NextResponse.json({ error: "A reset is already running" }, { status: 429 });

  const last = await prisma.auditEvent.findFirst({ where: { action: "demo.reset" }, orderBy: { createdAt: "desc" } });
  const wait = last ? COOLDOWN_MS - (Date.now() - last.createdAt.getTime()) : 0;
  if (wait > 0) {
    return NextResponse.json({ error: `Demo was just reset — try again in ${Math.ceil(wait / 1000)}s` }, { status: 429, headers: { "Retry-After": String(Math.ceil(wait / 1000)) } });
  }

  inFlight = true;
  try {
    const r = await resetAndSeed();
    await audit({
      actor: "system:demo-reset",
      kind: "HUMAN_ACTION",
      action: "demo.reset",
      summary: `Demo data reset: ${r.contracts} contracts, ${r.milestones} milestones re-seeded (app DB only; PayPal sandbox untouched)`,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    console.error("[demo:reset]", e);
    return NextResponse.json({ error: "Reset failed — see server logs" }, { status: 500 });
  } finally {
    inFlight = false;
  }
}
