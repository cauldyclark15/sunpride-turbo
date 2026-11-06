"use client";

import { useState } from "react";
import { useApi, useLive } from "../../lib/api";
import { Panel } from "../cockpit/kit";
import { formatAge, formatCasesPieces, formatPhp } from "../cockpit/format";
import { useVanCommand } from "./use-command";

type Quantity = {
  base: string;
  cases: number | null;
  pieces: number | null;
};
export type LoadDifferenceLine = {
  lineNumber: number;
  productCode: string;
  productName: string;
  reason: string | null;
  expected: Quantity;
  counted: Quantity;
  differenceBase: string;
  differenceCentavos: string | null;
  differs: boolean;
};
export type LoadDifference = {
  tripId: string;
  loadId: string;
  tripNumber: string;
  serviceDate: string;
  truck: string;
  sellerName: string;
  requestedAt: number | null;
  ageMinutes: number | null;
  lines: LoadDifferenceLine[];
  differenceCentavos: string;
  canDecide: boolean;
};

const key = ["van", "load-differences"] as const;
const REASON_LABEL: Record<string, string> = {
  short_loaded: "Short loaded",
  over_loaded: "Over loaded",
  damaged_at_loading: "Damaged at loading",
  wrong_item: "Wrong item",
  other: "Other",
};

/** A decision always carries a written reason. */
export function reasonGiven(reason: string | undefined) {
  return Boolean(reason && reason.trim());
}

export function quantityText(q: Quantity) {
  return q.cases === null || q.pieces === null
    ? `${q.base} units (case size not set)`
    : formatCasesPieces(q.cases, q.pieces);
}

const money = (centavos: string | null) =>
  centavos === null
    ? "No cost on file"
    : formatPhp(Number(centavos), { cents: true });

const button =
  "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50";

export function LoadDifferenceRows({
  items,
  onDecide,
  busyId = null,
}: {
  items: LoadDifference[];
  onDecide?: (
    tripId: string,
    decision: "approve" | "reject",
    reason: string,
  ) => void;
  busyId?: string | null;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  if (items.length === 0)
    return <p className="text-sm text-muted">No load differences waiting</p>;
  return (
    <div className="grid gap-3">
      {items.map((item) => {
        const reason = reasons[item.loadId];
        const blocked = !reasonGiven(reason) || busyId !== null;
        return (
          <article
            key={item.loadId}
            className="grid gap-2 border-b border-separator pb-3"
          >
            <h4 className="text-sm font-medium">
              {item.truck} · {item.sellerName} · {item.tripNumber}
            </h4>
            <p className="text-[13px] text-muted">
              {item.ageMinutes === null
                ? "Counted"
                : `Counted ${formatAge(0, item.ageMinutes * 60_000)} ago`}{" "}
              · Worth {money(item.differenceCentavos)} at cost
            </p>
            <ul className="grid gap-1 text-sm">
              {item.lines
                .filter((l) => l.differs)
                .map((l) => (
                  <li key={l.lineNumber}>
                    <span className="font-medium">{l.productName}</span>{" "}
                    <span className="font-mono text-xs text-muted">
                      {l.productCode}
                    </span>
                    <br />
                    Planned {quantityText(l.expected)} · Counted{" "}
                    {quantityText(l.counted)} ·{" "}
                    {BigInt(l.differenceBase) < 0n ? "Short" : "Over"}{" "}
                    {money(l.differenceCentavos)}
                    {l.reason ? ` · ${REASON_LABEL[l.reason] ?? l.reason}` : ""}
                  </li>
                ))}
            </ul>
            {item.canDecide && onDecide ? (
              <div className="grid gap-2">
                <label className="text-sm">
                  Reason (required)
                  <input
                    className="min-w-0 max-w-full w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                    maxLength={300}
                    value={reason ?? ""}
                    onChange={(e) =>
                      setReasons((old) => ({
                        ...old,
                        [item.loadId]: e.target.value,
                      }))
                    }
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={button}
                    disabled={blocked}
                    onClick={() =>
                      onDecide(item.tripId, "reject", reason!.trim())
                    }
                  >
                    Reject and recount
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={blocked}
                    onClick={() =>
                      onDecide(item.tripId, "approve", reason!.trim())
                    }
                  >
                    Approve
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-[13px] text-muted">
                Another supervisor decides this one
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}

/** Load differences wait in Decide; the existing `loads/approve` command settles them. */
export function LoadDifferenceReview() {
  const result = useApi<{ items: LoadDifference[] }>(
    key,
    "/api/v1/van/load-differences",
  );
  useLive(["van"], [key]);
  const decideLoad = useVanCommand<
    { tripId: string; decision: "approve" | "reject"; note: string },
    unknown
  >("/api/v1/van/loads/approve");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  async function decide(
    tripId: string,
    decision: "approve" | "reject",
    note: string,
  ) {
    setBusy(tripId);
    try {
      await decideLoad({ tripId, decision, note });
      setNotice(
        decision === "approve"
          ? "Load approved and sent to the truck"
          : "Sent back to the seller for a recount",
      );
    } catch (e) {
      setNotice(
        e instanceof Error ? e.message : "Could not record the decision",
      );
    } finally {
      setBusy(null);
    }
  }
  return (
    <Panel
      title="Load differences"
      question="Did the truck get what was planned?"
    >
      {result.error ? (
        <p role="alert">Could not load the load differences.</p>
      ) : !result.data ? (
        <p>Loading load differences…</p>
      ) : (
        <LoadDifferenceRows
          items={result.data.items}
          onDecide={(...args) => void decide(...args)}
          busyId={busy}
        />
      )}
      {notice && <p role="status">{notice}</p>}
    </Panel>
  );
}
