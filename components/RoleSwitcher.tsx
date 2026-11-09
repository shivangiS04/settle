"use client";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

export function RoleSwitcher({ role }: { role: "CLIENT" | "FREELANCER" }) {
  const router = useRouter();
  const set = (r: string) => {
    document.cookie = `settle_role=${r}; path=/; max-age=31536000`;
    router.refresh();
  };
  return (
    <div className="flex rounded-md border border-slate-300 bg-white p-0.5 text-xs font-medium">
      {(["CLIENT", "FREELANCER"] as const).map((r) => (
        <button
          key={r}
          onClick={() => set(r)}
          className={cn(
            "rounded px-3 py-1.5 transition-colors",
            role === r ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100",
          )}
        >
          View as {r === "CLIENT" ? "Client" : "Freelancer"}
        </button>
      ))}
    </div>
  );
}
