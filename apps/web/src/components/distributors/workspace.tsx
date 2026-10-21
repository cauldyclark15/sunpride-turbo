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
import type { Partner, Workspace } from "./types";
import {
  ActionForm,
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
  const session = useSession(),
    partners = useApi<{ rows: Partner[]; next: string | null }>(
      ["distributors", "list"],
      "/api/v1/distributors",
    );
  const [selected, setSelected] = useState("");
  const current =
    partners.data?.rows.find((p) => p.id === selected) ??
    partners.data?.rows[0];
  return (
    <div className="grid min-w-0 gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[.15em] text-muted">
            {portal
              ? "Your distributor workspace"
              : "Work · Channel Development"}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {portal
              ? (current?.name ?? "Distributor portal")
              : "Distributors & secondary sales"}
          </h1>
          <p className="mt-2 text-sm text-muted">
            {portal
              ? "Order, declare stock, submit retailer invoices and follow up money."
              : "Which partner needs attention, and does sell-in reconcile to retailer offtake?"}
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
        {(data) => (
          <>
            {current ? (
              <PartnerDetail
                key={current.id}
                partner={current}
                office={!portal}
              />
            ) : (
              <Empty>
                No current distributor membership. Ask Channel Development to
                invite this email to the correct partner.
              </Empty>
            )}
            {data.next ? (
              <p className="text-sm text-muted">
                Showing the first 200 distributors; more partners exist.
              </p>
            ) : null}
          </>
        )}
      </State>
      {!portal &&
      ["super_admin", "admin"].includes(session.profile?.role ?? "") ? (
        <ActionForm
          title="New distributor organization"
          submitLabel="Create applicant organization"
          onSubmit={async (f) => {
            const result = await mutate<{ id: string }>(
              "/api/v1/distributors/create",
              {
                code: value(f, "code"),
                name: value(f, "name"),
                orgUnitId: session.profile?.orgUnitId,
              },
              { invalidate: [["distributors", "list"]] },
            );
            setSelected(result.id);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Distributor code">
              <input required name="code" className={fieldClass} />
            </Field>
            <Field label="Distributor name">
              <input required name="name" className={fieldClass} />
            </Field>
          </div>
          <p className="text-xs text-muted">
            Supervised within your current Sunpride area. Set policy and import
            the SAP master snapshot next.
          </p>
        </ActionForm>
      ) : null}
    </div>
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
    [tab, setTab] = useState("overview"),
    command = usePartnerCommand(partner.id);
  const query = usePartnerQuery<Workspace>(partner.id, "workspace");
  const canManage =
    office && ["super_admin", "admin"].includes(session.profile?.role ?? "");
  const tabs = TABS.filter((t) => office || partner.grants?.includes(t.grant));
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
                <FieldConfig id={partner.id} showVan={has("settlement")} />
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
function FieldConfig({ id, showVan }: { id: string; showVan: boolean }) {
  const config = usePartnerQuery<{
      engine: string;
      nativeReady: boolean;
      outlets: { id: string; name: string }[];
    }>(id, "callflow-config"),
    van = usePartnerQuery<{
      ready: boolean;
      message: string;
      vans: { id: string; name: string }[];
    }>(id, "van-context", showVan);
  return (
    <>
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
      {showVan ? (
        <State query={van}>
          {(v) => (
            <Panel
              title="Distributor van load and settlement"
              detail={v.message}
            >
              <ul className="grid gap-2 text-sm">
                {v.vans.map((x) => (
                  <li key={x.id}>{x.name}</li>
                ))}
              </ul>
            </Panel>
          )}
        </State>
      ) : null}
    </>
  );
}
