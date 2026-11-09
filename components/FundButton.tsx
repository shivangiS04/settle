"use client";
import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";

async function post(path: string, body?: unknown) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Request failed");
  return j;
}

/**
 * PayPal JS SDK button with intent=authorize: buyer approves, we authorize server-side
 * (funds held, not captured). In mock mode we skip the popup and simulate approval.
 */
export function FundButton({ milestoneId, currency, clientId, mock }: { milestoneId: string; currency: string; clientId: string; mock: boolean }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (mock || !clientId) {
    return (
      <div className="space-y-1">
        <Button
          variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const { id } = await post(`/api/milestones/${milestoneId}/order`);
              await post(`/api/milestones/${milestoneId}/authorize`, { orderId: id });
              router.refresh();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Authorizing…" : "Fund escrow (simulated PayPal approval)"}
        </Button>
        {err && <p className="text-xs text-rose-600">{err}</p>}
      </div>
    );
  }

  return (
    <div className="max-w-xs space-y-1">
      <PayPalScriptProvider options={{ clientId, intent: "authorize", currency, components: "buttons" }}>
        <PayPalButtons
          style={{ layout: "horizontal", height: 36, tagline: false, label: "pay" }}
          createOrder={async () => (await post(`/api/milestones/${milestoneId}/order`)).id}
          onApprove={async (data) => {
            try {
              await post(`/api/milestones/${milestoneId}/authorize`, { orderId: data.orderID });
              router.refresh();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
          onError={(e) => setErr(String((e as { message?: string })?.message ?? e))}
        />
      </PayPalScriptProvider>
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}
