"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input, Textarea } from "@/components/ui";
import { postJson } from "@/components/ActionButton";

type Proposal = {
  id: string;
  round: number;
  freelancerPct: number;
  reasoning: string;
  clientResponse: string | null;
  clientCounterPct: number | null;
  clientCounterNote: string | null;
  freelancerResponse: string | null;
  freelancerCounterPct: number | null;
  freelancerCounterNote: string | null;
};
type Dispute = { id: string; reason: string; clientStatement: string; freelancerStatement: string; status: string; round: number; proposals: Proposal[] };

function useAction(milestoneId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (action: string, body: unknown, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setErr(null);
    try {
      await postJson(`/api/milestones/${milestoneId}/${action}`, body);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, run };
}

/** Client: open a dispute instead of approving. */
export function DisputeButton({ milestoneId }: { milestoneId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [statement, setStatement] = useState("");
  const { busy, err, run } = useAction(milestoneId);
  if (!open)
    return (
      <Button variant="outline" className="border-rose-300 text-rose-700 hover:bg-rose-50" onClick={() => setOpen(true)}>
        Dispute
      </Button>
    );
  return (
    <div className="w-full space-y-2 rounded-md border border-rose-200 bg-rose-50 p-3">
      <Input placeholder="What's wrong? (e.g. contact form doesn't work on mobile)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Textarea rows={3} placeholder="Your statement for the mediator (optional)" value={statement} onChange={(e) => setStatement(e.target.value)} />
      <div className="flex items-center gap-2">
        <Button variant="destructive" size="sm" disabled={busy || reason.trim().length < 5} onClick={() => run("dispute", { reason, statement })}>
          {busy ? "Opening…" : "Open dispute"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {err && <span className="text-xs text-rose-600">{err}</span>}
      </div>
    </div>
  );
}

export function DisputePanel({
  milestoneId,
  dispute,
  isClient,
  isFreelancer,
  amountCents,
  currency,
  feePct,
}: {
  milestoneId: string;
  dispute: Dispute;
  isClient: boolean;
  isFreelancer: boolean;
  amountCents: number;
  currency: string;
  feePct: number;
}) {
  const { busy, err, run } = useAction(milestoneId);
  const [statement, setStatement] = useState("");
  const [counter, setCounter] = useState<string>("");
  const [note, setNote] = useState("");
  const latest = dispute.proposals[dispute.proposals.length - 1];
  const myResponse = latest ? (isClient ? latest.clientResponse : isFreelancer ? latest.freelancerResponse : null) : null;
  const fmt = (c: number) => `${(c / 100).toFixed(2)} ${currency}`;

  return (
    <div className="space-y-3 rounded-md border border-purple-200 bg-purple-50/50 p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-purple-900">Dispute</span>
        <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-800">{dispute.status}</span>
        {dispute.round > 0 && <span className="text-xs text-slate-500">round {dispute.round} of 2</span>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded bg-white p-2 ring-1 ring-slate-200">
          <div className="text-[11px] font-semibold text-slate-500">Client</div>
          <div className="font-medium">{dispute.reason}</div>
          {dispute.clientStatement && <div className="text-xs text-slate-600">{dispute.clientStatement}</div>}
        </div>
        <div className="rounded bg-white p-2 ring-1 ring-slate-200">
          <div className="text-[11px] font-semibold text-slate-500">Freelancer</div>
          <div className="text-xs text-slate-600">{dispute.freelancerStatement || "No statement yet."}</div>
        </div>
      </div>

      {isFreelancer && dispute.round === 0 && (
        <div className="space-y-2">
          <Textarea rows={3} placeholder="Your side of the story for the Mediator Agent…" value={statement} onChange={(e) => setStatement(e.target.value)} />
          <Button size="sm" variant="primary" disabled={busy || !statement.trim()} onClick={() => run("dispute-statement", { statement })}>
            {busy ? "Mediator Agent is reviewing…" : "Submit statement & request mediation"}
          </Button>
        </div>
      )}
      {isClient && dispute.round === 0 && (
        <div className="flex items-center gap-2 text-xs text-slate-600">
          Waiting for the freelancer&apos;s statement.
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run("mediate", {})}>
            {busy ? "Mediating…" : "Mediate now without it"}
          </Button>
        </div>
      )}

      {dispute.proposals.map((p) => {
        const fc = Math.round((amountCents * p.freelancerPct) / 100);
        const fee = Math.round((fc * feePct) / 100);
        const isLatest = p.id === latest?.id;
        return (
          <div key={p.id} className={`space-y-2 rounded bg-white p-3 ring-1 ${isLatest ? "ring-purple-300" : "ring-slate-200 opacity-70"}`}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-semibold text-purple-800">Mediator Agent · round {p.round}</span>
              <span className="text-base font-bold">
                {p.freelancerPct}% freelancer / {Math.round((100 - p.freelancerPct) * 10) / 10}% client
              </span>
            </div>
            <div className="text-xs text-slate-600">
              Freelancer receives {fmt(fc - fee)} (after {feePct}% fee) · client gets {fmt(amountCents - fc)} released back
            </div>
            <p className="whitespace-pre-wrap text-sm text-slate-700">{p.reasoning}</p>
            <div className="flex gap-4 text-xs">
              <span>
                Client: <b>{p.clientResponse ?? "pending"}</b>
                {p.clientCounterPct != null && ` → ${p.clientCounterPct}%`} {p.clientCounterNote && `(“${p.clientCounterNote}”)`}
              </span>
              <span>
                Freelancer: <b>{p.freelancerResponse ?? "pending"}</b>
                {p.freelancerCounterPct != null && ` → ${p.freelancerCounterPct}%`} {p.freelancerCounterNote && `(“${p.freelancerCounterNote}”)`}
              </span>
            </div>
            {isLatest && dispute.status === "PROPOSED" && (isClient || isFreelancer) && !myResponse && (
              <div className="flex flex-wrap items-end gap-2 border-t pt-2">
                <Button
                  size="sm"
                  variant="success"
                  disabled={busy}
                  onClick={() =>
                    run(
                      "mediation-respond",
                      { proposalId: p.id, response: "ACCEPT" },
                      `Accept this split?\n\nIf the other party also accepts, Settle will immediately:\n• capture ${fmt(fc)} from the PayPal authorization (final capture)\n• pay the freelancer ${fmt(fc - fee)} via PayPal Payouts\n• release ${fmt(amountCents - fc)} back to the client`,
                    )
                  }
                >
                  Accept split
                </Button>
                {p.round < 2 ? (
                  <>
                    <Input className="h-8 w-24" type="number" min={0} max={100} placeholder="% to frl." value={counter} onChange={(e) => setCounter(e.target.value)} />
                    <Input className="h-8 w-64" placeholder="Why? (sent to the mediator)" value={note} onChange={(e) => setNote(e.target.value)} />
                    <Button size="sm" variant="outline" disabled={busy || counter === ""} onClick={() => run("mediation-respond", { proposalId: p.id, response: "COUNTER", counterPct: Number(counter), note })}>
                      Counter
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => run("mediation-respond", { proposalId: p.id, response: "COUNTER", counterPct: isClient ? 0 : 100, note: "Rejected final proposal" }, "Reject the final proposal? The dispute will be escalated to Settle ops and funds stay held.")}>
                    Reject (escalate)
                  </Button>
                )}
              </div>
            )}
            {isLatest && myResponse && dispute.status === "PROPOSED" && <div className="text-xs text-slate-500">You responded — waiting for the other party.</div>}
          </div>
        );
      })}
      {dispute.status === "ESCALATED" && (
        <div className="rounded bg-rose-100 p-2 text-xs text-rose-900">
          Escalated after 2 rounds. Funds remain held by the PayPal authorization while Settle ops reviews. The client can still approve in full.
        </div>
      )}
      {busy && <div className="text-xs text-purple-700">Working…</div>}
      {err && <div className="text-xs text-rose-600">{err}</div>}
    </div>
  );
}
