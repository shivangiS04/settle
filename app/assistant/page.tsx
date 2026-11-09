"use client";
import { useEffect, useRef, useState } from "react";
import { Button, Card, Input } from "@/components/ui";
import { cn } from "@/lib/utils";

type Action = { id: string; title: string; type: string; status: string; source: string; paramsJson: string; resultJson: string | null; createdAt: string };
type Msg = { role: "user" | "assistant"; content: string; actions?: Action[] };

const SUGGESTIONS = ["What's pending for me?", "Send a reminder to the client about the landing page", "Create an invoice for $150 of out-of-scope extra work (an extra FAQ section)", "List my PayPal invoices"];

export default function AssistantPage() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [actions, setActions] = useState<Record<string, Action>>({});
  const [pending, setPending] = useState<Action[]>([]);
  const end = useRef<HTMLDivElement>(null);

  const refreshPending = async () => {
    const r = await fetch("/api/assistant");
    if (r.ok) setPending(((await r.json()).actions as Action[]).filter((a) => a.status === "PENDING"));
  };
  useEffect(() => {
    refreshPending();
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: text }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const r = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setMsgs([...next, { role: "assistant", content: j.reply, actions: j.actions }]);
      setActions((a) => ({ ...a, ...Object.fromEntries((j.actions as Action[]).map((x) => [x.id, x])) }));
      refreshPending();
    } catch (e) {
      setMsgs([...next, { role: "assistant", content: `⚠ ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, op: "confirm" | "reject") {
    if (op === "confirm" && !window.confirm("Confirm this action? It will be executed now (PayPal Agent Toolkit / reminder).")) return;
    const r = await fetch(`/api/actions/${id}/${op}`, { method: "POST" });
    const j = await r.json();
    setActions((a) => ({
      ...a,
      [id]: { ...(a[id] ?? pending.find((p) => p.id === id)!), status: r.ok ? (op === "confirm" ? "EXECUTED" : "REJECTED") : "FAILED", resultJson: JSON.stringify(r.ok ? j.result ?? {} : { error: j.error }) },
    }));
    refreshPending();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <Card className="flex h-[calc(100vh-140px)] flex-col">
        <div className="border-b p-4">
          <h1 className="text-lg font-bold">Settle Assistant</h1>
          <p className="text-xs text-slate-500">
            Ask what&apos;s pending, send reminders, invoice extra work. PayPal actions run through the <b>PayPal Agent Toolkit</b> — and only after you click Confirm.
          </p>
        </div>
        <div className="flex-1 space-y-4 overflow-auto p-4">
          {msgs.length === 0 && (
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50">
                  {s}
                </button>
              ))}
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[80%] space-y-2 rounded-lg px-3 py-2 text-sm", m.role === "user" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-900")}>
                <div className="whitespace-pre-wrap">{m.content.replace(/\*\*(.+?)\*\*/g, "$1")}</div>
                {m.actions?.map((a) => (
                  <ActionCard key={a.id} a={actions[a.id] ?? a} onDecide={decide} />
                ))}
              </div>
            </div>
          ))}
          {busy && <div className="text-xs text-slate-500">Assistant is thinking…</div>}
          <div ref={end} />
        </div>
        <form
          className="flex gap-2 border-t p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. what's pending for me?" />
          <Button variant="primary" disabled={busy || !input.trim()}>
            Send
          </Button>
        </form>
      </Card>
      <aside className="space-y-2">
        <div className="text-sm font-semibold">Waiting for your confirmation</div>
        {pending.length === 0 && <p className="text-xs text-slate-500">Nothing pending.</p>}
        {pending.map((a) => (
          <ActionCard key={a.id} a={actions[a.id] ?? a} onDecide={decide} />
        ))}
      </aside>
    </div>
  );
}

function ActionCard({ a, onDecide }: { a: Action; onDecide: (id: string, op: "confirm" | "reject") => void }) {
  const [busy, setBusy] = useState(false);
  const params = JSON.parse(a.paramsJson || "{}");
  return (
    <div className="space-y-2 rounded-md border border-amber-300 bg-white p-3 text-slate-900 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold">{a.title}</div>
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold",
            a.status === "PENDING" ? "bg-amber-100 text-amber-800" : a.status === "EXECUTED" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600",
          )}
        >
          {a.status}
        </span>
      </div>
      <details>
        <summary className="cursor-pointer text-[11px] text-slate-500">{a.type === "TOOLKIT_CALL" ? `PayPal Agent Toolkit · ${params.tool}` : a.type}</summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-900 p-2 text-[10px] text-slate-100">{JSON.stringify(params.args ?? params, null, 2)}</pre>
      </details>
      {a.status === "PENDING" ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="success"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onDecide(a.id, "confirm");
              setBusy(false);
            }}
          >
            {busy ? "Executing…" : "Confirm"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(a.id, "reject")}>
            Reject
          </Button>
        </div>
      ) : (
        a.resultJson && <pre className="max-h-32 overflow-auto rounded bg-slate-50 p-2 text-[10px]">{a.resultJson}</pre>
      )}
    </div>
  );
}
