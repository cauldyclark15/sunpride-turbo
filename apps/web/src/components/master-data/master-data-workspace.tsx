"use client";

import { useState, type FormEvent } from "react";
import {
  Card,
  DataTable,
  FormField,
  Pager,
  UnderlineTabs,
  type DataColumn,
} from "@sunpride/ui";
import { Button } from "@heroui/react";
import { useOrgMutation, useOrgQuery } from "./api";
import type { Customer, Outlet, Product } from "./model";
import { SetupSearch } from "./setup-health";
import { collectExport, csvText, downloadCsv } from "./export";
import { useSetupParam } from "./location";

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
export function MasterDataWorkspace({
  initialSection = "products",
}: { initialSection?: Kind } = {}) {
  const missingPrice = useSetupParam("missingPrice") === "true";
  const [kind, setKind] = useState<Kind>(initialSection);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const permissions = useOrgQuery("org/permissions", {});
  const canEdit =
    (permissions?.capabilities.includes("masterdata.manage") ?? false) &&
    permissions?.national !== false;
  const pageInput = {
    q,
    paginationOpts: { numItems: 25, cursor: cursors.at(-1) ?? null },
    ...(missingPrice && kind === "products" ? { missingPrice: "true" } : {}),
    ...(filter
      ? kind === "products"
        ? { category: filter }
        : { channel: filter }
      : {}),
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
    canEdit && selected?.product ? {} : "skip",
  );
  const saveProduct = useOrgMutation("catalog/saveProduct");
  const saveCustomer = useOrgMutation("catalog/saveCustomer");
  const page =
    kind === "products" ? products : kind === "customers" ? customers : outlets;
  const rows: Row[] =
    kind === "products"
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
            channel: o.channel ?? "Needs setup",
            territory: o.territoryName ?? "Unassigned",
            credit: o.creditLimitCentavos ?? null,
            status:
              o.enrolmentStatus === "provisional"
                ? "Awaiting approval"
                : o.status.replace(/^./, (v) => v.toUpperCase()),
            outlet: o,
          }));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const name = String(data.get("name") ?? "").trim(),
        reason = String(data.get("reason") ?? "").trim();
      if (!name || !reason) throw new Error("Name and reason are required.");
      const active = data.get("active") === "on";
      if (selected.product)
        await saveProduct({
          productId: selected.id,
          name,
          category: String(data.get("category")),
          baseUomId: String(data.get("baseUomId")),
          quantityScale: Number(selected.product.quantityScale ?? 1),
          active,
          reason,
        });
      else if (selected.customer) {
        const amount = String(data.get("creditLimit") ?? "");
        if (!/^\d+(\.\d{1,2})?$/.test(amount))
          throw new Error(
            "Enter a peso credit limit with at most two decimal places.",
          );
        await saveCustomer({
          customerId: selected.id,
          name,
          channel: String(data.get("channel")),
          territory: String(data.get("territory")),
          creditLimitCentavos: Math.round(Number(amount) * 100),
          active,
          reason,
        });
      }
      setSelected(null);
      setMessage("Master data saved.");
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
  const columns: DataColumn<Row>[] = [
    {
      key: "name",
      label: kind === "products" ? "Product" : "Account",
      render: (r) => (
        <span>
          <span className="block font-medium">{r.name}</span>
          <span className="text-xs text-muted">{r.code}</span>
        </span>
      ),
    },
    ...(kind === "products"
      ? [
          {
            key: "unit",
            label: "Pack and category",
            render: (r: Row) => (
              <span>
                {r.unit}
                <span className="block text-xs text-muted">
                  {r.category} · Governed price required
                </span>
              </span>
            ),
          },
        ]
      : [
          {
            key: "channel",
            label: "Channel / territory",
            render: (r: Row) => (
              <span>
                {r.channel}
                <span className="block text-xs text-muted">{r.territory}</span>
              </span>
            ),
          },
          {
            key: "credit",
            label: "Credit limit",
            render: (r: Row) => money(r.credit),
          },
        ]),
    { key: "status", label: "Status", render: (r) => r.status },
    {
      key: "actions",
      label: "Next action",
      render: (r) =>
        r.outlet ? (
          <a
            className="underline"
            href={`/admin?section=outlets&outlet=${encodeURIComponent(r.id)}`}
          >
            Open store setup
          </a>
        ) : canEdit ? (
          <Button
            size="sm"
            variant="outline"
            onPress={() => {
              setSelected(r);
              setError("");
            }}
          >
            Edit
          </Button>
        ) : (
          <span className="text-muted">Read only</span>
        ),
    },
  ];
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted">
        Can the team identify every product and account correctly? Pack
        conversions, channel and territory must be set before selling. Selling
        prices come from governed price lists, not a zero-valued product field.
      </p>
      <UnderlineTabs
        label="Master data sections"
        items={tabs}
        activeId={kind}
        onChange={(value) => {
          setKind(value);
          setCursors([null]);
          setQ("");
          setFilter("");
          setSelected(null);
        }}
      />
      <Card
        label={
          kind === "products"
            ? "Products"
            : kind === "customers"
              ? "Customers"
              : "Stores"
        }
        count={rows.length}
        actions={
          <Button
            variant="outline"
            isPending={busy}
            onPress={() => void exportRows()}
          >
            Export CSV
          </Button>
        }
        flush
      >
        <div className="grid sm:grid-cols-2">
          <SetupSearch
            label="Search master data"
            value={q}
            onChange={(value) => {
              setQ(value);
              setCursors([null]);
            }}
          />
          <SetupSearch
            label={kind === "products" ? "Filter category" : "Filter channel"}
            value={filter}
            onChange={(value) => {
              setFilter(value);
              setCursors([null]);
            }}
          />
        </div>
        {page === undefined ? (
          <p className="p-4">Loading master data…</p>
        ) : (
          <DataTable
            bare
            rows={rows}
            columns={columns}
            empty={
              <p className="p-4">No matches. Change the search or filters.</p>
            }
          />
        )}
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
      </Card>
      {selected && canEdit ? (
        <Card label={`Edit · ${selected.name}`}>
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
            <FormField label="Name">
              <input name="name" defaultValue={selected.name} required />
            </FormField>
            {selected.product ? (
              <>
                <FormField label="Category">
                  <input
                    name="category"
                    defaultValue={selected.product.category}
                    required
                  />
                </FormField>
                <FormField label="Base unit">
                  <select
                    name="baseUomId"
                    defaultValue={selected.product.baseUomId}
                    required
                  >
                    <option value="">Select unit</option>
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
                    defaultValue={selected.channel}
                    required
                  />
                </FormField>
                <FormField label="Territory">
                  <input
                    name="territory"
                    defaultValue={selected.territory}
                    required
                  />
                </FormField>
                <FormField label="Credit limit (PHP)">
                  <input
                    name="creditLimit"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={(selected.credit ?? 0) / 100}
                    required
                  />
                </FormField>
              </>
            )}
            <label>
              <input
                name="active"
                type="checkbox"
                defaultChecked={selected.status === "Active"}
              />{" "}
              Active
            </label>
            <FormField label="Reason">
              <textarea name="reason" required rows={2} />
            </FormField>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" isPending={busy}>
                Save change
              </Button>
              <Button variant="outline" onPress={() => setSelected(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
