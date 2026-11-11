"use client";

import { Button } from "@heroui/react";
import Link from "next/link";
import { Card, FormField, Pager, WorkspaceIcon } from "@sunpride/ui";
import { useRef, useState, type FormEvent } from "react";
import { apiFetch, mutate, useApi, useLive } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import { manilaToday } from "../../lib/outside-calls";
import { Drawer } from "../cockpit/kit/drawer";
import { useUrlState } from "../cockpit/use-url-state";
import { ListPage, PAGE_SIZE, readPage } from "../list-page/list-page";
import { money } from "../orders/model";
import { PageTabs, rowButton, shortDate } from "./page-tabs";

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
  // WEB-139: report every bad row (with its line number), not only the first.
  const bad: string[] = [];
  const parsed = rows.map((r, i) => {
    if (
      r.length !== 3 ||
      !r[0] ||
      !r[1] ||
      !/^\d+$/.test(r[2] ?? "") ||
      !Number.isSafeInteger(Number(r[2]))
    )
      bad.push(
        `Row ${i + 1}: enter product code, selling unit, whole centavos.`,
      );
    return { productCode: r[0]!, uom: r[1]!, unitPriceCentavos: Number(r[2]) };
  });
  if (bad.length) throw new Error(bad.join(" · "));
  return parsed;
}

/** Rows matching the search text and status chip, before paging. */
export function matchRows<
  T extends { code: string; name: string; status: string },
>(rows: T[], q: string, status: string | null, extra?: (r: T) => string) {
  const needle = q.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!status || r.status === status) &&
      (!needle ||
        `${r.name} ${r.code} ${extra?.(r) ?? ""}`
          .toLowerCase()
          .includes(needle)),
  );
}

const TABS = [
  { id: "lists", label: "Price lists" },
  { id: "products", label: "Prices by product" },
  { id: "promotions", label: "Promotions" },
] as const;
type Tab = (typeof TABS)[number]["id"];
export function readPricingTab(params: URLSearchParams): Tab {
  const t = params.get("tab");
  return TABS.some((x) => x.id === t) ? (t as Tab) : "lists";
}

const fromDate = (value: FormDataEntryValue | null) =>
  new Date(`${String(value)}T00:00:00+08:00`).getTime();
const failure = (e: unknown) =>
  e instanceof Error ? e.message : "The change was not saved";
/** F-501: the API refuses to ACTIVATE a new promotion that has no approved campaign budget, and this form has no
 * campaign field, so a new promotion is saved Inactive (sending "active" made every save fail). */
export function newPromotionBody<T extends object>(fields: T) {
  return { ...fields, status: "inactive" as const };
}
export const NEW_PROMOTION_NOTICE =
  "Saved as Inactive. A new promotion goes live only once it is linked to an approved campaign budget.";

const statusWord = (s: string) => (s === "active" ? "Active" : "Inactive");
const ruleWord = (kind: string) =>
  kind === "percent_off"
    ? "Percent off"
    : kind === "bundle"
      ? "Bundle price"
      : "Buy and get free";
const STATUS_FILTERS = [
  { id: "active", label: "Active" },
  { id: "inactive", label: "Inactive" },
];

/** Price lists, prices by product and promotions: plain lists with Add and Edit. */
export function PricingWorkspace() {
  const { can } = usePermissions();
  const { params, set, hrefWith } = useUrlState();
  const tab = readPricingTab(params);
  const q = params.get("q") ?? "";
  const status = params.get("status");
  const page = readPage(params);
  const openList = params.get("list") ?? "";
  const editing = params.get("edit") === "1";
  const openPromo = params.get("promotion") ?? "";
  const [adding, setAdding] = useState<null | "list" | "promotion">(null);
  const [channel, setChannel] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
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
    openList ? ["pricing", "detail", openList] : null,
    ({ signal }) =>
      apiFetch("/api/v1/pricing/price-lists/detail", {
        query: { id: openList },
        signal,
      }),
  );
  // Same read (and cache key) as Master data: with SAP connected, prices are SAP's and the API refuses saves.
  const org = useApi<{ sapOwnsPrices?: boolean }>(
    can("report.read") ? ["setup", "org/permissions", {}] : null,
    "/api/v1/org/permissions",
  );
  useLive(["orders"], [["pricing"]]);
  if (!can("report.read")) return null;
  const canEdit = can("masterdata.manage");
  const sapOwnsPrices = org.data?.sapOwnsPrices === true;
  /** Price lists and their prices; promotions stay with [canEdit]. */
  const canEditPrices = canEdit && !sapOwnsPrices;
  const selectedList = lists.data?.rows.find((p) => p.id === openList);
  const selectedPromo = promotions.data?.rows.find((p) => p.id === openPromo);
  const tabHref = (id: string) =>
    hrefWith({
      tab: id === "lists" ? null : id,
      q: null,
      page: null,
      status: null,
      list: null,
      edit: null,
      promotion: null,
    });

  async function save(path: string, body: Record<string, unknown>) {
    if (busy) return false;
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
        return false;
      }
      intent.current = null;
      setNotice("Saved. Orders already taken keep their prices.");
      return true;
    } catch (e) {
      setError(failure(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function addList(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (
      await save("/api/v1/pricing/price-lists/save", {
        code: String(f.get("code")),
        name: String(f.get("name")),
        channelKey: String(f.get("channelKey")) || null,
        effectiveFrom: fromDate(f.get("effectiveFrom")),
        status: "active",
      })
    )
      setAdding(null);
  }
  async function editList(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedList) return;
    const f = new FormData(e.currentTarget);
    if (
      await save("/api/v1/pricing/price-lists/update", {
        ...selectedList,
        name: String(f.get("name")),
        status: String(f.get("status")),
      })
    )
      set({ edit: null });
  }
  async function removeList() {
    if (
      !selectedList ||
      !window.confirm(
        `Remove ${selectedList.name}? Orders already taken keep their prices.`,
      )
    )
      return;
    if (
      await save("/api/v1/pricing/price-lists/delete", { id: selectedList.id })
    )
      set({ list: null, edit: null });
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
  async function addPromotion(e: FormEvent<HTMLFormElement>) {
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
    if (
      await save(
        "/api/v1/pricing/promotions/save",
        newPromotionBody({
          code: String(f.get("code")),
          name: String(f.get("name")),
          priceListId: String(f.get("priceListId")) || null,
          effectiveFrom: fromDate(f.get("effectiveFrom")),
          rule,
        }),
      )
    ) {
      setAdding(null);
      setNotice(NEW_PROMOTION_NOTICE);
    }
  }
  async function editPromotion(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedPromo) return;
    const f = new FormData(e.currentTarget);
    if (
      await save("/api/v1/pricing/promotions/update", {
        ...selectedPromo,
        name: String(f.get("name")),
        status: String(f.get("status")),
      })
    )
      set({ promotion: null });
  }
  async function removePromotion() {
    if (
      !selectedPromo ||
      !window.confirm(`Remove ${selectedPromo.name} from new orders?`)
    )
      return;
    if (
      await save("/api/v1/pricing/promotions/delete", { id: selectedPromo.id })
    )
      set({ promotion: null });
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
  const listParams = {
    page,
    onPage: (n: number) => set({ page: n > 1 ? String(n) : null }),
    q,
    onSearch: (next: string) =>
      set({ q: next || null, page: null }, { replace: true }),
    filters: STATUS_FILTERS,
    filter: status,
    onFilter: (id: string | null) => set({ status: id, page: null }),
  };
  const pageOf = <T,>(rows: T[]) =>
    rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const listRows = lists.data
    ? matchRows(lists.data.rows, q, status, (r) => r.channelKey ?? "")
    : null;
  const promoRows = promotions.data
    ? matchRows(promotions.data.rows, q, status)
    : null;
  const listName = (id: string | null) =>
    id
      ? (lists.data?.rows.find((l) => l.id === id)?.name ?? "One list")
      : "Every list";

  const formActions = (onCancel: () => void) => (
    <div className="flex flex-wrap gap-2 sm:col-span-2">
      {error ? (
        <p role="alert" className="w-full text-sm">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="primary" isDisabled={busy}>
        Save
      </Button>
      <Button type="button" variant="outline" onPress={onCancel}>
        Cancel
      </Button>
    </div>
  );

  return (
    <div className="grid gap-4">
      <PageTabs label="Prices" tabs={TABS} current={tab} href={tabHref} />
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
      {sapOwnsPrices && tab !== "promotions" ? (
        <p className="text-sm text-muted" data-testid="sap-owns-prices">
          Prices come from SAP.
        </p>
      ) : null}

      {tab === "lists" && openList ? (
        <section className="grid gap-4" aria-label="Price list">
          <Link
            href={hrefWith({ list: null, edit: null })}
            className="text-[13px] text-muted hover:text-foreground"
          >
            ← Price lists
          </Link>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">
                {selectedList?.name ?? "Price list"}
              </h2>
              {selectedList ? (
                <p className="text-sm text-muted">
                  {selectedList.code} ·{" "}
                  {selectedList.channelKey ?? "Default channel"} ·{" "}
                  {statusWord(selectedList.status)} · from{" "}
                  {shortDate(selectedList.effectiveFrom)}
                  {selectedList.source === "sample" ? " · Sample data" : ""}
                </p>
              ) : null}
            </div>
            {canEditPrices && selectedList ? (
              <Link
                href={hrefWith({ edit: "1" })}
                scroll={false}
                className={rowButton}
              >
                Edit
              </Link>
            ) : null}
          </div>
          <Card label="Prices" icon={<WorkspaceIcon name="commercial" />}>
            <ul className="grid gap-2 p-4">
              {detail.data?.lines.map((l) => (
                <li
                  key={l.id}
                  className="flex flex-wrap justify-between gap-2 border-b border-border pb-2 text-sm"
                >
                  <span>
                    {l.productName} · {l.uom}
                    <small className="block text-muted">
                      {shortDate(l.effectiveFrom)} →{" "}
                      {l.effectiveTo ? shortDate(l.effectiveTo) : "now"}
                    </small>
                  </span>
                  <span>{money(l.unitPriceCentavos)}</span>
                </li>
              ))}
              {detail.data && !detail.data.lines.length ? (
                <li className="text-sm text-muted">No prices yet.</li>
              ) : null}
            </ul>
          </Card>
          {canEditPrices && selectedList ? (
            <Card label="Add prices" icon={<WorkspaceIcon name="commercial" />}>
              <form onSubmit={importPrices} className="grid gap-3 p-4">
                <FormField label="Prices start on">
                  <input
                    type="date"
                    name="effectiveFrom"
                    defaultValue={manilaToday()}
                    required
                  />
                </FormField>
                <FormField
                  label="One row each: product code, unit, centavos"
                  hint="Example: SKU001,PC,1250 is ₱12.50 a piece."
                >
                  <textarea name="rows" rows={5} required />
                </FormField>
                {error ? (
                  <p role="alert" className="text-sm text-danger">
                    {error}
                  </p>
                ) : null}
                <div>
                  <Button type="submit" variant="primary" isDisabled={busy}>
                    Save
                  </Button>
                </div>
              </form>
            </Card>
          ) : null}
        </section>
      ) : null}

      {tab === "lists" && !openList ? (
        <ListPage<PriceList>
          noun={{ one: "price list", many: "price lists" }}
          rows={listRows ? pageOf(listRows) : lists.error ? [] : null}
          total={listRows?.length ?? null}
          loading={!lists.data && !lists.error}
          searchPlaceholder="Search by name, code or channel"
          onAdd={canEditPrices ? () => setAdding("list") : undefined}
          {...listParams}
          rowKey={(r) => r.id}
          columns={[
            {
              key: "name",
              label: "Price list",
              primary: true,
              text: (r) => r.name,
              render: (r) => (
                <Link
                  href={hrefWith({ list: r.id })}
                  scroll={false}
                  className="hover:underline"
                >
                  {r.name}
                  {r.source === "sample" ? (
                    <span className="ml-2 text-[12px] font-normal text-muted">
                      Sample
                    </span>
                  ) : null}
                </Link>
              ),
            },
            {
              key: "channel",
              label: "Channel",
              text: (r) => r.channelKey ?? "Default",
              render: (r) => r.channelKey ?? "Default",
            },
            {
              key: "status",
              label: "Status",
              text: (r) => statusWord(r.status),
              render: (r) => statusWord(r.status),
            },
            {
              key: "from",
              label: "From",
              text: (r) => shortDate(r.effectiveFrom),
              render: (r) => shortDate(r.effectiveFrom),
            },
            {
              key: "prices",
              label: "Prices",
              align: "right",
              text: (r) => String(r.lineCount),
              render: (r) =>
                `${r.lineCount.toLocaleString("en-PH")} ${r.lineCount === 1 ? "price" : "prices"}`,
            },
            ...(canEditPrices
              ? [
                  {
                    key: "edit",
                    label: "",
                    align: "right" as const,
                    render: (r: PriceList) => (
                      <Link
                        href={hrefWith({ list: r.id, edit: "1" })}
                        scroll={false}
                        className={rowButton}
                        aria-label={`Edit ${r.name}`}
                      >
                        Edit
                      </Link>
                    ),
                  },
                ]
              : []),
          ]}
        />
      ) : null}

      {tab === "products" ? (
        <Card
          label="Prices by product"
          icon={<WorkspaceIcon name="commercial" />}
        >
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <FormField label="Channel">
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
            <FormField label="Search">
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
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="p-3">Product</th>
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
                          <span className="font-medium">No price yet</span>
                        ) : (
                          money(v.unitPriceCentavos)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {matrix.data && !matrix.data.channels.length ? (
              <p className="p-4 text-sm text-muted">
                No price lists yet. Add one on Price lists.
              </p>
            ) : null}
          </div>
          <div className="p-4">
            <Pager
              label="Product pages"
              page={cursors.length + 1}
              canPrevious={cursors.length > 0}
              canNext={!!matrix.data?.next}
              onPrevious={() => setCursors((x) => x.slice(0, -1))}
              onNext={() =>
                matrix.data?.next &&
                setCursors((x) => [...x, matrix.data!.next!])
              }
            />
          </div>
        </Card>
      ) : null}

      {tab === "promotions" ? (
        <>
          <p className="text-sm text-muted">
            One promotion applies per order; they never stack.
          </p>
          <ListPage<Promotion>
            noun={{ one: "promotion", many: "promotions" }}
            rows={promoRows ? pageOf(promoRows) : promotions.error ? [] : null}
            total={promoRows?.length ?? null}
            loading={!promotions.data && !promotions.error}
            searchPlaceholder="Search by name or code"
            onAdd={canEdit ? () => setAdding("promotion") : undefined}
            {...listParams}
            rowKey={(r) => r.id}
            columns={[
              {
                key: "name",
                label: "Promotion",
                primary: true,
                text: (r) => r.name,
                render: (r) => (
                  <>
                    {r.name}
                    {r.source === "sample" ? (
                      <span className="ml-2 text-[12px] font-normal text-muted">
                        Sample
                      </span>
                    ) : null}
                  </>
                ),
              },
              {
                key: "kind",
                label: "Kind",
                text: (r) => ruleWord(r.rule.kind),
                render: (r) => ruleWord(r.rule.kind),
              },
              {
                key: "list",
                label: "Price list",
                text: (r) => listName(r.priceListId),
                render: (r) => listName(r.priceListId),
              },
              {
                key: "status",
                label: "Status",
                text: (r) => statusWord(r.status),
                render: (r) => statusWord(r.status),
              },
              ...(canEdit
                ? [
                    {
                      key: "edit",
                      label: "",
                      align: "right" as const,
                      render: (r: Promotion) => (
                        <Link
                          href={hrefWith({ promotion: r.id })}
                          scroll={false}
                          className={rowButton}
                          aria-label={`Edit ${r.name}`}
                        >
                          Edit
                        </Link>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </>
      ) : null}

      <Drawer
        open={adding === "list"}
        title="Add price list"
        onClose={() => setAdding(null)}
      >
        <form onSubmit={addList} className="grid gap-3">
          <FormField label="Name">
            <input name="name" required maxLength={160} />
          </FormField>
          <FormField label="Code">
            <input name="code" required maxLength={80} />
          </FormField>
          <FormField label="Channel" hint="Leave empty for the default list.">
            <input name="channelKey" />
          </FormField>
          <FormField label="Starts on">
            <input
              name="effectiveFrom"
              type="date"
              required
              defaultValue={manilaToday()}
            />
          </FormField>
          {formActions(() => setAdding(null))}
        </form>
      </Drawer>

      <Drawer
        open={canEditPrices && editing && !!selectedList}
        title="Edit price list"
        onClose={() => set({ edit: null })}
      >
        {selectedList ? (
          <div className="grid gap-6">
            <form
              key={selectedList.id + selectedList.status}
              onSubmit={editList}
              className="grid gap-3"
            >
              <FormField label="Name">
                <input
                  name="name"
                  required
                  maxLength={160}
                  defaultValue={selectedList.name}
                />
              </FormField>
              <FormField
                label="Status"
                hint="Inactive lists are not used for new orders."
              >
                <select name="status" defaultValue={selectedList.status}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </FormField>
              {formActions(() => set({ edit: null }))}
            </form>
            <div className="grid gap-2 border-t border-separator pt-4">
              <Button
                variant="danger"
                isDisabled={busy}
                onPress={() => void removeList()}
                className="justify-self-start"
              >
                Remove
              </Button>
            </div>
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={adding === "promotion"}
        title="Add promotion"
        wide
        onClose={() => setAdding(null)}
      >
        <form onSubmit={addPromotion} className="grid gap-3 sm:grid-cols-2">
          <FormField label="Name">
            <input name="name" required />
          </FormField>
          <FormField label="Code">
            <input name="code" required />
          </FormField>
          <FormField label="Price list">
            <select name="priceListId">
              <option value="">Every list</option>
              {lists.data?.rows.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.channelKey ?? "Default"})
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Starts on">
            <input
              type="date"
              name="effectiveFrom"
              required
              defaultValue={manilaToday()}
            />
          </FormField>
          <FormField label="Kind">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
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
          {formActions(() => setAdding(null))}
        </form>
      </Drawer>

      <Drawer
        open={canEdit && !!selectedPromo}
        title="Edit promotion"
        onClose={() => set({ promotion: null })}
      >
        {selectedPromo ? (
          <div className="grid gap-6">
            <form
              key={selectedPromo.id + selectedPromo.status}
              onSubmit={editPromotion}
              className="grid gap-3"
            >
              <FormField label="Name">
                <input name="name" required defaultValue={selectedPromo.name} />
              </FormField>
              <FormField label="Status">
                <select name="status" defaultValue={selectedPromo.status}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </FormField>
              {formActions(() => set({ promotion: null }))}
            </form>
            <div className="border-t border-separator pt-4">
              <Button
                variant="danger"
                isDisabled={busy}
                onPress={() => void removePromotion()}
              >
                Remove
              </Button>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
