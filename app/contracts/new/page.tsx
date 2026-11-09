"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Textarea } from "@/components/ui";
import { postJson } from "@/components/ActionButton";

const SAMPLE = `[WhatsApp · 3 Nov]
Maya: Hey Arjun! Loved your portfolio. We need a landing page for our coffee subscription brand "Brewline".
Arjun: Thanks Maya! What do you need on it?
Maya: Hero section with our tagline + a "Start subscription" button, 3 plan cards (Starter $12, Daily $24, Office $60), and a contact form so cafés can reach us. Most of our traffic is mobile so it HAS to look right on phones.
Arjun: Got it. I'd do it in two parts: 1) design + build the landing page — $600, ready by Nov 20. 2) a 1500-word launch blog post about "why freshly roasted beans matter" — $250, by Nov 27.
Maya: Perfect. Contact form needs name, email, message. Can you also make sure it loads fast?
Arjun: Yes, I'll keep it lightweight. Deal!
Maya: Deal 🙌 let's use Settle so the payment is held until it's done.`;

export default function NewContract() {
  const router = useRouter();
  const [thread, setThread] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">New contract from a chat</h1>
        <p className="text-sm text-slate-500">
          Paste the WhatsApp / email / LinkedIn thread where you agreed the work. The Contract Agent drafts milestones, amounts and testable
          acceptance criteria. Both of you review and accept before any money is held.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Conversation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea rows={14} value={thread} onChange={(e) => setThread(e.target.value)} placeholder="Paste the thread here…" className="font-mono text-xs" />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={busy || thread.trim().length < 20}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  const { id } = await postJson("/api/contracts", { thread });
                  router.push(`/contracts/${id}`);
                } catch (e) {
                  setErr((e as Error).message);
                  setBusy(false);
                }
              }}
            >
              {busy ? "Contract Agent is reading the thread…" : "Extract contract with AI"}
            </Button>
            <Button variant="ghost" onClick={() => setThread(SAMPLE)}>
              Use sample thread
            </Button>
          </div>
          {err && <p className="text-sm text-rose-600">{err}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
