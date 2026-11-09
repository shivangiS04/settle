import { prisma } from "./db";

export type AuditInput = {
  contractId?: string | null;
  milestoneId?: string | null;
  actor: string;
  kind: "AGENT_DECISION" | "PAYPAL_API" | "WEBHOOK" | "STATE_CHANGE" | "HUMAN_ACTION" | "ERROR";
  action: string;
  summary: string;
  requestId?: string | null;
  paypalDebugId?: string | null;
  resourceId?: string | null;
  httpStatus?: number | null;
  durationMs?: number | null;
  request?: unknown;
  response?: unknown;
};

const MAX = 20_000;
function ser(v: unknown) {
  if (v === undefined || v === null) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > MAX ? s.slice(0, MAX) + "\n…[truncated]" : s;
}

/** Never throws — the audit log must not break a money flow. */
export async function audit(e: AuditInput) {
  try {
    return await prisma.auditEvent.create({
      data: {
        contractId: e.contractId ?? null,
        milestoneId: e.milestoneId ?? null,
        actor: e.actor,
        kind: e.kind,
        action: e.action,
        summary: e.summary,
        requestId: e.requestId ?? null,
        paypalDebugId: e.paypalDebugId ?? null,
        resourceId: e.resourceId ?? null,
        httpStatus: e.httpStatus ?? null,
        durationMs: e.durationMs ?? null,
        requestJson: ser(e.request),
        responseJson: ser(e.response),
      },
    });
  } catch (err) {
    console.error("[audit] failed to write", err);
  }
}
