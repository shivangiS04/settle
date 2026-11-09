import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { Card, CardContent, CardHeader, CardTitle, StatusPill } from "@/components/ui";
import { money, safeJson } from "@/lib/utils";
import { DraftEditor } from "@/components/DraftEditor";
import { paypalMock } from "@/lib/mode";
import { MilestoneCard } from "@/components/MilestoneCard";
import { AuditTrail } from "@/components/AuditTrail";

export const dynamic = "force-dynamic";

export default async function ContractPage({ params }: { params: { id: string } }) {
  const { role, user } = await currentUser();
  const c = await prisma.contract.findUnique({
    where: { id: params.id },
    include: {
      client: true,
      freelancer: true,
      milestones: {
        orderBy: { idx: "asc" },
        include: {
          criteria: { orderBy: { idx: "asc" } },
          deliveries: { orderBy: { createdAt: "desc" } },
          verifications: {
            orderBy: { createdAt: "desc" },
            include: { results: true, screenshots: { select: { id: true, label: true } } },
          },
          disputes: { orderBy: { createdAt: "desc" }, include: { proposals: { orderBy: { round: "asc" } } } },
        },
      },
    },
  });
  if (!c) notFound();
  const events = await prisma.auditEvent.findMany({ where: { contractId: c.id }, orderBy: { createdAt: "desc" }, take: 200 });
  const total = c.milestones.reduce((s, m) => s + m.amountCents, 0);
  const viewer = { role, userId: user?.id ?? "", isClient: user?.id === c.clientId, isFreelancer: user?.id === c.freelancerId };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{c.title}</h1>
            <p className="mt-1 text-sm text-slate-600">{c.summary}</p>
            <p className="mt-2 text-xs text-slate-500">
              Client <b>{c.client.name}</b> ({c.client.paypalEmail}) · Freelancer <b>{c.freelancer.name}</b> ({c.freelancer.paypalEmail}) ·{" "}
              {money(total, c.currency)} total
            </p>
          </div>
          <StatusPill status={c.status} />
        </div>

        {c.status === "DRAFT" ? (
          <DraftEditor
            key={c.updatedAt.toISOString()}
            draft={{
              id: c.id,
              title: c.title,
              summary: c.summary,
              currency: c.currency,
              milestones: c.milestones.map((m) => ({
                title: m.title,
                description: m.description,
                amount: m.amountCents / 100,
                dueDate: m.dueDate ? m.dueDate.toISOString().slice(0, 10) : null,
                criteria: m.criteria.map((cr) => ({ text: cr.text, checkType: cr.checkType, minWords: cr.minWords })),
              })),
            }}
            ambiguities={safeJson<{ ambiguities?: string[] }>(c.extractionJson, {}).ambiguities ?? []}
            clientAccepted={!!c.clientAcceptedAt}
            freelancerAccepted={!!c.freelancerAcceptedAt}
            isClient={viewer.isClient}
            canEdit={viewer.isClient || viewer.isFreelancer}
          />
        ) : (
          c.milestones.map((m) => (
            <MilestoneCard key={m.id} m={m} contract={c} viewer={viewer} paypalClientId={process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? ""} mock={paypalMock()} />
          ))
        )}

        {c.rawThread && (
          <details className="rounded-lg border bg-white p-4 text-sm">
            <summary className="cursor-pointer font-medium text-slate-600">Original thread</summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-slate-600">{c.rawThread}</pre>
          </details>
        )}
      </div>

      <aside className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Audit trail</CardTitle>
            <p className="text-xs text-slate-500">Every agent decision and PayPal API call on this contract.</p>
          </CardHeader>
          <CardContent>
            <AuditTrail events={events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() }))} />
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
