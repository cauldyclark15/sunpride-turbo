"use client";

import { Button } from "@heroui/react";
import Link from "next/link";
import { Card, FormField, Pager, WorkspaceIcon } from "@sunpride/ui";
import { useRef, useState, type FormEvent } from "react";
import { apiFetch, mutate, useApi, useLive } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import { manilaToday } from "../../lib/outside-calls";
import { money } from "../orders/model";

type PriceList = {
  id: string;
  code: string;
  name: string;
  channelKey: string | null;
  status: string;
  source: string;
  effectiveFrom: number;
  effectiveTo: number | null;
  lineCount: number;
};
type Matrix = {
  channels: string[];
  rows: {
    productId: string;
    productCode: string;
    productName: string;
    uom: string;
    prices: {
      channel: string;
      unitPriceCentavos: number | null;
      source: string | null;
    }[];
  }[];
  next: string | null;
  asOf: number;
};
type Promotion = {
  id: string;
  code: string;
  name: string;
  priceListId: string | null;
  rule: { kind: string; [key: string]: unknown };
  status: string;
  source: string;
  effectiveFrom: number;
  effectiveTo: number | null;
};
type Detail = PriceList & {
  lines: {
    id: string;
    productCode: string;
    productName: string;
    uom: string;
    unitPriceCentavos: number;
    effectiveFrom: number;
    effectiveTo: number | null;
  }[];
};
export function parsePriceRows(text: string) {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(",").map((s) => s.trim()));
  if (!rows.length || rows.length > 4000)
    throw new Error("Paste 1–4,000 product, unit and centavo rows.");
  return rows.map((r, i) => {
    if (
      r.length !== 3 ||
      !r[0] ||
      !r[1] ||
      !/^\d+$/.test(r[2] ?? "") ||
      !Number.isSafeInteger(Number(r[2]))
    )
      throw new Error(
        `Row ${i + 1}: enter product code, selling unit, whole centavos.`,
      );
    return { productCode: r[0]!, uom: r[1]!, unitPriceCentavos: Number(r[2]) };
  });
}
const fromDate = (value: FormDataEntryValue | null) =>
  new Date(`${String(value)}T00:00:00+08:00`).getTime();
const failure = (e: unknown) =>
  e instanceof Error ? e.message : "The change was not saved";

/** Which channels cannot sell, and which governed prices or promotions need attention? */
export function PricingWorkspace() {
  const { can } = usePermissions();
  const [channel, setChannel] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [kind, setKind] = useState("percent_off");
  const intent = useRef<{ hash: string; key: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lists = useApi<{ rows: PriceList[] }>(
    can("report.read") ? ["pricing", "lists"] : null,
    "/api/v1/pricing/price-lists",
  );
  const promotions = useApi<{ rows: Promotion[] }>(
    can("report.read") ? ["pricing", "promotions"] : null,
    "/api/v1/pricing/promotions",
  );
  const query = {
    channel: channel || undefined,
    q: search || undefined,
    cursor: cursors.at(-1),
  };
  const matrix = useApi<Matrix>(
    can("report.read") ? ["pricing", "matrix", query] : null,
    ({ signal }) => apiFetch("/api/v1/pricing/matrix", { query, signal }),
  );
  const detail = useApi<Detail>(
    selected ? ["pricing", "detail", selected] : null,
    ({ signal }) =>
      apiFetch("/api/v1/pricing/price-lists/detail", {
        query: { id: selected },
        signal,
      }),
  );
  useLive(["orders"], [["pricing"]]);
  if (!can("report.read")) return null;
  const canEdit = can("masterdata.manage");
  const selectedList = lists.data?.rows.find((p) => p.id === selected);
  const missing =
    matrix.data?.rows.filter((r) =>
      r.prices.some((p) => p.unitPriceCentavos === null),
    ).length ?? 0;
  async function save(path: string, body: Record<string, unknown>) {
    if (busy) return;
    const hash = JSON.stringify([path, body]);
    if (intent.current?.hash !== hash)
      intent.current = { hash, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await mutate<{
        ok: boolean;
        errors?: { row: number; message: string }[];
      }>(path, body, {
        invalidate: [["pricing"], ["orders"]],
        idempotencyKey: intent.current.key,
      });
      if (!result.ok) {
        setError(
          (result.errors ?? [])
            .map((r) => `Row ${r.row}: ${r.message}`)
            .join(" · "),
        );
        return;
      }
      intent.current = null;
      setNotice(
        "Saved. New orders use the governed effective dates; existing orders keep their captured prices.",
      );
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  function saveList(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void save("/api/v1/pricing/price-lists/save", {
      code: String(f.get("code")),
      name: String(f.get("name")),
      channelKey: String(f.get("channelKey")) || null,
      effectiveFrom: fromDate(f.get("effectiveFrom")),
      status: "active",
    });
  }
  function importPrices(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedList) return;
    const f = new FormData(e.currentTarget);
    try {
      void save("/api/v1/pricing/price-lists/import", {
        priceListCode: selectedList.code,
        channelKey: selectedList.channelKey,
        effectiveFrom: fromDate(f.get("effectiveFrom")),
        rows: parsePriceRows(String(f.get("rows"))),
      });
    } catch (e) {
      setError(failure(e));
    }
  }
  function savePromotion(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const unit = (prefix: string) => {
      const p = matrix.data?.rows.find(
        (p) => p.productId === f.get(`${prefix}Product`),
      );
      return {
        productId: p?.productId,
        uom: p?.uom,
        quantity: Number(f.get(`${prefix}Quantity`)),
      };
    };
    const rule =
      kind === "percent_off"
        ? {
            kind,
            item: unit("first"),
            percentOffBasisPoints: Math.round(Number(f.get("percent")) * 100),
          }
        : kind === "buy_x_get_y"
          ? { kind, buy: unit("first"), free: unit("second") }
          : {
              kind,
              components: [unit("first"), unit("second")],
              bundlePriceMinor: Number(f.get("bundlePrice")),
            };
    void save("/api/v1/pricing/promotions/save", {
      code: String(f.get("code")),
      name: String(f.get("name")),
      priceListId: String(f.get("priceListId")) || null,
      effectiveFrom: fromDate(f.get("effectiveFrom")),
      rule,
    });
  }
  const productField = (prefix: string, label: string) => (
    <>
      <FormField label={label}>
        <select name={`${prefix}Product`} required>
          <option value="">Choose product</option>
          {matrix.data?.rows.map((p) => (
            <option key={p.productId} value={p.productId}>
              {p.productName} ({p.productCode}, {p.uom})
            </option>
          ))}
        </select>
      </FormField>
      <FormField label={`${label} quantity`}>
        <input
          type="number"
          name={`${prefix}Quantity`}
          min="1"
          step="1"
          defaultValue="1"
          required
        />
      </FormField>
    </>
  );
  return (
    <div className="grid gap-5">
      <header>
        <p className="text-xs uppercase tracking-widest text-muted">
          Selling readiness
        </p>
        <h2 className="text-xl font-semibold">Prices by channel</h2>
        <p className="text-sm text-muted">
          A missing price is unknown, not free. Set the price before approving
          an order.
        </p>
      </header>
      {(error ||
        lists.error ||
        matrix.error ||
        promotions.error ||
        detail.error) && (
        <p role="alert" className="rounded-xl border border-border p-4">
          {error ||
            lists.error?.message ||
            matrix.error?.message ||
            promotions.error?.message ||
            detail.error?.message}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {matrix.data && (
        <section
          className="rounded-xl border border-border p-4"
          aria-label="Missing-price warning"
        >
          <h3 className="font-medium">
            {missing
              ? `${missing} products need a channel price on this page`
              : matrix.data.channels.length
                ? "Every product on this page has a channel price"
                : "Channel pricing needs setup"}
          </h3>
          <p className="text-sm text-muted">
            {matrix.data.next
              ? "More products remain. Continue through every page before declaring the catalog ready."
              : "Checked the products shown below."}{" "}
            Historical sales and targets are on{" "}
            <Link href="/sales-targets" className="underline">
              Sales & targets
            </Link>
            ; this is current setup, not a sales result.
          </p>
        </section>
      )}
      <Card
        label="Channel price lists"
        icon={<WorkspaceIcon name="commercial" />}
      >
        <div className="grid gap-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Channel filter">
              <select
                value={channel}
                onChange={(e) => {
                  setChannel(e.target.value);
                  setCursors([]);
                }}
              >
                <option value="">All channels</option>
                {[
                  ...new Set(
                    lists.data?.rows
                      .map((p) => p.channelKey)
                      .filter((p): p is string => p !== null),
                  ),
                ].map((ch) => (
                  <option key={ch}>{ch}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Product search">
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setCursors([]);
                }}
                placeholder="Code or product name"
              />
            </FormField>
          </div>
          <ul className="grid gap-2">
            {lists.data?.rows
              .filter((p) => !channel || p.channelKey === channel)
              .map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3"
                >
                  <button
                    className="text-left"
                    onClick={() => setSelected(p.id)}
                  >
                    <strong className="text-sm underline">{p.name}</strong>
                    <p className="text-xs text-muted">
                      {p.code} · {p.channelKey ?? "Default channel"} ·{" "}
                      {p.lineCount} price versions ·{" "}
                      {p.status === "active" ? "Active" : "Inactive"} ·{" "}
                      {p.source === "sample" ? "Sample data" : "Office"}
                    </p>
                    <p className="text-xs text-muted">
                      From{" "}
                      {new Date(p.effectiveFrom).toLocaleDateString("en-PH", {
                        timeZone: "Asia/Manila",
                      })}
                    </p>
                  </button>
                  {canEdit && (
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        isDisabled={busy}
                        onPress={() =>
                          void save("/api/v1/pricing/price-lists/update", {
                            ...p,
                            status:
                              p.status === "active" ? "inactive" : "active",
                          })
                        }
                      >
                        {p.status === "active" ? "Deactivate" : "Activate"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        isDisabled={busy}
                        onPress={() => {
                          if (
                            window.confirm(
                              `Remove ${p.name} from new-order pricing? Captured orders stay unchanged.`,
                            )
                          )
                            void save("/api/v1/pricing/price-lists/delete", {
                              id: p.id,
                            });
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </li>
              ))}
          </ul>
          {lists.data?.rows.length === 0 && (
            <p className="text-sm text-muted">
              No price lists yet. Create the first channel list below.
            </p>
          )}
          {canEdit && (
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Create a channel price list
              </summary>
              <form
                onSubmit={saveList}
                className="mt-3 grid gap-3 sm:grid-cols-2"
              >
                <FormField label="List code">
                  <input name="code" required maxLength={80} />
                </FormField>
                <FormField label="List name">
                  <input name="name" required maxLength={160} />
                </FormField>
                <FormField label="Channel (blank for default)">
                  <input name="channelKey" />
                </FormField>
                <FormField label="Effective from">
                  <input
                    name="effectiveFrom"
                    type="date"
                    required
                    defaultValue={manilaToday()}
                  />
                </FormField>
                <Button type="submit" isDisabled={busy}>
                  Create price list
                </Button>
              </form>
            </details>
          )}
        </div>
      </Card>
      {selectedList && (
        <Card
          label={`Price history · ${selectedList.name}`}
          icon={<WorkspaceIcon name="commercial" />}
        >
          <div className="grid gap-4 p-4">
            <button
              className="justify-self-end text-sm underline"
              onClick={() => setSelected("")}
            >
              Close price history
            </button>
            <ul className="grid gap-2">
              {detail.data?.lines.map((l) => (
                <li
                  key={l.id}
                  className="flex flex-wrap justify-between gap-2 border-b border-border pb-2 text-sm"
                >
                  <span>
                    {l.productName} · {l.uom}
                    <small className="block text-muted">
                      {new Date(l.effectiveFrom).toLocaleDateString("en-PH", {
                        timeZone: "Asia/Manila",
                      })}{" "}
                      →{" "}
                      {l.effectiveTo
                        ? new Date(l.effectiveTo).toLocaleDateString("en-PH", {
                            timeZone: "Asia/Manila",
                          })
                        : "Until replaced"}
                    </small>
                  </span>
                  <span>{money(l.unitPriceCentavos)}</span>
                </li>
              ))}
            </ul>
            {canEdit && (
              <form onSubmit={importPrices} className="grid gap-3">
                <FormField label="New prices effective from">
                  <input
                    type="date"
                    name="effectiveFrom"
                    defaultValue={manilaToday()}
                    required
                  />
                </FormField>
                <FormField
                  label="Paste rows: product code, unit, whole centavos"
                  hint="Example: SKU001,PC,1250 means ₱12.50 per piece. No header. All rows succeed or none are saved."
                >
                  <textarea name="rows" rows={5} required />
                </FormField>
                <Button type="submit" isDisabled={busy}>
                  Validate and import prices
                </Button>
              </form>
            )}
          </div>
        </Card>
      )}
      <Card
        label="Product × channel matrix"
        icon={<WorkspaceIcon name="commercial" />}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-3">Product / selling unit</th>
                {matrix.data?.channels.map((ch) => (
                  <th key={ch} className="p-3">
                    {ch}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.data?.rows.map((p) => (
                <tr key={p.productId} className="border-t border-border">
                  <td className="p-3">
                    {p.productName}
                    <p className="text-xs text-muted">
                      {p.productCode} · per {p.uom}
                    </p>
                  </td>
                  {p.prices.map((v) => (
                    <td className="p-3" key={v.channel}>
                      {v.unitPriceCentavos === null ? (
                        <span className="font-medium">Needs price</span>
                      ) : (
                        money(v.unitPriceCentavos)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="p-4">
          <Pager
            label="Price matrix pages"
            page={cursors.length + 1}
            canPrevious={cursors.length > 0}
            canNext={!!matrix.data?.next}
            onPrevious={() => setCursors((x) => x.slice(0, -1))}
            onNext={() =>
              matrix.data?.next && setCursors((x) => [...x, matrix.data!.next!])
            }
          />
        </div>
      </Card>
      <Card
        label="Governed promotions"
        icon={<WorkspaceIcon name="commercial" />}
      >
        <div className="grid gap-4 p-4">
          <p className="text-sm text-muted">
            One best promotion applies per order; promotions never stack. This
            is our provisional default.
          </p>
          <ul className="grid gap-2">
            {promotions.data?.rows.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3"
              >
                <div>
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-muted">
                    {p.code} ·{" "}
                    {p.rule.kind === "percent_off"
                      ? "Percent discount"
                      : p.rule.kind === "bundle"
                        ? "Bundle price"
                        : "Buy and get free goods"}{" "}
                    · {p.status === "active" ? "Active" : "Inactive"}
                    {p.source === "sample" ? " · Sample data" : ""}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      isDisabled={busy}
                      onPress={() =>
                        void save("/api/v1/pricing/promotions/update", {
                          ...p,
                          status: p.status === "active" ? "inactive" : "active",
                        })
                      }
                    >
                      {p.status === "active" ? "Deactivate" : "Activate"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      isDisabled={busy}
                      onPress={() => {
                        if (window.confirm(`Remove ${p.name} from new orders?`))
                          void save("/api/v1/pricing/promotions/delete", {
                            id: p.id,
                          });
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {promotions.data?.rows.length === 0 && (
            <p className="text-sm text-muted">
              No promotions configured. Regular governed prices apply.
            </p>
          )}
          {canEdit && (
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Create a promotion
              </summary>
              <form
                onSubmit={savePromotion}
                className="mt-3 grid gap-3 sm:grid-cols-2"
              >
                <FormField label="Promotion code">
                  <input name="code" required />
                </FormField>
                <FormField label="Promotion name">
                  <input name="name" required />
                </FormField>
                <FormField label="Applies to price list">
                  <select name="priceListId">
                    <option value="">Every list</option>
                    {lists.data?.rows.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.channelKey ?? "Default"})
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Effective from">
                  <input
                    type="date"
                    name="effectiveFrom"
                    required
                    defaultValue={manilaToday()}
                  />
                </FormField>
                <FormField label="Rule">
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                  >
                    <option value="percent_off">Percent off</option>
                    <option value="buy_x_get_y">Buy X, get Y free</option>
                    <option value="bundle">Bundle price</option>
                  </select>
                </FormField>
                {productField(
                  "first",
                  kind === "buy_x_get_y" ? "Buy product" : "First product",
                )}
                {kind !== "percent_off" &&
                  productField(
                    "second",
                    kind === "buy_x_get_y" ? "Free product" : "Second product",
                  )}
                {kind === "percent_off" ? (
                  <FormField label="Discount percent">
                    <input
                      name="percent"
                      type="number"
                      min="0.01"
                      max="100"
                      step="0.01"
                      required
                    />
                  </FormField>
                ) : kind === "bundle" ? (
                  <FormField label="Bundle price in centavos">
                    <input
                      name="bundlePrice"
                      type="number"
                      min="0"
                      step="1"
                      required
                    />
                  </FormField>
                ) : null}
                <p className="text-xs text-muted">
                  Product choices follow the current matrix page and product
                  search.
                </p>
                <Button type="submit" isDisabled={busy}>
                  Create promotion
                </Button>
              </form>
            </details>
          )}
        </div>
      </Card>
    </div>
  );
}
