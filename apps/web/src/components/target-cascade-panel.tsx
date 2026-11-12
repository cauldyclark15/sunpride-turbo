"use client";
import { useRef, useState } from "react";
import { useApi, useLive, useMutate } from "../lib/api";
import { formatDate, formatPhp } from "./cockpit/format";
import { monthLabel } from "../lib/call-sheet";
import { manilaToday } from "./cockpit/period";

type Line = {
  key: string;
  label: string;
  basis: number | null;
  amount: number;
};
type Metric = { key: string; label: string; unit: string; additive: boolean };
type Cascade = {
  id: string;
  metric: string;
  productCode: string | null;
  unit: string;
  parentLevel: string;
  parentKey: string;
  parentLabel: string;
  childLevel: string;
  parentAmount: number;
  method: string;
  basisFrom: string | null;
  version: number;
  status: "submitted" | "published" | "rejected" | "superseded";
  sourceRef: string;
  contentHash: string;
  preparedBy: string;
  preparedById: string;
  /** Server says Approve/Send back would be accepted for this caller (WEB-037). */
  canDecide?: boolean;
  decidedBy: string | null;
  decisionReason: string | null;
  lines: Line[];
};
type Book = {
  month: string;
  metrics: Metric[];
  parents: Record<
    "company" | "channel" | "territory",
    { key: string; label: string }[]
  >;
  canPrepare: boolean;
  canApprove: boolean;
  /** Company/channel cascades need company-wide scope (WEB-037). */
  companyWide?: boolean;
  me: string | null;
  cascades: Cascade[];
};
type Preview = {
  childLevel: string;
  method: string;
  basisFrom: string | null;
  basisTo: string | null;
  additive: boolean;
  lines: Line[];
};

const METHOD: Record<string, string> = {
  prior_actual: "split by the prior three months' actuals",
  equal: "split evenly (no prior actuals)",
  same_rate: "same rate for every child",
  manual: "edited by hand",
};
const button =
  "min-h-10 rounded-[10px] border border-border px-3 py-2 text-sm disabled:opacity-40";

const LEVEL_LABEL = {
  company: "Company",
  channel: "Channel",
  territory: "Territory",
} as const;

/** WEB-037: parent levels this caller may cascade. */
export function allowedLevels(d: {
  companyWide?: boolean;
}): ("company" | "channel" | "territory")[] {
  return d.companyWide === false
    ? ["territory"]
    : ["company", "channel", "territory"];
}

/** WEB-037: show Approve/Send back only when the server would accept them. */
export function canDecide(
  d: { canApprove: boolean; me: string | null },
  c: { preparedById: string; canDecide?: boolean },
) {
  return c.canDecide ?? (d.canApprove && c.preparedById !== d.me);
}

/** F-615: display a target amount in the metric's own unit. */
export function formatAmount(metric: string, n: number | null) {
  if (n == null) return "—";
  // Centavos shown so displayed children add up exactly to the displayed parent.
  if (metric === "sales_value") return formatPhp(n, { cents: true });
  if (metric === "msl_compliance") return `${(n / 100).toFixed(1)}%`;
  return n.toLocaleString("en-PH");
}
/** F-615: parse the parent entry in the unit people type (pesos, percent or whole counts). */
export function parseAmount(metric: string, text: string): number | null {
  const t = text.replace(/[,₱%\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  if (metric === "sales_value") return Math.round(v * 100);
  if (metric === "msl_compliance") return v > 100 ? null : Math.round(v * 100);
  return Number.isInteger(v) ? v : null;
}
/** F-615: reconciliation the preparer sees before submitting. */
export function reconciliation(
  metric: string,
  additive: boolean,
  parent: number,
  lines: Line[],
) {
  if (!additive)
    return lines.every((l) => l.amount >= 0 && l.amount <= 10000)
      ? {
          ok: true,
          text: "Each child carries its own rate; rates are not summed.",
        }
      : { ok: false, text: "A rate cannot exceed 100%." };
  const total = lines.reduce((a, l) => a + l.amount, 0),
    diff = parent - total;
  return diff === 0
    ? { ok: true, text: "Children add up exactly to the parent." }
    : {
        ok: false,
        text: `Children are ${formatAmount(metric, Math.abs(diff))} ${diff > 0 ? "short of" : "over"} the parent.`,
      };
}

/** F-615: allocate a parent target to its whole team, reconcile, submit, and publish by a second person. */
export function TargetCascadePanel() {
  const [month, setMonth] = useState(() => {
    const d = new Date(manilaToday() + "T00:00:00Z");
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
      .toISOString()
      .slice(0, 7);
  });
  const data = useApi<Book>(
    ["targets", "cascade", month],
    `/api/v1/targets/cascade?month=${month}`,
  );
  useLive(["analytics"], [["targets"]]);
  const { mutate } = useMutate();
  const keys = useRef(new Map<string, string>());
  const [metric, setMetric] = useState("sales_value"),
    [chosenLevel, setLevel] = useState<"company" | "channel" | "territory">(
      "company",
    ),
    [chosenParentKey, setParentKey] = useState("company"),
    [amountText, setAmountText] = useState(""),
    [product, setProduct] = useState(""),
    [source, setSource] = useState(
      "SAMPLE plan — replace with Sunpride's approved budget",
    ),
    [preview, setPreview] = useState<
      (Preview & { parentAmount: number }) | null
    >(null),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function post<T>(
    path: string,
    body: object,
    keyed = false,
  ): Promise<T | null> {
    let payload: object = body;
    if (keyed) {
      const intent = JSON.stringify({ path, body });
      let key = keys.current.get(intent);
      if (!key) {
        key = crypto.randomUUID();
        keys.current.set(intent, key);
      }
      payload = { ...body, idempotencyKey: key };
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      return await mutate<T>(path, payload, { invalidate: [["targets"]] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      return null;
    } finally {
      setBusy(false);
    }
  }
  if (data.error)
    return <p role="alert">Target cascades could not be loaded.</p>;
  if (!data.data) return <p>Loading target cascades…</p>;
  const d = data.data;
  const levels = allowedLevels(d);
  const level = levels.includes(chosenLevel) ? chosenLevel : levels[0]!;
  const parentKey =
    level === chosenLevel ? chosenParentKey : (d.parents[level][0]?.key ?? "");
  const parentAmount = parseAmount(metric, amountText);
  const identity = {
    month,
    metric,
    parentLevel: level,
    parentKey,
    parentAmount,
    ...(metric === "volume" ? { productCode: product.trim() } : {}),
  };
  const check = preview
    ? reconciliation(
        metric,
        preview.additive,
        preview.parentAmount,
        preview.lines,
      )
    : null;
  const waiting = d.cascades.filter((c) => c.status === "submitted");
  const published = d.cascades.filter((c) => c.status === "published");
  const history = d.cascades.filter(
    (c) => c.status === "rejected" || c.status === "superseded",
  );
  const label = (m: string) => d.metrics.find((x) => x.key === m)?.label ?? m;
  return (
    <section
      aria-label="Target cascade"
      className="grid gap-4 rounded-xl border border-border p-4"
    >
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">
            Does every team&apos;s target add up to the company plan?
          </h2>
          <p className="text-sm text-muted">
            Allocate one target to the whole team below it, check it reconciles,
            then a second person publishes it. Sales value publishes into the
            target book every screen uses.
          </p>
        </div>
        <label className="grid gap-1 text-sm">
          Month
          <input
            type="month"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              setPreview(null);
            }}
          />
        </label>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {waiting.length > 0 && (
        <section aria-label="Waiting for approval" className="grid gap-3">
          <h3 className="font-medium">
            Waiting for approval ({waiting.length})
          </h3>
          {waiting.map((c) => (
            <article key={c.id} className="rounded-xl border border-border p-3">
              <p className="text-sm font-medium">
                {label(c.metric)}
                {c.productCode ? ` · ${c.productCode}` : ""} · {c.parentLabel}:{" "}
                {formatAmount(c.metric, c.parentAmount)} · version {c.version}
              </p>
              <p className="text-xs text-muted">
                Prepared by {c.preparedBy}; {METHOD[c.method]}
                {c.basisFrom ? ` from ${c.basisFrom}` : ""}. Source:{" "}
                {c.sourceRef}
              </p>
              <CascadeTable cascade={c} />
              {canDecide(d, c) ? (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <button
                    className={button}
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await post("/api/v1/targets/cascade/decide", {
                          cascadeId: c.id,
                          decision: "approve",
                          contentHash: c.contentHash,
                        })
                      )
                        setNotice(
                          "Published. The new targets apply from the start of the month.",
                        );
                    }}
                  >
                    Approve and publish
                  </button>
                  <label className="grid gap-1 text-sm">
                    Reason to send back
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <button
                    className={button}
                    disabled={busy || !reason.trim()}
                    onClick={async () => {
                      if (
                        await post("/api/v1/targets/cascade/decide", {
                          cascadeId: c.id,
                          decision: "reject",
                          reason,
                          contentHash: c.contentHash,
                        })
                      ) {
                        setReason("");
                        setNotice("Sent back to the preparer.");
                      }
                    }}
                  >
                    Send back
                  </button>
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted">
                  {c.preparedById === d.me
                    ? "A different person must approve your cascade."
                    : d.canApprove
                      ? "A company-wide manager or approver decides this cascade."
                      : "Awaiting a manager or approver."}
                </p>
              )}
            </article>
          ))}
        </section>
      )}
      <section aria-label="Published targets" className="grid gap-3">
        <h3 className="font-medium">
          Published for {monthLabel(month)} · applies from{" "}
          {formatDate(`${month}-01`)}
        </h3>
        {published.length === 0 && (
          <p className="text-sm">Nothing published for this month yet.</p>
        )}
        {published.map((c) => (
          <article key={c.id} className="rounded-xl border border-border p-3">
            <p className="text-sm font-medium">
              {label(c.metric)}
              {c.productCode ? ` · ${c.productCode}` : ""} · {c.parentLabel}:{" "}
              {formatAmount(c.metric, c.parentAmount)} · version {c.version},
              approved by {c.decidedBy}
            </p>
            <CascadeTable cascade={c} />
          </article>
        ))}
      </section>
      {d.canPrepare && (
        <form
          aria-label="Prepare a cascade"
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (parentAmount == null) return;
            const p = await post<Preview>(
              "/api/v1/targets/cascade/preview",
              identity,
            );
            if (p) setPreview({ ...p, parentAmount });
          }}
        >
          <h3 className="font-medium">Prepare a cascade</h3>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="grid gap-1 text-sm">
              Measure
              <select
                value={metric}
                onChange={(e) => {
                  setMetric(e.target.value);
                  setPreview(null);
                }}
              >
                {d.metrics.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Parent level
              <select
                value={level}
                onChange={(e) => {
                  const v = e.target.value as typeof level;
                  setLevel(v);
                  setParentKey(d.parents[v][0]?.key ?? "");
                  setPreview(null);
                }}
              >
                {levels.map((v) => (
                  <option key={v} value={v}>
                    {LEVEL_LABEL[v]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Parent
              <select
                value={parentKey}
                onChange={(e) => {
                  setParentKey(e.target.value);
                  setPreview(null);
                }}
              >
                {d.parents[level].map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {metric === "volume" && (
              <label className="grid gap-1 text-sm">
                Product code
                <input
                  required
                  value={product}
                  onChange={(e) => {
                    setProduct(e.target.value);
                    setPreview(null);
                  }}
                />
              </label>
            )}
            <label className="grid gap-1 text-sm">
              Parent target{" "}
              {metric === "sales_value"
                ? "(₱)"
                : metric === "msl_compliance"
                  ? "(%)"
                  : ""}
              <input
                inputMode="decimal"
                required
                value={amountText}
                onChange={(e) => {
                  setAmountText(e.target.value);
                  setPreview(null);
                }}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Source / assumption
              <input
                required
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            </label>
          </div>
          <button
            className={button}
            disabled={busy || parentAmount == null || !parentKey}
          >
            Preview allocation
          </button>
          {preview && check && (
            <div className="grid gap-2">
              <p className="text-sm">
                {preview.lines.length}{" "}
                {preview.childLevel === "agent"
                  ? "agents"
                  : preview.childLevel === "territory"
                    ? "territories"
                    : "channels"}
                , {METHOD[preview.method]}
                {preview.basisFrom
                  ? ` (${preview.basisFrom} to ${preview.basisTo})`
                  : ""}
                . Edit any child; the total must still match.
              </p>
              <table aria-label="Allocation preview" className="text-sm">
                <thead>
                  <tr>
                    <th className="text-left">Child</th>
                    <th className="text-right">Prior actual</th>
                    <th className="text-right">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((l, i) => (
                    <tr key={l.key}>
                      <td>{l.label}</td>
                      <td className="text-right tabular-nums">
                        {formatAmount(metric, l.basis)}
                      </td>
                      <td className="text-right">
                        <input
                          key={`${preview.method}:${l.key}`}
                          aria-label={`Target for ${l.label}`}
                          className="w-36 text-right tabular-nums"
                          defaultValue={
                            metric === "sales_value" ||
                            metric === "msl_compliance"
                              ? (l.amount / 100).toFixed(2)
                              : String(l.amount)
                          }
                          onChange={(e) => {
                            const v = parseAmount(metric, e.target.value);
                            if (v == null) return;
                            setPreview({
                              ...preview,
                              lines: preview.lines.map((x, j) =>
                                j === i ? { ...x, amount: v } : x,
                              ),
                            });
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p
                role="status"
                className={check.ok ? "text-sm" : "text-sm font-medium"}
              >
                {check.text}
              </p>
              <button
                type="button"
                className={button}
                disabled={busy || !check.ok}
                onClick={async () => {
                  const r = await post<{ version: number }>(
                    "/api/v1/targets/cascade/submit",
                    {
                      ...identity,
                      sourceRef: source,
                      method: preview.method,
                      lines: preview.lines.map((l) => ({
                        key: l.key,
                        amount: l.amount,
                      })),
                    },
                    true,
                  );
                  if (r) {
                    setPreview(null);
                    setNotice(`Version ${r.version} sent for approval.`);
                  }
                }}
              >
                Submit for approval
              </button>
            </div>
          )}
        </form>
      )}
      {history.length > 0 && (
        <details>
          <summary className="text-sm">
            Earlier versions ({history.length})
          </summary>
          <ul className="text-sm">
            {history.map((c) => (
              <li key={c.id}>
                {label(c.metric)} · {c.parentLabel} · version {c.version}:{" "}
                {c.status === "rejected"
                  ? `sent back by ${c.decidedBy} — ${c.decisionReason}`
                  : "replaced by a later version"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function CascadeTable({ cascade }: { cascade: Cascade }) {
  const total = cascade.lines.reduce((a, l) => a + l.amount, 0);
  return (
    <table className="mt-2 w-full text-sm">
      <thead>
        <tr>
          <th className="text-left">
            {cascade.childLevel === "agent"
              ? "Agent"
              : cascade.childLevel === "territory"
                ? "Territory"
                : "Channel"}
          </th>
          <th className="text-right">Prior actual</th>
          <th className="text-right">Target</th>
        </tr>
      </thead>
      <tbody>
        {cascade.lines.map((l) => (
          <tr key={l.key}>
            <td>{l.label}</td>
            <td className="text-right tabular-nums">
              {formatAmount(cascade.metric, l.basis)}
            </td>
            <td className="text-right tabular-nums">
              {formatAmount(cascade.metric, l.amount)}
            </td>
          </tr>
        ))}
      </tbody>
      {cascade.metric !== "msl_compliance" && (
        <tfoot>
          <tr>
            <td>Total</td>
            <td />
            <td className="text-right tabular-nums">
              {formatAmount(cascade.metric, total)}
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}
