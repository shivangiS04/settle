"use client";
import { useState } from "react";
import { cn } from "@/lib/utils";

export type AuditRow = {
  id: string;
  actor: string;
  kind: string;
  action: string;
  summary: string;
  requestId: string | null;
  paypalDebugId: string | null;
  resourceId: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  requestJson: string | null;
  responseJson: string | null;
  createdAt: string;
};

const KIND_STYLE: Record<string, string> = {
  AGENT_DECISION: "bg-violet-100 text-violet-700",
  PAYPAL_API: "bg-blue-100 text-blue-700",
  WEBHOOK: "bg-cyan-100 text-cyan-700",
  STATE_CHANGE: "bg-slate-100 text-slate-700",
  HUMAN_ACTION: "bg-emerald-100 text-emerald-700",
  ERROR: "bg-rose-100 text-rose-700",
};

export function AuditTrail({ events, compact }: { events: AuditRow[]; compact?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!events.length) return <p className="text-xs text-slate-500">No events yet.</p>;
  return (
    <ol className={cn("space-y-2", compact ? "text-xs" : "text-[13px]")}>
      {events.map((e) => (
        <li key={e.id} className="rounded-md border border-slate-200 bg-white p-2">
          <button className="w-full text-left" onClick={() => setOpen(open === e.id ? null : e.id)}>
            <div className="flex items-center gap-2">
              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", KIND_STYLE[e.kind] ?? "bg-slate-100")}>{e.kind.replace("_", " ")}</span>
              <span className="truncate font-mono text-[11px] text-slate-500">{e.action}</span>
              <span className="ml-auto shrink-0 text-[10px] text-slate-400">{new Date(e.createdAt).toLocaleString()}</span>
            </div>
            <div className="mt-1 text-slate-800">{e.summary}</div>
            <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-slate-500">
              <span>by {e.actor}</span>
              {e.requestId && <span>PayPal-Request-Id: <code>{e.requestId}</code></span>}
              {e.resourceId && <span>resource: <code>{e.resourceId}</code></span>}
              {e.paypalDebugId && <span>debug_id: <code>{e.paypalDebugId}</code></span>}
              {e.httpStatus && <span>HTTP {e.httpStatus}</span>}
              {e.durationMs != null && <span>{e.durationMs}ms</span>}
            </div>
          </button>
          {open === e.id && (e.requestJson || e.responseJson) && (
            <div className="mt-2 space-y-2">
              {e.requestJson && (
                <details open>
                  <summary className="cursor-pointer text-[11px] font-semibold text-slate-600">Request / input</summary>
                  <pre className="max-h-64 overflow-auto rounded bg-slate-900 p-2 text-[10px] text-slate-100">{e.requestJson}</pre>
                </details>
              )}
              {e.responseJson && (
                <details open>
                  <summary className="cursor-pointer text-[11px] font-semibold text-slate-600">Response / output</summary>
                  <pre className="max-h-64 overflow-auto rounded bg-slate-900 p-2 text-[10px] text-slate-100">{e.responseJson}</pre>
                </details>
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
