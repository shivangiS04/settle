"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GridApi,
  type ICellRendererParams,
  type IDetailCellRendererParams,
  type RowClickedEvent,
  type ValueFormatterParams,
} from "ag-grid-community";
import { LicenseManager, MasterDetailModule, RowGroupingModule, RowGroupingPanelModule, SetFilterModule, ColumnMenuModule, ContextMenuModule } from "ag-grid-enterprise";
import type { ContractRow, CriterionRow, MilestoneRow } from "@/lib/dashboard";
import { STATUS_COLORS } from "@/components/ui";
import { AuditTrail, type AuditRow } from "@/components/AuditTrail";
import { cn } from "@/lib/utils";

ModuleRegistry.registerModules([AllCommunityModule, MasterDetailModule, RowGroupingModule, RowGroupingPanelModule, SetFilterModule, ColumnMenuModule, ContextMenuModule]);
if (process.env.NEXT_PUBLIC_AG_GRID_LICENSE) LicenseManager.setLicenseKey(process.env.NEXT_PUBLIC_AG_GRID_LICENSE);

const theme = themeQuartz.withParams({ fontSize: 13, headerFontWeight: 600, accentColor: "#0070e0", rowHeight: 40 });

// ---------- renderers ----------
function StatusRenderer(p: ICellRendererParams) {
  if (!p.value) return null;
  return <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS_COLORS[p.value] ?? "bg-slate-100")}>{p.value}</span>;
}
function ScoreRenderer(p: ICellRendererParams) {
  if (p.value == null) return <span className="text-slate-400">—</span>;
  const v = Number(p.value);
  const color = v >= 100 ? "#10b981" : v >= 60 ? "#f59e0b" : "#f43f5e";
  return (
    <div className="flex h-full items-center gap-2">
      <div className="h-2 w-20 overflow-hidden rounded-full bg-slate-200">
        <div style={{ width: `${Math.min(100, v)}%`, background: color }} className="h-full" />
      </div>
      <span className="tabular-nums text-xs">{v}%</span>
    </div>
  );
}
function RiskRenderer(p: ICellRendererParams) {
  if (!p.value) return p.node.rowPinned ? null : <span className="text-xs text-emerald-600">● ok</span>;
  return <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[11px] font-semibold text-rose-700">⚠ {String(p.value).replace(/_/g, " ")}</span>;
}
function PassRenderer(p: ICellRendererParams) {
  if (p.value == null) return <span className="text-slate-400">pending</span>;
  return p.value ? <span className="font-semibold text-emerald-600">✓ pass</span> : <span className="font-semibold text-rose-600">✗ fail</span>;
}
function ShotRenderer(p: ICellRendererParams) {
  return p.value ? (
    <a href={p.value} target="_blank" rel="noreferrer" className="text-blue-600 underline">
      view
    </a>
  ) : null;
}

const usd = (p: ValueFormatterParams) => (p.value == null ? "" : `$${Number(p.value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const since = (p: ValueFormatterParams) => {
  if (!p.value) return "";
  const ms = Date.now() - new Date(p.value).getTime();
  const h = ms / 3600_000;
  return h < 1 ? `${Math.round(ms / 60000)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
};

const moneyCols = (): ColDef[] => [
  { field: "held", headerName: "Held in escrow", valueFormatter: usd, type: "rightAligned", aggFunc: "sum", width: 140 },
  { field: "paidOut", headerName: "Paid out", valueFormatter: usd, type: "rightAligned", aggFunc: "sum", width: 120 },
  { field: "refunded", headerName: "Released to client", valueFormatter: usd, type: "rightAligned", aggFunc: "sum", width: 150 },
  { field: "fees", headerName: "Fees", valueFormatter: usd, type: "rightAligned", aggFunc: "sum", width: 100 },
];
const tailCols = (): ColDef[] => [
  { field: "score", headerName: "Verifier score", cellRenderer: ScoreRenderer, width: 150, filter: "agNumberColumnFilter" },
  { field: "riskFlag", headerName: "Risk", cellRenderer: RiskRenderer, filter: "agSetColumnFilter", width: 190 },
  { field: "lastPaypalEvent", headerName: "Last PayPal event", filter: "agSetColumnFilter", width: 250, cellClass: "font-mono text-[11px]" },
  { field: "stateChangedAt", headerName: "Time in state", valueFormatter: since, width: 120, sort: undefined },
];

type Selection = { kind: "contract" | "milestone"; id: string; title: string } | null;

export function OpsGrid({ rows }: { rows: ContractRow[] }) {
  const apiRef = useRef<GridApi<ContractRow> | null>(null);
  const [grouped, setGrouped] = useState(false);
  const [pinned, setPinned] = useState<Partial<ContractRow>[]>([]);
  const [sel, setSel] = useState<Selection>(null);
  const [audit, setAudit] = useState<{ events: AuditRow[]; actions: { id: string; title: string; source: string; status: string; type: string; rationale: string; createdAt: string }[] } | null>(null);

  const recomputeTotals = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const t = { held: 0, paidOut: 0, refunded: 0, fees: 0, amount: 0 };
    api.forEachNodeAfterFilter((n) => {
      if (!n.data) return;
      t.held += n.data.held;
      t.paidOut += n.data.paidOut;
      t.refunded += n.data.refunded;
      t.fees += n.data.fees;
      t.amount += n.data.amount;
    });
    setPinned([{ title: "TOTAL", ...t } as Partial<ContractRow>]);
  }, []);

  const openAudit = useCallback(async (s: NonNullable<Selection>) => {
    setSel(s);
    setAudit(null);
    const r = await fetch(`/api/audit?${s.kind === "contract" ? "contractId" : "milestoneId"}=${s.id}`);
    setAudit(await r.json());
  }, []);

  const columnDefs = useMemo<ColDef<ContractRow>[]>(
    () => [
      { field: "title", headerName: "Contract", cellRenderer: "agGroupCellRenderer", minWidth: 260, flex: 1, filter: "agTextColumnFilter" },
      { field: "client", filter: "agSetColumnFilter", width: 120, enableRowGroup: true },
      { field: "freelancer", filter: "agSetColumnFilter", width: 120, enableRowGroup: true },
      { field: "status", cellRenderer: StatusRenderer, filter: "agSetColumnFilter", enableRowGroup: true, width: 130 },
      { field: "amount", headerName: "Contract value", valueFormatter: usd, type: "rightAligned", aggFunc: "sum", width: 130 },
      ...(moneyCols() as ColDef<ContractRow>[]),
      ...(tailCols() as ColDef<ContractRow>[]),
    ],
    [],
  );

  const detailCellRendererParams = useMemo(
    () =>
      ({
        detailGridOptions: {
          theme,
          masterDetail: true,
          detailRowAutoHeight: true,
          columnDefs: [
            { field: "title", headerName: "Milestone", cellRenderer: "agGroupCellRenderer", minWidth: 220, flex: 1 },
            { field: "status", cellRenderer: StatusRenderer, width: 120 },
            { field: "amount", valueFormatter: usd, type: "rightAligned", width: 110 },
            ...moneyCols(),
            ...tailCols(),
            { field: "payoutStatus", headerName: "Payout", width: 110 },
          ] as ColDef<MilestoneRow>[],
          defaultColDef: { resizable: true, sortable: true },
          onRowClicked: (e: RowClickedEvent<MilestoneRow>) => e.data && openAudit({ kind: "milestone", id: e.data.id, title: e.data.title }),
          rowClass: "cursor-pointer",
          detailCellRendererParams: {
            detailGridOptions: {
              theme,
              columnDefs: [
                { field: "criterion", flex: 2, minWidth: 260, wrapText: true, autoHeight: true },
                { field: "checkType", headerName: "Type", width: 110 },
                { field: "passed", headerName: "Result", cellRenderer: PassRenderer, width: 100 },
                { field: "confidence", width: 110, valueFormatter: (p: ValueFormatterParams) => (p.value == null ? "" : `${Math.round(p.value * 100)}%`) },
                { field: "evidence", flex: 3, minWidth: 300, wrapText: true, autoHeight: true, cellClass: "text-xs leading-snug py-1" },
                { field: "screenshotUrl", headerName: "Shot", cellRenderer: ShotRenderer, width: 80 },
              ] as ColDef<CriterionRow>[],
              defaultColDef: { resizable: true },
              domLayout: "autoHeight",
            },
            getDetailRowData: (p: { data: MilestoneRow; successCallback: (r: CriterionRow[]) => void }) => p.successCallback(p.data.criteria),
          },
        },
        getDetailRowData: (p: { data: ContractRow; successCallback: (r: MilestoneRow[]) => void }) => p.successCallback(p.data.milestones),
      }) as unknown as IDetailCellRendererParams<ContractRow, MilestoneRow>,
    [openAudit],
  );

  const toggleGroup = () => {
    const next = !grouped;
    setGrouped(next);
    apiRef.current?.applyColumnState({ state: [{ colId: "status", rowGroup: next, hide: next }], defaultState: { rowGroup: false } });
  };

  return (
    <div className="flex gap-4">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <button onClick={toggleGroup} className={cn("rounded-md border px-3 py-1.5 text-xs font-medium", grouped ? "border-slate-900 bg-slate-900 text-white" : "bg-white")}>
            {grouped ? "✓ Grouped by status" : "Group by status"}
          </button>
          <button onClick={() => apiRef.current?.setFilterModel({ riskFlag: { filterType: "set", values: Array.from(new Set(rows.map((r) => r.riskFlag).filter(Boolean))) } })} className="rounded-md border bg-white px-3 py-1.5 text-xs font-medium">
            Show only at-risk
          </button>
          <button onClick={() => apiRef.current?.setFilterModel(null)} className="rounded-md border bg-white px-3 py-1.5 text-xs font-medium">
            Clear filters
          </button>
          <span className="ml-auto text-xs text-slate-500">Click any contract or milestone row for its audit trail →</span>
        </div>
        <div style={{ height: 640 }}>
          <AgGridReact<ContractRow>
            theme={theme}
            rowData={rows}
            columnDefs={columnDefs}
            defaultColDef={{ resizable: true, sortable: true, filter: true }}
            masterDetail
            detailRowAutoHeight
            detailCellRendererParams={detailCellRendererParams}
            isRowMaster={(d) => !!d && d.milestones.length > 0}
            rowGroupPanelShow="always"
            suppressAggFuncInHeader
            isGroupOpenByDefault={(p) => !!p.rowNode.group}
            autoGroupColumnDef={{ headerName: "Status group", minWidth: 200 }}
            pinnedBottomRowData={pinned}
            getRowId={(p) => p.data.id}
            rowClass="cursor-pointer"
            onGridReady={(e) => {
              apiRef.current = e.api;
              recomputeTotals();
            }}
            onFilterChanged={recomputeTotals}
            onRowDataUpdated={recomputeTotals}
            onRowClicked={(e) => {
              if (e.node.rowPinned || e.node.group || !e.data) return;
              openAudit({ kind: "contract", id: e.data.id, title: e.data.title });
            }}
          />
        </div>
      </div>

      {sel && (
        <aside className="w-[420px] shrink-0 space-y-3 rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Audit trail · {sel.kind}</div>
              <div className="font-semibold">{sel.title}</div>
              {sel.kind === "contract" && (
                <a href={`/contracts/${sel.id}`} className="text-xs text-blue-600 underline">
                  open contract
                </a>
              )}
            </div>
            <button onClick={() => setSel(null)} className="text-slate-400 hover:text-slate-700">
              ✕
            </button>
          </div>
          {!audit ? (
            <p className="text-xs text-slate-500">Loading…</p>
          ) : (
            <div className="max-h-[600px] space-y-3 overflow-auto pr-1">
              {audit.actions.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-semibold text-slate-500">Proposed actions (human-in-the-loop)</div>
                  {audit.actions.map((a) => (
                    <div key={a.id} className="rounded border border-slate-200 p-2 text-xs">
                      <div className="flex justify-between gap-2">
                        <span className="font-medium">{a.title}</span>
                        <span className={cn("rounded px-1 text-[10px] font-semibold", a.status === "EXECUTED" ? "bg-emerald-100 text-emerald-700" : a.status === "FAILED" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-800")}>
                          {a.status}
                        </span>
                      </div>
                      <div className="text-slate-500">
                        {a.type} · proposed by {a.source}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <AuditTrail events={audit.events} compact />
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
