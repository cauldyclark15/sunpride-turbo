"use client";

import Link from "next/link";
import { useCallback, useState, type FormEvent } from "react";
import { FormField, Pager, UnderlineTabs } from "@sunpride/ui";
import { Button } from "@heroui/react";
import { useOrgMutation, useOrgQuery } from "./api";
import type { Customer, Outlet, Product } from "./model";
import { collectExport, csvText, downloadCsv } from "./export";
import { useSetupParam } from "./location";
import { ListPage, type ListColumn } from "../list-page/list-page";
import { Drawer } from "../cockpit/kit/drawer";

type Kind = "products" | "customers" | "outlets";
type Row = {
  id: string;
  code: string;
  name: string;
  category: string;
  unit: string;
  channel: string;
  territory: string;
  credit: number | null;
  status: string;
  product?: Product;
  customer?: Customer;
  outlet?: Outlet;
};
/** What the form is doing: editing a row, or adding a new product/customer. */
type Editing = { row: Row | null; kind: "products" | "customers" };
const money = (v: number | null) =>
  v === null
    ? "Not set"
    : new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
      }).format(v / 100);
const tabs = [
  ["products", "Products"],
  ["customers", "Customers"],
  ["outlets", "Stores"],
] as const;
const KINDS = tabs.map(([id]) => id) as readonly Kind[];
const NOUN: Record<Kind, { one: string; many: string }> = {
  products: { one: "product", many: "products" },
  customers: { one: "customer", many: "customers" },
  outlets: { one: "store", many: "stores" },
};
const editClass =
  "inline-flex h-9 items-center rounded-lg border border-border px-3 text-[13px] font-medium text-foreground hover:bg-default-soft";

/** Write URL params in place (tabs, search and filter survive reload and links). */
function setParams(values: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(values))
    if (v) url.searchParams.set(k, v);
    else url.searchParams.delete(k);
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event("popstate"));
}

export function MasterDataWorkspace({
  initialSection = "products",
}: { initialSection?: Kind } = {}) {
  const tabParam = useSetupParam("tab");
  const kind: Kind = KINDS.includes(tabParam as Kind)
    ? (tabParam as Kind)
    : initialSection;
  const missingPrice = useSetupParam("missingPrice") === "true";
  const q = useSetupParam("q");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const permissions = useOrgQuery("org/permissions", {});
  const canEdit =
    (permissions?.capabilities.includes("masterdata.manage") ?? false) &&
    permissions?.national !== false;
  const filter = "";
  const pageInput = {
    q,
    paginationOpts: { numItems: 25, cursor: cursors.at(-1) ?? null },
    ...(missingPrice && kind === "products" ? { missingPrice: "true" } : {}),
  };
  const products = useOrgQuery(
    "catalog/products/list",
    kind === "products" ? pageInput : "skip",
  );
  const customers = useOrgQuery(
    "catalog/customers/list",
    kind === "customers" ? pageInput : "skip",
  );
  const outlets = useOrgQuery(
    "outlets/list",
    kind === "outlets" ? pageInput : "skip",
  );
  const units = useOrgQuery(
    "catalog/uoms",
    canEdit && editing?.kind === "products" ? {} : "skip",
  );
  const saveProduct = useOrgMutation("catalog/saveProduct");
  const saveCustomer = useOrgMutation("catalog/saveCustomer");
  const onSearch = useCallback((next: string) => {
    setParams({ q: next || null });
    setCursors([null]);
  }, []);
  const page =
    kind === "products" ? products : kind === "customers" ? customers : outlets;
  const rows: Row[] | null =
    page === undefined
      ? null
      : kind === "products"
        ? (products?.page ?? []).map((p) => ({
            id: p._id,
            code: p.code,
            name: p.name,
            category: p.category,
            unit: p.uomDisplay ?? p.uom,
            channel: "—",
            territory: "—",
            credit: null,
            status: p.active ? "Active" : "Inactive",
            product: p,
          }))
        : kind === "customers"
          ? (customers?.page ?? []).map((c) => ({
              id: c._id,
              code: c.code,
              name: c.name,
              category: "—",
              unit: "—",
              channel: c.channel,
              territory: c.territory,
              credit: c.creditLimitCentavos,
              status: c.active ? "Active" : "Inactive",
              customer: c,
            }))
          : (outlets?.page ?? []).map((o) => ({
              id: o._id,
              code: o.code,
              name: o.name,
              category: "—",
              unit: "—",
              channel: o.channel ?? "No channel",
              territory: o.territoryName ?? "No area",
              credit: o.creditLimitCentavos ?? null,
              status:
                o.enrolmentStatus === "provisional"
                  ? "Waiting for approval"
                  : o.status.replace(/^./, (v) => v.toUpperCase()),
              outlet: o,
            }));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || busy) return;
    const selected = editing.row;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const name = String(data.get("name") ?? "").trim(),
        reason = String(data.get("reason") ?? "").trim(),
        code = String(data.get("code") ?? "").trim();
      if (!name || !reason) throw new Error("Name and reason are required.");
      if (!selected && !code) throw new Error("Code is required.");
      const active = data.get("active") === "on";
      if (editing.kind === "products")
        await saveProduct({
          ...(selected ? { productId: selected.id } : { code }),
          name,
          category: String(data.get("category")),
          baseUomId: String(data.get("baseUomId")),
          quantityScale: selected
            ? Number(selected.product?.quantityScale ?? 1)
            : 10 **
              (units?.find((u) => u._id === String(data.get("baseUomId")))
                ?.decimalPlaces ?? 0),
          active,
          reason,
        });
      else {
        const amount = String(data.get("creditLimit") ?? "");
        if (!/^\d+(\.\d{1,2})?$/.test(amount))
          throw new Error(
            "Enter a peso credit limit with at most two decimal places.",
          );
        await saveCustomer({
          ...(selected ? { customerId: selected.id } : { code }),
          name,
          channel: String(data.get("channel")),
          territory: String(data.get("territory")),
          creditLimitCentavos: Math.round(Number(amount) * 100),
          active,
          reason,
        });
      }
      setEditing(null);
      setMessage("Saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }
  async function exportRows() {
    setBusy(true);
    setError("");
    try {
      const input = {
        q,
        ...(missingPrice && kind === "products"
          ? { missingPrice: "true" }
          : {}),
        ...(filter
          ? kind === "products"
            ? { category: filter }
            : { channel: filter }
          : {}),
      };
      if (kind === "products") {
        const all = await collectExport<Product>(
          "catalog/products/list",
          input,
        );
        downloadCsv(
          "products.csv",
          csvText([
            [
              "Code",
              "Product",
              "Category",
              "Pack conversion",
              "Price",
              "Status",
            ],
            ...all.map((r) => [
              r.code,
              r.name,
              r.category,
              r.uomDisplay ?? r.uom,
              r.priceStatus,
              r.active ? "Active" : "Inactive",
            ]),
          ]),
        );
      } else if (kind === "customers") {
        const all = await collectExport<Customer>(
          "catalog/customers/list",
          input,
        );
        downloadCsv(
          "customers.csv",
          csvText([
            [
              "Code",
              "Customer",
              "Channel",
              "Territory",
              "Credit limit (PHP)",
              "Status",
            ],
            ...all.map((r) => [
              r.code,
              r.name,
              r.channel,
              r.territory,
              r.creditLimitCentavos / 100,
              r.active ? "Active" : "Inactive",
            ]),
          ]),
        );
      } else {
        const all = await collectExport<Outlet>("outlets/list", input);
        downloadCsv(
          "stores.csv",
          csvText([
            [
              "Code",
              "Store",
              "Channel",
              "Territory",
              "Route",
              "Credit limit (PHP)",
              "Status",
            ],
            ...all.map((r) => [
              r.code,
              r.name,
              r.channel,
              r.territoryName,
              r.routeName,
              r.creditLimitCentavos == null ? "" : r.creditLimitCentavos / 100,
              r.status,
            ]),
          ]),
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Export failed. No file was downloaded.",
      );
    } finally {
      setBusy(false);
    }
  }
  const nameCol: ListColumn<Row> = {
    key: "name",
    label: kind === "products" ? "Product" : kind === "customers" ? "Customer" : "Store",
    primary: true,
    render: (r) => r.name,
    text: (r) => r.name,
  };
  const codeCol: ListColumn<Row> = {
    key: "code",
    label: "Code",
    render: (r) => <span className="tabular-nums">{r.code}</span>,
    text: (r) => r.code,
  };
  const statusCol: ListColumn<Row> = {
    key: "status",
    label: "Status",
    render: (r) => r.status,
    text: (r) => r.status,
  };
  const columns: ListColumn<Row>[] =
    kind === "products"
      ? [
          nameCol,
          codeCol,
          {
            key: "unit",
            label: "Pack",
            render: (r) => r.unit,
            text: (r) => r.unit,
          },
          {
            key: "category",
            label: "Category",
            render: (r) => r.category,
            text: (r) => r.category,
          },
          statusCol,
        ]
      : [
          nameCol,
          codeCol,
          {
            key: "channel",
            label: "Channel · area",
            render: (r) => `${r.channel} · ${r.territory}`,
            text: (r) => `${r.channel} · ${r.territory}`,
          },
          ...(kind === "customers"
            ? [
                {
                  key: "credit",
                  label: "Credit limit",
                  align: "right" as const,
                  render: (r: Row) => money(r.credit),
                  text: (r: Row) => money(r.credit),
                },
              ]
            : []),
          statusCol,
        ];
  const rowEnd =
    kind === "outlets"
      ? (r: Row) => (
          <Link
            className={editClass}
            href={`/stores?edit=${encodeURIComponent(r.id)}`}
            aria-label={`Edit ${r.name}`}
          >
            Edit
          </Link>
        )
      : canEdit
        ? (r: Row) => (
            <button
              type="button"
              className={editClass}
              aria-label={`Edit ${r.name}`}
              onClick={() => {
                setEditing({ row: r, kind: kind as Editing["kind"] });
                setError("");
              }}
            >
              Edit
            </button>
          )
        : undefined;
  const selected = editing?.row ?? null;
  return (
    <div className="grid gap-4">
      <UnderlineTabs
        label="Master data sections"
        items={tabs}
        activeId={kind}
        onChange={(value) => {
          setParams({ tab: value === "products" ? null : value, q: null });
          setCursors([null]);
          setEditing(null);
        }}
      />
      <ListPage
        noun={NOUN[kind]}
        rows={rows}
        total={
          page && page.isDone && cursors.length === 1 ? page.page.length : null
        }
        page={1}
        onPage={() => {}}
        q={q}
        onSearch={onSearch}
        searchPlaceholder={`Search ${NOUN[kind].many} by name or code`}
        onAdd={
          canEdit && kind !== "outlets"
            ? () => {
                setEditing({ row: null, kind: kind as Editing["kind"] });
                setError("");
              }
            : undefined
        }
        filters={
          kind === "products"
            ? [{ id: "missingPrice", label: "No price yet" }]
            : undefined
        }
        filter={missingPrice && kind === "products" ? "missingPrice" : null}
        onFilter={(id) => {
          setParams({ missingPrice: id ? "true" : null });
          setCursors([null]);
        }}
        columns={columns}
        rowKey={(r) => r.id}
        rowEnd={rowEnd}
        exportName={NOUN[kind].many}
        loading={page === undefined}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Pager
          label="Master data pages"
          page={cursors.length}
          canPrevious={cursors.length > 1}
          canNext={!!page && !page.isDone}
          onPrevious={() => setCursors((old) => old.slice(0, -1))}
          onNext={() =>
            page && setCursors((old) => [...old, page.continueCursor])
          }
        />
        <Button
          variant="outline"
          isPending={busy}
          onPress={() => void exportRows()}
        >
          Export CSV
        </Button>
      </div>
      <Drawer
        open={!!editing && canEdit}
        title={
          selected
            ? `Edit ${selected.name}`
            : `Add ${editing ? NOUN[editing.kind].one : ""}`
        }
        wide
        onClose={() => setEditing(null)}
      >
        {editing ? (
          <form
            key={selected?.id ?? "new"}
            onSubmit={submit}
            className="grid gap-3 sm:grid-cols-2"
          >
            {!selected ? (
              <FormField label="Code">
                <input name="code" required />
              </FormField>
            ) : null}
            <FormField label="Name">
              <input name="name" defaultValue={selected?.name} required />
            </FormField>
            {editing.kind === "products" ? (
              <>
                <FormField label="Category">
                  <input
                    name="category"
                    defaultValue={selected?.product?.category}
                    required
                  />
                </FormField>
                <FormField label="Base unit">
                  <select
                    name="baseUomId"
                    defaultValue={selected?.product?.baseUomId}
                    required
                  >
                    <option value="">Pick a unit</option>
                    {units?.map((u) => (
                      <option key={u._id} value={u._id}>
                        {u.name} · {u.code}
                      </option>
                    ))}
                  </select>
                </FormField>
              </>
            ) : (
              <>
                <FormField label="Channel">
                  <input
                    name="channel"
                    defaultValue={selected?.channel}
                    required
                  />
                </FormField>
                <FormField label="Area">
                  <input
                    name="territory"
                    defaultValue={selected?.territory}
                    required
                  />
                </FormField>
                <FormField label="Credit limit (PHP)">
                  <input
                    name="creditLimit"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={(selected?.credit ?? 0) / 100}
                    required
                  />
                </FormField>
              </>
            )}
            <label className="flex items-center gap-2 text-[14px]">
              <input
                name="active"
                type="checkbox"
                defaultChecked={!selected || selected.status === "Active"}
              />
              Active
            </label>
            <FormField label="Reason">
              <textarea name="reason" required rows={2} />
            </FormField>
            {error ? (
              <p role="alert" className="text-sm text-danger sm:col-span-2">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" variant="primary" isPending={busy}>
                Save
              </Button>
              <Button variant="outline" onPress={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </Drawer>
      {error && !editing ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
