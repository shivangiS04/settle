"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, type ButtonProps } from "@/components/ui";

export async function postJson(path: string, body?: unknown) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

/** POSTs to an endpoint, optionally after a confirm() describing exactly what money moves. */
export function ActionButton({
  path,
  body,
  confirmText,
  children,
  busyText,
  ...props
}: ButtonProps & { path: string; body?: unknown; confirmText?: string; busyText?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        {...props}
        disabled={busy || props.disabled}
        onClick={async () => {
          if (confirmText && !window.confirm(confirmText)) return;
          setBusy(true);
          setErr(null);
          try {
            await postJson(path, body);
            router.refresh();
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? busyText ?? "Working…" : children}
      </Button>
      {err && <span className="max-w-xs text-xs text-rose-600">{err}</span>}
    </span>
  );
}
