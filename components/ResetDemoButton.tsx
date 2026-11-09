"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ResetDemoButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      title="Restore the demo contracts (app data only — PayPal sandbox is not touched)"
      className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
      onClick={async () => {
        if (!window.confirm("Reset demo data?\n\nAll contracts in this demo are replaced with the fresh demo set. Real PayPal sandbox transactions are not affected.")) return;
        setBusy(true);
        try {
          const r = await fetch("/api/demo/reset", { method: "POST" });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) window.alert(j.error ?? "Reset failed");
          else {
            router.push("/");
            router.refresh();
          }
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Resetting…" : "↺ Reset demo"}
    </button>
  );
}
