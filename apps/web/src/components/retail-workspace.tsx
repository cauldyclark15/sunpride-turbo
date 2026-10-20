"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { apiFetch, mutate, useApi, useLive } from "../lib/api";
import { useSession } from "../lib/auth/session";

type Named = { id: string; name: string; code?: string };
type Component = { key: string; weight: number; allowNotApplicable: boolean };
type MasterData = {
  serial?: string;
  model?: string;
  sapFixedAssetId?: string;
  custodian?: string;
  agreement?: string;
  location?: string;
  type?: string;
  outletId?: string;
  deployedAt?: number;
  policyVersionId?: string;
  minTemperatureDeciC?: number;
  maxTemperatureDeciC?: number;
  minOwnSharePercent?: number;
  followupHours?: number;
  targetSharePercent?: number;
  targetPercent?: number;
  components?: Component[];
  lines?: { productId: string; facings: number; position: string }[];
  productId?: string;
  nearExpiryDays?: number;
  action?: string;
  material?: string;
  auditEveryDays?: number;
  severity?: string;
  slaHours?: number;
};
type Master = {
  id: string;
  kind: string;
  code: string;
  label: string;
  version: number;
  outlet_class: string;
  effective_from: string;
  effective_to: string | null;
  source: string;
  data: MasterData;
};
type ActionCase = {
  id: string;
  kind: string;
  status: string;
  outlet_name: string;
  due_at: string;
  facts: {
    productName?: string;
    batch?: string;
    expiryDate?: string;
    quantityBase?: number;
    note?: string;
    breaches?: string[];
  };
};
type Workspace = {
  masters: Master[];
  cases: ActionCase[];
  outlets: Named[];
  accounts: Named[];
  products: Named[];
  lots: { id: string; lot_number: string; product_name: string }[];
  services: {
    id: string;
    label: string;
    kind: string;
    reference: string;
    note: string;
  }[];
  deployments: { id: string; unit_code: string; label: string; kind: string }[];
  custodians: Named[];
  posmUnits: {
    id: string;
    unit_code: string;
    label: string;
    kind: string;
    custodian_name: string;
    nextAuditAt: number | null;
  }[];
  audits: {
    id: string;
    kind: string;
    outlet_name: string;
    component_score: number | null;
    captured_at: string;
  }[];
  incompleteSections?: string[];
  asOf: number;
  nextAction: string;
};
export type WeekScore = {
  source?: string;
  synthetic?: boolean;
  accountName: string;
  weekStart: string;
  score: number | null;
  status: string;
  totalBranches: number;
  completeBranches: number;
  branches: {
    outletId: string;
    outletName: string;
    score: number | null;
    target: number | null;
    missing: string[];
    components?: {
      key: string;
      weight: number;
      status: string;
      value: { score?: number } | null;
    }[];
  }[];
};
type Scores = {
  current: WeekScore;
  prior: WeekScore;
  publications: { id: string; revision: number; snapshot: WeekScore }[];
};
export type Trace = {
  lot: { batch: string; product: string };
  rows: {
    id: string;
    outlet_name: string;
    quantity_base: number | string;
    lot_number: string;
    certainty: string;
    source_key: string;
  }[];
  affectedOutlets: number;
  warning: string;
};
const panel = "grid gap-4 rounded-xl border border-border bg-surface p-5";
const input =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground";
const button =
  "rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40";
const labels: Record<string, string> = {
  planogram: "Planograms",
  posm: "POSM",
  equipment: "Cold equipment",
  cold_policy: "Temperature & purity",
  scorecard: "Score weights",
  expiry_policy: "Near-expiry rules",
  incident_category: "Incident categories",
  cold_breach: "Cold-chain breach",
  pullout: "Pull-out",
  markdown: "Markdown",
  incident: "Field incident",
  issue_log: "Issue log",
  freezer: "Freezer",
  price: "Price compliance",
  availability: "Availability",
  promotion: "Promotion",
  awaiting_sap: "Waiting for SAP",
  assigned: "Assigned",
  open: "Open",
  resolved: "Resolved",
  rejected: "Rejected",
  approved: "Approved",
};
const label = (s: string) => labels[s] ?? s.replaceAll("_", " ");
const pct = (n: number | null | undefined) =>
  n == null ? "Incomplete" : `${n.toFixed(1)}%`;
export function monday(at = Date.now()) {
  const day = new Date(at + 8 * 3600000).toISOString().slice(0, 10);
  const d = new Date(day).getUTCDay();
  return new Date(Date.parse(day) - (((d + 6) % 7) + 7) * 86400000)
    .toISOString()
    .slice(0, 10);
}
const localMinute = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 16);
function Field({ title, children }: { title: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span>{title}</span>
      {children}
    </label>
  );
}
function Select({
  title,
  value,
  onChange,
  rows,
  empty = "Choose…",
}: {
  title: string;
  value: string;
  onChange: (s: string) => void;
  rows: { id: string; name: string }[];
  empty?: string;
}) {
  return (
    <Field title={title}>
      <select
        aria-label={title}
        className={input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{empty}</option>
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** F-311–F-321/F-614: which stores need action, and what evidence supports this week's score? */
export function RetailWorkspace() {
  const { profile } = useSession();
  const allowed = profile?.active;
  const [outletFilter, setOutletFilter] = useState("");
  const workspace = useApi<Workspace>(
    allowed ? ["retail", "workspace", outletFilter] : null,
    `/api/v1/retail/workspace?outletId=${outletFilter}`,
  );
  useLive(["retail", "visits"], [["retail"]]);
  const [tab, setTab] = useState("Weekly scores"),
    [account, setAccount] = useState(""),
    [week, setWeek] = useState(monday),
    [lot, setLot] = useState(""),
    [selected, setSelected] = useState<Master | null>(null);
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const d = workspace.data;
  const customer = account || d?.accounts[0]?.id || "";
  const scores = useApi<Scores>(
    allowed && customer && tab === "Weekly scores"
      ? ["retail", "scores", customer, week]
      : null,
    `/api/v1/retail/scores?customerId=${customer}&weekStart=${week}`,
  );
  const trace = useApi<Trace>(
    allowed && lot && tab === "Batch recall" ? ["retail", "trace", lot] : null,
    `/api/v1/retail/batch/trace?lotId=${lot}`,
  );
  const canManage =
    !!profile && ["super_admin", "admin", "operations"].includes(profile.role);
  async function command(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const saved = await mutate<{ id?: string }>(
        `/api/v1/retail/${path}`,
        { ...body, requestKey: crypto.randomUUID() },
        { invalidate: [["retail"]] },
      );
      await apiFetch("/api/v1/retail/workspace");
      setMessage("Saved. Refreshed the retail workspace.");
      return saved;
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "Could not save. Refresh and try again.",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }
  if (workspace.error)
    return (
      <div role="alert" className={panel}>
        Could not load retail execution. {workspace.error.message}
        <button className={button} onClick={() => void workspace.refetch()}>
          Try again
        </button>
      </div>
    );
  if (!d) return <p>Loading retail execution…</p>;
  const open = d.cases.filter(
    (c) => !["resolved", "rejected"].includes(c.status),
  );
  const tabs = [
    "Weekly scores",
    "Equipment",
    "Shelf actions",
    "Planograms",
    "POSM",
    "Policies",
    "Batch recall",
    "Observations",
  ];
  return (
    <div className="grid gap-4" data-retail-workspace>
      <section className={panel}>
        <p className="text-xs uppercase tracking-widest text-muted">
          Retail execution · sample policies are labelled
        </p>
        <h2 className="text-xl font-semibold">
          Make the next store action clear
        </h2>
        <p>
          {open.length} open actions shown ·{" "}
          {
            d.masters.filter(
              (m) =>
                m.kind === "equipment" &&
                Date.parse(m.effective_from) <= d.asOf &&
                (!m.effective_to || Date.parse(m.effective_to) > d.asOf),
            ).length
          }{" "}
          registered cold assets
        </p>
        <p className="text-sm text-muted">
          Next: {label(d.nextAction)}. Incomplete evidence is never counted as a
          perfect store.
        </p>
      </section>
      <section className={panel}>
        <Select
          title="Store · equipment, observations and actions"
          value={outletFilter}
          onChange={setOutletFilter}
          rows={d.outlets}
          empty="All accessible stores"
        />
        {!!d.incompleteSections?.length && (
          <p role="status">
            A bounded page is shown, not complete totals. Choose a store to
            narrow equipment, observations and actions.
          </p>
        )}
      </section>
      <nav className="flex flex-wrap gap-2" aria-label="Retail views">
        {tabs.map((t) => (
          <button
            key={t}
            className={button}
            aria-pressed={t === tab}
            onClick={() => {
              setTab(t);
              setSelected(null);
            }}
          >
            {t}
          </button>
        ))}
      </nav>
      {message && <p role="status">{message}</p>}
      {tab === "Weekly scores" && (
        <>
          <section className={panel}>
            <div className="grid gap-3 md:grid-cols-2">
              <Select
                title="Account"
                value={customer}
                onChange={setAccount}
                rows={d.accounts}
              />
              <Field title="Week starting Monday">
                <input
                  className={input}
                  type="date"
                  value={week}
                  onChange={(e) => setWeek(e.target.value)}
                />
              </Field>
            </div>
            {scores.error ? (
              <p role="alert">{scores.error.message}</p>
            ) : scores.data ? (
              <>
                <p className="text-sm text-muted">
                  Live preview from canonical observations. Published results
                  below stay frozen.
                </p>
                <PerfectStoreScore
                  current={scores.data.current}
                  prior={scores.data.prior}
                />
                {scores.data.publications.length ? (
                  scores.data.publications.slice(0, 1).map((publication) => (
                    <details
                      key={publication.id}
                      className="rounded-lg border border-border p-3"
                    >
                      <summary>
                        Published revision {publication.revision} ·{" "}
                        {pct(publication.snapshot.score)}
                        {publication.snapshot.synthetic
                          ? " · sample illustration"
                          : ""}
                      </summary>
                      {publication.snapshot.branches.map((branch) => (
                        <div key={branch.outletId} className="mt-3">
                          <p>
                            {branch.outletName} · {pct(branch.score)}
                          </p>
                          {!!branch.missing.length && (
                            <p>
                              Missing: {branch.missing.map(label).join(", ")}
                            </p>
                          )}
                          {branch.components?.map((component) => (
                            <p key={component.key}>
                              {label(component.key)} · weight {component.weight}
                              % ·{" "}
                              {component.status === "complete"
                                ? pct(component.value?.score)
                                : label(component.status)}
                            </p>
                          ))}
                        </div>
                      ))}
                    </details>
                  ))
                ) : (
                  <p>Not published yet</p>
                )}
                {canManage && (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void command("scores/publish", {
                        customerId: customer,
                        weekStart: week,
                      })
                    }
                  >
                    Publish weekly account score
                  </button>
                )}
              </>
            ) : (
              <p>Choose an account to see evidence completeness.</p>
            )}
          </section>
        </>
      )}
      {tab === "Batch recall" && (
        <section className={panel}>
          <Select
            title="Trace a received batch"
            value={lot}
            onChange={setLot}
            rows={d.lots.map((l) => ({
              id: l.id,
              name: `${l.lot_number} · ${l.product_name}`,
            }))}
          />
          {trace.error ? (
            <p role="alert">{trace.error.message}</p>
          ) : trace.data ? (
            <>
              <BatchTrace trace={trace.data} />
              {canManage && (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void command("recalls/open", {
                      lotId: lot,
                      reason: f.get("reason"),
                    });
                  }}
                >
                  <input
                    className={input}
                    name="reason"
                    required
                    placeholder="Reason for recall"
                    aria-label="Recall reason"
                  />
                  <button className={button} disabled={busy}>
                    Open recall
                  </button>
                </form>
              )}
            </>
          ) : (
            <p>
              Choose a batch. Uncaptured delivery batches remain unknown, not
              zero.
            </p>
          )}
        </section>
      )}
      {tab === "Shelf actions" && (
        <section className={panel}>
          <h3>Cold-chain, shelf expiry and field incidents</h3>
          <p>
            Separate from the software issue board. Pull-outs and markdowns wait
            for SAP acknowledgement.
          </p>
          {open.length === 0 ? (
            <p>No open actions in this page.</p>
          ) : (
            open.map((c) => (
              <article
                key={c.id}
                className="grid gap-2 border-t border-border pt-3"
              >
                <h4>
                  {c.outlet_name} · {label(c.kind)}
                </h4>
                <p>
                  {label(c.status)} · due{" "}
                  {new Date(c.due_at).toLocaleString("en-PH", {
                    timeZone: "Asia/Manila",
                  })}
                </p>
                <p>
                  {[
                    c.facts.productName,
                    c.facts.batch,
                    c.facts.expiryDate,
                    c.facts.quantityBase
                      ? `${c.facts.quantityBase} pieces`
                      : null,
                    c.facts.note,
                    c.facts.breaches?.map(label).join(", "),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {canManage && (
                  <form
                    className="flex flex-wrap gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void command("cases/action", {
                        caseId: c.id,
                        action: f.get("action"),
                        note: f.get("note"),
                        reference: f.get("reference"),
                      });
                    }}
                  >
                    <input
                      className={input}
                      name="note"
                      aria-label="Action note"
                      required
                      placeholder="Action taken / reason"
                    />
                    <input
                      className={input}
                      name="reference"
                      aria-label="Completion reference"
                      placeholder="Service or acknowledged return reference"
                    />
                    <select
                      className={input}
                      name="action"
                      aria-label="Case action"
                    >
                      <option value="approve">
                        Request pull-out / markdown approval
                      </option>
                      <option value="resolve">Resolve with reference</option>
                      <option value="reject">Reject</option>
                    </select>
                    <button className={button} disabled={busy}>
                      Record action
                    </button>
                  </form>
                )}
              </article>
            ))
          )}
        </section>
      )}
      {["Equipment", "Planograms", "POSM", "Policies"].includes(tab) && (
        <>
          <section className={panel}>
            <h3>{tab}</h3>
            {d.masters
              .filter((m) =>
                tab === "Equipment"
                  ? m.kind === "equipment"
                  : tab === "Planograms"
                    ? m.kind === "planogram"
                    : tab === "POSM"
                      ? m.kind === "posm"
                      : [
                          "cold_policy",
                          "scorecard",
                          "expiry_policy",
                          "incident_category",
                        ].includes(m.kind),
              )
              .map((m) => (
                <article
                  key={m.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
                >
                  <div>
                    <p>
                      {m.label} · version {m.version} ·{" "}
                      {m.source === "sample" ? "Sample" : "Office"}
                    </p>
                    <p className="text-sm text-muted">
                      {label(m.kind)} ·{" "}
                      {m.effective_to ? "Historical / replaced" : "Published"} ·{" "}
                      {m.data.serial ?? m.code}
                      {m.data.sapFixedAssetId
                        ? ` · SAP asset ${m.data.sapFixedAssetId}`
                        : ""}
                    </p>
                    {m.kind === "equipment" && (
                      <p>
                        {d.outlets.find((o) => o.id === m.data.outletId)
                          ?.name ?? "Store outside current list"}{" "}
                        · {m.data.model} · {m.data.custodian}
                      </p>
                    )}
                  </div>
                  {canManage && (
                    <button className={button} onClick={() => setSelected(m)}>
                      Edit next version
                    </button>
                  )}
                </article>
              ))}
            {canManage && (
              <button className={button} onClick={() => setSelected(null)}>
                Create new {tab === "Policies" ? "policy" : "record"}
              </button>
            )}
          </section>
          {canManage && (
            <MasterEditor
              key={selected?.id ?? tab}
              workspace={d}
              selected={selected}
              kind={
                tab === "Equipment"
                  ? "equipment"
                  : tab === "Planograms"
                    ? "planogram"
                    : tab === "POSM"
                      ? "posm"
                      : "cold_policy"
              }
              busy={busy}
              onSave={async (b) => {
                await command("masters/publish", b);
              }}
            />
          )}
          {tab === "Equipment" && (
            <section className={panel}>
              <h3>Service & fixed-asset reconciliation history</h3>
              {d.services.map((s) => (
                <p key={s.id}>
                  {s.label} · {label(s.kind)} · {s.reference} · {s.note}
                </p>
              ))}
              {canManage && (
                <form
                  className="grid gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void command("equipment/service", Object.fromEntries(f));
                  }}
                >
                  <Field title="Equipment">
                    <select
                      className={input}
                      name="equipmentVersionId"
                      required
                    >
                      {d.masters
                        .filter(
                          (m) => m.kind === "equipment" && !m.effective_to,
                        )
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field title="Event">
                    <select className={input} name="kind">
                      <option value="service">Service</option>
                      <option value="repair">Repair</option>
                      <option value="reconcile">
                        Reconcile to SAP extract
                      </option>
                    </select>
                  </Field>
                  <input
                    className={input}
                    name="reference"
                    required
                    aria-label="Service reference"
                    placeholder="SAP extract / service reference"
                  />
                  <input
                    className={input}
                    name="note"
                    required
                    aria-label="Service note"
                    placeholder="Work completed or discrepancy"
                  />
                  <button className={button} disabled={busy}>
                    Record service / reconciliation
                  </button>
                </form>
              )}
            </section>
          )}
          {tab === "POSM" && (
            <section className={panel}>
              <h3>Issued & deployed units</h3>
              {d.deployments.map((p) => (
                <p key={p.id}>
                  {p.unit_code} · {p.label} · {label(p.kind)}
                </p>
              ))}
              <p>
                Field deployments require an uploaded photo from the outlet
                call. Custody and independent write-off actions use the same
                register.
              </p>
              {d.posmUnits.map((p) => (
                <p key={p.id}>
                  {p.unit_code} · {p.label} · {p.custodian_name} ·{" "}
                  {label(p.kind)}
                  {p.nextAuditAt
                    ? ` · next audit ${new Date(p.nextAuditAt).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })}`
                    : ""}
                </p>
              ))}
              {canManage && (
                <form
                  className="grid gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void command("posm/custody", Object.fromEntries(f));
                  }}
                >
                  <Field title="POSM catalogue version">
                    <select className={input} name="materialVersionId" required>
                      {d.masters
                        .filter((m) => m.kind === "posm")
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label} · version {m.version}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field title="Unit code">
                    <input
                      className={input}
                      name="unitCode"
                      required
                      placeholder="One identifiable POSM unit"
                    />
                  </Field>
                  <Field title="Custodian">
                    <select
                      className={input}
                      name="custodianProfileId"
                      required
                    >
                      {d.custodians.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field title="Custody action">
                    <select className={input} name="kind">
                      <option value="issue">Issue to field</option>
                      <option value="return">Return to office</option>
                      <option value="write_off_request">
                        Request write-off
                      </option>
                      <option value="write_off">
                        Independently approve write-off
                      </option>
                    </select>
                  </Field>
                  <Field title="Reason">
                    <input className={input} name="reason" required />
                  </Field>
                  <button className={button} disabled={busy}>
                    Record custody action
                  </button>
                </form>
              )}
            </section>
          )}
        </>
      )}
      {tab === "Observations" && (
        <section className={panel}>
          <h3>Captured execution evidence</h3>
          {d.audits.map((a) => (
            <article key={a.id}>
              <p>
                {a.outlet_name} · {label(a.kind)} ·{" "}
                {a.component_score == null
                  ? "Observation"
                  : `${Number(a.component_score).toFixed(1)}%`}
              </p>
              <p className="text-sm text-muted">
                {new Date(a.captured_at).toLocaleString("en-PH", {
                  timeZone: "Asia/Manila",
                })}
              </p>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

/** F-316: no partial subtotal is labelled as an account-wide score. */
export function PerfectStoreScore({
  current,
  prior,
}: {
  current: WeekScore;
  prior: WeekScore;
}) {
  const targets = [
    ...new Set(
      current.branches
        .map((b) => b.target)
        .filter((v): v is number => v != null),
    ),
  ];
  const target = targets[0];
  return (
    <div className="grid gap-4" data-perfect-store-score>
      <h3 className="text-lg font-semibold">
        {current.accountName} · week of {current.weekStart}
      </h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <p>
          Account score
          <br />
          <strong className="text-2xl">{pct(current.score)}</strong>
        </p>
        <p>
          Target
          <br />
          <strong>
            {targets.length > 1
              ? "Varies by branch"
              : target == null
                ? "No applied target"
                : `${target}%`}
          </strong>
        </p>
        <p>
          Prior week
          <br />
          <strong>{pct(prior.score)}</strong>
          {current.score != null && prior.score != null && (
            <span>
              {" "}
              · {current.score - prior.score >= 0 ? "+" : ""}
              {(current.score - prior.score).toFixed(1)} points
            </span>
          )}
        </p>
      </div>
      <p>
        {current.completeBranches} of {current.totalBranches} branches have
        complete evidence.{" "}
        {current.status !== "complete"
          ? "Collect missing evidence before calling the account complete."
          : "Evidence is complete; publish the weekly result."}
      </p>
      <div className="grid gap-3">
        {current.branches.map((b) => (
          <details
            key={b.outletId}
            className="rounded-lg border border-border p-3"
          >
            <summary>
              {b.outletName} · {pct(b.score)}
            </summary>
            <p>
              Target: {b.target == null ? "No applied target" : `${b.target}%`}
            </p>
            {b.missing.length > 0 && (
              <p>Missing: {b.missing.map(label).join(", ")}</p>
            )}
            {b.components?.map((c) => (
              <p key={c.key}>
                {label(c.key)} · weight {c.weight}% ·{" "}
                {c.status === "complete"
                  ? pct(c.value?.score)
                  : label(c.status)}
              </p>
            ))}
          </details>
        ))}
      </div>
    </div>
  );
}
/** F-614: inference and confirmed receipt are never mixed into a fictitious physical-delivery total. */
export function BatchTrace({ trace }: { trace: Trace }) {
  return (
    <div className="grid gap-3" data-batch-trace>
      <h3>
        {trace.lot.batch} · {trace.lot.product}
      </h3>
      <p>{trace.affectedOutlets} affected outlets in your scope</p>
      <p className="text-sm text-muted">{trace.warning}</p>
      {trace.rows.map((r) => (
        <article key={r.id} className="rounded-lg border border-border p-3">
          <p>
            {r.outlet_name} · {r.lot_number} · {r.quantity_base} pieces
          </p>
          <p>
            {r.certainty === "allocation_inference"
              ? "Inferred from van allocation — physical batch not confirmed"
              : r.certainty === "sample_confirmation"
                ? "Sample confirmed receipt"
                : "Confirmed receipt"}
          </p>
        </article>
      ))}
    </div>
  );
}

function MasterEditor({
  workspace: d,
  selected,
  kind: initial,
  busy,
  onSave,
}: {
  workspace: Workspace;
  selected: Master | null;
  kind: string;
  busy: boolean;
  onSave: (b: Record<string, unknown>) => Promise<void>;
}) {
  const [kind, setKind] = useState(selected?.kind ?? initial),
    [equipmentType, setEquipmentType] = useState(
      selected?.data.type ?? "freezer",
    );
  const [openedAt] = useState(Date.now);
  const values = selected?.data;
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const n = (key: string) => Number(f.get(key));
    const s = (key: string) => String(f.get(key) ?? "");
    let data: Record<string, unknown> = {};
    if (kind === "equipment")
      data = {
        serial: s("serial"),
        model: s("model"),
        sapFixedAssetId: s("sapFixedAssetId"),
        custodian: s("custodian"),
        agreement: s("agreement"),
        location: s("location"),
        type: equipmentType,
        outletId: s("outletId"),
        deployedAt: Date.parse(`${s("deployedDate")}T00:00:00+08:00`),
        policyVersionId: s("policyVersionId"),
      };
    if (kind === "cold_policy")
      data = {
        type: equipmentType,
        minTemperatureDeciC: Math.round(n("minimum") * 10),
        maxTemperatureDeciC: Math.round(n("maximum") * 10),
        minOwnSharePercent: n("minOwnSharePercent"),
        followupHours: n("followupHours"),
      };
    if (kind === "planogram")
      data = {
        targetSharePercent: n("targetSharePercent"),
        lines: d.products
          .filter((p) => n(`facings:${p.id}`) > 0)
          .map((p) => ({
            productId: p.id,
            facings: n(`facings:${p.id}`),
            position: s(`position:${p.id}`),
          })),
      };
    if (kind === "scorecard")
      data = {
        targetPercent: n("targetPercent"),
        components: [
          "availability",
          "planogram",
          "posm",
          "price",
          "freezer",
          "promotion",
        ].map((key) => ({
          key,
          weight: n(`weight:${key}`),
          allowNotApplicable: f.has(`na:${key}`),
        })),
      };
    if (kind === "expiry_policy")
      data = {
        productId: s("productId"),
        nearExpiryDays: n("nearExpiryDays"),
        action: s("action"),
      };
    if (kind === "posm")
      data = { material: s("material"), auditEveryDays: n("auditEveryDays") };
    if (kind === "incident_category")
      data = { severity: s("severity"), slaHours: n("slaHours") };
    await onSave({
      kind,
      code: s("code"),
      label: s("label"),
      outletClass: s("outletClass") || "*",
      effectiveFrom: Date.parse(`${s("effectiveFrom")}+08:00`),
      data,
    });
  }
  const number = (
    title: string,
    name: string,
    value: number | undefined,
    step = "1",
  ) => (
    <Field title={title}>
      <input
        className={input}
        name={name}
        type="number"
        step={step}
        required
        defaultValue={value}
      />
    </Field>
  );
  const text = (title: string, name: string, value: string | undefined) => (
    <Field title={title}>
      <input className={input} name={name} required defaultValue={value} />
    </Field>
  );
  return (
    <form className={panel} onSubmit={(e) => void save(e)}>
      <h3>
        {selected
          ? `Publish next version of ${selected.label}`
          : "Create an effective-dated record"}
      </h3>
      {!selected && (
        <Field title="Record type">
          <select
            className={input}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {Object.entries(labels)
              .filter(([k]) =>
                [
                  "planogram",
                  "posm",
                  "equipment",
                  "cold_policy",
                  "scorecard",
                  "expiry_policy",
                  "incident_category",
                ].includes(k),
              )
              .map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
          </select>
        </Field>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {text("Business code", "code", selected?.code)}
        {text("Name", "label", selected?.label)}
        {text(
          "Outlet class · * for any class",
          "outletClass",
          selected?.outlet_class ?? "*",
        )}
        <Field title="Effective from · Manila time">
          <input
            className={input}
            type="datetime-local"
            name="effectiveFrom"
            required
            defaultValue={localMinute(openedAt + 120000)}
          />
        </Field>
      </div>
      {["equipment", "cold_policy"].includes(kind) && (
        <Field title="Equipment type">
          <select
            className={input}
            value={equipmentType}
            onChange={(e) => setEquipmentType(e.target.value)}
          >
            <option value="freezer">Freezer</option>
            <option value="chiller">Chiller</option>
          </select>
        </Field>
      )}
      {kind === "equipment" && (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            {text("Serial", "serial", values?.serial)}
            {text("Model", "model", values?.model)}
            {text(
              "SAP fixed-asset ID",
              "sapFixedAssetId",
              values?.sapFixedAssetId,
            )}
            {text("Custodian", "custodian", values?.custodian)}
            {text("Agreement", "agreement", values?.agreement)}
            {text("Location", "location", values?.location)}
          </div>
          <Field title="Outlet">
            <select
              className={input}
              name="outletId"
              required
              defaultValue={values?.outletId}
            >
              {d.outlets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
          <Field title="Deployment date">
            <input
              className={input}
              name="deployedDate"
              type="date"
              required
              defaultValue={new Date(
                (values?.deployedAt ?? openedAt) + 8 * 3600000,
              )
                .toISOString()
                .slice(0, 10)}
            />
          </Field>
          <Field title="Temperature & purity agreement">
            <select
              className={input}
              name="policyVersionId"
              required
              defaultValue={values?.policyVersionId}
            >
              {d.masters
                .filter(
                  (m) =>
                    m.kind === "cold_policy" &&
                    !m.effective_to &&
                    m.data.type === equipmentType,
                )
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
            </select>
          </Field>
        </>
      )}
      {kind === "cold_policy" && (
        <div className="grid gap-3 md:grid-cols-2">
          {number(
            "Minimum °C",
            "minimum",
            values?.minTemperatureDeciC == null
              ? -25
              : values.minTemperatureDeciC / 10,
            "0.1",
          )}
          {number(
            "Maximum °C",
            "maximum",
            values?.maxTemperatureDeciC == null
              ? -18
              : values.maxTemperatureDeciC / 10,
            "0.1",
          )}
          {number(
            "Minimum own-product share %",
            "minOwnSharePercent",
            values?.minOwnSharePercent ?? 90,
          )}
          {number(
            "Follow-up within hours",
            "followupHours",
            values?.followupHours ?? 4,
          )}
        </div>
      )}
      {kind === "planogram" && (
        <>
          {number(
            "Target share of shelf %",
            "targetSharePercent",
            values?.targetSharePercent ?? 50,
          )}
          {d.products.map((p) => {
            const l = values?.lines?.find((l) => l.productId === p.id);
            return (
              <div key={p.id} className="grid gap-2 md:grid-cols-3">
                <p>{p.name}</p>
                {number(
                  "Target facings · 0 excludes",
                  `facings:${p.id}`,
                  l?.facings ?? 0,
                )}
                <Field title="Target position">
                  <input
                    className={input}
                    name={`position:${p.id}`}
                    defaultValue={l?.position ?? "Shelf 1"}
                  />
                </Field>
              </div>
            );
          })}
        </>
      )}
      {kind === "scorecard" && (
        <>
          {number(
            "Perfect store target %",
            "targetPercent",
            values?.targetPercent ?? 90,
          )}
          {[
            "availability",
            "planogram",
            "posm",
            "price",
            "freezer",
            "promotion",
          ].map((key, i) => {
            const c = values?.components?.find((c) => c.key === key);
            return (
              <div key={key} className="grid gap-2 md:grid-cols-2">
                {number(
                  `${label(key)} weight %`,
                  `weight:${key}`,
                  c?.weight ?? (i === 0 ? 25 : 15),
                )}
                <label>
                  <input
                    name={`na:${key}`}
                    type="checkbox"
                    defaultChecked={
                      c?.allowNotApplicable ??
                      ["freezer", "promotion", "posm"].includes(key)
                    }
                  />{" "}
                  Allow not applicable when no asset / campaign is assigned
                </label>
              </div>
            );
          })}
          <p>Weights must total 100. Missing evidence stays incomplete.</p>
        </>
      )}
      {kind === "expiry_policy" && (
        <>
          <Field title="Product">
            <select
              className={input}
              name="productId"
              required
              defaultValue={values?.productId}
            >
              {d.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          {number(
            "Near-expiry days",
            "nearExpiryDays",
            values?.nearExpiryDays ?? 30,
          )}
          <Field title="Next action">
            <select
              className={input}
              name="action"
              defaultValue={values?.action ?? "pullout"}
            >
              <option value="pullout">Pull-out</option>
              <option value="markdown">Request SAP markdown</option>
            </select>
          </Field>
        </>
      )}
      {kind === "posm" && (
        <>
          {text("Material description", "material", values?.material)}
          {number(
            "Audit every days",
            "auditEveryDays",
            values?.auditEveryDays ?? 7,
          )}
        </>
      )}
      {kind === "incident_category" && (
        <>
          <Field title="Severity">
            <select
              className={input}
              name="severity"
              defaultValue={values?.severity ?? "high"}
            >
              {["low", "medium", "high", "critical"].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          {number("Resolution SLA · hours", "slaHours", values?.slaHours ?? 4)}
        </>
      )}
      <button className={button} disabled={busy}>
        Publish prospective version
      </button>
    </form>
  );
}
