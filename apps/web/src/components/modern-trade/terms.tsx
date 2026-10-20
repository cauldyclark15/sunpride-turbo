"use client";
import { useState } from "react";
import { useApi } from "../../lib/api";
import type { Options, Term } from "./model";
import {
  ExportActions,
  Field,
  Form,
  Notice,
  action,
  dateText,
  inputClass,
  iso,
  label,
  panel,
  php,
  text,
  useCommand,
} from "./kit";

type Condition = {
  kind: string;
  productCode: string;
  uom: string;
  amountCentavos: string;
  rateBps: string;
};
export function TradeTerms({
  options,
  canEdit,
  canApprove,
  userId,
}: {
  options: Options;
  canEdit: boolean;
  canApprove: boolean;
  userId: string;
}) {
  const query = useApi<{ rows: Term[] }>(["mt", "terms"], "/api/v1/mt/terms"),
    cmd = useCommand();
  const [conditions, setConditions] = useState<Condition[]>([
    {
      kind: "price",
      productCode: options.products[0]?.code ?? "",
      uom: options.products[0]?.uom ?? "PC",
      amountCentavos: "",
      rateBps: "",
    },
  ]);
  const [scopeKind, setScopeKind] = useState("branch");
  const scopes = [
    ...new Map(
      options.bindings.map((b) => {
        const key =
          scopeKind === "account"
            ? b.account_key
            : scopeKind === "banner"
              ? b.banner_key
              : b.branch_key;
        return [key, { key, name: scopeKind === "branch" ? b.label : key }];
      }),
    ).values(),
  ];
  return (
    <div className="grid gap-5">
      <Notice>
        Sample SAP conditions. A different approver must publish each request.
        SAP remains the production pricing authority; local terms never post
        accounting entries.
      </Notice>
      {cmd.error ? <Notice>{cmd.error}</Notice> : null}
      {query.error ? <Notice>{query.error.message}</Notice> : null}
      {query.data ? (
        <ExportActions
          name="account-terms"
          rows={[
            [
              "Terms",
              "Account scope",
              "Status",
              "From",
              "Until",
              "Condition",
              "Product",
              "Unit",
              "Centavos",
              "Basis points",
            ],
            ...query.data.rows.flatMap((t) =>
              t.conditions.map((l) => [
                t.name,
                t.scopeLabel,
                t.status,
                dateText(t.effective_from),
                dateText(t.effective_to),
                label(l.kind),
                l.product_name ?? "",
                l.uom ?? "",
                l.amount_centavos ?? "",
                l.rate_bps ?? "",
              ]),
            ),
          ]}
        />
      ) : null}
      {canEdit ? (
        <details className={panel}>
          <summary className="cursor-pointer font-semibold">
            Propose account terms
          </summary>
          <div className="mt-4">
            <Form
              onSubmit={async (f) => {
                await cmd.run("/api/v1/mt/terms/save", {
                  name: text(f, "name"),
                  scopeKind,
                  scopeKey: text(f, "scope"),
                  effectiveFrom: iso(f, "from"),
                  effectiveTo: text(f, "to") ? iso(f, "to") : null,
                  conditions: conditions.map((l) => ({
                    kind: l.kind,
                    ...(l.kind === "price"
                      ? { productCode: l.productCode, uom: l.uom }
                      : {}),
                    ...(l.amountCentavos !== ""
                      ? { amountCentavos: Number(l.amountCentavos) }
                      : l.rateBps !== ""
                        ? { rateBps: Number(l.rateBps) }
                        : {}),
                  })),
                });
              }}
            >
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="Terms name">
                  <input
                    name="name"
                    className={inputClass}
                    required
                    placeholder="Sample 2027 supply agreement"
                  />
                </Field>
                <Field label="Account level">
                  <select
                    className={inputClass}
                    value={scopeKind}
                    onChange={(e) => setScopeKind(e.target.value)}
                  >
                    <option value="account">Chain</option>
                    <option value="banner">Banner</option>
                    <option value="branch">Branch</option>
                  </select>
                </Field>
                <Field label="Applies to">
                  <select className={inputClass} name="scope" required>
                    {scopes.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Effective from · Manila">
                  <input
                    type="date"
                    name="from"
                    className={inputClass}
                    required
                  />
                </Field>
                <Field label="Effective until · optional">
                  <input type="date" name="to" className={inputClass} />
                </Field>
              </div>
              {conditions.map((l, i) => (
                <div
                  key={i}
                  className="grid items-end gap-3 rounded-lg border border-border p-3 sm:grid-cols-2 lg:grid-cols-5"
                >
                  <Field label={`Condition ${i + 1}`}>
                    <select
                      className={inputClass}
                      value={l.kind}
                      onChange={(e) =>
                        setConditions(
                          conditions.map((x, n) =>
                            n === i
                              ? { ...x, kind: e.target.value, rateBps: "" }
                              : x,
                          ),
                        )
                      }
                    >
                      {[
                        "price",
                        "listing_fee",
                        "rebate",
                        "logistics_allowance",
                      ].map((k) => (
                        <option key={k} value={k}>
                          {label(k)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {l.kind === "price" ? (
                    <>
                      <Field label="Product">
                        <select
                          className={inputClass}
                          value={l.productCode}
                          onChange={(e) =>
                            setConditions(
                              conditions.map((x, n) =>
                                n === i
                                  ? {
                                      ...x,
                                      productCode: e.target.value,
                                      uom:
                                        options.products.find(
                                          (p) => p.code === e.target.value,
                                        )?.uom ?? "PC",
                                    }
                                  : x,
                              ),
                            )
                          }
                        >
                          {options.products.map((p) => (
                            <option key={p.code} value={p.code}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Selling unit">
                        <input
                          className={inputClass}
                          value={l.uom}
                          onChange={(e) =>
                            setConditions(
                              conditions.map((x, n) =>
                                n === i ? { ...x, uom: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </Field>
                    </>
                  ) : null}
                  <Field label="Amount · whole centavos">
                    <input
                      className={inputClass}
                      type="number"
                      min="0"
                      step="1"
                      value={l.amountCentavos}
                      onChange={(e) =>
                        setConditions(
                          conditions.map((x, n) =>
                            n === i
                              ? {
                                  ...x,
                                  amountCentavos: e.target.value,
                                  rateBps: "",
                                }
                              : x,
                          ),
                        )
                      }
                    />
                  </Field>
                  {l.kind !== "price" ? (
                    <Field label="Or rate · basis points (100 = 1%)">
                      <input
                        className={inputClass}
                        type="number"
                        min="0"
                        max="10000"
                        step="1"
                        value={l.rateBps}
                        onChange={(e) =>
                          setConditions(
                            conditions.map((x, n) =>
                              n === i
                                ? {
                                    ...x,
                                    rateBps: e.target.value,
                                    amountCentavos: "",
                                  }
                                : x,
                            ),
                          )
                        }
                      />
                    </Field>
                  ) : null}
                  <button
                    type="button"
                    className={action}
                    onClick={() =>
                      setConditions(conditions.filter((_, n) => n !== i))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="flex gap-2">
                <button
                  className={action}
                  type="button"
                  onClick={() =>
                    setConditions([
                      ...conditions,
                      {
                        kind: "rebate",
                        productCode: "",
                        uom: "PC",
                        amountCentavos: "",
                        rateBps: "",
                      },
                    ])
                  }
                >
                  Add condition
                </button>
                <button
                  className={action}
                  disabled={cmd.pending || !conditions.length}
                >
                  Save draft terms
                </button>
              </div>
            </Form>
          </div>
        </details>
      ) : null}
      {query.data?.rows.map((t) => (
        <article className={panel} key={t.id}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">{t.name}</h2>
              <p className="text-sm text-muted">
                {t.scopeLabel} · {label(t.scope_kind)} · {label(t.status)} ·{" "}
                {label(t.source)} data
              </p>
              <p className="text-sm text-muted">
                {dateText(t.effective_from)} →{" "}
                {t.effective_to ? dateText(t.effective_to) : "Open ended"}
              </p>
            </div>
            {canApprove &&
            t.status === "submitted" &&
            t.requested_by !== userId ? (
              <div className="flex gap-2">
                <button
                  className={action}
                  disabled={cmd.pending}
                  onClick={() =>
                    void cmd.run("/api/v1/mt/terms/approve", {
                      id: t.id,
                      note: "Reviewed account conditions",
                    })
                  }
                >
                  Approve
                </button>
                <button
                  className={action}
                  disabled={cmd.pending}
                  onClick={() =>
                    void cmd.run("/api/v1/mt/terms/reject", {
                      id: t.id,
                      note: "Account conditions need revision",
                    })
                  }
                >
                  Reject
                </button>
              </div>
            ) : null}
            {canEdit && t.status === "draft" ? (
              <button
                className={action}
                disabled={cmd.pending}
                onClick={() =>
                  void cmd.run("/api/v1/mt/terms/submit", { id: t.id })
                }
              >
                Submit for approval
              </button>
            ) : null}
          </div>
          {canApprove &&
          t.status === "approved" &&
          t.source === "sample" &&
          t.requested_by !== userId ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm underline">
                Schedule an end or replacement
              </summary>
              <div className="mt-3">
                <Form
                  onSubmit={async (f) => {
                    await cmd.run("/api/v1/mt/terms/end", {
                      id: t.id,
                      effectiveTo: iso(f, "end"),
                      note: text(f, "reason"),
                    });
                  }}
                >
                  <Field label="Effective until · future Manila date">
                    <input
                      name="end"
                      type="date"
                      required
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Reason">
                    <input name="reason" required className={inputClass} />
                  </Field>
                  <button className={action} disabled={cmd.pending}>
                    Approve end of terms
                  </button>
                </Form>
              </div>
            </details>
          ) : null}
          <ul className="my-4 grid gap-2 text-sm">
            {t.conditions.map((l) => (
              <li key={l.id} className="border-b border-border py-2">
                {label(l.kind)}
                {l.product_name ? ` · ${l.product_name} / ${l.uom}` : ""}
                <span className="float-right font-medium">
                  {l.amount_centavos !== null
                    ? php(l.amount_centavos)
                    : `${Number(l.rate_bps) / 100}%`}
                </span>
              </li>
            ))}
          </ul>
          <details className="text-sm">
            <summary className="cursor-pointer">Approval history</summary>
            {t.events.map((e, i) => (
              <p key={i} className="mt-2">
                {dateText(e.created_at)} · {e.actor_name ?? "Account team"} ·{" "}
                {label(e.action)} · {e.note}
              </p>
            ))}
          </details>
        </article>
      ))}
      {query.data?.rows.length === 0 ? (
        <Notice>
          No account terms yet. Propose a sample agreement to start.
        </Notice>
      ) : null}
    </div>
  );
}
