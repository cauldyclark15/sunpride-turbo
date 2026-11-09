"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { formatDateRange } from "../cockpit/format";
import { Drawer } from "../cockpit/kit/drawer";
import { useUrlState } from "../cockpit/use-url-state";
import { ListPage, PAGE_SIZE, readPage } from "../list-page/list-page";
import { UrlTabs } from "../url-tabs";
import { apiFetch, mutate, useApi, useLive } from "../../lib/api";
import { useSession } from "../../lib/auth/session";
import { TrendChart } from "../cockpit/kit/trend-chart";
import { ClaimantClaims } from "../claimant-claims";

export type AgencyEvidence = {
  retailIssueFeedAvailable?: boolean;
  partner: { id: string; name: string; sample: boolean };
  from: string;
  to: string;
  source: string;
  evidenceHash: string;
  summary: {
    staff: number;
    planned: number;
    attended: number;
    completed: number;
    compliant: number;
    issues: number;
    eligibleDays: number;
    amountCentavos: number;
  };
  rows: Array<{
    profileId: string;
    name: string;
    date: string;
    planned: number;
    attended: number;
    completed: number;
    compliant: number;
    issues: number;
    target: number | null;
    eligible: boolean;
    amountCentavos: number;
    billingIssue?: string | null;
  }>;
  visits: Array<{
    id: string;
    profileId: string;
    name: string;
    outlet: string;
    date: string;
    attended: boolean;
    completed: boolean;
    compliant: boolean;
    issues: string[];
    dwellMs: number | null;
    sources?: {
      activities: Array<{ kind: string }>;
      contractVersion: number | null;
    };
  }>;
};
type Setup = {
  staff: Array<{ id: string; name: string; email: string; grants: string[] }>;
  outlets: Array<{
    id: string;
    outlet_id: string;
    name: string;
    effective_from: string;
    effective_to: string | null;
  }>;
  outletOptions: Array<{ id: string; name: string }>;
  contracts: Array<{
    id: string;
    version: number;
    rate_centavos: number;
    minimum_calls: number;
    minimum_dwell_ms: number;
    minimum_retail_score: number;
    required_kinds: string[];
    source_ref: string;
    effective_from: string;
    effective_to: string | null;
  }>;
  periods: Array<{
    id: string;
    period_from: string;
    period_to: string;
    evidence_hash: string;
    decision: string | null;
  }>;
};
type Billing = {
  id: string;
  from: string;
  to: string;
  evidenceHash: string;
  stale: boolean;
  lines: AgencyEvidence["rows"];
  decision: { decision: string; reviewer: string; reason: string } | null;
};
const panel = "rounded-xl border border-border bg-surface p-5";
const button =
  "min-h-10 rounded-lg border border-border px-3 text-sm font-medium disabled:opacity-40";
const field =
  "mt-1 min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm";
const money = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(
    n / 100,
  );
const dateOf = (n: number) => new Date(n).toISOString().slice(0, 10);
const effectiveLabel = (value: string) =>
  new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(new Date(value));
export function effectiveManilaTime(value: FormDataEntryValue | null) {
  return typeof value === "string" && value
    ? new Date(`${value}+08:00`).toISOString()
    : undefined;
}
export function comparisonPeriod(from: string, to: string) {
  if (
    !Number.isFinite(Date.parse(from)) ||
    !Number.isFinite(Date.parse(to)) ||
    from > to
  )
    return { from, to };
  const days = Math.floor((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  return {
    from: dateOf(Date.parse(from) - days * 86400000),
    to: dateOf(Date.parse(from) - 86400000),
  };
}

/** F-319: exceptions first, comparison, trend and person → call evidence drill. */
export function AgencyEvidenceView({
  data,
  prior,
  onBuild,
  busy = false,
}: {
  data: AgencyEvidence;
  prior?: AgencyEvidence;
  onBuild?: () => void;
  busy?: boolean;
}) {
  const [person, setPerson] = useState("");
  const people = [
    ...new Map(data.rows.map((r) => [r.profileId, r.name])).entries(),
  ];
  const visits = data.visits.filter((v) => !person || v.profileId === person);
  const dates = [...new Set(data.rows.map((r) => r.date))];
  const values = dates.map((d) =>
    data.rows.filter((r) => r.date === d).reduce((n, r) => n + r.compliant, 0),
  );
  const targets = dates.map((d) => {
    const rows = data.rows.filter((r) => r.date === d);
    return rows.some((r) => r.target === null)
      ? null
      : rows.reduce((n, r) => n + (r.target ?? 0), 0);
  });
  return (
    <div className="space-y-5">
      <section className={panel}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-widest text-muted">
              System evidence {data.partner.sample ? "· Sample data" : ""}
            </p>
            <h2 className="mt-1 text-xl font-semibold">{data.partner.name}</h2>
          </div>
          {onBuild ? (
            <button className={button} disabled={busy} onClick={onBuild}>
              Build billing evidence
            </button>
          ) : null}
        </div>
        <p className="mt-3 text-sm text-muted">
          {data.summary.issues
            ? `${data.summary.issues} checks need attention. Review the calls below before billing.`
            : "No outstanding checks in the recorded calls. Days without qualifying evidence are not billable."}
        </p>
        {data.retailIssueFeedAvailable === false ? (
          <p className="mt-2 text-sm text-muted">
            Operational incident feed is not connected. These figures cover
            recorded call checks and the configured contract only.
          </p>
        ) : null}
        {data.rows
          .filter((r) => r.billingIssue)
          .map((r) => (
            <p key={`${r.profileId}-${r.date}`} className="mt-2 text-sm">
              {r.name} · {r.date}: {r.billingIssue}
            </p>
          ))}
      </section>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          [
            "Attendance",
            data.summary.attended,
            prior?.summary.attended,
            "Verified check-ins, not an agency attendance sheet.",
          ],
          [
            "Completed calls",
            data.summary.completed,
            prior?.summary.completed,
            `${data.summary.planned} signed planned stops in this period.`,
          ],
          [
            "Compliant calls",
            data.summary.compliant,
            prior?.summary.compliant,
            "Required activities, location and independent reviews checked.",
          ],
          [
            "Evidence-supported billing",
            money(data.summary.amountCentavos),
            prior ? money(prior.summary.amountCentavos) : undefined,
            `${data.summary.eligibleDays} qualified staff days. Not a payment instruction.`,
          ],
        ].map(([label, value, previous, note]) => (
          <section key={String(label)} className={panel}>
            <p className="text-sm text-muted">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
            <p className="mt-2 text-xs text-muted">
              Prior period: {previous ?? "Unavailable"}
            </p>
            <p className="mt-2 text-xs text-muted">{note}</p>
          </section>
        ))}
      </div>
      <section className={panel}>
        <h3 className="mb-4 font-medium">
          Compliant work against contract minimum
        </h3>
        <TrendChart
          label="Agency compliant calls by day"
          dates={dates}
          unit="count"
          series={[
            { key: "actual", label: "Compliant calls", kind: "bar", values },
            {
              key: "target",
              label: "Contract minimum",
              kind: "target",
              values: targets,
            },
          ]}
        />
      </section>
      <section className={panel}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h3 className="font-medium">Staff and call evidence</h3>
          <label className="text-sm">
            Staff member
            <select
              className={field}
              value={person}
              onChange={(e) => setPerson(e.target.value)}
            >
              <option value="">All assigned staff</option>
              {people.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!visits.length ? (
          <p className="mt-5 text-sm text-muted">
            No system-recorded calls for this selection. Attendance and billable
            work are not inferred.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  {[
                    "Staff / store",
                    "Date",
                    "Attendance",
                    "Completion",
                    "Compliance / next action",
                  ].map((h) => (
                    <th
                      className="border-b border-border py-3 pr-4 font-medium"
                      key={h}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...visits]
                  .sort(
                    (a, b) =>
                      Number(b.issues.length > 0) - Number(a.issues.length > 0),
                  )
                  .map((v) => (
                    <tr key={v.id}>
                      <td className="border-b border-border py-3 pr-4">
                        <p>{v.name}</p>
                        <p className="text-xs text-muted">{v.outlet}</p>
                      </td>
                      <td className="border-b border-border py-3 pr-4">
                        {v.date}
                      </td>
                      <td className="border-b border-border py-3 pr-4">
                        {v.attended ? "Verified" : "Needs review"}
                      </td>
                      <td className="border-b border-border py-3 pr-4">
                        {v.completed ? "Completed" : "Not completed"}
                      </td>
                      <td className="border-b border-border py-3 pr-4">
                        <details>
                          <summary className="cursor-pointer">
                            {v.compliant
                              ? "Evidence complete"
                              : `Review ${v.issues.length} ${v.issues.length === 1 ? "check" : "checks"}`}
                          </summary>
                          <p className="mt-2 text-xs text-muted">
                            {v.dwellMs === null
                              ? "Call duration unavailable"
                              : `${Math.floor(v.dwellMs / 60000)} minutes recorded`}
                          </p>
                          <p className="mt-1 text-xs text-muted">
                            Activities:{" "}
                            {v.sources?.activities
                              .map((a) => a.kind.replaceAll("_", " "))
                              .join(", ") || "No recorded activity evidence"}
                          </p>
                          <ul className="mt-2 space-y-1 text-xs text-muted">
                            {v.issues.map((i) => (
                              <li key={i}>{i}</li>
                            ))}
                          </ul>
                        </details>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="text-xs text-muted">{data.source}</p>
    </div>
  );
}

export function AgencyWorkspace() {
  const session = useSession(),
    external = Boolean(session.me?.partner);
  const office =
    !external &&
    ["super_admin", "admin", "operations"].includes(
      session.profile?.role ?? "",
    );
  const editing =
    office && ["super_admin", "admin"].includes(session.profile?.role ?? "");
  const [today] = useState(() =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
  );
  const url = useUrlState();
  const selected = url.params.get("id") ?? "";
  const setSelected = (next: string) =>
    url.set({ id: next || null, tab: null });
  const [adding, setAdding] = useState(false);
  const [from, setFrom] = useState(dateOf(Date.parse(today) - 6 * 86400000)),
    [to, setTo] = useState(today),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [period, setPeriod] = useState("");
  const list = useApi<{ rows: Array<{ id: string; name: string }> }>(
    ["partners", "list"],
    "/api/v1/partners",
  );
  const id =
    selected ||
    session.me?.partner?.id ||
    (office ? "" : list.data?.rows[0]?.id) ||
    "";
  const previous = comparisonPeriod(from, to);
  const current = useApi<AgencyEvidence>(
    id ? ["partners", id, "evidence", from, to] : null,
    `/api/v1/partners/evidence?partnerId=${id}&from=${from}&to=${to}`,
  );
  const prior = useApi<AgencyEvidence>(
    id ? ["partners", id, "evidence", previous.from, previous.to] : null,
    `/api/v1/partners/evidence?partnerId=${id}&from=${previous.from}&to=${previous.to}`,
  );
  const setup = useApi<Setup>(
    id ? ["partners", id, "setup"] : null,
    `/api/v1/partners/setup?partnerId=${id}`,
  );
  const units = useApi<Array<{ id: string; name: string }>>(
    editing ? ["partners", "units"] : null,
    "/api/v1/org/tree",
  );
  const bill = useApi<Billing>(
    id && period ? ["partners", id, "billing", period] : null,
    `/api/v1/partners/billing?partnerId=${id}&periodId=${period}`,
  );
  useLive(id ? [`partner:${id}`] : [], [["partners"]]);
  async function save(action: string, body: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const result = await mutate<{ id: string }>(
        `/api/v1/partners/${action}`,
        { partnerId: id, requestKey: crypto.randomUUID(), ...body },
        { invalidate: [["partners"]] },
      );
      // Verify the exact target through its authorized reader, not just the write response.
      if (action === "create") {
        const fresh = await apiFetch<{ rows: Array<{ id: string }> }>(
          "/api/v1/partners",
        );
        if (!fresh.rows.some((r) => r.id === result.id))
          throw new Error("Agency read-back failed");
        setAdding(false);
        setSelected(result.id);
      } else if (action === "billing/build") {
        const fresh = await apiFetch<Billing>(
          `/api/v1/partners/billing?partnerId=${id}&periodId=${result.id}`,
        );
        if (fresh.id !== result.id) throw new Error("Billing read-back failed");
        setPeriod(result.id);
      } else await apiFetch(`/api/v1/partners/setup?partnerId=${id}`);
      setMessage("Saved and checked against the current record.");
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "The record could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  function submit(
    action: string,
    convert: (f: FormData) => Record<string, unknown>,
  ) {
    return (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      void save(action, convert(new FormData(e.currentTarget)));
    };
  }
  if (list.error)
    return (
      <p role="alert" className="p-6">
        Your organisation portal is unavailable. Sign in again or ask the office
        to check your access.
      </p>
    );
  const tab = readAgencyTab(url.params, editing);
  const addDrawer = (
    <Drawer open={adding} title="Add agency" onClose={() => setAdding(false)}>
      <form
        className="space-y-3"
        onSubmit={submit("create", (f) => ({
          code: f.get("code"),
          name: f.get("name"),
          orgUnitId: f.get("orgUnitId"),
        }))}
      >
        <label className="block text-sm">
          Code
          <input className={field} name="code" required maxLength={50} />
        </label>
        <label className="block text-sm">
          Name
          <input className={field} name="name" required />
        </label>
        <label className="block text-sm">
          Supervising area
          <select className={field} name="orgUnitId" required>
            {units.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2">
          <button className={button} disabled={busy}>
            Save
          </button>
          <button
            type="button"
            className={button}
            onClick={() => setAdding(false)}
          >
            Cancel
          </button>
        </div>
      </form>
    </Drawer>
  );
  if (office && !selected) {
    const q = url.params.get("q") ?? "";
    const page = readPage(url.params);
    const rows = list.data?.rows ?? null;
    const hits = (rows ?? []).filter((r) =>
      r.name.toLowerCase().includes(q.trim().toLowerCase()),
    );
    return (
      <div className="mx-auto grid max-w-7xl gap-5 p-5 lg:p-8">
        <h1 className="text-3xl font-semibold tracking-tight">Agencies</h1>
        <ListPage<{ id: string; name: string }>
          noun={{ one: "agency", many: "agencies" }}
          rows={
            rows ? hits.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null
          }
          total={rows ? hits.length : null}
          loading={!rows}
          page={page}
          onPage={(n) => url.set({ page: n > 1 ? String(n) : null })}
          q={q}
          onSearch={(v) =>
            url.set({ q: v || null, page: null }, { replace: true })
          }
          searchPlaceholder="Search agencies"
          onAdd={editing ? () => setAdding(true) : undefined}
          rowKey={(r) => r.id}
          rowHref={(r) => url.hrefWith({ id: r.id, q: null, page: null })}
          columns={[
            {
              key: "name",
              label: "Agency",
              primary: true,
              render: (r) => r.name,
              text: (r) => r.name,
            },
            {
              key: "edit",
              label: "",
              align: "right",
              render: () =>
                editing ? (
                  <span className="inline-flex min-h-9 items-center rounded-[10px] border border-border px-3 text-sm font-medium">
                    Edit
                  </span>
                ) : null,
            },
          ]}
        />
        {addDrawer}
      </div>
    );
  }
  const name =
    current.data?.partner.name ??
    list.data?.rows.find((r) => r.id === id)?.name ??
    "Agency";
  return (
    <div className="mx-auto max-w-7xl space-y-5 p-5 lg:p-8">
      {office ? (
        <Link
          href={url.hrefWith({ id: null, tab: null })}
          className="text-sm text-muted underline"
        >
          ← Agencies
        </Link>
      ) : null}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{name}</h1>
        {editing && tab !== "setup" ? (
          <button className={button} onClick={() => url.set({ tab: "setup" })}>
            Edit
          </button>
        ) : null}
      </header>
      <UrlTabs
        label="Agency"
        tabs={AGENCY_TABS.filter((t) => editing || t.id !== "setup")}
        tab={tab}
        onTab={(t) => url.set({ tab: t === "work" ? null : t })}
      />
      {message ? (
        <p role="status" className={panel}>
          {message}
        </p>
      ) : null}
      {tab === "work" ? (
        <>
          <div className={`${panel} flex flex-wrap items-end gap-4`}>
            <label className="text-sm">
              From
              <input
                className={field}
                type="date"
                max={to}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="text-sm">
              Through
              <input
                className={field}
                type="date"
                min={from}
                max={today}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <button className={button} onClick={() => void current.refetch()}>
              Refresh
            </button>
          </div>
          {current.error ? (
            <p role="alert" className={panel}>
              Evidence could not be read. Choose up to 31 elapsed days and check
              current staff and store access.
            </p>
          ) : current.data ? (
            <AgencyEvidenceView
              data={current.data}
              prior={prior.data}
              busy={busy}
              onBuild={() => void save("billing/build", { from, to })}
            />
          ) : (
            <p className={panel}>
              {id
                ? "Loading system evidence…"
                : "Create an agency and assign staff to begin."}
            </p>
          )}
        </>
      ) : null}
      {tab === "claims" ? (
        <>
          {id && current.data ? (
            <ClaimantClaims
              key={id}
              base="/api/v1/partners/claims/shared"
              partyId={id}
              name={current.data.partner.name}
            />
          ) : null}
        </>
      ) : null}
      {tab === "billing" ? (
        <>
          {id ? (
            <section className={panel}>
              <h2 className="font-medium">Frozen billing packages</h2>
              <label className="mt-3 block text-sm">
                Evidence period
                <select
                  className={field}
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                >
                  <option value="">Choose a package</option>
                  {setup.data?.periods.map((p) => (
                    <option value={p.id} key={p.id}>
                      {formatDateRange(
                        p.period_from.slice(0, 10),
                        p.period_to.slice(0, 10),
                      )}{" "}
                      · {p.decision ?? "Awaiting office sign-off"}
                    </option>
                  ))}
                </select>
              </label>
              {bill.error ? (
                <p role="alert" className="mt-4 text-sm">
                  This package is no longer available under your current staff
                  and store access.
                </p>
              ) : bill.data ? (
                <div className="mt-4 space-y-3">
                  <p className="text-sm">
                    {bill.data.lines.length} staff-day evidence lines ·{" "}
                    {money(
                      bill.data.lines.reduce((n, r) => n + r.amountCentavos, 0),
                    )}
                  </p>
                  <p className="text-sm text-muted">
                    {bill.data.stale
                      ? "Source evidence has changed. Build a fresh package before sign-off."
                      : bill.data.decision
                        ? `${bill.data.decision.decision} by ${bill.data.decision.reviewer}`
                        : "Awaiting an independent office review."}
                  </p>
                  <a
                    className={`${button} inline-flex items-center`}
                    href={`/api/v1/partners/billing/export?partnerId=${id}&periodId=${period}`}
                  >
                    Download frozen evidence
                  </a>
                  {editing && !bill.data.stale && !bill.data.decision ? (
                    <form
                      onSubmit={submit("billing/decide", (f) => ({
                        periodId: period,
                        evidenceHash: bill.data!.evidenceHash,
                        decision: f.get("decision"),
                        reason: f.get("reason"),
                      }))}
                      className="flex flex-wrap items-end gap-3"
                    >
                      <label className="text-sm">
                        Decision
                        <select className={field} name="decision">
                          <option value="approved">Approve evidence</option>
                          <option value="rejected">Reject evidence</option>
                        </select>
                      </label>
                      <label className="flex-1 text-sm">
                        Review reason
                        <input
                          className={field}
                          name="reason"
                          required
                          maxLength={500}
                        />
                      </label>
                      <button className={button} disabled={busy}>
                        Sign off exact evidence
                      </button>
                    </form>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
      {tab === "setup" && editing ? (
        <section className={panel}>
          <div className="grid gap-5 lg:grid-cols-2">
            {id ? (
              <>
                <form
                  className="space-y-3"
                  onSubmit={submit("invite", (f) => ({
                    name: f.get("name"),
                    email: f.get("email"),
                    access: f.get("access"),
                  }))}
                >
                  <h3 className="font-medium">
                    Invite dedicated partner account
                  </h3>
                  <label className="block text-sm">
                    Name
                    <input className={field} name="name" required />
                  </label>
                  <label className="block text-sm">
                    Email
                    <input
                      className={field}
                      name="email"
                      type="email"
                      required
                    />
                  </label>
                  <label className="block text-sm">
                    Access
                    <select className={field} name="access">
                      <option value="field">
                        Merchandiser in existing field app
                      </option>
                      <option value="portal">Agency coordinator portal</option>
                    </select>
                  </label>
                  <button className={button} disabled={busy}>
                    Invite staff member
                  </button>
                  <p className="text-xs text-muted">
                    They sign up with this exact email. Existing employee logins
                    cannot be adopted.
                  </p>
                </form>
                <form
                  className="space-y-3"
                  onSubmit={submit("outlet/set", (f) => ({
                    outletId: f.get("outletId"),
                    allowed: f.get("allowed") === "true",
                    effectiveFrom: effectiveManilaTime(f.get("effectiveFrom")),
                  }))}
                >
                  <h3 className="font-medium">Assign shared store access</h3>
                  <label className="block text-sm">
                    Store
                    <select className={field} name="outletId" required>
                      {setup.data?.outletOptions?.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm">
                    Permission
                    <select className={field} name="allowed">
                      <option value="true">Allow assigned staff</option>
                      <option value="false">End agency access</option>
                    </select>
                  </label>
                  <label className="block text-sm">
                    Access change starts (Manila time)
                    <input
                      className={field}
                      type="datetime-local"
                      name="effectiveFrom"
                    />
                    <span className="text-xs text-muted">
                      Leave blank to apply now.
                    </span>
                  </label>
                  <button className={button} disabled={busy}>
                    Save store access
                  </button>
                  <p className="text-xs text-muted">
                    {setup.data?.outlets.length ?? 0} access records. The shared
                    store master is unchanged.
                  </p>
                  <details className="text-xs text-muted">
                    <summary>Store access dates</summary>
                    <ul className="mt-2 space-y-2">
                      {setup.data?.outlets.map((o) => (
                        <li key={o.id}>
                          {o.name} · {effectiveLabel(o.effective_from)} –{" "}
                          {o.effective_to
                            ? effectiveLabel(o.effective_to)
                            : "No scheduled end"}
                        </li>
                      ))}
                    </ul>
                  </details>
                </form>
                <form
                  className="space-y-3"
                  onSubmit={submit("contract/set", (f) => ({
                    rateCentavos: Math.round(Number(f.get("rate")) * 100),
                    minimumCalls: Number(f.get("calls")),
                    minimumDwellMs: Number(f.get("minutes")) * 60000,
                    minimumRetailScore: Number(f.get("retailScore")),
                    requiredKinds: f.getAll("requiredKinds"),
                    sourceRef: f.get("sourceRef"),
                    effectiveFrom: effectiveManilaTime(f.get("effectiveFrom")),
                  }))}
                >
                  <h3 className="font-medium">Publish next billing contract</h3>
                  <p className="text-xs text-muted">
                    Latest configured rate:{" "}
                    {setup.data?.contracts[0]
                      ? money(Number(setup.data.contracts[0].rate_centavos))
                      : "Needs setup"}
                    . Earlier versions stay frozen.
                  </p>
                  <label className="block text-sm">
                    Contract starts (Manila time)
                    <input
                      className={field}
                      type="datetime-local"
                      name="effectiveFrom"
                    />
                    <span className="text-xs text-muted">
                      Leave blank to apply now. Choose the next service day to
                      avoid changing a rate during a working day.
                    </span>
                  </label>
                  <label className="block text-sm">
                    Day rate (₱)
                    <input
                      className={field}
                      type="number"
                      min="0"
                      step="0.01"
                      max="1000000"
                      name="rate"
                      required
                    />
                  </label>
                  <div className="flex gap-3">
                    <label className="block text-sm">
                      Minimum compliant calls
                      <input
                        className={field}
                        type="number"
                        min="1"
                        max="200"
                        name="calls"
                        required
                      />
                    </label>
                    <label className="block text-sm">
                      Minimum minutes per call
                      <input
                        className={field}
                        type="number"
                        min="0"
                        max="1440"
                        name="minutes"
                        required
                      />
                    </label>
                  </div>
                  <fieldset className="text-sm">
                    <legend>Required system activities</legend>
                    {[
                      ["merchandising", "Merchandising"],
                      ["inventory_check", "Stock check"],
                      ["price_check", "Price check"],
                      ["promotion", "Promotion"],
                      ["note", "Note"],
                    ].map(([key, label]) => (
                      <label key={key} className="mr-3 inline-flex gap-2">
                        <input
                          type="checkbox"
                          name="requiredKinds"
                          value={key}
                          defaultChecked={key === "merchandising"}
                        />
                        {label}
                      </label>
                    ))}
                  </fieldset>
                  <label className="block text-sm">
                    Policy source / approval reference
                    <input className={field} name="sourceRef" required />
                  </label>
                  <label className="block text-sm">
                    Minimum retail audit score (%)
                    <input
                      className={field}
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      name="retailScore"
                      key={setup.data?.contracts[0]?.id ?? "pending"}
                      defaultValue={
                        setup.data?.contracts[0]?.minimum_retail_score ?? 100
                      }
                      required
                    />
                    <span className="text-xs text-muted">
                      A versioned billing requirement for recorded MERCH scores,
                      not a claim that its workflow passed.
                    </span>
                  </label>
                  <button className={button} disabled={busy}>
                    Publish effective contract
                  </button>
                  <details className="text-xs text-muted">
                    <summary>Contract versions and effective dates</summary>
                    <ul className="mt-2 space-y-2">
                      {setup.data?.contracts.map((k) => (
                        <li key={k.id}>
                          Version {k.version} · {money(Number(k.rate_centavos))}{" "}
                          · Retail minimum {k.minimum_retail_score}% ·{" "}
                          {effectiveLabel(k.effective_from)} –{" "}
                          {k.effective_to
                            ? effectiveLabel(k.effective_to)
                            : "No scheduled end"}{" "}
                          · {k.source_ref}
                        </li>
                      ))}
                    </ul>
                  </details>
                </form>
                <div>
                  <h3 className="font-medium">Current agency access</h3>
                  <ul className="mt-3 space-y-3">
                    {setup.data?.staff.map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <div>
                          {p.name}
                          <p className="text-xs text-muted">
                            {p.email} ·{" "}
                            {p.grants.includes("field")
                              ? "Field staff"
                              : "Portal coordinator"}
                          </p>
                        </div>
                        <button
                          className={button}
                          disabled={busy}
                          onClick={() =>
                            void save("revoke", { membershipId: p.id })
                          }
                        >
                          End access
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export const AGENCY_TABS = [
  { id: "work", label: "Work" },
  { id: "billing", label: "Billing" },
  { id: "claims", label: "Claims" },
  { id: "setup", label: "Setup" },
] as const;
export type AgencyTab = (typeof AGENCY_TABS)[number]["id"];
/** ?tab= for one agency; Setup only for people who can edit. */
export function readAgencyTab(
  params: URLSearchParams,
  editing: boolean,
): AgencyTab {
  const t = params.get("tab");
  const hit = AGENCY_TABS.find((x) => x.id === t);
  return hit && (hit.id !== "setup" || editing) ? hit.id : "work";
}
