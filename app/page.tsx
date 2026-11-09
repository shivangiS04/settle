import Link from "next/link";
import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { Button, Card, CardContent, StatusPill } from "@/components/ui";
import { money } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { role, user } = await currentUser();
  if (!user) {
    return (
      <Card className="p-8 text-center">
        <p className="text-slate-600">No demo users yet. Run <code className="rounded bg-slate-100 px-1">npm run seed</code>.</p>
      </Card>
    );
  }
  const contracts = await prisma.contract.findMany({
    where: role === "CLIENT" ? { clientId: user.id } : { freelancerId: user.id },
    include: { milestones: { orderBy: { idx: "asc" } }, client: true, freelancer: true },
    orderBy: { updatedAt: "desc" },
  });
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My contracts</h1>
          <p className="text-sm text-slate-500">
            Viewing as <b>{user.name}</b> ({role.toLowerCase()}). Funds are held by PayPal authorizations until delivery is verified.
          </p>
        </div>
        <Link href="/contracts/new"><Button variant="primary">+ New contract from chat</Button></Link>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {contracts.map((c) => {
          const total = c.milestones.reduce((s, m) => s + m.amountCents, 0);
          return (
            <Link key={c.id} href={`/contracts/${c.id}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardContent className="space-y-3 pt-5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold">{c.title}</div>
                      <div className="text-xs text-slate-500">
                        {c.client.name} → {c.freelancer.name} · {money(total, c.currency)}
                      </div>
                    </div>
                    <StatusPill status={c.status} />
                  </div>
                  <div className="space-y-1">
                    {c.milestones.map((m) => (
                      <div key={m.id} className="flex items-center justify-between text-sm">
                        <span className="truncate text-slate-700">{m.idx + 1}. {m.title}</span>
                        <span className="flex items-center gap-2">
                          <span className="tabular-nums text-slate-500">{money(m.amountCents, m.currency)}</span>
                          <StatusPill status={m.status} />
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
        {contracts.length === 0 && <p className="text-sm text-slate-500">No contracts yet.</p>}
      </div>
    </div>
  );
}
