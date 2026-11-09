import type { MilestoneFull } from "./MilestoneCard";
import { cn } from "@/lib/utils";

export function ScoreBar({ pct }: { pct: number }) {
  const color = pct >= 100 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-28 overflow-hidden rounded-full bg-slate-200">
        <div className={cn("h-full", color)} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="text-xs font-semibold tabular-nums">{pct}%</span>
    </div>
  );
}

export function VerificationPanel({ m }: { m: MilestoneFull }) {
  const v = m.verifications[0];
  if (!v) return null;
  const delivery = m.deliveries.find((d) => d.id === v.deliveryId);
  return (
    <div className="space-y-3 rounded-md border border-teal-200 bg-teal-50/40 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold">Verifier Agent</span>
        <ScoreBar pct={v.scorePct} />
        <span className="text-[11px] text-slate-500">
          {v.model} · {v.createdAt.toLocaleString()}
        </span>
      </div>
      {delivery && (
        <div className="text-xs text-slate-600">
          Delivery ({delivery.type}):{" "}
          {delivery.type === "TEXT" ? (
            <span className="italic">{delivery.content.slice(0, 120)}…</span>
          ) : (
            <a href={delivery.content} target="_blank" rel="noreferrer" className="text-blue-600 underline">
              {delivery.content}
            </a>
          )}
        </div>
      )}
      <p className="text-sm text-slate-700">{v.summary}</p>
      <ul className="space-y-2">
        {m.criteria.map((c) => {
          const r = v.results.find((x) => x.criterionId === c.id);
          if (!r) return null;
          return (
            <li key={c.id} className="rounded-md bg-white p-2 text-sm ring-1 ring-slate-200">
              <div className="flex items-start gap-2">
                <span className={cn("mt-0.5 text-base leading-none", r.passed ? "text-emerald-600" : "text-rose-600")}>{r.passed ? "✓" : "✗"}</span>
                <div className="flex-1">
                  <div className="font-medium">{c.text}</div>
                  <div className="text-xs text-slate-600">{r.evidence}</div>
                </div>
                <span className="shrink-0 text-[11px] text-slate-400">conf {Math.round(r.confidence * 100)}%</span>
                {r.screenshotUrl && (
                  <a href={r.screenshotUrl} target="_blank" rel="noreferrer" className="shrink-0 text-[11px] text-blue-600 underline">
                    screenshot
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {v.screenshots.length > 0 && (
        <div className="flex gap-3">
          {v.screenshots.map((s) => (
            <a key={s.id} href={`/api/screenshots/${s.id}`} target="_blank" rel="noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/screenshots/${s.id}`}
                alt={`${s.label} screenshot`}
                className={cn("rounded border object-cover object-top", s.label === "mobile" ? "h-48 w-24" : "h-48 w-72")}
              />
              <div className="mt-1 text-center text-[10px] text-slate-500">{s.label === "mobile" ? "375px" : "desktop"}</div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
