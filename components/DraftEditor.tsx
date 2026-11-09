"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, CardContent, Input, Textarea } from "@/components/ui";
import { postJson } from "@/components/ActionButton";

type Crit = { text: string; checkType: string; minWords: number | null };
type Ms = { title: string; description: string; amount: number; dueDate: string | null; criteria: Crit[] };
export type DraftData = { id: string; title: string; summary: string; currency: string; milestones: Ms[] };

const CHECK_TYPES = ["VISUAL", "FUNCTIONAL", "CONTENT", "CODE", "WORD_COUNT"];

export function DraftEditor({
  draft,
  ambiguities,
  clientAccepted,
  freelancerAccepted,
  isClient,
  canEdit,
}: {
  draft: DraftData;
  ambiguities: string[];
  clientAccepted: boolean;
  freelancerAccepted: boolean;
  isClient: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [d, setD] = useState<DraftData>(draft);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const iAccepted = isClient ? clientAccepted : freelancerAccepted;

  const up = (fn: (x: DraftData) => void) => {
    const copy = structuredClone(d);
    fn(copy);
    setD(copy);
    setDirty(true);
  };

  async function save() {
    const r = await fetch(`/api/contracts/${d.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    setDirty(false);
  }

  const total = d.milestones.reduce((s, m) => s + (Number(m.amount) || 0), 0);

  return (
    <div className="space-y-4">
      <Card className="border-indigo-200 bg-indigo-50/50">
        <CardContent className="space-y-2 pt-5 text-sm">
          <div className="font-semibold text-indigo-900">Draft — review the AI-extracted terms</div>
          <div className="flex gap-4 text-xs">
            <span>Client: {clientAccepted ? "✅ accepted" : "⏳ pending"}</span>
            <span>Freelancer: {freelancerAccepted ? "✅ accepted" : "⏳ pending"}</span>
            <span>Total: {total.toFixed(2)} {d.currency}</span>
          </div>
          {ambiguities.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              <b>Contract Agent flagged:</b>
              <ul className="ml-4 list-disc">
                {ambiguities.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-5">
          <Input value={d.title} disabled={!canEdit} onChange={(e) => up((x) => void (x.title = e.target.value))} className="text-base font-semibold" />
          <Textarea rows={2} value={d.summary} disabled={!canEdit} onChange={(e) => up((x) => void (x.summary = e.target.value))} />
        </CardContent>
      </Card>

      {d.milestones.map((m, i) => (
        <Card key={i}>
          <CardContent className="space-y-3 pt-5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium uppercase text-slate-400">Milestone {i + 1}</span>
              {canEdit && d.milestones.length > 1 && (
                <button className="ml-auto text-xs text-rose-600" onClick={() => up((x) => void x.milestones.splice(i, 1))}>
                  remove
                </button>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_120px_150px]">
              <Input value={m.title} disabled={!canEdit} onChange={(e) => up((x) => void (x.milestones[i].title = e.target.value))} />
              <Input
                type="number"
                step="0.01"
                value={m.amount}
                disabled={!canEdit}
                onChange={(e) => up((x) => void (x.milestones[i].amount = Number(e.target.value)))}
              />
              <Input
                type="date"
                value={m.dueDate ?? ""}
                disabled={!canEdit}
                onChange={(e) => up((x) => void (x.milestones[i].dueDate = e.target.value || null))}
              />
            </div>
            <Textarea rows={2} placeholder="Description" value={m.description} disabled={!canEdit} onChange={(e) => up((x) => void (x.milestones[i].description = e.target.value))} />
            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-500">Acceptance criteria (testable — the Verifier Agent checks these)</div>
              {m.criteria.map((c, j) => (
                <div key={j} className="flex gap-2">
                  <Input value={c.text} disabled={!canEdit} onChange={(e) => up((x) => void (x.milestones[i].criteria[j].text = e.target.value))} />
                  <select
                    className="h-9 rounded-md border border-slate-300 bg-white px-2 text-xs"
                    value={c.checkType}
                    disabled={!canEdit}
                    onChange={(e) => up((x) => void (x.milestones[i].criteria[j].checkType = e.target.value))}
                  >
                    {CHECK_TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  {c.checkType === "WORD_COUNT" && (
                    <Input
                      type="number"
                      className="w-24"
                      placeholder="min words"
                      value={c.minWords ?? ""}
                      disabled={!canEdit}
                      onChange={(e) => up((x) => void (x.milestones[i].criteria[j].minWords = e.target.value ? Number(e.target.value) : null))}
                    />
                  )}
                  {canEdit && (
                    <button className="text-xs text-slate-400 hover:text-rose-600" onClick={() => up((x) => void x.milestones[i].criteria.splice(j, 1))}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {canEdit && m.criteria.length < 5 && (
                <button
                  className="text-xs text-blue-600"
                  onClick={() => up((x) => void x.milestones[i].criteria.push({ text: "", checkType: "CONTENT", minWords: null }))}
                >
                  + add criterion
                </button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
      {canEdit && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => up((x) => void x.milestones.push({ title: "New milestone", description: "", amount: 100, dueDate: null, criteria: [{ text: "", checkType: "CONTENT", minWords: null }] }))}
        >
          + Add milestone
        </Button>
      )}

      {canEdit && (
        <div className="sticky bottom-4 flex items-center gap-3 rounded-lg border bg-white p-3 shadow-lg">
          <span className="text-sm text-slate-600">
            {dirty ? "Unsaved edits — saving resets both acceptances." : iAccepted ? "You accepted. Waiting for the other party." : "Review, edit if needed, then accept."}
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              variant="outline"
              disabled={!dirty || busy}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  await save();
                  router.refresh();
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save edits
            </Button>
            <Button
              variant="success"
              disabled={busy || (iAccepted && !dirty)}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  if (dirty) await save();
                  await postJson(`/api/contracts/${d.id}/accept`);
                  router.refresh();
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {dirty ? "Save & accept terms" : "Accept terms"}
            </Button>
          </div>
          {err && <span className="text-xs text-rose-600">{err}</span>}
        </div>
      )}
    </div>
  );
}
