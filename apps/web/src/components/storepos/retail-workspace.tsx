"use client";
import { formatDate, formatStatus } from "../../lib/format";

import { useState } from "react";
import Link from "next/link";
import { useApi, useLive, mutate } from "../../lib/api";
import { Panel } from "../cockpit/kit";
import { formatPhp as cockpitPhp } from "../cockpit/format";

/** Plain status word for a void/refund request (WEB-043). */
export const reversalStatus = (status: string) =>
  status === "pending" ? "Waiting for a decision" : formatStatus(status);
const formatPhp = (value: number | null | undefined) =>
  cockpitPhp(value, { cents: true });

type Choice = { id: string; name: string; type?: string; code?: string };
export type RetailRow = {
  id: string;
  name: string;
  register: string;
  registers?: Choice[];
  sales: number;
  prior: number;
  target: number;
  basket: number;
  orders: number;
  shrink: number | null;
  trend: { day: string; category: string; sales: number }[];
  nextAction: string;
};
type Read = {
  id: string;
  kind: string;
  sequence: string;
  snapshot: {
    salesCentavos: string;
    date: string;
    tenders: { label: string; amount: string }[];
    vat: Record<string, string>;
    journal: {
      number?: string;
      status?: string;
      original?: string;
      kind?: string;
      amount?: string;
      snapshot?: {
        cashier: string;
        lines: {
          description: string;
          quantity: number;
          uom: string;
          lineTotalCentavos: number;
        }[];
      };
    }[];
  };
};
type SavedPolicy = {
  id: string;
  toleranceCentavos: string;
  loyaltyEnabled: boolean;
  earnPerCentavos: string;
  pointValueCentavos: string;
  employeeDiscountBps: number;
};

const pesos = (centavos: string | number) => {
  const n = Number(centavos) / 100;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

/** WEB-044: the configuration form starts from the saved policy and target (sample
 * defaults only when nothing is saved yet). */
export function policyFormValues(d: {
  policy?: SavedPolicy | null;
  dailyTargetCentavos?: string | null;
}) {
  const p = d.policy;
  return {
    key: `${p?.id ?? "none"}:${d.dailyTargetCentavos ?? ""}`,
    dailyTarget:
      d.dailyTargetCentavos != null ? pesos(d.dailyTargetCentavos) : "",
    tolerance: p ? pesos(p.toleranceCentavos) : "50",
    discount: p ? String(p.employeeDiscountBps / 100) : "10",
    loyalty: p ? p.loyaltyEnabled : false,
    earn: p ? pesos(p.earnPerCentavos) : "100",
    pointValue: p ? pesos(p.pointValueCentavos) : "1",
  };
}

type Office = {
  register: {
    id: string;
    name: string;
    store: string;
    outletId: string | null;
  };
  reversals: {
    id: string;
    kind: string;
    reason: string;
    status: string;
    number: string;
    canDecide: boolean;
    /** Who decides, when this viewer cannot (WEB-043). */
    decideNote?: string | null;
  }[];
  deposits: {
    id: string;
    bank: string;
    reference: string;
    amount: string;
    status: string;
    canDecide: boolean;
    expected?: string;
    difference?: string;
    canViewPhoto?: boolean;
  }[];
  replenishments: {
    id: string;
    name: string;
    quantity: string;
    status: string;
    transfer_id: string | null;
    canDecide: boolean;
  }[];
  reads: Read[];
  policy?: SavedPolicy | null;
  dailyTargetCentavos?: string | null;
  locations: Choice[];
  products: Choice[];
  outlets: Choice[];
  canManage: boolean;
  canPrepare: boolean;
  canApprove: boolean;
};
const control =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";
const button =
  "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50";
const reportKey = ["storepos", "report"] as const;
function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
/** F-R08 genuine Excel 2003 XML, typed text cells (never formulas), no internal identifiers. */
type ExcelSheet = {
  name: string;
  headers: string[];
  rows: (string | number)[][];
};
export function excelWorkbook(
  headers: string[],
  rows: (string | number)[][],
  extra: ExcelSheet[] = [],
) {
  const escape = (s: unknown) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const line = (cells: (string | number)[]) =>
    `<Row>${cells.map((c) => `<Cell><Data ss:Type="${typeof c === "number" ? "Number" : "String"}">${escape(c)}</Data></Cell>`).join("")}</Row>`;
  const sheets = [{ name: "Retail POS", headers, rows }, ...extra];
  return `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">${sheets.map((s) => `<Worksheet ss:Name="${escape(s.name)}"><Table>${line(s.headers)}${s.rows.map(line).join("")}</Table></Worksheet>`).join("")}</Workbook>`;
}
/** F-R02: recognized net reconciles to the read; original void amounts remain visible, refunds are negative. */
export function readWorkbook(r: Read) {
  const rows = r.snapshot.journal.flatMap(
    (j) =>
      j.snapshot?.lines.map((l) => {
        const captured = Number(l.lineTotalCentavos) / 100,
          net =
            j.status === "voided"
              ? 0
              : j.kind === "refund"
                ? -Math.abs(captured)
                : captured;
        return [
          `${r.kind.toUpperCase()} ${r.sequence}`,
          r.snapshot.date,
          j.number ?? "",
          j.status ?? j.kind ?? "issued",
          j.original ?? "",
          j.snapshot?.cashier ?? "",
          l.description,
          l.quantity,
          l.uom,
          captured,
          net,
        ];
      }) ?? [
        [
          `${r.kind.toUpperCase()} ${r.sequence}`,
          r.snapshot.date,
          j.number ?? "",
          j.kind ?? "refund",
          j.original ?? "",
          "",
          "Receipt-linked refund (summary)",
          "",
          "",
          -Math.abs(Number(j.amount ?? 0)) / 100,
          -Math.abs(Number(j.amount ?? 0)) / 100,
        ],
      ],
  );
  const tax: Record<string, string> = {
    vatableSalesMinor: "VATable sales",
    vatMinor: "VAT",
    vatExemptMinor: "VAT-exempt sales",
    zeroRatedMinor: "Zero-rated sales",
  };
  return excelWorkbook(
    [
      "Read",
      "Day",
      "Invoice",
      "Status",
      "Original invoice",
      "Cashier",
      "Product",
      "Quantity",
      "UOM",
      "Captured line PHP",
      "Net sales PHP",
    ],
    rows,
    [
      {
        name: "Tenders",
        headers: ["Tender", "Amount PHP"],
        rows: r.snapshot.tenders.map((t) => [t.label, Number(t.amount) / 100]),
      },
      {
        name: "VAT",
        headers: ["Tax", "Amount PHP"],
        rows: Object.entries(tax).map(([key, label]) => [
          label,
          Number(r.snapshot.vat[key] ?? 0) / 100,
        ]),
      },
    ],
  );
}
function downloadXml(name: string, xml: string) {
  const url = URL.createObjectURL(
    new Blob([xml], { type: "application/vnd.ms-excel" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function download(
  name: string,
  headers: string[],
  rows: (string | number)[][],
) {
  downloadXml(name, excelWorkbook(headers, rows));
}
function Select({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  rows: Choice[];
}) {
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <select
        aria-label={label}
        className={control}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose…</option>
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </label>
  );
}
function Field({
  label,
  value,
  set,
  type = "text",
}: {
  label: string;
  value: string;
  set: (s: string) => void;
  type?: string;
}) {
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <input
        aria-label={label}
        className={control}
        type={type}
        value={value}
        onChange={(e) => set(e.target.value)}
        autoComplete={type === "password" ? "new-password" : undefined}
      />
    </label>
  );
}

/** F-R08 owner question: which retail store is behind, and what should we act on next? */
export function RetailWorkspace() {
  const [from, setFrom] = useState(today),
    [to, setTo] = useState(today),
    [selected, setSelected] = useState("");
  const result = useApi<{ from: string; to: string; rows: RetailRow[] }>(
    [...reportKey, from, to],
    `/api/v1/storepos/report?from=${from}&to=${to}`,
  );
  useLive(["storepos", "analytics"], [reportKey]);
  const rows = result.data?.rows ?? [],
    r = rows.find((x) => x.id === selected);
  const total = rows.reduce((n, r) => n + r.sales, 0),
    target = rows.reduce((n, r) => n + r.target, 0),
    prior = rows.reduce((n, r) => n + r.prior, 0);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From" type="date" value={from} set={setFrom} />
        <Field label="To" type="date" value={to} set={setTo} />
        <button
          className={button}
          disabled={!rows.length}
          onClick={() =>
            download(
              "retail-stores.xml",
              [
                "Store",
                "Register",
                "Sales PHP",
                "Target PHP",
                "Prior PHP",
                "Average basket PHP",
                "Transactions",
                "Shrink base units",
                "Next action",
              ],
              rows.map((r) => [
                r.name,
                r.register,
                r.sales / 100,
                r.target / 100,
                r.prior / 100,
                r.basket / 100,
                r.orders,
                r.shrink ?? "Restricted",
                r.nextAction,
              ]),
            )
          }
        >
          Excel XML export
        </button>
      </div>
      {result.error ? (
        <p role="alert">
          Could not load retail stores. Check the dates and retry.
        </p>
      ) : !result.data ? (
        <p>Loading retail stores…</p>
      ) : (
        <>
          <Panel
            title="Retail stores"
            question="Which store is behind target, and what should we act on next?"
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                Sales
                <strong className="block text-2xl">{formatPhp(total)}</strong>
              </div>
              <div>
                Target
                <strong className="block text-2xl">
                  {target ? formatPhp(target) : "Set a store target"}
                </strong>
              </div>
              <div>
                Prior equal period
                <strong className="block text-2xl">{formatPhp(prior)}</strong>
              </div>
            </div>
            <p className="mt-3 text-sm text-muted">
              The same canonical commercial facts feed the owner cockpit and
              this tab. Voids are excluded; approved refunds are negative facts,
              never a second sales total.
            </p>
          </Panel>
          <Panel
            title="Store performance"
            question="Exceptions first. Choose a store to review its register, stock and cash."
          >
            {!rows.length ? (
              <p>
                No store registers in your area. Add a store location and
                terminal in Setup → Phones.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      {[
                        "Store",
                        "Sales / target",
                        "Prior",
                        "Basket",
                        "Shrink",
                        "Next action",
                      ].map((h) => (
                        <th className="p-2" key={h}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...rows]
                      .sort((a, b) => a.sales - a.target - (b.sales - b.target))
                      .map((s) => (
                        <tr className="border-t border-separator" key={s.id}>
                          <td className="p-2">
                            <button
                              className="text-left underline"
                              onClick={() => setSelected(s.id)}
                            >
                              {s.name}
                              <span className="block text-xs text-muted">
                                {s.register}
                              </span>
                            </button>
                          </td>
                          <td className="p-2">
                            {formatPhp(s.sales)} /{" "}
                            {s.target ? formatPhp(s.target) : "No target"}
                          </td>
                          <td className="p-2">{formatPhp(s.prior)}</td>
                          <td className="p-2">
                            {formatPhp(s.basket)} · {s.orders} baskets
                          </td>
                          <td className="p-2">
                            {s.shrink === null
                              ? "Approver only"
                              : `${s.shrink} base units`}
                          </td>
                          <td className="p-2">
                            <button
                              onClick={() => setSelected(s.id)}
                              className="underline"
                            >
                              {s.nextAction}
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          {r && (
            <>
              <Panel
                title={`${r.name} · daily trend and category mix`}
                question="Where did sales change, and which categories explain it?"
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  {r.trend.map((t) => (
                    <div
                      key={`${t.day}:${t.category}`}
                      className="border-l-2 border-foreground pl-3"
                    >
                      <span>
                        {formatDate(t.day)} · {t.category}
                      </span>
                      <strong className="block">{formatPhp(t.sales)}</strong>
                      <meter
                        className="w-full"
                        min={0}
                        max={Math.max(
                          1,
                          ...r.trend.map((x) => Math.max(0, x.sales)),
                        )}
                        value={Math.max(0, t.sales)}
                      />
                    </div>
                  ))}
                </div>
                {!r.trend.length && (
                  <p>
                    No sales in this period. Receive governed stock, open a
                    shift and take the next sale.
                  </p>
                )}
              </Panel>
              <StoreRegisterDrill key={r.id} row={r} from={from} to={to} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function StoreRegisterDrill({
  row,
  from,
  to,
}: {
  row: RetailRow;
  from: string;
  to: string;
}) {
  const choices = row.registers ?? [{ id: row.id, name: row.register }];
  const [register, setRegister] = useState(choices[0]?.id ?? "");
  return (
    <div className="grid gap-3">
      {choices.length > 1 && (
        <Select
          label="Store register"
          value={register}
          onChange={setRegister}
          rows={choices}
        />
      )}
      <RetailOperations
        key={register}
        registerId={register}
        from={from}
        to={to}
      />
    </div>
  );
}

/** F-R03/F-R06 escalation joins the existing Decide page; register names, never raw IDs. */
export function RetailExceptionReview() {
  const key = ["storepos", "workspace"] as const;
  const result = useApi<{ registers: (Choice & { store_name: string })[] }>(
    key,
    "/api/v1/storepos/workspace",
  );
  useLive(["storepos"], [key]);
  const [selected, setSelected] = useState("");
  const rows = result.data?.registers ?? [];
  const current = selected || rows[0]?.id;
  return (
    <div className="grid gap-3">
      <h3 className="text-lg font-medium">Store refunds and deposits</h3>
      {result.error ? (
        <p role="alert">Could not load retail exceptions.</p>
      ) : !rows.length ? (
        <p>No store registers in this area.</p>
      ) : (
        <>
          <Select
            label="Store register to review"
            value={current ?? ""}
            onChange={setSelected}
            rows={rows.map((r) => ({
              id: r.id,
              name: `${r.store_name} · ${r.name}`,
            }))}
          />
          {current && (
            <RetailOperations
              key={current}
              registerId={current}
              from={today()}
              to={today()}
              reviewsOnly
            />
          )}
        </>
      )}
    </div>
  );
}

/** F-R02..R07 operator workflows stay inside the existing owner shell. */
export function RetailOperations({
  registerId,
  from,
  to,
  reviewsOnly = false,
}: {
  registerId: string;
  from: string;
  to: string;
  reviewsOnly?: boolean;
}) {
  const key = ["storepos", "operations", registerId, from, to] as const;
  const result = useApi<Office>(
    key,
    `/api/v1/storepos/operations?registerId=${encodeURIComponent(registerId)}&from=${from}&to=${to}`,
  );
  useLive(["storepos", "inventory"], [key]);
  const [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [outlet, setOutlet] = useState(""),
    [product, setProduct] = useState(""),
    [source, setSource] = useState(""),
    [transit, setTransit] = useState("");
  const [minimum, setMinimum] = useState(""),
    [stockTarget, setStockTarget] = useState(""),
    [dailyTarget, setDailyTarget] = useState("");
  const [tolerance, setTolerance] = useState("50"),
    [pin, setPin] = useState(""),
    [discount, setDiscount] = useState("10"),
    [loyalty, setLoyalty] = useState(false),
    [earn, setEarn] = useState("100"),
    [pointValue, setPointValue] = useState("1");
  const [reason, setReason] = useState("");
  const d = result.data;
  // Seed (and re-seed after a save) from what is stored, during render.
  const [seeded, setSeeded] = useState("");
  if (d) {
    const v = policyFormValues(d);
    if (v.key !== seeded) {
      setSeeded(v.key);
      setDailyTarget(v.dailyTarget);
      setTolerance(v.tolerance);
      setDiscount(v.discount);
      setLoyalty(v.loyalty);
      setEarn(v.earn);
      setPointValue(v.pointValue);
    }
  }
  async function send(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setNotice("");
    try {
      await mutate(
        `/api/v1/storepos/${path}`,
        { registerId, ...body, requestKey: crypto.randomUUID() },
        { invalidate: [key, reportKey, ["storepos", "workspace"]] },
      );
      setPin("");
      setNotice("Saved. Sync the POS to receive updated setup.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }
  if (result.error)
    return <p role="alert">Could not load this store’s operations.</p>;
  if (!d) return <p>Loading store operations…</p>;
  const money = (v: string) => String(Math.round(Number(v) * 100));
  return (
    <div className="grid gap-4">
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <Panel
        title={`${d.register.store} · register operations`}
        question="Resolve exceptions, then receive stock and trade."
      >
        <p className="text-sm">
          <Link className="underline" href="/setup">
            Cashiers, device mode and location setup
          </Link>{" "}
          ·{" "}
          <Link className="underline" href="/stock">
            Canonical receiving, stock count approval and warehouse transfers
          </Link>
        </p>
        <Field label="Review reason" value={reason} set={setReason} />
        {d.reversals
          .filter((v) => v.status === "pending")
          .map((v) => (
            <div key={v.id} className="mt-3 border-t border-separator pt-3">
              <p>
                {v.kind === "void" ? "Void" : "Refund"} · {v.number} ·{" "}
                {v.reason} · {reversalStatus(v.status)}
              </p>
              {v.canDecide ? (
                <div className="mt-2 flex gap-2">
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void send("reversals/decide", {
                        id: v.id,
                        decision: "approved",
                      })
                    }
                  >
                    Approve {v.kind}
                  </button>
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void send("reversals/decide", {
                        id: v.id,
                        decision: "rejected",
                      })
                    }
                  >
                    Reject
                  </button>
                </div>
              ) : (
                <p>
                  {v.decideNote ??
                    "A store manager, sales manager or approver decides this."}
                </p>
              )}
            </div>
          ))}
        {d.deposits.map((v) => (
          <div key={v.id} className="mt-3 border-t border-separator pt-3">
            <p>
              {v.bank} · {v.reference} · {formatPhp(Number(v.amount))} ·{" "}
              {v.status === "matched"
                ? "Matches Z-read amount · not bank confirmation"
                : formatStatus(v.status)}
            </p>
            {v.canViewPhoto && (
              <a
                className="underline text-sm"
                href={`/api/v1/storepos/deposits/${encodeURIComponent(v.id)}/photo`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View deposit slip
              </a>
            )}
            {v.canDecide && v.status === "needs_review" && (
              <>
                <p>
                  Expected {formatPhp(Number(v.expected))} · difference{" "}
                  {formatPhp(Number(v.difference))}
                </p>
                <button
                  className={button}
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    void send("deposits/decide", {
                      id: v.id,
                      decision: "accepted",
                      reason,
                    })
                  }
                >
                  Accept deposit difference
                </button>
                <button
                  className={button}
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    void send("deposits/decide", {
                      id: v.id,
                      decision: "investigate",
                      reason,
                    })
                  }
                >
                  Investigate
                </button>
              </>
            )}
          </div>
        ))}
        {!d.reversals.some((v) => v.status === "pending") &&
          !d.deposits.some((v) => v.status === "needs_review") && (
            <p className="mt-3 text-sm">
              No void, refund or deposit exceptions in the displayed queue.
            </p>
          )}
      </Panel>
      {!reviewsOnly && (
        <>
          <Panel
            title="X / Z reads and e-journal"
            question="What was issued, tendered and taxed, without rewriting history?"
          >
            {d.reads.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-separator py-3"
              >
                <span>
                  {r.kind.toUpperCase()} read {r.sequence} · {formatDate(r.snapshot.date)} ·{" "}
                  {formatPhp(Number(r.snapshot.salesCentavos))}
                </span>
                <button
                  className={button}
                  onClick={() =>
                    downloadXml(
                      `${r.kind}-read-${r.sequence}.xml`,
                      readWorkbook(r),
                    )
                  }
                >
                  Export journal for Excel
                </button>
                <div className="w-full text-xs text-muted">
                  {r.snapshot.tenders
                    .map((t) => `${t.label}: ${formatPhp(Number(t.amount))}`)
                    .join(" · ")}{" "}
                  · VAT {formatPhp(Number(r.snapshot.vat.vatMinor))}
                </div>
              </div>
            ))}
            {!d.reads.length && (
              <p>
                Save an X-read or close the day with a Z-read on the POS, then
                sync.
              </p>
            )}
          </Panel>
          <Panel
            title="Replenishment"
            question="Which items are below their store reorder point?"
          >
            {d.replenishments.map((v) => (
              <div key={v.id} className="border-b border-separator py-3">
                <p>
                  {v.name} · {v.quantity} base units · {v.status}
                </p>
                {v.status === "pending" && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {!v.transfer_id && d.canPrepare && (
                      <button
                        className={button}
                        disabled={busy || !transit}
                        onClick={() =>
                          void send("replenishments/prepare", {
                            id: v.id,
                            inTransitLocationId: transit,
                          })
                        }
                      >
                        Prepare warehouse transfer
                      </button>
                    )}
                    {v.transfer_id && d.canApprove && v.canDecide && (
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() =>
                          void send("replenishments/decide", {
                            id: v.id,
                            decision: "approved",
                          })
                        }
                      >
                        Approve transfer
                      </button>
                    )}
                    {d.canApprove && v.canDecide && (
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() =>
                          void send("replenishments/decide", {
                            id: v.id,
                            decision: "rejected",
                          })
                        }
                      >
                        Reject suggestion
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {d.canPrepare && (
              <Select
                label="Transit location for replenishment"
                value={transit}
                onChange={setTransit}
                rows={d.locations.filter((l) => l.type === "in_transit")}
              />
            )}
            {d.canManage && (
              <button
                className={`${button} mt-3`}
                disabled={busy}
                onClick={() => void send("reorder/suggest", {})}
              >
                Refresh low-stock suggestions
              </button>
            )}
            <p className="mt-2 text-sm text-muted">
              A suggestion does not move stock. The independently approved
              canonical transfer must be shipped and received.
            </p>
          </Panel>
          {d.canManage && (
            <Panel
              title="Store configuration"
              question="Edit dated store rules; missing client policy uses clearly marked sample defaults."
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  label="Commercial store / accounting link"
                  value={outlet}
                  onChange={setOutlet}
                  rows={d.outlets}
                />
                <button
                  className={button}
                  disabled={busy || !outlet}
                  onClick={() =>
                    void send("registers/link", { outletId: outlet })
                  }
                >
                  Link register to store
                </button>
              </div>
              <details className="mt-4">
                <summary>Daily target</summary>
                <div className="mt-3 grid gap-3">
                  <p className="text-sm">
                    Applies per day from {from} to {to}.
                  </p>
                  <Field
                    label="Daily target (₱)"
                    value={dailyTarget}
                    set={setDailyTarget}
                  />
                  <button
                    className={button}
                    disabled={busy || !/^\d+(\.\d{1,2})?$/.test(dailyTarget)}
                    onClick={() =>
                      void send("targets/save", {
                        from,
                        to,
                        amountCentavos: money(dailyTarget),
                      })
                    }
                  >
                    Save daily target
                  </button>
                </div>
              </details>
              <details className="mt-4">
                <summary>SKU reorder point</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Select
                    label="Product"
                    value={product}
                    onChange={setProduct}
                    rows={d.products}
                  />
                  <Select
                    label="Source warehouse or van"
                    value={source}
                    onChange={setSource}
                    rows={d.locations.filter((l) =>
                      ["warehouse", "truck"].includes(l.type ?? ""),
                    )}
                  />
                  <Field
                    label="Reorder below (base units)"
                    value={minimum}
                    set={setMinimum}
                  />
                  <Field
                    label="Replenish to (base units)"
                    value={stockTarget}
                    set={setStockTarget}
                  />
                  <button
                    className={button}
                    disabled={
                      busy ||
                      !product ||
                      !source ||
                      !/^\d+$/.test(minimum) ||
                      !/^\d+$/.test(stockTarget)
                    }
                    onClick={() =>
                      void send("reorder/save", {
                        productId: product,
                        sourceLocationId: source,
                        minimumBase: minimum,
                        targetBase: stockTarget,
                      })
                    }
                  >
                    Save effective reorder rule
                  </button>
                </div>
              </details>
              <details className="mt-4">
                <summary>Cash, loyalty and supervisor PIN</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Cash tolerance (₱)"
                    value={tolerance}
                    set={setTolerance}
                  />
                  <Field
                    label="New supervisor PIN (6–12 digits, blank keeps it)"
                    type="password"
                    value={pin}
                    set={setPin}
                  />
                  <Field
                    label="Employee discount (%)"
                    value={discount}
                    set={setDiscount}
                  />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={loyalty}
                      onChange={(e) => setLoyalty(e.target.checked)}
                    />
                    Enable points (off by default)
                  </label>
                  <Field
                    label="Spend per point earned (₱)"
                    value={earn}
                    set={setEarn}
                  />
                  <Field
                    label="Redemption value per point (₱)"
                    value={pointValue}
                    set={setPointValue}
                  />
                  <button
                    className={button}
                    disabled={
                      busy ||
                      !/^\d+(\.\d{1,2})?$/.test(tolerance) ||
                      !(Number(earn) > 0) ||
                      !(Number(pointValue) > 0) ||
                      (pin !== "" && !/^\d{6,12}$/.test(pin))
                    }
                    onClick={() =>
                      void send("policies/save", {
                        toleranceCentavos: money(tolerance),
                        loyaltyEnabled: loyalty,
                        earnPerCentavos: money(earn),
                        pointValueCentavos: money(pointValue),
                        employeeDiscountBps: Math.round(Number(discount) * 100),
                        ...(pin ? { pin } : {}),
                      })
                    }
                  >
                    Save effective register policy
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted">
                  Close the cashier session first. The PIN is never stored on
                  the phone or in an audit. Device mode switching must
                  separately be allowed in Setup → Phones.
                </p>
              </details>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
