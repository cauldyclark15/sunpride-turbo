"use client";
import Link from "next/link";
import { useState } from "react";
import { mutate, useApi, useLive } from "../../lib/api";
import { useSession } from "../../lib/auth/session";
import { Accreditation, Claims, Documents, Money } from "./finance";
import { Ordering, Overview, Stock } from "./commercial";
import { Reconcile, Secondary } from "./secondary";
import { Setup } from "./setup";
import { ClaimantClaims } from "../claimant-claims";
import { VanArrangement, type PartnerVanData } from "./van-arrangement";
import type { Partner, Workspace } from "./types";
import { Drawer } from "../cockpit/kit/drawer";
import { useUrlState } from "../cockpit/use-url-state";
import { ListPage, PAGE_SIZE, readPage } from "../list-page/list-page";
import {
  buttonClass,
  Empty,
  Field,
  fieldClass,
  Panel,
  State,
  usePartnerCommand,
  usePartnerQuery,
  value,
  words,
} from "./kit";

const TABS = [
  { id: "overview", label: "Overview", grant: "read" },
  { id: "orders", label: "Primary orders", grant: "order" },
  { id: "stock", label: "Stock", grant: "stock" },
  { id: "secondary", label: "Secondary sales", grant: "secondary" },
  { id: "reconciliation", label: "Reconciliation", grant: "read" },
  { id: "claims", label: "Claims", grant: "claim" },
  { id: "money", label: "Money", grant: "finance" },
  { id: "documents", label: "Documents", grant: "documents" },
  { id: "accreditation", label: "Accreditation", grant: "read" },
  { id: "field", label: "Field staff", grant: "dsr" },
] as const;
export function DistributorWorkspace({ portal = false }: { portal?: boolean }) {
  const session = useSession();
  if (!session.profile)
    return <p className="text-sm text-muted">Checking partner access…</p>;
  const partner = session.profile.role === "distributor";
  if (
    (portal && !partner) ||
    (!portal &&
      !["super_admin", "admin", "operations"].includes(session.profile.role))
  )
    return (
      <Empty>
        This page is not available to your account.{" "}
        {partner ? (
          <Link href="/distributor" className="underline">
            Open your distributor portal
          </Link>
        ) : (
          <Link href="/distributors" className="underline">
            Open Channel Development
          </Link>
        )}
      </Empty>
    );
  return <AllowedWorkspace portal={portal} />;
}
function AllowedWorkspace({ portal }: { portal: boolean }) {
  const partners = useApi<{ rows: Partner[]; next: string | null }>(
    ["distributors", "list"],
    "/api/v1/distributors",
  );
  const [selected, setSelected] = useState("");
  if (!portal) return <OfficeDistributors partners={partners} />;
  const current =
    partners.data?.rows.find((p) => p.id === selected) ??
    partners.data?.rows[0];
  return (
    <div className="grid min-w-0 gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {current?.name ?? "Distributor portal"}
          </h1>
          <p className="mt-2 text-sm text-muted">
            Order, declare stock, submit retailer invoices and follow up money.
          </p>
        </div>
        {partners.data && partners.data.rows.length > 1 ? (
          <Field label="Distributor">
            <select
              className={`${fieldClass} min-w-64 !pr-10`}
              value={current?.id ?? ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              {partners.data.rows.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </header>
      <State query={partners}>
        {() =>
          current ? (
            <PartnerDetail key={current.id} partner={current} office={false} />
          ) : (
            <Empty>
              No current distributor membership. Ask Channel Development to
              invite this email to the correct partner.
            </Empty>
          )
        }
      </State>
    </div>
  );
}

/** Distributor rows matching the search box and status chip. */
export function filterPartners(
  rows: Partner[],
  q: string,
  status: string | null,
) {
  const needle = q.trim().toLowerCase();
  return rows.filter(
    (p) =>
      (!status || p.status === status) &&
      (!needle || `${p.name} ${p.code}`.toLowerCase().includes(needle)),
  );
}

/** Office: the distributor list (search · Add distributor · chips · pages), or one distributor at ?id=. */
function OfficeDistributors({
  partners,
}: {
  partners: ReturnType<typeof useApi<{ rows: Partner[]; next: string | null }>>;
}) {
  const session = useSession();
  const { params, set, hrefWith } = useUrlState();
  const [adding, setAdding] = useState<string | null>(null);
  const canAdd = ["super_admin", "admin"].includes(session.profile?.role ?? "");
  const id = params.get("id");
  const rows = partners.data?.rows ?? null;
  const current = id ? rows?.find((p) => p.id === id) : undefined;
  if (id)
    return (
      <div className="grid min-w-0 gap-5">
        <Link
          href={hrefWith({ id: null, tab: null })}
          className="text-sm text-muted underline"
        >
          ← Distributors
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {current?.name ?? "Distributor"}
        </h1>
        <State query={partners}>
          {() =>
            current ? (
              <PartnerDetail key={current.id} partner={current} office />
            ) : (
              <Empty>This distributor is not on your list.</Empty>
            )
          }
        </State>
      </div>
    );
  const q = params.get("q") ?? "";
  const status = params.get("status");
  const page = readPage(params);
  const hits = filterPartners(rows ?? [], q, status);
  const statuses = [...new Set((rows ?? []).map((p) => p.status))].sort();
  return (
    <div className="grid min-w-0 gap-5">
      <ListPage<Partner>
        noun={{ one: "distributor", many: "distributors" }}
        rows={
          rows ? hits.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null
        }
        total={rows ? hits.length : null}
        loading={!rows && !partners.error}
        page={page}
        onPage={(n) => set({ page: n > 1 ? String(n) : null })}
        q={q}
        onSearch={(v) => set({ q: v || null, page: null }, { replace: true })}
        searchPlaceholder="Search by name or code"
        onAdd={canAdd ? (name) => setAdding(name) : undefined}
        filters={statuses.map((s) => ({
          id: s,
          label: words(s),
          count: (rows ?? []).filter((p) => p.status === s).length,
        }))}
        filter={status}
        onFilter={(v) => set({ status: v, page: null })}
        rowKey={(p) => p.id}
        rowHref={(p) =>
          hrefWith({ id: p.id, q: null, page: null, status: null })
        }
        columns={[
          {
            key: "name",
            label: "Distributor",
            primary: true,
            render: (p) => p.name,
            text: (p) => p.name,
          },
          {
            key: "code",
            label: "Code",
            render: (p) => p.code,
            text: (p) => p.code,
          },
          {
            key: "status",
            label: "Status",
            render: (p) => words(p.status),
            text: (p) => words(p.status),
          },
          {
            key: "edit",
            label: "",
            align: "right",
            render: () =>
              canAdd ? (
                <span className="inline-flex min-h-9 items-center rounded-[10px] border border-border px-3 text-sm font-medium">
                  Edit
                </span>
              ) : null,
          },
        ]}
      />
      {partners.data?.next ? (
        <p className="text-sm text-muted">
          Showing the first 200 distributors.
        </p>
      ) : null}
      <Drawer
        open={adding !== null}
        title="Add distributor"
        onClose={() => setAdding(null)}
      >
        {adding !== null ? (
          <AddDistributor
            key={adding}
            name={adding}
            orgUnitId={session.profile?.orgUnitId}
            onCancel={() => setAdding(null)}
            onSaved={(newId) => {
              setAdding(null);
              set({ id: newId, q: null, page: null, status: null });
            }}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

function AddDistributor({
  name,
  orgUnitId,
  onCancel,
  onSaved,
}: {
  name: string;
  orgUnitId?: string | null;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  return (
    <form
      aria-label="Add distributor"
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setPending(true);
        setError(null);
        try {
          const result = await mutate<{ id: string }>(
            "/api/v1/distributors/create",
            { code: value(f, "code"), name: value(f, "name"), orgUnitId },
            { invalidate: [["distributors", "list"]] },
          );
          onSaved(result.id);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not save");
        } finally {
          setPending(false);
        }
      }}
    >
      <Field label="Name">
        <input
          required
          name="name"
          defaultValue={name}
          className={fieldClass}
        />
      </Field>
      <Field label="Code">
        <input required name="code" className={fieldClass} />
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className={`${buttonClass} !bg-foreground !text-background`}
        >
          Save
        </button>
        <button type="button" className={buttonClass} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
function PartnerDetail({
  partner,
  office,
}: {
  partner: Partner;
  office: boolean;
}) {
  const session = useSession(),
    url = useUrlState(),
    tab = url.params.get("tab") ?? "overview",
    setTab = (t: string) => url.set({ tab: t === "overview" ? null : t }),
    command = usePartnerCommand(partner.id);
  const query = usePartnerQuery<Workspace>(partner.id, "workspace");
  const canManage =
    office && ["super_admin", "admin"].includes(session.profile?.role ?? "");
  const tabs = TABS.filter(
    (t) =>
      office ||
      partner.grants?.includes(t.grant) ||
      (t.id === "field" && partner.grants?.includes("settlement")),
  );
  const active =
    tabs.some((t) => t.id === tab) || (tab === "setup" && canManage)
      ? tab
      : tabs[0]?.id;
  const has = (grant: string) =>
    office || Boolean(partner.grants?.includes(grant));
  const canWrite = office ? canManage : true;
  useLive(`distributor:${partner.id}`, [["distributors", partner.id]]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-y border-border py-3 text-sm">
        <span>{words(partner.status)}</span>
        {partner.source === "sample" ? (
          <span className="rounded border border-border px-2 py-1 text-xs">
            Fictional sample data · Mock SAP
          </span>
        ) : null}
        <span className="text-muted">Only this distributor's records</span>
      </div>
      <nav
        aria-label="Distributor sections"
        className="flex flex-wrap gap-1 border-b border-border pb-2"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={active === t.id ? "page" : undefined}
            className={`${buttonClass} shrink-0 ${active === t.id ? "!bg-foreground !text-background" : ""}`}
          >
            {t.label}
          </button>
        ))}
        {canManage ? (
          <button
            onClick={() => setTab("setup")}
            aria-current={active === "setup" ? "page" : undefined}
            className={`${buttonClass} shrink-0 ${active === "setup" ? "!bg-foreground !text-background" : ""}`}
          >
            Partner setup
          </button>
        ) : null}
      </nav>
      {active === "setup" && canManage ? (
        <Setup id={partner.id} command={command} />
      ) : (
        <State query={query}>
          {(w) => (
            <>
              {active === "overview" ? (
                <Overview
                  workspace={w}
                  onStock={() => setTab("stock")}
                  stockAllowed={has("stock")}
                />
              ) : null}
              {active === "orders" ? (
                <Ordering workspace={w} command={command} canWrite={canWrite} />
              ) : null}
              {active === "stock" ? (
                <Stock workspace={w} command={command} canWrite={canWrite} />
              ) : null}
              {active === "secondary" ? (
                <Secondary
                  workspace={w}
                  command={command}
                  canWrite={canWrite}
                />
              ) : null}
              {active === "reconciliation" ? (
                <Reconcile
                  workspace={w}
                  command={command}
                  canWrite={canWrite}
                />
              ) : null}
              {active === "claims" ? (
                <>
                  <Claims
                    workspace={w}
                    command={command}
                    canWrite={canWrite}
                    office={office}
                  />
                  <ClaimantClaims
                    key={partner.id}
                    base="/api/v1/distributors/claims/shared"
                    partyId={partner.id}
                    name={partner.name}
                  />
                </>
              ) : null}
              {active === "money" ? (
                <Money
                  workspace={w}
                  command={command}
                  canWrite={canWrite}
                  office={office}
                />
              ) : null}
              {active === "documents" ? (
                <Documents
                  workspace={w}
                  command={command}
                  canWrite={canWrite}
                  office={office}
                />
              ) : null}
              {active === "accreditation" ? (
                <Accreditation
                  workspace={w}
                  command={command}
                  canWrite={canWrite}
                  office={office}
                />
              ) : null}
              {active === "field" ? (
                <FieldConfig
                  id={partner.id}
                  showVan={has("settlement")}
                  showDsr={has("dsr")}
                  office={canManage}
                  command={command}
                />
              ) : null}
            </>
          )}
        </State>
      )}
      {query.error && canManage && active !== "setup" ? (
        <button onClick={() => setTab("setup")} className={buttonClass}>
          Set up partner policy and SAP synchronization
        </button>
      ) : null}
    </>
  );
}
function FieldConfig({
  id,
  showVan,
  showDsr,
  office,
  command,
}: {
  id: string;
  showVan: boolean;
  showDsr: boolean;
  office: boolean;
  command: (action: string, body: Record<string, unknown>) => Promise<unknown>;
}) {
  const config = usePartnerQuery<{
      engine: string;
      nativeReady: boolean;
      outlets: { id: string; name: string }[];
    }>(id, "callflow-config", showDsr),
    van = usePartnerQuery<PartnerVanData>(id, "van-context", showVan);
  return (
    <>
      {showDsr ? (
        <State query={config}>
          {(c) => (
            <Panel
              title="Distributor reps use the shared call flow"
              detail="Invite a dedicated field representative in Setup, assign their PJP and stores, then sign in to the existing Android field app. Portal credentials remain separate; no distributor app is needed."
            >
              <p className="text-sm">
                Assigned shared outlets: {c.outlets.length}
              </p>
              <ul className="grid gap-2 text-sm">
                {c.outlets.map((o) => (
                  <li key={o.id}>{o.name}</li>
                ))}
              </ul>
              <p className="text-sm text-muted">
                {c.nativeReady
                  ? "Native configuration connected"
                  : "Native connection pending"}
              </p>
            </Panel>
          )}
        </State>
      ) : null}
      {showVan ? (
        <State query={van}>
          {(v) => <VanArrangement data={v} office={office} command={command} />}
        </State>
      ) : null}
    </>
  );
}
