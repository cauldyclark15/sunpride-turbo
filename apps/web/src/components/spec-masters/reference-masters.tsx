"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Card, FormField, Notice, Pager } from "@sunpride/ui";
import { mutate, useApi, useLive } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { useQuery } from "../master-data/api";
import { CustomerGroupsAdmin } from "../customer-groups-admin";

type PlaceKind = "region" | "province" | "municipality" | "barangay";
type ReferenceRow = {
  id?: string;
  code: string;
  name: string;
  updatedAt: string;
  salesOrgCode?: string;
  parentCode?: string;
  parentName?: string;
};
type ChannelSetup = {
  rows: ReferenceRow[];
  salesOrgs: { code: string; name: string }[];
};
type PlacePage = { rows: ReferenceRow[]; hasMore: boolean };
const kinds: [PlaceKind, string][] = [
  ["region", "Region"],
  ["province", "Province"],
  ["municipality", "City / Municipality"],
  ["barangay", "Barangay"],
];
const parentKind: Record<PlaceKind, PlaceKind | null> = {
  region: null,
  province: "region",
  municipality: "province",
  barangay: "municipality",
};
const button =
  "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50";
const control =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";

export function ReferenceMasters({ other }: { other: React.ReactNode }) {
  const [section, setSection] = useState("customer-groups");
  const permissions = useQuery("org/permissions", {});
  const national =
    !!permissions?.national &&
    permissions.capabilities.includes("territory.manage");
  useLive(["masters", "org"], [["masters"], ["setup"]]);
  return (
    <div className="grid gap-4">
      <nav className="flex flex-wrap gap-2" aria-label="Field master sections">
        {[
          ["customer-groups", "Customer groups"],
          ["channels", "Channels"],
          ["places", "Places"],
          ["stock-reasons", "Stock reasons"],
          ["log", "Change log"],
          ["other", "Other field masters"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={button}
            aria-pressed={section === key}
            onClick={() => setSection(key!)}
          >
            {label}
          </button>
        ))}
      </nav>
      {section === "other" ? (
        other
      ) : section === "customer-groups" ? (
        <CustomerGroupsAdmin />
      ) : !permissions ? (
        <p>Loading access…</p>
      ) : !national ? (
        <Notice
          title="A national administrator maintains these shared lists and their change log."
          tone="warning"
        />
      ) : section === "channels" ? (
        <Channels />
      ) : section === "places" ? (
        <Places />
      ) : section === "stock-reasons" ? (
        <StockReasons />
      ) : (
        <ReferenceChangeLog />
      )}
    </div>
  );
}

/** Shared, explicit form-to-command boundary, also exercised without a browser. */
export function referenceSaveBody(
  mode: "channel" | PlaceKind,
  form: Pick<FormData, "get">,
  current?: ReferenceRow,
) {
  const text = (key: string) => String(form.get(key) ?? "").trim();
  return {
    name: text("name"),
    reason: text("reason"),
    ...(current ? { baseUpdatedAt: current.updatedAt } : {}),
    ...(mode === "channel"
      ? current
        ? { id: current.id }
        : { code: text("code"), salesOrgCode: text("salesOrgCode") }
      : {
          kind: mode,
          code: current?.code ?? text("code"),
          create: !current,
          ...(parentKind[mode] ? { parentCode: text("parentCode") } : {}),
        }),
  };
}
function Channels() {
  const setup = useApi<ChannelSetup>(
    ["masters", "channels"],
    "/api/v1/masters/channels",
  );
  const [current, setCurrent] = useState<ReferenceRow>();
  const [message, setMessage] = useState("");
  return (
    <Card label="Distribution channels">
      <div className="grid gap-4">
        <p>
          Maintain the distribution channels used on the customer form. Codes
          stay unchanged; this does not change selling prices.
        </p>
        {setup.error ? (
          <Notice title={setup.error.message} tone="danger" />
        ) : !setup.data ? (
          <p>Loading channels…</p>
        ) : (
          <>
            <button className={button} onClick={() => setCurrent(undefined)}>
              Add distribution channel
            </button>
            <ul className="grid gap-2">
              {setup.data.rows.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span>
                    {r.salesOrgCode} / {r.code} · {r.name}
                  </span>
                  <button className={button} onClick={() => setCurrent(r)}>
                    Edit {r.name}
                  </button>
                </li>
              ))}
            </ul>
            <ReferenceForm
              key={`${current?.id ?? "new"}:${current?.updatedAt ?? ""}`}
              mode="channel"
              current={current}
              salesOrgs={setup.data.salesOrgs}
              onSaved={() => {
                setCurrent(undefined);
                setMessage(
                  "Channel saved. Open Change log to see what changed, the reason, who and when.",
                );
              }}
            />
          </>
        )}
        {message && <p role="status">{message}</p>}
      </div>
    </Card>
  );
}
type StockReason = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  updatedAt: string;
};
/** SP-0227 truck stock reasons used in the Saturday count. Never deleted; retire instead. */
export function stockReasonSaveBody(
  form: Pick<FormData, "get">,
  current?: StockReason,
) {
  const text = (key: string) => String(form.get(key) ?? "").trim();
  return {
    name: text("name"),
    reason: text("reason"),
    active: current ? form.get("active") === "on" : true,
    ...(current ? { id: current.id, baseUpdatedAt: current.updatedAt } : {}),
  };
}
function StockReasons() {
  const setup = useApi<{ rows: StockReason[] }>(
    ["masters", "stock-reasons"],
    "/api/v1/masters/stock-reasons",
  );
  const [current, setCurrent] = useState<StockReason>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestKey, setRequestKey] = useState<string>();
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const body = stockReasonSaveBody(new FormData(e.currentTarget), current);
    const key = requestKey ?? crypto.randomUUID();
    setRequestKey(key);
    setBusy(true);
    setError("");
    try {
      await mutate("/api/v1/masters/reference/stock-reason-save", body, {
        idempotencyKey: key,
        invalidate: [["masters"]],
      });
      setRequestKey(undefined);
      setCurrent(undefined);
      setMessage(
        "Stock reason saved. Salesmen see it after their next Field app sync.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card label="Stock reasons">
      <div className="grid gap-4">
        <p>
          Reasons the salesman picks in his Saturday truck stock count. A reason
          that was used is never deleted; turn it off instead and old counts
          keep their reason.
        </p>
        {setup.error ? (
          <Notice title={setup.error.message} tone="danger" />
        ) : !setup.data ? (
          <p>Loading stock reasons…</p>
        ) : (
          <>
            <button className={button} onClick={() => setCurrent(undefined)}>
              Add stock reason
            </button>
            <ul className="grid gap-2">
              {setup.data.rows.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span>
                    {r.name}
                    {r.active ? "" : " · Not in use"}
                  </span>
                  <button className={button} onClick={() => setCurrent(r)}>
                    Edit {r.name}
                  </button>
                </li>
              ))}
            </ul>
            <form
              key={`${current?.id ?? "new"}:${current?.updatedAt ?? ""}`}
              className="grid gap-3 border-t border-border pt-4"
              onSubmit={save}
              onChange={() => setRequestKey(undefined)}
            >
              <h3>{current ? `Edit ${current.name}` : "New stock reason"}</h3>
              <FormField label="Name">
                <input
                  name="name"
                  className={control}
                  defaultValue={current?.name}
                  maxLength={120}
                  required
                />
              </FormField>
              {current && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="active"
                    defaultChecked={current.active}
                  />
                  In use (salesmen can choose it)
                </label>
              )}
              <FormField label="Reason for this change">
                <input
                  name="reason"
                  className={control}
                  maxLength={500}
                  required
                />
              </FormField>
              <button className={button} disabled={busy}>
                Save stock reason
              </button>
              {error && <p role="alert">{error}</p>}
            </form>
          </>
        )}
        {message && <p role="status">{message}</p>}
      </div>
    </Card>
  );
}
function Places() {
  const [kind, setKind] = useState<PlaceKind>("municipality");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [current, setCurrent] = useState<ReferenceRow>();
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState("");
  const page = useApi<PlacePage>(
    ["masters", "places", kind, q, offset],
    `/api/v1/masters/places?kind=${kind}&q=${encodeURIComponent(q)}&offset=${offset}`,
  );
  return (
    <Card label="Places">
      <div className="grid gap-4">
        <p>
          Rename a place or move it under its new parent after a realignment.
          Its PSGC code stays the same. Current customer addresses and automatic
          territory coverage are updated together; approved coverage plans are
          protected.
        </p>
        <p>
          <Link href="/admin?section=territories" className="underline">
            Re-map the places or customer groups covered by a territory in Setup
            &gt; Territories.
          </Link>{" "}
          Those coverage changes also appear in Change log.
        </p>
        <FormField label="Place type">
          <select
            className={control}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as PlaceKind);
              setOffset(0);
              setCurrent(undefined);
              setAdding(false);
            }}
          >
            {kinds.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Search places by name or PSGC code">
          <input
            className={control}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
          />
        </FormField>
        <button
          className={button}
          onClick={() => {
            setCurrent(undefined);
            setAdding(true);
          }}
        >
          Add place with an official PSGC code
        </button>
        {page.error ? (
          <Notice title={page.error.message} tone="danger" />
        ) : !page.data ? (
          <p>Loading places…</p>
        ) : (
          <>
            {!page.data.rows.length && <p>No places match this search.</p>}
            <ul className="grid gap-2">
              {page.data.rows.map((r) => (
                <li
                  key={r.code}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span>
                    {r.name} · {r.code}
                    {r.parentName ? ` · ${r.parentName}` : ""}
                  </span>
                  <button
                    className={button}
                    onClick={() => {
                      setCurrent(r);
                      setAdding(false);
                    }}
                  >
                    Edit {r.name}
                  </button>
                </li>
              ))}
            </ul>
            <Pager
              label="Places pages"
              page={offset / 25 + 1}
              canPrevious={offset > 0}
              canNext={page.data.hasMore}
              onPrevious={() => setOffset(offset - 25)}
              onNext={() => setOffset(offset + 25)}
            />
          </>
        )}
        {(current || adding) && (
          <ReferenceForm
            key={`${kind}:${current?.code ?? "new"}:${current?.updatedAt ?? ""}`}
            mode={kind}
            current={current}
            onSaved={() => {
              setCurrent(undefined);
              setAdding(false);
              setMessage(
                "Place saved. Current customer details were updated. Open Change log to review the change.",
              );
            }}
          />
        )}
        {message && <p role="status">{message}</p>}
      </div>
    </Card>
  );
}
export function ReferenceForm({
  mode,
  current,
  salesOrgs = [],
  onSaved,
}: {
  mode: "channel" | PlaceKind;
  current?: ReferenceRow;
  salesOrgs?: { code: string; name: string }[];
  onSaved: () => void;
}) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [parent, setParent] = useState(current?.parentCode ?? "");
  const [parentLabel, setParentLabel] = useState(current?.parentName ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestKey, setRequestKey] = useState<string>();
  const parentType = mode === "channel" ? null : parentKind[mode];
  const choices = useApi<PlacePage>(
    parentType
      ? ["masters", "parent-places", parentType, search, offset]
      : null,
    `/api/v1/masters/places?kind=${parentType}&q=${encodeURIComponent(search)}&offset=${offset}`,
  );
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const body = referenceSaveBody(
      mode,
      new FormData(e.currentTarget),
      current,
    );
    const key = requestKey ?? crypto.randomUUID();
    setRequestKey(key);
    setBusy(true);
    setError("");
    try {
      await mutate(
        `/api/v1/masters/reference/${mode === "channel" ? "channel" : "place"}-save`,
        body,
        {
          idempotencyKey: key,
          invalidate: [["masters"], ["setup"], ["customers"]],
        },
      );
      setRequestKey(undefined);
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="grid gap-3 border-t border-border pt-4"
      onSubmit={save}
      onChange={() => setRequestKey(undefined)}
    >
      <h3>
        {current
          ? `Edit ${current.name}`
          : mode === "channel"
            ? "New distribution channel"
            : "New place"}
      </h3>
      {current ? (
        <p>
          Code: {current.code}
          {current.salesOrgCode
            ? ` · Sales organization: ${current.salesOrgCode}`
            : ""}{" "}
          (unchanged)
        </p>
      ) : (
        <FormField
          label={
            mode === "channel"
              ? "Channel code"
              : "Official PSGC code (10 digits)"
          }
        >
          <input
            name="code"
            required
            maxLength={mode === "channel" ? 40 : 10}
            pattern={mode === "channel" ? undefined : "[0-9]{10}"}
            className={control}
          />
        </FormField>
      )}
      {mode === "channel" && !current && (
        <FormField label="Sales organization">
          <select name="salesOrgCode" required className={control}>
            <option value="">Choose…</option>
            {salesOrgs.map((o) => (
              <option key={o.code} value={o.code}>
                {o.code} · {o.name}
              </option>
            ))}
          </select>
        </FormField>
      )}
      <FormField label="Name">
        <input
          name="name"
          className={control}
          defaultValue={current?.name}
          maxLength={200}
          required
        />
      </FormField>
      {parentType && (
        <fieldset className="grid gap-2">
          <legend>Parent {kinds.find((k) => k[0] === parentType)?.[1]}</legend>
          <p>
            {parent
              ? `Selected: ${parentLabel} · ${parent}`
              : "Choose an existing parent place."}
          </p>
          <input type="hidden" name="parentCode" value={parent} />
          <FormField label="Search parent places">
            <input
              className={control}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
          </FormField>
          {choices.error ? (
            <Notice title={choices.error.message} tone="danger" />
          ) : !choices.data ? (
            <p>Loading parent places…</p>
          ) : (
            <>
              {choices.data.rows.map((r) => (
                <label key={r.code} className="flex gap-2">
                  <input
                    type="radio"
                    name="parentChoice"
                    checked={parent === r.code}
                    onChange={() => {
                      setParent(r.code);
                      setParentLabel(r.name);
                    }}
                  />
                  {r.name} · {r.code}
                  {r.parentName ? ` · ${r.parentName}` : ""}
                </label>
              ))}
              {!choices.data.rows.length && <p>No parent places match.</p>}
              <Pager
                label="Parent places pages"
                page={offset / 25 + 1}
                canPrevious={offset > 0}
                canNext={choices.data.hasMore}
                onPrevious={() => setOffset(offset - 25)}
                onNext={() => setOffset(offset + 25)}
              />
            </>
          )}
        </fieldset>
      )}
      <FormField label="Reason for this change">
        <textarea name="reason" className={control} required maxLength={500} />
      </FormField>
      {error && <p role="alert">{error}</p>}
      <button className={button} disabled={busy || (!!parentType && !parent)}>
        {busy ? "Saving…" : "Save change"}
      </button>
    </form>
  );
}

type Change = {
  id: string;
  kind: string;
  label: string;
  reason: string;
  actorName: string;
  createdAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};
const labels: Record<string, string> = {
  customer_group: "Customer groups",
  group_store: "Group stores",
  channel: "Channels",
  place: "Places",
  territory: "Territory coverage",
  stock_reason: "Stock reasons",
  active: "Active",
  code: "Code",
  name: "Name",
  salesOrgCode: "Sales organization",
  parentCode: "Parent place",
  type: "Territory type",
  coverage: "Places / Groups",
};
function valueText(value: unknown): string {
  if (value == null) return "Not set";
  if (Array.isArray(value))
    return value.length ? value.map(valueText).join(", ") : "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object")
    return "name" in value
      ? String(value.name)
      : Object.values(value).map(valueText).join(" · ");
  return value === "customer_group"
    ? "Customer group"
    : value === "location"
      ? "Location"
      : String(value);
}
export function ReferenceChangeLog() {
  const [kind, setKind] = useState("");
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const cursor = pages.at(-1);
  const data = useApi<{ rows: Change[]; next: string | null }>(
    ["masters", "reference-log", kind, cursor],
    `/api/v1/masters/reference-log?kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  return (
    <Card label="Change log">
      <div className="grid gap-4">
        <FormField label="Changes to">
          <select
            className={control}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setPages([null]);
            }}
          >
            <option value="">All field reference changes</option>
            {[
              "customer_group",
              "group_store",
              "channel",
              "place",
              "territory",
              "stock_reason",
            ].map((k) => (
              <option key={k} value={k}>
                {labels[k]}
              </option>
            ))}
          </select>
        </FormField>
        {data.error ? (
          <Notice title={data.error.message} tone="danger" />
        ) : !data.data ? (
          <p>Loading change log…</p>
        ) : (
          <>
            {!data.data.rows.length && <p>No recorded changes yet.</p>}
            {data.data.rows.map((r) => (
              <article
                key={r.id}
                className="grid gap-2 border-b border-border pb-4"
              >
                <h3>
                  {labels[r.kind] ?? r.kind} · {r.label}
                </h3>
                <p>
                  {r.actorName} · {formatDateTime(r.createdAt)}
                </p>
                <p>Reason: {r.reason}</p>
                <div className="grid gap-3 md:grid-cols-2">
                  {(["before", "after"] as const).map((side) => (
                    <section key={side}>
                      <h4>{side === "before" ? "Before" : "After"}</h4>
                      {r[side] ? (
                        <dl>
                          {Object.entries(r[side]!).map(([key, value]) => (
                            <div key={key}>
                              <dt className="text-xs text-muted">
                                {labels[key] ?? key}
                              </dt>
                              <dd>{valueText(value)}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        <p>{side === "before" ? "New record" : "Removed"}</p>
                      )}
                    </section>
                  ))}
                </div>
              </article>
            ))}
            <Pager
              label="Change log pages"
              page={pages.length}
              canPrevious={pages.length > 1}
              canNext={!!data.data.next}
              onPrevious={() => setPages((p) => p.slice(0, -1))}
              onNext={() => setPages((p) => [...p, data.data!.next])}
            />
          </>
        )}
      </div>
    </Card>
  );
}
