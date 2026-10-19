"use client";

import { Button, Input } from "@heroui/react";
import {
  Card,
  FormField,
  MetricCard,
  Notice,
  PageHeader,
  UnderlineTabs,
} from "@sunpride/ui";
import Link from "next/link";
import { useRef, useState } from "react";
import { apiFetch, useApi, useApiPages, useLive, useMutate } from "../lib/api";
import { usePermissions } from "../lib/auth";
import { NegativeStockPanel } from "./negative-stock-panel";

export type StockQuantity = {
  base: number;
  cases: number | null;
  pieces: number | null;
  display: string;
  valueCentavos: number | null;
};
export type StockUnits = {
  basePerCase: number | null;
  basePerPiece: number | null;
  baseCode: string;
  scale: number;
};
type Product = {
  id: string;
  code: string;
  name: string;
  tracking: string;
  units: StockUnits;
};
type Location = {
  id: string;
  _id: string;
  code: string;
  name: string;
  type: string;
  active: boolean;
};
type Row = {
  productId: string;
  code: string;
  name: string;
  locationId: string;
  locationName: string;
  locationType: string;
  kind: string;
  onHand: StockQuantity;
  available: StockQuantity;
  reserved: StockQuantity;
  hold: StockQuantity;
  valueCentavos: number | null;
  prior: StockQuantity;
  daysCover: number | null;
  target: StockQuantity | null;
  status: string;
  units: StockUnits;
};
type Overview = {
  asOf: number;
  valuation: string;
  locations: {
    id: string;
    name: string;
    type: string;
    kind: string;
    valueCentavos: number | null;
    priorValueCentavos: number | null;
    out: number;
    low: number;
  }[];
  rows: Row[];
  out: Row[];
  low: Row[];
  nearExpiry: {
    id: string;
    productId: string;
    name: string;
    locationName: string;
    lotNumber: string;
    expiresAt: number;
    quantity: StockQuantity;
  }[];
  trend: { date: string; valueCentavos: number | null }[];
  summary: {
    valueCentavos: number | null;
    priorValueCentavos: number | null;
    outAtDepot: number;
    low: number;
    nearExpiry: number;
    unknownPrices: number;
    policiesMissing: number;
  };
};
type Doc = {
  id: string;
  number: string;
  status: string;
  locations: string[];
  canApprove: boolean;
  requestedBy: string | null;
};
type Count = {
  session: { id: string; status: string; createdBy: string };
  canApprove: boolean;
  lines: {
    id: string;
    productId: string;
    code: string;
    name: string;
    stockStatus: string;
    lotNumber?: string;
    counted: StockQuantity | null;
    expected?: StockQuantity;
    variance?: StockQuantity | null;
  }[];
};
type StockLot = {
  id: string;
  lotId: string;
  productId: string;
  locationId: string;
  lotNumber: string;
  stockStatus: string;
  onHand: StockQuantity;
};
type Movement = {
  id: string;
  number: string;
  kind: string;
  at: number;
  lines: {
    id: string;
    name: string;
    quantity: StockQuantity;
    from: string | null;
    to: string | null;
  }[];
};
type Trace = {
  movement: Movement;
  allocations: { id: string; lotNumber: string; quantity: StockQuantity }[];
  ledger: {
    id: string;
    locationId: string;
    status: string;
    delta: StockQuantity;
    reservedDelta: StockQuantity;
    after: StockQuantity;
    balanceVersion: number;
  }[];
};
const tabs = [
  ["stock", "Overview"],
  ["receiving", "Receiving"],
  ["transfers", "Transfers"],
  ["counts", "Stock counts"],
  ["controls", "Adjustments"],
  ["ledger", "Movements"],
] as const;
type Tab = (typeof tabs)[number][0];
const fieldClass =
  "h-10 w-full rounded-[10px] border border-field-border bg-field-background px-3 text-sm";
const tableClass =
  "w-full min-w-[720px] text-left text-sm [&_th]:border-b [&_th]:border-separator [&_th]:px-3 [&_th]:py-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted [&_td]:border-b [&_td]:border-separator [&_td]:px-3 [&_td]:py-3";
export const stockMoney = (v: number | null | undefined) =>
  v == null
    ? "Unknown"
    : new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
      }).format(v / 100);
const label = (s: string) =>
  s.replaceAll("_", " ").replace(/^./, (v) => v.toUpperCase());
/** Converts the catalog's cases + pieces to integer base units; never multiplies by a guessed 1000. */
export function enteredStockQuantity(
  cases: string,
  pieces: string,
  units: StockUnits,
  allowZero = false,
) {
  if (!/^\d*$/.test(cases) || !/^\d*(\.\d+)?$/.test(pieces))
    throw new Error("Enter non-negative cases and pieces");
  if (Number(cases) && !units.basePerCase)
    throw new Error("Set up the case conversion first");
  if (Number(pieces) && !units.basePerPiece)
    throw new Error("Set up the piece conversion first");
  const base =
    Number(cases || 0) * (units.basePerCase ?? 0) +
    Number(pieces || 0) * (units.basePerPiece ?? 0);
  if (!Number.isSafeInteger(base) || base < (allowZero ? 0 : 1))
    throw new Error("Enter a whole base quantity within the product's units");
  return base;
}
function Picker({
  label: caption,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  options: { id: string; name: string }[];
}) {
  return (
    <FormField label={caption}>
      <select
        aria-label={caption}
        className={fieldClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose {caption.toLowerCase()}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </FormField>
  );
}
function Amount({ q }: { q: StockQuantity }) {
  return (
    <span className="tabular-nums">
      {q.display}
      <small className="block text-xs text-muted">
        {stockMoney(q.valueCentavos)}
      </small>
    </span>
  );
}

export function InventoryWorkspace({ setupMessage }: { setupMessage: string }) {
  void setupMessage;
  const [tab, setTab] = useState<Tab>("stock"),
    [locationId, setLocationId] = useState(""),
    [productId, setProductId] = useState(""),
    [traceId, setTraceId] = useState(""),
    [countId, setCountId] = useState("");
  const [cases, setCases] = useState(""),
    [pieces, setPieces] = useState(""),
    [source, setSource] = useState(""),
    [destination, setDestination] = useState(""),
    [lotNumber, setLotNumber] = useState(""),
    [expires, setExpires] = useState(""),
    [reason, setReason] = useState(""),
    [subtract, setSubtract] = useState(true);
  const [counts, setCounts] = useState<
      Record<string, { cases: string; pieces: string }>
    >({}),
    [notice, setNotice] = useState<string | null>(null),
    [success, setSuccess] = useState<string | null>(null);
  const [reorderCases, setReorderCases] = useState(""),
    [targetCases, setTargetCases] = useState("");
  const { can } = usePermissions();
  const write = useMutate();
  const intents = useRef(new Map<string, string>());
  const locations = useApi<Location[]>(
    ["inventory", "locations"],
    "/api/v1/inventory/locations",
  );
  const products = useApi<Product[]>(
    ["inventory", "products"],
    "/api/v1/inventory/products",
  );
  const overview = useApi<Overview>(
    ["inventory", "overview", locationId],
    ({ signal }) =>
      apiFetch("/api/v1/inventory/overview", {
        signal,
        query: { locationId: locationId || undefined },
      }),
  );
  const queueKind =
    tab === "receiving"
      ? "receipts"
      : tab === "transfers"
        ? "transfers"
        : tab === "counts"
          ? "counts"
          : tab === "controls"
            ? "adjustments"
            : null;
  const queue = useApiPages<Doc>(
    queueKind ? ["inventory", queueKind] : null,
    (cursor, { signal }) =>
      apiFetch(`/api/v1/inventory/${queueKind}`, {
        signal,
        query: { cursor: cursor ?? undefined },
      }),
  );
  const detail = useApi<Count>(
    countId ? ["inventory", "count", countId] : null,
    ({ signal }) =>
      apiFetch("/api/v1/inventory/counts/detail", {
        signal,
        query: { sessionId: countId },
      }),
  );
  const moves = useApiPages<Movement>(
    tab === "ledger" || productId
      ? ["inventory", "movements", productId]
      : null,
    (cursor, { signal }) =>
      apiFetch("/api/v1/inventory/movements", {
        signal,
        query: {
          cursor: cursor ?? undefined,
          productId: productId || undefined,
        },
      }),
  );
  const trace = useApi<Trace>(
    traceId ? ["inventory", "trace", traceId] : null,
    ({ signal }) =>
      apiFetch("/api/v1/inventory/trace", {
        signal,
        query: { movementId: traceId },
      }),
  );
  const lots = useApi<StockLot[]>(
    tab === "controls" && productId ? ["inventory", "lots", productId] : null,
    ({ signal }) =>
      apiFetch("/api/v1/inventory/lots", { signal, query: { productId } }),
  );
  useLive(["inventory"], [["inventory"]]);
  const selected = products.data?.find((p) => p.id === productId),
    data = overview.data;
  const stocks = (data?.rows ?? []).filter(
    (r) => !productId || r.productId === productId,
  );
  const locationOptions = (locations.data ?? []).filter(
    (l) => l.active && l.type !== "virtual_boundary",
  );
  const transit = locationOptions.find((l) => l.type === "in_transit");
  async function run(
    action: string,
    body: Record<string, unknown>,
    done = "Saved",
  ) {
    if (write.pending) return;
    const fingerprint = JSON.stringify([action, body]);
    let key = intents.current.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      intents.current.set(fingerprint, key);
    }
    try {
      await write.mutate(
        `/api/v1/inventory/${action}`,
        { ...body, idempotencyKey: key },
        { invalidate: [["inventory"]] },
      );
      intents.current.delete(fingerprint);
      setNotice(null);
      setSuccess(done);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Action failed. Try again.");
    }
  }
  function withQuantity(action: (base: number) => void) {
    try {
      if (!selected) throw new Error("Choose a product");
      action(enteredStockQuantity(cases, pieces, selected.units));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Check the quantity");
    }
  }
  function focus(row: Row, next: Tab) {
    setLocationId(row.locationId);
    setSource(row.locationId);
    setDestination(row.locationId);
    setProductId(row.productId);
    setTab(next);
  }
  function rowActions(row: Row) {
    return (
      <div className="flex gap-2">
        {can("inventory.write") ? (
          <Button
            size="sm"
            variant="outline"
            onPress={() => focus(row, "transfers")}
          >
            Transfer
          </Button>
        ) : null}
        {can("inventory.count.submit") ? (
          <Button
            size="sm"
            variant="outline"
            onPress={() => focus(row, "counts")}
          >
            Count
          </Button>
        ) : null}
        {can("inventory.adjustment.request") ? (
          <Button
            size="sm"
            variant="outline"
            onPress={() => focus(row, "controls")}
          >
            Adjust
          </Button>
        ) : null}
      </div>
    );
  }
  function exportRows() {
    const escape = (v: string) =>
      `"${(/^[=+@\-\t\r]/.test(v) ? "'" : "") + v.replaceAll('"', '""')}"`;
    const csv =
      "\uFEFF" +
      [
        [
          "Product",
          "Location",
          "On hand",
          "Available",
          "Value PHP",
          "Cover days",
        ],
        ...stocks.map((r) => [
          r.name,
          r.locationName,
          r.onHand.display,
          r.available.display,
          r.valueCentavos == null ? "Unknown" : String(r.valueCentavos / 100),
          r.daysCover == null ? "Unknown" : r.daysCover.toFixed(1),
        ]),
      ]
        .map((row) => row.map(escape).join(","))
        .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "stock-by-location.csv";
    a.click();
    URL.revokeObjectURL(url);
  }
  const quantityFields = (
    <div className="grid grid-cols-2 gap-3">
      <FormField label="Cases">
        <Input
          className={fieldClass}
          aria-label="Cases"
          value={cases}
          onChange={(e) => setCases(e.target.value)}
          disabled={!selected?.units.basePerCase}
        />
      </FormField>
      <FormField label="Pieces">
        <Input
          className={fieldClass}
          aria-label="Pieces"
          value={pieces}
          onChange={(e) => setPieces(e.target.value)}
          disabled={!selected?.units.basePerPiece}
        />
      </FormField>
    </div>
  );
  return (
    <div className="grid gap-4">
      <PageHeader
        title="Inventory"
        meta="Is the right stock in the right place?"
      />
      {notice ? <Notice title={notice} tone="danger" /> : null}
      {success ? (
        <p role="status" className="text-sm">
          {success}
        </p>
      ) : null}
      {overview.error ? (
        <Notice title={overview.error.message} tone="danger" />
      ) : null}
      {!data && !overview.error ? <p>Loading stock…</p> : null}
      {locations.data?.length === 0 || products.data?.length === 0 ? (
        <Notice
          title="Inventory is not set up yet. Ask your administrator."
          meta={<Link href="/admin">Set up locations and catalog</Link>}
        />
      ) : null}
      <UnderlineTabs
        items={tabs}
        activeId={tab}
        onChange={setTab}
        label="Inventory sections"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Picker
          label="Location"
          value={locationId}
          onChange={setLocationId}
          options={locationOptions}
        />
        <Picker
          label="Product"
          value={productId}
          onChange={setProductId}
          options={products.data ?? []}
        />
      </div>
      {tab === "stock" && data ? (
        <>
          <section
            aria-label="Stock exceptions"
            className="grid gap-3 md:grid-cols-3"
          >
            <Card label="Out at depot">
              <p className="text-2xl tabular-nums">{data.summary.outAtDepot}</p>
              <p className="text-sm text-muted">
                Products needing stock, not a count of empty balance rows.
              </p>
              {data.out
                .filter((r) => r.kind === "depot")
                .slice(0, 5)
                .map((r) => (
                  <div key={`${r.productId}:${r.locationId}`} className="my-3">
                    <button
                      className="text-sm underline"
                      onClick={() => setProductId(r.productId)}
                    >
                      {r.name} · {r.locationName}
                    </button>
                    {rowActions(r)}
                  </div>
                ))}
            </Card>
            <Card label="Low stock">
              <p className="text-2xl tabular-nums">{data.summary.low}</p>
              {data.low.slice(0, 5).map((r) => (
                <div key={`${r.productId}:${r.locationId}`} className="my-3">
                  <p>
                    {r.name} · {r.locationName}
                  </p>
                  <Amount q={r.available} />
                  {rowActions(r)}
                </div>
              ))}
              {data.summary.policiesMissing ? (
                <p className="text-sm text-muted">
                  {data.summary.policiesMissing} product/location targets need
                  setup.
                </p>
              ) : null}
            </Card>
            <Card label="Near expiry">
              <p className="text-2xl tabular-nums">{data.summary.nearExpiry}</p>
              <p className="text-sm text-muted">
                Next 30 days · count and inspect before moving.
              </p>
              {data.nearExpiry.slice(0, 5).map((r) => (
                <div key={r.id} className="my-3">
                  <button
                    className="underline"
                    onClick={() => {
                      setProductId(r.productId);
                      setTab("counts");
                    }}
                  >
                    {r.name} · {r.locationName}
                  </button>
                  <p className="text-xs text-muted">
                    Lot {r.lotNumber} ·{" "}
                    {new Date(r.expiresAt).toLocaleDateString("en-PH", {
                      timeZone: "Asia/Manila",
                    })}
                  </p>
                  <Amount q={r.quantity} />
                </div>
              ))}
            </Card>
          </section>
          <div className="grid gap-4 md:grid-cols-3">
            <MetricCard
              label="Stock selling value"
              value={stockMoney(data.summary.valueCentavos)}
              detail={`28 days ago: ${stockMoney(data.summary.priorValueCentavos)}`}
            />
            <MetricCard
              label="Locations configured"
              value={String(locations.data?.length ?? 0)}
              detail="Depot, trucks and goods on the road"
            />
            <MetricCard
              label="Price setup"
              value={
                data.summary.unknownPrices
                  ? `${data.summary.unknownPrices} unknown`
                  : "Available"
              }
              detail="Default price list · not accounting cost"
            />
          </div>
          <Card label="Value by location">
            <div className="grid gap-3 md:grid-cols-3">
              {data.locations.map((l) => (
                <button
                  key={l.id}
                  className="rounded-lg border border-separator p-4 text-left"
                  onClick={() => setLocationId(l.id)}
                >
                  <span className="block font-medium">
                    {l.name} · {label(l.kind)}
                  </span>
                  <span className="block tabular-nums">
                    {stockMoney(l.valueCentavos)}
                  </span>
                  <small className="text-muted">
                    28 days ago {stockMoney(l.priorValueCentavos)} · {l.out} out
                    · {l.low} low
                  </small>
                </button>
              ))}
            </div>
          </Card>
          <Card label="Stock value trend · last 14 days">
            <div
              className="flex h-28 items-end gap-1"
              role="img"
              aria-label="Stock value over the last 14 days"
            >
              {data.trend.map((d) => {
                const maximum = Math.max(
                  1,
                  ...data.trend.map((t) => t.valueCentavos ?? 0),
                );
                return (
                  <div
                    key={d.date}
                    className="flex-1 bg-foreground/70"
                    style={{
                      height:
                        d.valueCentavos == null
                          ? 2
                          : Math.max(2, (d.valueCentavos / maximum) * 100) +
                            "%",
                    }}
                    title={`${d.date}: ${stockMoney(d.valueCentavos)}`}
                  />
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted">
              Reconstructed from the ledger at today's default prices. Unknown
              price is not zero.
            </p>
          </Card>
          <Card
            label="Stock by location"
            actions={
              <div className="flex gap-2">
                <Button variant="outline" onPress={exportRows}>
                  Export CSV
                </Button>
                <Button variant="outline" onPress={() => window.print()}>
                  Print
                </Button>
              </div>
            }
          >
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th>Product / location</th>
                    <th>On hand</th>
                    <th>Available / reserved</th>
                    <th>Value</th>
                    <th>Cover / target</th>
                    <th>Next action</th>
                  </tr>
                </thead>
                <tbody>
                  {stocks.map((r) => (
                    <tr key={`${r.productId}:${r.locationId}`}>
                      <td>
                        <button
                          className="text-left font-medium underline"
                          onClick={() => {
                            setProductId(r.productId);
                            setTab("ledger");
                          }}
                        >
                          {r.name}
                        </button>
                        <small className="block text-muted">
                          {r.code} · {r.locationName} · {label(r.locationType)}
                        </small>
                      </td>
                      <td>
                        <Amount q={r.onHand} />
                      </td>
                      <td>
                        <Amount q={r.available} />
                        <small>Reserved {r.reserved.display}</small>
                      </td>
                      <td className="text-right tabular-nums">
                        {stockMoney(r.valueCentavos)}
                      </td>
                      <td>
                        {r.daysCover == null
                          ? "Unknown demand"
                          : `${r.daysCover.toFixed(1)} days`}
                        <small className="block text-muted">
                          {r.target
                            ? `Target ${r.target.display}`
                            : "Target needs setup"}
                        </small>
                        <small className="block text-muted">
                          28 days ago {r.prior.display}
                        </small>
                      </td>
                      <td>{rowActions(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {stocks.length === 0 ? (
                <p className="p-4 text-sm text-muted">No stock yet</p>
              ) : null}
            </div>
            <p className="mt-3 text-xs text-muted">
              Cover uses the last 28 days of issues and POS sales, not
              transfers. Updated{" "}
              {new Date(data.asOf).toLocaleString("en-PH", {
                timeZone: "Asia/Manila",
              })}
              .
            </p>
          </Card>
        </>
      ) : null}
      {tab === "receiving" ? (
        <Card label="Receive stock">
          {can("inventory.write") ? (
            <div className="grid max-w-xl gap-3">
              <Picker
                label="Receiving location"
                value={destination}
                onChange={setDestination}
                options={locationOptions}
              />
              {quantityFields}
              <FormField label="Lot number">
                <Input
                  className={fieldClass}
                  value={lotNumber}
                  onChange={(e) => setLotNumber(e.target.value)}
                />
              </FormField>
              <FormField label="Expiry date">
                <Input
                  type="date"
                  className={fieldClass}
                  value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                />
              </FormField>
              <Button
                isPending={write.pending}
                onPress={() =>
                  withQuantity(
                    (base) =>
                      void run(
                        "receipts/post",
                        {
                          receivingLocationId: destination,
                          receiptType: "unplanned",
                          lines: [
                            {
                              productId,
                              quantityBase: base,
                              ...(lotNumber ? { lotNumber } : {}),
                              ...(expires
                                ? {
                                    expiresAt: new Date(
                                      `${expires}T00:00:00+08:00`,
                                    ).getTime(),
                                  }
                                : {}),
                            },
                          ],
                        },
                        "Receipt posted",
                      ),
                  )
                }
              >
                Post receipt
              </Button>
            </div>
          ) : (
            <p>Stock receiving is read-only for your role.</p>
          )}
        </Card>
      ) : null}
      {tab === "transfers" ? (
        <Card label="New transfer">
          {can("inventory.write") ? (
            <div className="grid max-w-xl gap-3">
              <Picker
                label="Source location"
                value={source}
                onChange={setSource}
                options={locationOptions.filter((l) => l.type !== "in_transit")}
              />
              <Picker
                label="Destination location"
                value={destination}
                onChange={setDestination}
                options={locationOptions.filter((l) => l.type !== "in_transit")}
              />
              {quantityFields}
              {!transit ? <p>Set up an in-transit location first.</p> : null}
              <Button
                isDisabled={!transit}
                isPending={write.pending}
                onPress={() =>
                  withQuantity(
                    (base) =>
                      void run(
                        "transfers/request",
                        {
                          sourceLocationId: source,
                          destinationLocationId: destination,
                          inTransitLocationId: transit?.id,
                          lines: [{ productId, quantityBase: base }],
                        },
                        "Transfer requested",
                      ),
                  )
                }
              >
                Request transfer
              </Button>
            </div>
          ) : (
            <p>Transfers are read-only for your role.</p>
          )}
        </Card>
      ) : null}
      {tab === "counts" ? (
        <Card label="Blind stock count">
          {can("inventory.count.submit") ? (
            <div className="flex flex-wrap gap-2">
              {locationOptions
                .filter((l) => !locationId || l.id === locationId)
                .map((l) => (
                  <Button
                    key={l.id}
                    variant="outline"
                    isPending={write.pending}
                    onPress={() =>
                      void run(
                        "counts/start",
                        {
                          locationId: l.id,
                          blindCount: true,
                          countType: "cycle",
                        },
                        "Count started",
                      )
                    }
                  >
                    Count {l.name}
                  </Button>
                ))}
            </div>
          ) : null}
          {detail.error ? (
            <Notice title={detail.error.message} tone="danger" />
          ) : null}
          {detail.data ? (
            <div className="mt-4 grid gap-3">
              {detail.data.lines.map((l) => {
                const units = products.data?.find(
                  (p) => p.id === l.productId,
                )?.units;
                return (
                  <div
                    key={l.id}
                    className="grid gap-3 border-b border-separator py-3 sm:grid-cols-[1fr_100px_100px]"
                  >
                    <div>
                      <p>
                        {l.name} · {label(l.stockStatus)}
                      </p>
                      <small>
                        {l.lotNumber ? `Lot ${l.lotNumber} · ` : ""}
                        {l.expected
                          ? `Expected ${l.expected.display} · ${stockMoney(l.expected.valueCentavos)}`
                          : "Blind count · expected stock hidden"}
                      </small>
                      {l.variance ? (
                        <p>
                          Variance <Amount q={l.variance} />
                        </p>
                      ) : null}
                      {l.counted ? (
                        <p>
                          Counted <Amount q={l.counted} />
                        </p>
                      ) : null}
                    </div>
                    {detail.data?.session.status === "counting" &&
                    can("inventory.count.submit") ? (
                      <>
                        <FormField label={`Cases · ${l.code}`}>
                          <Input
                            aria-label={`Count cases ${l.code}`}
                            className={fieldClass}
                            disabled={!units?.basePerCase}
                            value={counts[l.id]?.cases ?? ""}
                            onChange={(e) =>
                              setCounts({
                                ...counts,
                                [l.id]: {
                                  pieces: counts[l.id]?.pieces ?? "",
                                  cases: e.target.value,
                                },
                              })
                            }
                          />
                        </FormField>
                        <FormField label={`Pieces · ${l.code}`}>
                          <Input
                            aria-label={`Count pieces ${l.code}`}
                            className={fieldClass}
                            disabled={!units?.basePerPiece}
                            value={counts[l.id]?.pieces ?? ""}
                            onChange={(e) =>
                              setCounts({
                                ...counts,
                                [l.id]: {
                                  cases: counts[l.id]?.cases ?? "",
                                  pieces: e.target.value,
                                },
                              })
                            }
                          />
                        </FormField>
                      </>
                    ) : null}
                  </div>
                );
              })}
              {detail.data.session.status === "counting" &&
              can("inventory.count.submit") ? (
                <Button
                  isPending={write.pending}
                  onPress={() => {
                    try {
                      const ls = detail.data!.lines.map((l) => {
                        const units = products.data?.find(
                          (p) => p.id === l.productId,
                        )?.units;
                        if (!units) throw new Error("Product units need setup");
                        const entered = counts[l.id];
                        if (!entered || (!entered.cases && !entered.pieces))
                          throw new Error("Enter every count, including zero");
                        return {
                          lineId: l.id,
                          countedBase: enteredStockQuantity(
                            entered.cases,
                            entered.pieces,
                            units,
                            true,
                          ),
                        };
                      });
                      void run(
                        "counts/submit",
                        { sessionId: countId, lines: ls },
                        "Count submitted",
                      );
                    } catch (e) {
                      setNotice(
                        e instanceof Error ? e.message : "Check the count",
                      );
                    }
                  }}
                >
                  Submit count
                </Button>
              ) : null}
              {detail.data.canApprove ? (
                <Button
                  isPending={write.pending}
                  onPress={() =>
                    void run(
                      "counts/approve",
                      {
                        sessionId: countId,
                        reasonCode: "verified_stock_count",
                      },
                      "Count posted",
                    )
                  }
                >
                  Approve count
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted">
              Select a count below to enter or review it.
            </p>
          )}
        </Card>
      ) : null}
      {tab === "controls" ? (
        <>
          <Card label="Request an adjustment">
            {can("inventory.adjustment.request") ? (
              <div className="grid max-w-xl gap-3">
                <Picker
                  label="Adjustment location"
                  value={source}
                  onChange={setSource}
                  options={locationOptions}
                />
                {quantityFields}
                <label className="text-sm">
                  <input
                    type="checkbox"
                    checked={subtract}
                    onChange={(e) => setSubtract(e.target.checked)}
                  />{" "}
                  Remove stock (untick to add)
                </label>
                <FormField label="Reason">
                  <Input
                    className={fieldClass}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </FormField>
                <Button
                  isPending={write.pending}
                  onPress={() =>
                    withQuantity(
                      (base) =>
                        void run(
                          "adjustments/request",
                          {
                            reasonCode: reason,
                            lines: [
                              {
                                productId,
                                locationId: source,
                                varianceBase: subtract ? -base : base,
                                stockStatus: "available",
                              },
                            ],
                          },
                          "Adjustment submitted for a different approver",
                        ),
                    )
                  }
                >
                  Request adjustment
                </Button>
                <p className="text-xs text-muted">
                  Lot-tracked corrections use a blind count to retain exact lot
                  evidence.
                </p>
              </div>
            ) : null}
          </Card>
          <NegativeStockPanel locations={locations.data} />
        </>
      ) : null}
      {tab === "controls" && can("inventory.write") ? (
        <Card label="Stock targets">
          <div className="grid max-w-xl gap-3">
            <p className="text-sm text-muted">
              Use the selected product and adjustment location. Thresholds are
              cases from the catalog.
            </p>
            <FormField label="Reorder point · cases">
              <Input
                className={fieldClass}
                value={reorderCases}
                onChange={(e) => setReorderCases(e.target.value)}
              />
            </FormField>
            <FormField label="Target stock · cases">
              <Input
                className={fieldClass}
                value={targetCases}
                onChange={(e) => setTargetCases(e.target.value)}
              />
            </FormField>
            <Button
              variant="outline"
              isPending={write.pending}
              onPress={() => {
                try {
                  if (!selected || !source)
                    throw new Error("Choose a product and location");
                  void run(
                    "replenishment/save",
                    {
                      productId,
                      locationId: source,
                      reorderPointBase: enteredStockQuantity(
                        reorderCases,
                        "",
                        selected.units,
                        true,
                      ),
                      targetLevelBase: enteredStockQuantity(
                        targetCases,
                        "",
                        selected.units,
                      ),
                    },
                    "Stock target saved",
                  );
                } catch (e) {
                  setNotice(
                    e instanceof Error ? e.message : "Check the stock target",
                  );
                }
              }}
            >
              Save stock target
            </Button>
          </div>
        </Card>
      ) : null}
      {tab === "controls" && productId ? (
        <Card label="Lot quality">
          {lots.error ? (
            <Notice title={lots.error.message} tone="danger" />
          ) : null}
          {lots.data
            ?.filter((l) => !source || l.locationId === source)
            .map((l) => (
              <div
                key={l.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-separator py-3"
              >
                <p>
                  Lot {l.lotNumber} · {label(l.stockStatus)} ·{" "}
                  <Amount q={l.onHand} />
                </p>
                {l.onHand.base > 0 &&
                l.stockStatus === "available" &&
                can("inventory.write") ? (
                  <Button
                    variant="outline"
                    onPress={() =>
                      void run(
                        "quality/change",
                        {
                          lotId: l.lotId,
                          locationId: l.locationId,
                          fromStatus: l.stockStatus,
                          toStatus: "quarantine",
                          quantityBase: l.onHand.base,
                          reasonCode: reason || "inspection_required",
                        },
                        "Stock held for inspection",
                      )
                    }
                  >
                    Hold for inspection
                  </Button>
                ) : null}
                {l.onHand.base > 0 &&
                ["quality_hold", "quarantine"].includes(l.stockStatus) &&
                can("inventory.approve") ? (
                  <Button
                    variant="outline"
                    onPress={() =>
                      void run(
                        "quality/change",
                        {
                          lotId: l.lotId,
                          locationId: l.locationId,
                          fromStatus: l.stockStatus,
                          toStatus: "available",
                          quantityBase: l.onHand.base,
                          reasonCode: reason || "quality_released",
                        },
                        "Quality stock released",
                      )
                    }
                  >
                    Release stock
                  </Button>
                ) : null}
              </div>
            ))}
        </Card>
      ) : null}
      {queueKind ? (
        <Card label={`Recent ${queueKind}`}>
          {queue.error ? (
            <Notice title={queue.error.message} tone="danger" />
          ) : null}
          {queue.items?.length === 0 && queue.isComplete ? (
            <p className="text-sm text-muted">No {queueKind} yet</p>
          ) : null}
          {queue.items?.map((d) => (
            <div
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-separator py-3"
            >
              <div>
                <p>{d.locations.join(" → ")}</p>
                <small className="text-muted">
                  {d.number} · {label(d.status)}
                </small>
              </div>
              <div className="flex gap-2">
                {queueKind === "counts" ? (
                  <Button
                    variant="outline"
                    onPress={() => {
                      setCountId(d.id);
                      setCounts({});
                    }}
                  >
                    Open count
                  </Button>
                ) : null}
                {queueKind === "transfers" &&
                d.status === "requested" &&
                d.canApprove ? (
                  <Button
                    variant="outline"
                    onPress={() =>
                      void run(
                        "transfers/approve",
                        { transferId: d.id },
                        "Transfer approved",
                      )
                    }
                  >
                    Approve
                  </Button>
                ) : null}
                {queueKind === "transfers" &&
                ["approved", "shipped"].includes(d.status) &&
                can("inventory.write") ? (
                  <Button
                    variant="outline"
                    onPress={() =>
                      void run(
                        `transfers/${d.status === "approved" ? "ship" : "receive"}`,
                        { transferId: d.id },
                        "Transfer updated",
                      )
                    }
                  >
                    {d.status === "approved" ? "Ship" : "Receive"}
                  </Button>
                ) : null}
                {queueKind === "adjustments" &&
                d.status === "submitted" &&
                d.canApprove ? (
                  <>
                    <Button
                      variant="outline"
                      onPress={() =>
                        void run(
                          "adjustments/decide",
                          { adjustmentId: d.id, decision: "approved" },
                          "Adjustment posted",
                        )
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      variant="outline"
                      onPress={() =>
                        void run(
                          "adjustments/decide",
                          { adjustmentId: d.id, decision: "rejected" },
                          "Adjustment rejected",
                        )
                      }
                    >
                      Reject
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          ))}
          {queue.status === "canLoadMore" ? (
            <Button variant="outline" onPress={() => void queue.loadMore()}>
              Show older
            </Button>
          ) : null}
        </Card>
      ) : null}
      {tab === "ledger" ? (
        <Card label="Movement trace">
          {moves.error ? (
            <Notice title={moves.error.message} tone="danger" />
          ) : null}
          {moves.items?.map((m) => (
            <div key={m.id} className="border-b border-separator py-3">
              <button className="underline" onClick={() => setTraceId(m.id)}>
                {label(m.kind)} · {m.number}
              </button>
              {m.lines.map((l) => (
                <p key={l.id} className="text-sm">
                  {l.name} · {l.from ?? "Received"} → {l.to ?? "Issued"} ·{" "}
                  <Amount q={l.quantity} />
                </p>
              ))}
            </div>
          ))}
          {moves.status === "canLoadMore" ? (
            <Button variant="outline" onPress={() => void moves.loadMore()}>
              Show older
            </Button>
          ) : null}
          {trace.error ? (
            <Notice title={trace.error.message} tone="danger" />
          ) : null}
          {trace.data ? (
            <div className="mt-4">
              <h3 className="font-medium">
                {trace.data.movement.number} · ledger evidence
              </h3>
              {trace.data.allocations.map((a) => (
                <p key={a.id}>
                  Lot {a.lotNumber} · <Amount q={a.quantity} />
                </p>
              ))}
              {trace.data.ledger.map((e) => (
                <p key={e.id} className="py-2 text-sm">
                  {locations.data?.find((l) => l.id === e.locationId)?.name ??
                    "Location"}{" "}
                  · {label(e.status)} · change <Amount q={e.delta} /> · balance{" "}
                  <Amount q={e.after} /> · revision {e.balanceVersion}
                </p>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
