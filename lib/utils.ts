import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function money(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format((cents ?? 0) / 100);
}

/** PayPal wants "123.45" strings. */
export function centsToValue(cents: number) {
  return (cents / 100).toFixed(2);
}

export function valueToCents(v: string | number) {
  return Math.round(Number(v) * 100);
}

export function safeJson<T = unknown>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function feePct() {
  return Number(process.env.PLATFORM_FEE_PCT ?? "3");
}

export function splitFee(grossCents: number) {
  const fee = Math.round((grossCents * feePct()) / 100);
  return { feeCents: fee, netCents: grossCents - fee };
}

export function timeAgo(d: Date | string) {
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
