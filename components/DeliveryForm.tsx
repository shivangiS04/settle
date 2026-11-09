"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Input, Textarea } from "@/components/ui";
import { postJson } from "@/components/ActionButton";
import { cn } from "@/lib/utils";

const TYPES = [
  { k: "URL", label: "Live URL", ph: "https://brewline-landing.vercel.app" },
  { k: "GITHUB", label: "GitHub repo", ph: "https://github.com/owner/repo" },
  { k: "TEXT", label: "Text", ph: "Paste the deliverable text (e.g. the blog post)…" },
] as const;

export function DeliveryForm({ milestoneId, resubmit }: { milestoneId: string; resubmit?: boolean }) {
  const router = useRouter();
  const [type, setType] = useState<(typeof TYPES)[number]["k"]>("URL");
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(!resubmit);
  const t = TYPES.find((x) => x.k === type)!;

  if (!open)
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Submit a revised delivery
      </Button>
    );

  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="text-sm font-semibold">{resubmit ? "Submit a revision" : "Submit your delivery"}</div>
      <div className="flex gap-1">
        {TYPES.map((x) => (
          <button
            key={x.k}
            onClick={() => setType(x.k)}
            className={cn("rounded px-2.5 py-1 text-xs font-medium", type === x.k ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200")}
          >
            {x.label}
          </button>
        ))}
      </div>
      {type === "TEXT" ? (
        <Textarea rows={8} value={content} onChange={(e) => setContent(e.target.value)} placeholder={t.ph} />
      ) : (
        <Input value={content} onChange={(e) => setContent(e.target.value)} placeholder={t.ph} />
      )}
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to client (optional)" />
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !content.trim()}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await postJson(`/api/milestones/${milestoneId}/submit`, { type, content, note });
              router.refresh();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Submitting…" : "Submit for AI verification"}
        </Button>
        {err && <span className="text-xs text-rose-600">{err}</span>}
      </div>
    </div>
  );
}

/** Polls while the verifier runs in the background. */
export function AutoRefresh({ every = 3000 }: { every?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), every);
    return () => clearInterval(t);
  }, [router, every]);
  return null;
}
