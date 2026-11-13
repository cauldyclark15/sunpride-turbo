"use client";

/**
 * SP-0170 Customers list (customer = store): search by Customer Code / Customer Name /
 * Registered Name, the client's assignment filters, status and completeness, paged with the
 * shared ListPage pager.
 */
import { apiFetch, useApi } from "../../lib/api";
import {
  ListPage,
  PAGE_SIZE,
  type ListColumn,
  type ListFilter,
} from "../list-page/list-page";
import { inputClass } from "./customer-form";
import { formatDate } from "../../lib/format";

/** Manila calendar day of an epoch ms. */
const manilaDay = (at: number) =>
  new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);
import {
  statusLabel,
  statusTone,
  awaitsApproval,
  optionLabel,
  type CustomerRow,
  type CustomerStatus,
  type ReferenceIndex,
  type RefOption,
} from "./model";

export const CUSTOMER_STATUS_FILTERS: ListFilter[] = [
  { id: "prospect", label: "Prospect" },
  { id: "active", label: "Active" },
  { id: "inactive", label: "Inactive" },
];

export type CustomerFilters = {
  salesOrgCode?: string;
  salesOfficeCode?: string;
  distributionChannelCode?: string;
  customerGroup1Code?: string;
  customerGroup2Code?: string;
  customerGroupCode?: string;
  completeness?: string;
  /** SP-0175: the person who added the store, and the Manila day (YYYY-MM-DD). */
  addedBy?: string;
  addedOn?: string;
};

export type Adder = { id: string; name: string };

/** A filter whose parent changed is dropped (same chain as the form). */
export const FILTER_DEPENDENTS: Record<string, (keyof CustomerFilters)[]> = {
  salesOrgCode: [
    "salesOfficeCode",
    "distributionChannelCode",
    "customerGroup1Code",
    "customerGroup2Code",
  ],
  distributionChannelCode: ["customerGroup1Code", "customerGroup2Code"],
  customerGroup1Code: ["customerGroup2Code"],
};

export function nameOf(
  index: ReferenceIndex,
  list: string,
  code: string | null,
) {
  if (!code) return "";
  const row = (index.all(list) as RefOption[]).find((r) => r.code === code);
  return row ? optionLabel(row) : code;
}

export function customerColumns(
  index: ReferenceIndex,
): ListColumn<CustomerRow>[] {
  const coded = (name: string | null, code: string | null) =>
    code ? (name ? `${name} (${code})` : code) : "";
  return [
    {
      key: "code",
      label: "Customer Code",
      render: (r) => <span className="tabular-nums">{r.code}</span>,
      text: (r) => r.code,
    },
    {
      key: "name",
      label: "Customer Name",
      primary: true,
      render: (r) => r.customerName,
      text: (r) => r.customerName,
    },
    {
      key: "registered",
      label: "Registered Name",
      render: (r) => r.registeredName ?? "",
      text: (r) => r.registeredName ?? "",
    },
    {
      key: "channel",
      label: "Distribution Channel",
      render: (r) =>
        coded(r.distributionChannelName, r.distributionChannelCode),
      text: (r) => coded(r.distributionChannelName, r.distributionChannelCode),
    },
    {
      key: "group",
      label: "Customer Group",
      render: (r) => coded(r.customerGroupName, r.customerGroupCode),
      text: (r) => coded(r.customerGroupName, r.customerGroupCode),
    },
    {
      key: "office",
      label: "Sales Office",
      render: (r) => nameOf(index, "sales_office", r.salesOfficeCode),
      text: (r) => nameOf(index, "sales_office", r.salesOfficeCode),
    },
    {
      key: "added",
      label: "Added by",
      render: (r) =>
        r.addedByName || r.addedAt ? (
          <span className="inline-flex flex-col">
            <span>{r.addedByName ?? ""}</span>
            {r.addedAt ? (
              <span className="text-[12px] text-muted tabular-nums">
                {formatDate(manilaDay(r.addedAt))}
              </span>
            ) : null}
          </span>
        ) : (
          ""
        ),
      text: (r) =>
        [r.addedByName, r.addedAt ? manilaDay(r.addedAt) : null]
          .filter(Boolean)
          .join(" "),
    },
    {
      key: "municipality",
      label: "Municipality",
      render: (r) => r.municipalityName ?? "",
      text: (r) => r.municipalityName ?? "",
    },
    {
      key: "status",
      label: "Status",
      render: (r) => (
        <span className="inline-flex flex-col">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${statusTone(r) === "good" ? "bg-[#1f7a43]" : statusTone(r) === "wait" ? "bg-[#c27a0a]" : "bg-[#9aa0a6]"}`}
            />
            {statusLabel(r)}
          </span>
          {r.completeness === "draft" ? (
            <span className="text-[12px] text-muted">Incomplete</span>
          ) : null}
        </span>
      ),
      text: (r) => statusLabel(r),
    },
  ];
}

/** Assignment filters as dropdowns, each "Description (Code)" and narrowed by its parent. */
export function CustomerFilterBar({
  index,
  filters,
  onFilter,
  adders = [],
}: {
  index: ReferenceIndex;
  filters: CustomerFilters;
  onFilter: (key: keyof CustomerFilters, value: string | null) => void;
  /** People who added stores in scope, for the "Added by" filter. */
  adders?: Adder[];
}) {
  const org = filters.salesOrgCode ?? null;
  const ch = filters.distributionChannelCode ?? null;
  const g1 = filters.customerGroup1Code ?? null;
  const opts = (
    list: string,
    parent: Record<string, string | null> = {},
  ): { code: string; label: string }[] => {
    const seen = new Set<string>();
    return (index.options(list, parent) as RefOption[])
      .filter((r) => !seen.has(r.code) && Boolean(seen.add(r.code)))
      .map((r) => ({ code: r.code, label: optionLabel(r) }));
  };
  const selects: {
    key: keyof CustomerFilters;
    label: string;
    options: { code: string; label: string }[];
  }[] = [
    {
      key: "salesOrgCode",
      label: "Sales Organization",
      options: opts("sales_organization"),
    },
    {
      key: "salesOfficeCode",
      label: "Sales Office",
      options: opts("sales_office", { salesOrgCode: org }),
    },
    {
      key: "distributionChannelCode",
      label: "Distribution Channel",
      options: opts("distribution_channel", { salesOrgCode: org }),
    },
    {
      key: "customerGroup1Code",
      label: "Customer Grp 1",
      options: ch
        ? opts("customer_group_1", { salesOrgCode: org, channelCode: ch })
        : [],
    },
    {
      key: "customerGroup2Code",
      label: "Customer Grp 2",
      options: g1
        ? opts("customer_group_2", {
            salesOrgCode: org,
            channelCode: ch,
            group1Code: g1,
          })
        : [],
    },
    {
      key: "customerGroupCode",
      label: "Customer Group",
      options: opts("customer_group"),
    },
  ];
  return (
    <div
      className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4"
      aria-label="Customer filters"
      role="group"
    >
      {selects.map((s) => (
        <label key={s.key} className="grid gap-1 text-[12px] text-muted">
          {s.label}
          <select
            className={`${inputClass} border-border text-foreground`}
            value={filters[s.key] ?? ""}
            disabled={s.options.length === 0}
            onChange={(e) => onFilter(s.key, e.target.value || null)}
          >
            <option value="">All</option>
            {s.options.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <label className="grid gap-1 text-[12px] text-muted">
        Completeness
        <select
          className={`${inputClass} border-border text-foreground`}
          value={filters.completeness ?? ""}
          onChange={(e) => onFilter("completeness", e.target.value || null)}
        >
          <option value="">All</option>
          <option value="complete">Complete</option>
          <option value="draft">Incomplete</option>
        </select>
      </label>
      <label className="grid gap-1 text-[12px] text-muted">
        Added by
        <select
          className={`${inputClass} border-border text-foreground`}
          value={filters.addedBy ?? ""}
          onChange={(e) => onFilter("addedBy", e.target.value || null)}
        >
          <option value="">Anyone</option>
          {filters.addedBy && !adders.some((a) => a.id === filters.addedBy) ? (
            <option value={filters.addedBy}>Selected person</option>
          ) : null}
          {adders.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-[12px] text-muted">
        Added on
        <input
          type="date"
          className={`${inputClass} border-border text-foreground`}
          value={filters.addedOn ?? ""}
          onChange={(e) => onFilter("addedOn", e.target.value || null)}
        />
      </label>
    </div>
  );
}

type ListResponse = {
  rows: CustomerRow[];
  adders?: Adder[];
  nextCursor: string | null;
  total?: number;
  statusCounts?: StatusCounts | null;
};

export type StatusCounts = {
  all: number;
  prospect: number;
  active: number;
  inactive: number;
};

/** WEB-040: each status chip carries its count for the current search and filters. */
export function statusFilters(counts?: StatusCounts | null): ListFilter[] {
  return CUSTOMER_STATUS_FILTERS.map((f) => ({
    ...f,
    count: counts ? (counts[f.id as keyof StatusCounts] ?? null) : null,
  }));
}

/** Reads the list for the URL state; `offset` paging so the shared pager can jump pages. */
export function useCustomerList(
  q: string,
  status: CustomerStatus | null,
  filters: CustomerFilters,
  page: number,
  awaitingApproval = false,
) {
  const query = {
    q: q || undefined,
    status: status ?? undefined,
    awaitingApproval: awaitingApproval ? "true" : undefined,
    ...filters,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };
  return useApi<ListResponse>(["customers", "list", query], (ctx) =>
    apiFetch<ListResponse>("/api/v1/customers", {
      query,
      signal: ctx.signal,
    }),
  );
}

export function CustomerListView({
  index,
  rows,
  total,
  page,
  q,
  status,
  filters,
  statusCounts = null,
  loading = false,
  canAdd,
  onSearch,
  onPage,
  onAdd,
  onStatus,
  onFilter,
  onEdit,
  customerHref,
  adders = [],
}: {
  adders?: Adder[];
  index: ReferenceIndex;
  rows: CustomerRow[] | null;
  total: number | null;
  page: number;
  q: string;
  status: CustomerStatus | null;
  filters: CustomerFilters;
  statusCounts?: StatusCounts | null;
  loading?: boolean;
  canAdd: boolean;
  onSearch: (q: string) => void;
  onPage: (page: number) => void;
  onAdd: (name: string) => void;
  onStatus: (status: CustomerStatus | null) => void;
  onFilter: (key: keyof CustomerFilters, value: string | null) => void;
  /** Omit when the person may not edit customers. */
  onEdit?: (row: CustomerRow) => void;
  customerHref: (row: CustomerRow) => string;
}) {
  return (
    <div className="grid gap-4">
      <ListPage
        noun={{ one: "customer", many: "customers" }}
        filterPanel={{
          // WEB-177: at phone width the seven dropdowns fold behind "Filters".
          node: (
            <CustomerFilterBar
              index={index}
              filters={filters}
              onFilter={onFilter}
              adders={adders}
            />
          ),
          active: Object.values(filters).filter(Boolean).length,
        }}
        rows={rows}
        total={total}
        page={page}
        onPage={onPage}
        q={q}
        onSearch={onSearch}
        searchPlaceholder="Search by Customer Code, Customer Name or Registered Name"
        onAdd={canAdd ? onAdd : undefined}
        addLabel="Add customer"
        columns={customerColumns(index)}
        rowKey={(r) => r.id}
        rowHref={customerHref}
        filters={statusFilters(statusCounts)}
        allCount={statusCounts?.all ?? null}
        filter={status}
        onFilter={(id) => onStatus((id as CustomerStatus | null) ?? null)}
        exportName="customers"
        rowEnd={
          onEdit
            ? (r) => (
                <button
                  type="button"
                  className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-[13px] font-medium text-foreground hover:bg-default-soft"
                  aria-label={`${awaitsApproval(r) ? "Complete" : "Edit"} ${r.customerName}`}
                  onClick={() => onEdit(r)}
                >
                  {awaitsApproval(r) ? "Complete" : "Edit"}
                </button>
              )
            : undefined
        }
        loading={loading}
      />
    </div>
  );
}
