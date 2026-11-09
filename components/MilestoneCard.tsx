import type { Prisma } from "@prisma/client";
import { Card, CardContent, StatusPill } from "@/components/ui";
import { FundButton } from "@/components/FundButton";
import { ActionButton } from "@/components/ActionButton";
import { authHealth } from "@/lib/escrow";
import { llmLabel } from "@/lib/mode";
import { AutoRefresh, DeliveryForm } from "@/components/DeliveryForm";
import { VerificationPanel } from "@/components/VerificationPanel";
import { centsToValue, feePct, money, splitFee } from "@/lib/utils";
import { DisputeButton, DisputePanel } from "@/components/DisputePanel";

export type MilestoneFull = Prisma.MilestoneGetPayload<{
  include: {
    criteria: true;
    deliveries: true;
    verifications: { include: { results: true; screenshots: { select: { id: true; label: true } } } };
    disputes: { include: { proposals: true } };
  };
}>;
export type Viewer = { role: string; userId: string; isClient: boolean; isFreelancer: boolean };

export function MilestoneCard({
  m,
  contract,
  viewer,
  paypalClientId,
  mock,
}: {
  m: MilestoneFull;
  contract: { id: string; status: string; currency: string };
  viewer: Viewer;
  paypalClientId: string;
  mock: boolean;
}) {
  const health = authHealth(m);
  const { feeCents, netCents } = splitFee(m.amountCents);
  const latestDelivery = m.deliveries[0];
  const dispute = m.disputes[0];
  const pending = m.status === "SUBMITTED" && !!latestDelivery && !m.verifications.some((v) => v.deliveryId === latestDelivery.id);
  // Failed = the verifier recorded an error (timeout, AI busy, page unreachable), or it's silently stuck >3 min.
  const stalled = pending && (!!latestDelivery.verifyError || Date.now() - latestDelivery.createdAt.getTime() > 180_000);
  const verifying = pending && !stalled;

  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Milestone {m.idx + 1}</div>
            <div className="text-lg font-semibold">{m.title}</div>
            {m.description && <p className="text-sm text-slate-600">{m.description}</p>}
            <div className="mt-1 text-xs text-slate-500">
              {money(m.amountCents, m.currency)}
              {m.dueDate && <> · due {m.dueDate.toDateString()}</>}
              {m.authorizationId && <> · auth <code>{m.authorizationId}</code> ({m.authStatus})</>}
            </div>
          </div>
          <StatusPill status={m.status} />
        </div>

        <div>
          <div className="mb-1 text-xs font-semibold text-slate-500">Acceptance criteria</div>
          <ul className="space-y-1 text-sm">
            {m.criteria.map((c) => (
              <li key={c.id} className="flex gap-2">
                <span className="text-slate-400">•</span>
                <span>{c.text}</span>
                <span className="ml-auto shrink-0 text-[10px] uppercase text-slate-400">{c.checkType}</span>
              </li>
            ))}
          </ul>
        </div>

        {health.level !== "ok" && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <span>⚠ {health.message}</span>
            {viewer.isClient && health.level === "honor" && (
              <ActionButton size="sm" variant="outline" path={`/api/milestones/${m.id}/reauthorize`}>
                Reauthorize
              </ActionButton>
            )}
          </div>
        )}

        {/* Funding */}
        {m.status === "AGREED" && contract.status !== "DRAFT" && (
          viewer.isClient ? (
            <div className="rounded-md bg-slate-50 p-3">
              <p className="mb-2 text-sm text-slate-600">
                Fund this milestone. PayPal <b>authorizes</b> {money(m.amountCents, m.currency)} — it is held, not charged, until you approve the work.
              </p>
              <FundButton milestoneId={m.id} currency={m.currency} clientId={paypalClientId} mock={mock} />
            </div>
          ) : (
            <p className="text-sm text-slate-500">Waiting for the client to fund escrow.</p>
          )
        )}

        {/* Delivery (freelancer) */}
        {viewer.isFreelancer && m.status === "FUNDED" && <DeliveryForm milestoneId={m.id} />}
        {m.status === "FUNDED" && !viewer.isFreelancer && <p className="text-sm text-slate-500">Funds held in escrow. Waiting for the freelancer&apos;s delivery.</p>}

        {/* Verification */}
        {verifying && (
          <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-600 border-t-transparent" />
            Verifier Agent is checking the delivery (headless browser at desktop + 375px, then {llmLabel()} judges each criterion)…
            <AutoRefresh />
          </div>
        )}
        {stalled && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
            <span>
              <b>Verification didn&apos;t finish.</b> {latestDelivery?.verifyError ?? "It took too long — see the audit trail for details."}
            </span>
            <ActionButton size="sm" variant="outline" path={`/api/milestones/${m.id}/verify`}>
              Retry verification
            </ActionButton>
          </div>
        )}
        <VerificationPanel m={m} />
        {viewer.isFreelancer && m.status === "VERIFIED" && <DeliveryForm milestoneId={m.id} resubmit />}
        {m.status === "VERIFIED" && m.autoApproveAt && (
          <p className="text-xs text-emerald-700">
            All criteria passed — funds auto-release {m.autoApproveAt.toLocaleString()} unless the client approves or disputes first.
          </p>
        )}

        {/* Approve (client) */}
        {dispute && ["DISPUTED", "MEDIATED", "SETTLED"].includes(m.status) && (
          <DisputePanel
            milestoneId={m.id}
            dispute={dispute}
            isClient={viewer.isClient}
            isFreelancer={viewer.isFreelancer}
            amountCents={m.amountCents}
            currency={m.currency}
            feePct={feePct()}
          />
        )}

        {viewer.isClient && ["SUBMITTED", "VERIFIED", "DISPUTED"].includes(m.status) && (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            {m.status !== "DISPUTED" && <DisputeButton milestoneId={m.id} />}
            <ActionButton
              variant="success"
              path={`/api/milestones/${m.id}/approve`}
              busyText="Capturing & paying out…"
              confirmText={`Approve and release funds?\n\nCapture: ${centsToValue(m.amountCents)} ${m.currency}\nPlatform fee (3%): ${centsToValue(feeCents)}\nPayout to freelancer: ${centsToValue(netCents)} ${m.currency}`}
            >
              Approve & release {money(m.amountCents, m.currency)}
            </ActionButton>
          </div>
        )}

        {m.status === "SETTLED" && (
          <div className="grid grid-cols-2 gap-2 rounded-md bg-emerald-50 p-3 text-sm sm:grid-cols-4">
            <Stat label="Captured" v={money(m.capturedCents, m.currency)} />
            <Stat label="Returned to client" v={money(m.releasedCents, m.currency)} />
            <Stat label="Platform fee" v={money(m.feeCents, m.currency)} />
            <Stat label={`Payout (${m.payoutStatus ?? "—"})`} v={money(m.payoutCents, m.currency)} />
            {m.payoutStatus === "FAILED" && (
              <div className="col-span-full">
                <ActionButton size="sm" variant="destructive" path={`/api/milestones/${m.id}/retry-payout`}>
                  Retry payout
                </ActionButton>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="font-semibold tabular-nums">{v}</div>
    </div>
  );
}
