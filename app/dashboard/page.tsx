import { loadDashboard } from "@/lib/dashboard";
import { OpsGrid } from "@/components/OpsGrid";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const rows = await loadDashboard();
  const [events, webhooks] = await Promise.all([prisma.auditEvent.count({ where: { kind: "PAYPAL_API" } }), prisma.webhookEvent.count()]);
  const t = rows.reduce((a, r) => ({ held: a.held + r.held, paid: a.paid + r.paidOut, fees: a.fees + r.fees, risk: a.risk + (r.riskFlag ? 1 : 0) }), { held: 0, paid: 0, fees: 0, risk: 0 });
  const f = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Ops dashboard</h1>
        <p className="text-sm text-slate-500">Every contract, every milestone, every criterion — and why money moved. Expand rows for milestones → verifier results.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ["Held in escrow", f(t.held)],
          ["Paid out to freelancers", f(t.paid)],
          ["Platform fees earned", f(t.fees)],
          ["Contracts at risk", String(t.risk)],
          ["PayPal API calls / webhooks", `${events} / ${webhooks}`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border bg-white p-3">
            <div className="text-[11px] font-medium text-slate-500">{k}</div>
            <div className="text-xl font-bold tabular-nums">{v}</div>
          </div>
        ))}
      </div>
      <OpsGrid rows={rows} />
    </div>
  );
}
