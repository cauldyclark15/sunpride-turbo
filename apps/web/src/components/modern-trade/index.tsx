"use client";
import { useState } from "react";
import { useApi, useLive } from "../../lib/api";
import { usePermissions, useSession } from "../../lib/auth/session";
import type { DeductionType, Options } from "./model";
import { IntakeConsole } from "./intake";
import { TradeTerms } from "./terms";
import { DeductionWorkspace } from "./deductions";
import {
  Field,
  Form,
  Notice,
  action,
  dateText,
  inputClass,
  iso,
  panel,
  text,
  useCommand,
} from "./kit";

export function ModernTradeWorkspace() {
  const { can } = usePermissions(),
    session = useSession(),
    [tab, setTab] = useState("intake");
  const query = useApi<Options>(["mt", "options"], "/api/v1/mt/options");
  useLive(["mt"], [["mt"]]);
  if (query.error) return <Notice>{query.error.message}</Notice>;
  if (!query.data) return <Notice>Loading account branches…</Notice>;
  const options = query.data;
  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Modern trade</h1>
        <p className="mt-1 text-sm text-muted">
          Which purchase orders and account deductions need action today?
        </p>
      </div>
      <nav aria-label="Modern trade views" className="flex flex-wrap gap-2">
        {[
          ["intake", "PO intake"],
          ["terms", "Trade terms"],
          ["deductions", "Deductions"],
          ...(can("masterdata.manage") ? [["settings", "Account setup"]] : []),
        ].map(([key = "", title = ""]) => (
          <button
            className={`${action} ${tab === key ? "bg-foreground text-background" : ""}`}
            key={key}
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
          >
            {title}
          </button>
        ))}
      </nav>
      {!options.bindings.length ? (
        <Notice>
          No modern-trade branches are configured in your area. Add the marked
          sample data or map branches in Account setup.
        </Notice>
      ) : null}
      {tab === "intake" ? (
        <IntakeConsole options={options} canEdit={can("order.encode")} />
      ) : null}
      {tab === "terms" ? (
        <TradeTerms
          options={options}
          canEdit={can("masterdata.manage")}
          canApprove={can("order.approve")}
          userId={session.profile?.subject ?? ""}
        />
      ) : null}
      {tab === "deductions" ? (
        <DeductionWorkspace
          options={options}
          canEdit={can("order.encode")}
          canApprove={can("order.approve")}
        />
      ) : null}
      {tab === "settings" && can("masterdata.manage") ? (
        <Settings options={options} />
      ) : null}
    </div>
  );
}
function Settings({ options }: { options: Options }) {
  const cmd = useCommand();
  const query = useApi<{
    types: DeductionType[];
    stores: {
      outlet_id: string;
      outlet_name: string;
      customer_id: string;
      customer_name: string;
    }[];
    externalUsers: { id: string; name: string; email: string }[];
    profiles: {
      id: string;
      account_key: string;
      format: string;
      columns: Record<string, string>;
      effective_from: string;
      effective_to: string | null;
    }[];
  }>(["mt", "settings"], "/api/v1/mt/settings");
  const { can } = usePermissions();
  return (
    <div className="grid gap-5">
      {cmd.error ? <Notice>{cmd.error}</Notice> : null}
      {query.error ? <Notice>{query.error.message}</Notice> : null}
      <section className={panel}>
        <h2 className="mb-4 font-semibold">Account export mapping</h2>
        <Form
          onSubmit={async (f) => {
            await cmd.run("/api/v1/mt/settings/parser", {
              accountKey: text(f, "account"),
              format: text(f, "format"),
              effectiveFrom: iso(f, "from"),
              columns: Object.fromEntries(
                [
                  "po_number",
                  "delivery_date",
                  "sku",
                  "uom",
                  "quantity",
                  "price_centavos",
                ].map((k) => [k, text(f, k) || k]),
              ),
            });
          }}
        >
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Account">
              <select name="account" className={inputClass}>
                {[...new Set(options.bindings.map((b) => b.account_key))].map(
                  (k) => (
                    <option key={k}>{k}</option>
                  ),
                )}
              </select>
            </Field>
            <Field label="Format">
              <select name="format" className={inputClass}>
                <option value="csv">CSV / portal export</option>
                <option value="email">Structured email</option>
              </select>
            </Field>
            <Field label="Effective from">
              <input type="date" name="from" required className={inputClass} />
            </Field>
            {[
              ["po_number", "PO number header"],
              ["delivery_date", "Delivery date header"],
              ["sku", "Product header"],
              ["uom", "Unit header"],
              ["quantity", "Quantity header"],
              ["price_centavos", "Centavo price header"],
            ].map(([k = "", l = ""]) => (
              <Field key={k} label={l}>
                <input name={k} defaultValue={k} className={inputClass} />
              </Field>
            ))}
          </div>
          <button className={action} disabled={cmd.pending}>
            Publish new mapping version
          </button>
        </Form>
        {query.data?.profiles.map((p) => (
          <p className="mt-3 text-sm text-muted" key={p.id}>
            {p.account_key} · {p.format.toUpperCase()} · from{" "}
            {dateText(p.effective_from)}
            {p.effective_to ? ` until ${dateText(p.effective_to)}` : ""}
          </p>
        ))}
      </section>
      <section className={panel}>
        <h2 className="mb-4 font-semibold">Deduction types & follow-up SLA</h2>
        <Form
          onSubmit={async (f) => {
            await cmd.run("/api/v1/mt/settings/deduction-type", {
              code: text(f, "code"),
              label: text(f, "label"),
              slaDays: Number(text(f, "sla")),
              effectiveFrom: iso(f, "from"),
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Type code">
              <input name="code" required className={inputClass} />
            </Field>
            <Field label="Plain name">
              <input name="label" required className={inputClass} />
            </Field>
            <Field label="Follow up within · days">
              <input
                name="sla"
                type="number"
                min="1"
                max="365"
                required
                className={inputClass}
              />
            </Field>
            <Field label="Effective from">
              <input name="from" type="date" required className={inputClass} />
            </Field>
          </div>
          <button className={action} disabled={cmd.pending}>
            Publish type version
          </button>
        </Form>
        <ul className="mt-4 grid gap-2 text-sm">
          {query.data?.types.map((t) => (
            <li key={t.id}>
              {t.label} · {t.sla_days} days · {dateText(t.effective_from)}
              {t.effective_to ? ` → ${dateText(t.effective_to)}` : ""}
            </li>
          ))}
        </ul>
      </section>
      <section className={panel}>
        <h2 className="mb-2 font-semibold">Branch adapter mappings</h2>
        <p className="mb-4 text-sm text-muted">
          Temporary seam to the shared account master. Store and accounting
          customer stay canonical. Keys are the upstream chain, banner and
          branch codes.
        </p>
        <Form
          onSubmit={async (f) => {
            await cmd.run("/api/v1/mt/bindings/save", {
              customerId: query.data?.stores.find(
                (s) => s.outlet_id === text(f, "outlet"),
              )?.customer_id,
              outletId: text(f, "outlet"),
              accountKey: text(f, "account"),
              bannerKey: text(f, "banner"),
              branchKey: text(f, "branch"),
              label: text(f, "label"),
              effectiveFrom: iso(f, "from"),
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Existing store and accounting customer">
              <select name="outlet" required className={inputClass}>
                {query.data?.stores.map((s) => (
                  <option key={s.outlet_id} value={s.outlet_id}>
                    {s.outlet_name} · {s.customer_name}
                  </option>
                ))}
              </select>
            </Field>
            {[
              ["account", "Chain key"],
              ["banner", "Banner key"],
              ["branch", "Branch key"],
              ["label", "Branch name"],
            ].map(([k = "", l = ""]) => (
              <Field key={k} label={l}>
                <input name={k} required className={inputClass} />
              </Field>
            ))}
            <Field label="Effective from">
              <input name="from" type="date" required className={inputClass} />
            </Field>
          </div>
          <button className={action} disabled={cmd.pending}>
            Map branch
          </button>
        </Form>
      </section>
      {can("admin.manage") ? (
        <section className={panel}>
          <h2 className="mb-4 font-semibold">Customer portal access</h2>
          <Form
            onSubmit={async (f) => {
              await cmd.run("/api/v1/mt/portal/access", {
                userId: text(f, "user"),
                name: text(f, "name"),
                scopeKind: text(f, "kind"),
                scopeKey: text(f, "scope"),
                effectiveFrom: iso(f, "from"),
                effectiveTo: text(f, "to") ? iso(f, "to") : null,
              });
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Customer login">
                <select name="user" required className={inputClass}>
                  {query.data?.externalUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} · {u.email}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Customer name">
                <input name="name" required className={inputClass} />
              </Field>
              <Field label="Access level">
                <select name="kind" className={inputClass}>
                  <option value="account">Chain</option>
                  <option value="banner">Banner</option>
                  <option value="branch">Branch</option>
                </select>
              </Field>
              <Field label="Account key">
                <input name="scope" required className={inputClass} />
              </Field>
              <Field label="Starts">
                <input
                  type="date"
                  name="from"
                  required
                  className={inputClass}
                />
              </Field>
              <Field label="Ends · optional">
                <input type="date" name="to" className={inputClass} />
              </Field>
            </div>
            <button className={action} disabled={cmd.pending}>
              Publish access period
            </button>
          </Form>
          <p className="mt-3 text-sm text-muted">
            The portal is at /portal/login. Customer identities have no employee
            profile or office permissions. Sample passwords are written only to
            the private trial record.
          </p>
        </section>
      ) : null}
    </div>
  );
}
