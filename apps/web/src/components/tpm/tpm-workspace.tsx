"use client";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { mutate, useApi, useLive } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import { TrendChart } from "../cockpit/kit/trend-chart";
import {
  ClaimEvidencePreview,
  type EvidencePreview,
} from "./claim-evidence-preview";
import {
  centavos,
  signedCentavos,
  day,
  peso,
  words,
  type Campaign,
  type Claim,
  type Options,
  type Policies,
  type Summary,
  type Liability,
  type Deduction,
  type Roi,
  type Incentives,
} from "./model";

const input =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground";
const button =
  "rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40";
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-xs text-muted">
      {label}
      {children}
    </label>
  );
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 rounded-lg border border-border bg-surface p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}
/** F-501/F-507 stable retry keys; never optimistically show a Finance write as successful. */
function CommandForm({
  path,
  build,
  children,
  label = "Save",
  reuseCompleted = true,
  onSaved,
}: {
  path: string;
  build: (data: FormData) => Record<string, unknown>;
  children: ReactNode;
  label?: string;
  reuseCompleted?: boolean;
  onSaved?: () => void;
}) {
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  const request = useRef<{ signature: string; key: string } | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setMessage("");
    try {
      const body = build(new FormData(e.currentTarget)),
        signature = JSON.stringify(body);
      if (request.current?.signature !== signature)
        request.current = { signature, key: crypto.randomUUID() };
      const result = await mutate<{
        passed?: boolean;
        reasons?: string[];
        status?: string;
      }>(
        path,
        { ...body, idempotencyKey: request.current.key },
        { invalidate: [["tpm"], ["pricing"]] },
      );
      setMessage(
        result.passed === false
          ? (result.reasons?.join(". ") ?? "More evidence needed")
          : result.status === "pending_sap"
            ? "Requested. Settlement waits for SAP confirmation."
            : "Saved.",
      );
      // Creation replays stay stable; explicit recalculation must read newly changed source facts.
      if (!reuseCompleted) request.current = null;
      onSaved?.();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={submit} className="grid gap-3">
      <fieldset disabled={pending} className="grid gap-3 sm:grid-cols-2">
        {children}
      </fieldset>
      <div>
        <button className={button} disabled={pending}>
          {pending ? "Saving…" : label}
        </button>
      </div>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </form>
  );
}
function QueryState({
  error,
  loading,
}: {
  error?: { message: string };
  loading: boolean;
}) {
  return error ? (
    <p role="alert" className="text-sm">
      {error.message}
    </p>
  ) : loading ? (
    <p className="text-sm text-muted">Loading…</p>
  ) : null;
}
function Snapshot({ data }: { data: Summary }) {
  return (
    <div className="grid gap-3 md:grid-cols-4">
      {[
        [
          "Committed trade spend",
          peso(data.committedCentavos),
          `Budget ${peso(data.budgetCentavos)}`,
        ],
        [
          "Claims needing evidence",
          String(data.claimsAwaitingEvidence),
          "Link captured evidence before approval",
        ],
        [
          "Claims ready for approval",
          String(data.claimsAwaitingApproval),
          "Independent Finance decision needed",
        ],
        [
          "Claims · last 14 days",
          peso(data.claimsCurrentCentavos),
          `Prior 14 days ${peso(data.claimsPriorCentavos)}`,
        ],
      ].map(([label, value, note]) => (
        <section key={label} className="border border-border rounded-lg p-4">
          <p className="text-xs text-muted">{label}</p>
          <p className="my-2 text-2xl font-semibold">{value}</p>
          <p className="text-xs text-muted">{note}</p>
        </section>
      ))}
    </div>
  );
}
export function TradeMarketingWorkspace() {
  const permissions = usePermissions(),
    canEdit = permissions.can("masterdata.manage");
  const summary = useApi<Summary>(["tpm", "summary"], "/api/v1/tpm/summary");
  const campaigns = useApi<{ rows: Campaign[] }>(
    ["tpm", "campaigns"],
    "/api/v1/tpm/campaigns",
  );
  const options = useApi<Options>(["tpm", "options"], "/api/v1/tpm/options");
  const roi = useApi<{ rows: Roi[] }>(["tpm", "roi"], "/api/v1/tpm/roi");
  const [selected, setSelected] = useState<Campaign | null>(null);
  useLive(["tpm"], [["tpm"]]);
  return (
    <div className="grid gap-5">
      <p className="text-sm text-muted">
        Which campaigns are earning their budget, and what needs action? Sample
        campaigns are labelled. ROI is directional, not a certified financial
        result.
      </p>
      <QueryState
        error={summary.error ?? campaigns.error ?? options.error ?? roi.error}
        loading={!summary.data || !campaigns.data}
      />
      {summary.data ? (
        <>
          <Snapshot data={summary.data} />
          <Panel title="Claims trend · last 28 days">
            <TrendChart
              label="Claim intake by day"
              dates={summary.data.trend.map((r) => r.date)}
              series={[
                {
                  key: "claims",
                  label: "Claimed value",
                  kind: "bar",
                  values: summary.data.trend.map((r) => r.amountCentavos),
                },
              ]}
            />
          </Panel>
        </>
      ) : null}
      <Panel title="Campaigns and budget">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  "Campaign",
                  "Period",
                  "Committed / budget",
                  "Expected volume",
                  "Next action",
                ].map((x) => (
                  <th className="p-2 text-xs text-muted" key={x}>
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {campaigns.data?.rows.map((c) => (
                <tr className="border-t border-border" key={c.versionId}>
                  <td className="p-2">
                    {c.name}
                    <p className="text-xs text-muted">
                      Version {c.version} · {words(c.status)} ·{" "}
                      {c.source === "sample" ? "Sample data" : "Office"}
                    </p>
                  </td>
                  <td className="p-2">
                    {day(c.effectiveFrom)} → {day(c.effectiveTo)}
                  </td>
                  <td className="p-2">
                    {peso(c.committedCentavos)} / {peso(c.budgetCentavos)}
                  </td>
                  <td className="p-2">
                    {c.expectedVolumeBase.toLocaleString()} pieces
                  </td>
                  <td className="p-2">
                    {canEdit ? (
                      <button className={button} onClick={() => setSelected(c)}>
                        Create next version
                      </button>
                    ) : (
                      "Review budget"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!campaigns.data?.rows.length ? (
          <p className="text-sm text-muted">
            No campaigns yet. Set a period and budget to start.
          </p>
        ) : null}
      </Panel>
      {canEdit ? (
        <Panel
          title={
            selected ? "Create a prospective campaign version" : "New campaign"
          }
        >
          <CampaignEditor
            key={selected?.versionId ?? "new"}
            campaign={selected}
            options={options.data}
          />
          {selected ? (
            <button className={button} onClick={() => setSelected(null)}>
              New campaign instead
            </button>
          ) : null}
        </Panel>
      ) : null}
      {canEdit && campaigns.data && options.data ? (
        <Panel title="Scheme authoring · shared engine version 1">
          <SchemeEditor
            campaigns={campaigns.data.rows}
            options={options.data}
          />
          <p className="text-xs text-muted">
            Lower precedence runs first. Stacked discounts use the remaining net
            value. Campaign period and scope always apply; exclusions win. New
            governed selling waits for Finance authority to be connected.
          </p>
        </Panel>
      ) : null}
      {canEdit && campaigns.data ? (
        <Panel title="Commit planned spend">
          <CommandForm
            path="/api/v1/tpm/budget/commit"
            build={(d) => ({
              campaignVersionId: d.get("campaign"),
              sourceKey: d.get("reference"),
              amountCentavos: centavos(d.get("amount")),
            })}
          >
            <Field label="Campaign">
              <CampaignPicker campaigns={campaigns.data.rows} />
            </Field>
            <Field label="Commitment reference">
              <input name="reference" required className={input} />
            </Field>
            <Field label="Amount · ₱">
              <input
                name="amount"
                required
                inputMode="decimal"
                className={input}
              />
            </Field>
          </CommandForm>
        </Panel>
      ) : null}
      <Panel title="Measured promotion uplift and ROI">
        <div className="grid gap-3 md:grid-cols-3">
          {roi.data?.rows.map((r) => (
            <article key={r.id} className="rounded-md border border-border p-4">
              <h3 className="font-medium">{r.campaignName}</h3>
              <p className="text-xs text-muted">
                {r.accountKey} · {r.mechanic}
              </p>
              <p className="mt-3 text-sm">
                Baseline {r.baselineVolumeBase.toLocaleString()} → promoted{" "}
                {r.promotedVolumeBase.toLocaleString()} pieces
              </p>
              <p className="text-sm">
                Incremental {r.incrementalVolumeBase.toLocaleString()} pieces ·
                spend {peso(r.spendCentavos)}
              </p>
              <p className="mt-2 text-sm">
                Gross ROI{" "}
                {r.grossRoiBps == null
                  ? "Unknown"
                  : `${(r.grossRoiBps / 100).toFixed(1)}%`}{" "}
                · net ROI{" "}
                {r.netRoiBps == null
                  ? "Unknown"
                  : `${(r.netRoiBps / 100).toFixed(1)}%`}
              </p>
              <p className="text-xs text-muted">
                Directional · review baseline and SAP margin source
              </p>
            </article>
          ))}
        </div>
        {canEdit && campaigns.data ? (
          <CommandForm
            path="/api/v1/tpm/roi/evaluate"
            reuseCompleted={false}
            label="Evaluate from governed sources"
            build={(d) => ({
              campaignVersionId: d.get("campaign"),
              accountKey: d.get("account"),
            })}
          >
            <Field label="Campaign">
              <CampaignPicker campaigns={campaigns.data.rows} />
            </Field>
            <Field label="Account code">
              <input name="account" required className={input} />
            </Field>
          </CommandForm>
        ) : null}
      </Panel>
    </div>
  );
}
function CampaignPicker({ campaigns }: { campaigns: Campaign[] }) {
  return (
    <select name="campaign" required className={input}>
      <option value="">Choose campaign</option>
      {campaigns.map((c) => (
        <option key={c.versionId} value={c.versionId}>
          {c.name} · version {c.version}
        </option>
      ))}
    </select>
  );
}
function CampaignEditor({
  campaign,
  options,
}: {
  campaign: Campaign | null;
  options?: Options;
}) {
  const [now] = useState(() => Date.now());
  return (
    <CommandForm
      path="/api/v1/tpm/campaigns/save"
      build={(d) => ({
        code: d.get("code"),
        name: d.get("name"),
        mechanic: d.get("mechanic"),
        status: d.get("status"),
        effectiveFrom: `${d.get("from")}T00:00:00+08:00`,
        effectiveTo: `${d.get("to")}T00:00:00+08:00`,
        budgetCentavos: centavos(d.get("budget")),
        expectedVolumeBase: Number(d.get("volume")),
        expectedRoiBps: centavos(d.get("roi")),
        scope: Object.fromEntries(
          [
            "channelKey",
            "classKey",
            "geographyKey",
            "distributorId",
            "outletId",
            "territoryId",
          ].flatMap((key) => {
            const parse = (name: string) =>
              ["outletId", "territoryId"].includes(key)
                ? d.getAll(name).map(String)
                : String(d.get(name) ?? "")
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean);
            const include = parse(key),
              exclude = parse(key + "Exclude");
            return include.length || exclude.length
              ? [[key, { include, exclude }]]
              : [];
          }),
        ),
        checklist: String(d.get("checklist") ?? "")
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
      })}
    >
      {(
        [
          ["code", "Campaign code", campaign?.code ?? ""],
          ["name", "Campaign name", campaign?.name ?? ""],
          ["mechanic", "Mechanic / objective", campaign?.mechanic ?? ""],
        ] as const
      ).map(([name, label, value]) => (
        <Field key={name} label={label}>
          <input name={name} required defaultValue={value} className={input} />
        </Field>
      ))}
      <Field label="Status">
        <select name="status" className={input} defaultValue="draft">
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="closed">Closed</option>
        </select>
      </Field>
      <Field label="Starts · Manila">
        <input
          type="date"
          name="from"
          required
          defaultValue={day(now + (campaign ? 86400_000 : 0))}
          className={input}
        />
      </Field>
      <Field label="Ends · exclusive Manila date">
        <input
          type="date"
          name="to"
          required
          defaultValue={day(now + 30 * 86400_000)}
          className={input}
        />
      </Field>
      <Field label="Budget · ₱">
        <input
          name="budget"
          inputMode="decimal"
          required
          defaultValue={String((campaign?.budgetCentavos ?? 0) / 100)}
          className={input}
        />
      </Field>
      <Field label="Expected volume · base pieces">
        <input
          name="volume"
          type="number"
          min="0"
          required
          defaultValue={campaign?.expectedVolumeBase ?? 0}
          className={input}
        />
      </Field>
      <Field label="Expected ROI · %">
        <input
          name="roi"
          inputMode="decimal"
          required
          defaultValue={String((campaign?.expectedRoiBps ?? 0) / 100)}
          className={input}
        />
      </Field>
      {(
        [
          ["channelKey", "Channel codes"],
          ["classKey", "Outlet classes"],
          ["geographyKey", "Geography codes"],
          ["distributorId", "Distributor codes"],
        ] as const
      ).flatMap(([name, label]) =>
        ["include", "exclude"].map((mode) => (
          <Field
            key={name + mode}
            label={`${label} · ${mode} · comma separated`}
          >
            <input
              name={name + (mode === "exclude" ? "Exclude" : "")}
              defaultValue={
                campaign?.scope[name]?.[mode as "include" | "exclude"]?.join(
                  ", ",
                ) ?? ""
              }
              className={input}
            />
          </Field>
        )),
      )}
      {(["outletId", "territoryId"] as const).flatMap((key) =>
        ["include", "exclude"].map((mode) => (
          <Field
            key={key + mode}
            label={`${key === "outletId" ? "Outlets" : "Territories"} · ${mode} · leave empty for all`}
          >
            <select
              multiple
              name={key + (mode === "exclude" ? "Exclude" : "")}
              defaultValue={
                campaign?.scope[key]?.[mode as "include" | "exclude"] ?? []
              }
              className={input}
            >
              {(key === "outletId"
                ? options?.outlets
                : options?.territories
              )?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.code} · {o.name}
                </option>
              ))}
            </select>
          </Field>
        )),
      )}
      <Field label="Execution checklist · one item per line">
        <textarea
          name="checklist"
          rows={4}
          defaultValue={
            campaign?.checklist.join("\n") ??
            "Display present\nPrice correct\nPOSM up\nStock sufficient"
          }
          className={input}
        />
      </Field>
    </CommandForm>
  );
}
function SchemeEditor({
  campaigns,
  options,
}: {
  campaigns: Campaign[];
  options: Options;
}) {
  const [kind, setKind] = useState("basket");
  return (
    <CommandForm
      path="/api/v1/pricing/promotions/create"
      build={(d) => {
        const product = options.products.find((p) => p.id === d.get("product")),
          gift = options.products.find((p) => p.id === d.get("gift")),
          second = options.products.find((p) => p.id === d.get("second"));
        const item = {
          productId: product?.id,
          uom: product?.uom,
          quantity: Number(d.get("quantity") ?? 1),
        };
        let rule: Record<string, unknown> = { kind };
        if (kind === "basket")
          rule = {
            kind,
            minSubtotalCentavos: centavos(d.get("threshold")),
            valueCentavos: centavos(d.get("value")),
          };
        else if (kind === "percent_off")
          rule = {
            kind,
            item,
            percentOffBasisPoints: centavos(d.get("percent")),
          };
        else if (kind === "value_off")
          rule = { kind, item, valueCentavos: centavos(d.get("value")) };
        else if (kind === "quantity_off")
          rule = { kind, item, quantityOff: Number(d.get("offQuantity")) };
        else if (kind === "slab")
          rule = {
            kind,
            item,
            slabs: [
              {
                minQuantity: Number(d.get("slab1")),
                percentOffBasisPoints: centavos(d.get("percent1")),
              },
              {
                minQuantity: Number(d.get("slab2")),
                percentOffBasisPoints: centavos(d.get("percent2")),
              },
            ],
          };
        else if (kind === "combo")
          rule = {
            kind,
            components: [
              item,
              {
                productId: second?.id,
                uom: second?.uom,
                quantity: Number(d.get("secondQuantity")),
              },
            ],
            bundlePriceMinor: centavos(d.get("value")),
          };
        else
          rule = {
            kind,
            buy: item,
            free: {
              productId: gift?.id,
              uom: gift?.uom,
              quantity: Number(d.get("free")),
            },
          };
        const campaign = campaigns.find(
          (c) => c.versionId === d.get("campaign"),
        );
        if (!campaign) throw new Error("Choose a campaign.");
        return {
          code: d.get("code"),
          name: d.get("name"),
          campaignVersionId: campaign.versionId,
          effectiveFrom: campaign.effectiveFrom,
          effectiveTo: campaign.effectiveTo,
          status: d.get("status"),
          rule,
          precedence: Number(d.get("precedence")),
          stacking: d.get("stacking"),
          benefitTiming: d.get("benefitTiming"),
          excludes: String(d.get("excludes") ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          exclusionGroup: String(d.get("group") ?? "").trim() || null,
        };
      }}
    >
      <Field label="Campaign">
        <CampaignPicker campaigns={campaigns} />
      </Field>
      <Field label="Scheme code">
        <input name="code" required className={input} />
      </Field>
      <Field label="Scheme name">
        <input name="name" required className={input} />
      </Field>
      <Field label="Mechanic">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className={input}
        >
          {[
            "basket",
            "slab",
            "combo",
            "bogo",
            "free_goods",
            "percent_off",
            "value_off",
            "quantity_off",
          ].map((k) => (
            <option key={k} value={k}>
              {words(k)}
            </option>
          ))}
        </select>
      </Field>
      {kind !== "basket" ? (
        <>
          <Field label="Qualifying product">
            <ProductPicker name="product" products={options.products} />
          </Field>
          <Field label="Qualifying quantity · selling units">
            <input
              type="number"
              min="1"
              name="quantity"
              defaultValue="1"
              required
              className={input}
            />
          </Field>
        </>
      ) : null}
      {["bogo", "free_goods"].includes(kind) ? (
        <>
          <Field label="Free product">
            <ProductPicker name="gift" products={options.products} />
          </Field>
          <Field label="Free quantity · selling units">
            <input
              name="free"
              type="number"
              min="1"
              defaultValue="1"
              required
              className={input}
            />
          </Field>
        </>
      ) : null}
      {kind === "combo" ? (
        <>
          <Field label="Second combo product">
            <ProductPicker name="second" products={options.products} />
          </Field>
          <Field label="Second product quantity">
            <input
              name="secondQuantity"
              type="number"
              min="1"
              defaultValue="1"
              required
              className={input}
            />
          </Field>
        </>
      ) : null}
      {["basket", "value_off", "combo"].includes(kind) ? (
        <Field
          label={
            kind === "combo"
              ? "Combo selling price · ₱"
              : "Discount per qualifying block · ₱"
          }
        >
          <input name="value" inputMode="decimal" required className={input} />
        </Field>
      ) : null}
      {kind === "basket" ? (
        <Field label="Minimum basket · ₱">
          <input
            name="threshold"
            inputMode="decimal"
            required
            className={input}
          />
        </Field>
      ) : null}
      {kind === "percent_off" ? (
        <Field label="Discount · %">
          <input
            name="percent"
            inputMode="decimal"
            required
            className={input}
          />
        </Field>
      ) : null}
      {kind === "quantity_off" ? (
        <Field label="Paid units discounted per qualifying block">
          <input
            name="offQuantity"
            type="number"
            min="0"
            required
            className={input}
          />
        </Field>
      ) : null}
      {kind === "slab"
        ? [1, 2].map((i) => (
            <div key={i} className="grid grid-cols-2 gap-3">
              <Field label={`Slab ${i} · minimum units`}>
                <input
                  name={`slab${i}`}
                  type="number"
                  min="1"
                  required
                  className={input}
                />
              </Field>
              <Field label={`Slab ${i} · discount %`}>
                <input name={`percent${i}`} required className={input} />
              </Field>
            </div>
          ))
        : null}
      <Field label="When is the benefit granted?">
        <select name="benefitTiming" className={input}>
          <option value="on_invoice">
            Immediate invoice discount / free goods
          </option>
          <option value="claimable">Deferred claimable monetary rebate</option>
        </select>
      </Field>
      <Field label="Precedence · lower runs first">
        <input
          name="precedence"
          type="number"
          min="0"
          defaultValue="100"
          required
          className={input}
        />
      </Field>
      <Field label="Stacking">
        <select name="stacking" className={input}>
          <option value="exclusive">Exclusive</option>
          <option value="stack">Stack on remaining net value</option>
        </select>
      </Field>
      <Field label="Excluded scheme codes · comma separated">
        <input name="excludes" className={input} />
      </Field>
      <Field label="Mutually exclusive group · optional">
        <input name="group" className={input} />
      </Field>
      <Field label="Status">
        <select name="status" className={input}>
          <option value="inactive">Inactive draft</option>
          <option value="active">Active</option>
        </select>
      </Field>
    </CommandForm>
  );
}
function ProductPicker({
  name,
  products,
}: {
  name: string;
  products: Options["products"];
}) {
  return (
    <select name={name} required className={input}>
      <option value="">Choose product</option>
      {products.map((p) => (
        <option key={p.id} value={p.id}>
          {p.code} · {p.name} · {p.uom}
        </option>
      ))}
    </select>
  );
}

export function FinanceClaimsWorkspace() {
  const { can } = usePermissions(),
    canIntake = can("order.encode"),
    canApprove = can("order.approve");
  const [selected, setSelected] = useState<Claim | null>(null),
    [tab, setTab] = useState("Claims");
  const summary = useApi<Summary>(["tpm", "summary"], "/api/v1/tpm/summary");
  const claims = useApi<{ rows: Claim[] }>(
    ["tpm", "claims"],
    "/api/v1/tpm/claims",
  );
  const policies = useApi<Policies>(
    ["tpm", "policies"],
    "/api/v1/tpm/policies",
  );
  const liabilities = useApi<{ rows: Liability[] }>(
    ["tpm", "liabilities"],
    "/api/v1/tpm/liabilities",
  );
  const deductions = useApi<{ rows: Deduction[] }>(
    ["tpm", "deductions"],
    "/api/v1/tpm/deductions",
  );
  const incentives = useApi<Incentives>(
    ["tpm", "incentives"],
    "/api/v1/tpm/incentives",
  );
  const options = useApi<Options>(["tpm", "options"], "/api/v1/tpm/options");
  useLive(["tpm"], [["tpm"]]);
  return (
    <div className="grid gap-5">
      <p className="text-sm text-muted">
        What can Finance approve, what is still missing, and what has SAP
        actually settled? One claim object serves distributor, modern trade and
        agency claims.
      </p>
      <QueryState
        loading={!claims.data}
        error={
          summary.error ??
          claims.error ??
          policies.error ??
          liabilities.error ??
          deductions.error ??
          incentives.error ??
          options.error
        }
      />
      {summary.data ? (
        <>
          <Snapshot data={summary.data} />
          <Panel title="Claims trend · last 28 days">
            <TrendChart
              label="Claim intake by day"
              dates={summary.data.trend.map((r) => r.date)}
              series={[
                {
                  key: "claims",
                  label: "Claimed value",
                  kind: "bar",
                  values: summary.data.trend.map((r) => r.amountCentavos),
                },
              ]}
            />
          </Panel>
        </>
      ) : null}
      <nav aria-label="Finance views" className="flex flex-wrap gap-2">
        {["Claims", "Liability", "Deductions", "Incentives"].map((x) => (
          <button
            className={button}
            aria-pressed={tab === x}
            key={x}
            onClick={() => setTab(x)}
          >
            {x}
          </button>
        ))}
      </nav>
      {tab === "Claims" ? (
        <>
          <Panel title="Evidence and approval queue">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    {[
                      "Claimant",
                      "Period",
                      "Value",
                      "Status",
                      "Next action",
                    ].map((x) => (
                      <th key={x} className="p-2 text-xs text-muted">
                        {x}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {claims.data?.rows.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="p-2">
                        {r.partyName}
                        <p className="text-xs text-muted">
                          {words(r.partyType)} · {r.reference}
                        </p>
                      </td>
                      <td className="p-2">
                        {r.periodFrom} → {r.periodTo}
                      </td>
                      <td className="p-2">{peso(r.amountCentavos)}</td>
                      <td className="p-2">{words(r.status)}</td>
                      <td className="p-2">
                        <button
                          className={button}
                          onClick={() => setSelected(r)}
                        >
                          Review claim
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted">
              Rejection rate{" "}
              {summary.data?.rejectionBps == null
                ? "Unknown"
                : `${summary.data.rejectionBps / 100}%`}
              . No payment is complete until the SAP acknowledgement arrives.
            </p>
          </Panel>
          {selected ? (
            <Panel title={selected.partyName + " · " + selected.reference}>
              <ClaimReview
                key={selected.id}
                claim={
                  claims.data?.rows.find((r) => r.id === selected.id) ??
                  selected
                }
                canIntake={canIntake}
                canApprove={canApprove}
                options={options.data}
              />
            </Panel>
          ) : null}
          {canIntake && policies.data ? (
            <Panel title="Consolidated claim intake">
              <CommandForm
                path="/api/v1/tpm/claims/submit"
                label="Submit claim"
                build={(d) => {
                  const party = options.data?.parties?.find(
                    (p) => `${p.type}:${p.id}` === d.get("party"),
                  );
                  return {
                    reference: d.get("reference"),
                    partyType: party?.type ?? d.get("partyType"),
                    partyId: party?.id ?? d.get("party"),
                    partyName: party?.name ?? d.get("name"),
                    typeId: d.get("type"),
                    earningId: d.get("earning") || undefined,
                    campaignVersionId: liabilities.data?.rows.find(
                      (e) => e.id === d.get("earning"),
                    )?.campaignVersionId,
                    outletId: d.get("outlet") || undefined,
                    periodFrom: d.get("from"),
                    periodTo: d.get("to"),
                    amountCentavos: centavos(d.get("amount")),
                    ...(d.get("sourceQuantity")
                      ? {
                          quantityUnits: Number(d.get("sourceQuantity")),
                          productId: d.get("sourceProduct"),
                          uom: d.get("sourceUom"),
                        }
                      : {}),
                  };
                }}
              >
                {options.data?.parties?.length ? (
                  <Field label="Claimant · governed organization or customer branch">
                    <select name="party" required className={input}>
                      <option value="">Choose claimant</option>
                      {options.data.parties.map((p) => (
                        <option
                          key={`${p.type}:${p.id}`}
                          value={`${p.type}:${p.id}`}
                        >
                          {p.name} · {words(p.type)}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <>
                    <Field label="Claimant type">
                      <select name="partyType" className={input}>
                        <option value="distributor">Distributor</option>
                        <option value="modern_trade">Modern trade</option>
                        <option value="agency">Agency</option>
                      </select>
                    </Field>
                    <Field label="Account / party code">
                      <input name="party" required className={input} />
                    </Field>
                    <Field label="Claimant name">
                      <input name="name" required className={input} />
                    </Field>
                  </>
                )}
                <Field label="Claim reference">
                  <input name="reference" required className={input} />
                </Field>
                <Field label="Claim type and required evidence">
                  <select name="type" className={input} required>
                    <option value="">Choose type</option>
                    {policies.data.types.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.code} · {t.required_evidence.map(words).join(", ")}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Earned promotion benefit · optional">
                  <select name="earning" className={input}>
                    <option value="">No promotion earning</option>
                    {liabilities.data?.rows.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.campaignName} · {e.accountKey} ·{" "}
                        {peso(e.operationalOpenCentavos)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Outlet · optional">
                  <select name="outlet" className={input}>
                    <option value="">No specific outlet</option>
                    {options.data?.outlets.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.code} · {o.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Claimed value · ₱">
                  <input name="amount" required className={input} />
                </Field>
                <details>
                  <summary className="cursor-pointer text-sm">
                    Match one source SKU line · optional, not for earned rebates
                  </summary>
                  <div className="mt-3 grid gap-3">
                    <Field label="Source product">
                      <select name="sourceProduct" className={input}>
                        <option value="">Choose source product</option>
                        {options.data?.products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.code} · {p.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Source selling UOM">
                      <input
                        name="sourceUom"
                        className={input}
                        placeholder="Exact unit on the source invoice"
                      />
                    </Field>
                    <Field label="Claimed quantity · source selling units">
                      <input
                        name="sourceQuantity"
                        type="number"
                        min="1"
                        step="1"
                        className={input}
                      />
                    </Field>
                    <p className="text-xs text-muted">
                      Finance matches one SKU and the captured unit conversion;
                      its prorated source value caps the claim.
                    </p>
                  </div>
                </details>
                <Field label="Period from">
                  <input name="from" type="date" required className={input} />
                </Field>
                <Field label="Period to">
                  <input name="to" type="date" required className={input} />
                </Field>
              </CommandForm>
            </Panel>
          ) : null}
        </>
      ) : null}
      {tab === "Liability" ? (
        <Panel title="Open promotion liability · SAP reconciliation">
          <div className="grid gap-3">
            {liabilities.data?.rows.map((r) => (
              <article key={r.id} className="border-b border-border pb-3">
                <h3 className="font-medium">
                  {r.campaignName} · {r.accountKey}
                </h3>
                {r.openCentavos == null ? (
                  <p className="text-sm">
                    SAP acknowledgement has not been confirmed. Operational
                    exposure: {peso(r.operationalOpenCentavos)}.
                  </p>
                ) : (
                  <p className="text-sm">
                    SAP-earned {peso(r.acknowledgedEarnedCentavos)} −
                    SAP-reversed {peso(r.acknowledgedReversedCentavos)} −
                    SAP-released {peso(r.releasedCentavos)} = open{" "}
                    {peso(r.openCentavos)}
                  </p>
                )}
                <p className="text-xs text-muted">
                  {r.pendingSap
                    ? "Next: connect or retry the SAP posting instruction."
                    : "Review reconciliation with SAP."}
                </p>
              </article>
            ))}
          </div>
        </Panel>
      ) : null}
      {tab === "Deductions" ? (
        <Panel title="Classified deductions · named owners">
          <div className="grid gap-4">
            {deductions.data?.rows.map((r) => (
              <article key={r.id} className="border-b border-border pb-4">
                <h3 className="font-medium">
                  {r.accountKey} · {words(r.classification)}
                </h3>
                <p className="text-sm">
                  {r.ownerName} · {r.ageDays} days · {words(r.status)} ·
                  outstanding{" "}
                  {peso(
                    r.amountCentavos -
                      r.recoveredCentavos -
                      (r.writtenOffCentavos ?? 0),
                  )}{" "}
                  · SAP write-off {peso(r.writtenOffCentavos ?? 0)}
                </p>
                {canApprove && r.status !== "resolved" ? (
                  <CommandForm
                    path="/api/v1/tpm/deductions/decide"
                    label="Update case"
                    build={(d) => ({
                      id: r.id,
                      action: d.get("action"),
                      classification: d.get("classification"),
                      reason: d.get("reason"),
                      ...(d.get("amount")
                        ? { amountCentavos: centavos(d.get("amount")) }
                        : {}),
                    })}
                  >
                    <Field label="Action">
                      <select name="action" className={input}>
                        <option value="classify">Change classification</option>
                        <option value="dispute">Dispute</option>
                        <option value="recover">Request SAP recovery</option>
                        <option value="write_off">Request SAP write-off</option>
                        <option value="resolve">
                          Close SAP-reconciled case
                        </option>
                      </select>
                    </Field>
                    <Field label="Classification · only when changing classification">
                      <input
                        name="classification"
                        defaultValue={r.classification}
                        className={input}
                      />
                    </Field>
                    <p className="text-xs text-muted">
                      Recovery and write-off require an independent approver and
                      SAP acknowledgement. A pending request does not reduce the
                      balance.
                    </p>
                    <Field label="Amount · ₱, for recovery or write-off">
                      <input name="amount" className={input} />
                    </Field>
                    <Field label="Reason / SAP reference">
                      <input name="reason" required className={input} />
                    </Field>
                  </CommandForm>
                ) : null}
              </article>
            ))}
          </div>
          {canIntake && options.data ? (
            <CommandForm
              path="/api/v1/tpm/deductions/capture"
              label="Capture deduction"
              build={(d) => ({
                sourceKey: d.get("source"),
                accountKey: d.get("account"),
                classification: d.get("classification"),
                invoiceReference: d.get("invoice"),
                remittanceReference: d.get("remittance"),
                amountCentavos: centavos(d.get("amount")),
                ownerProfileId: d.get("owner"),
                openedOn: d.get("from"),
                dueOn: d.get("to"),
              })}
            >
              {(
                [
                  ["source", "Source reference"],
                  ["account", "Account code"],
                  ["classification", "Deduction type"],
                  ["invoice", "Underlying invoice"],
                  ["remittance", "Remittance reference"],
                  ["amount", "Deducted value · ₱"],
                ] as const
              ).map(([name, label]) => (
                <Field key={name} label={label}>
                  <input name={name} required className={input} />
                </Field>
              ))}
              <Field label="Case owner">
                <select name="owner" required className={input}>
                  {options.data.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Opened on">
                <input name="from" type="date" required className={input} />
              </Field>
              <Field label="Due on">
                <input name="to" type="date" required className={input} />
              </Field>
            </CommandForm>
          ) : null}
        </Panel>
      ) : null}
      {tab === "Incentives" ? (
        <Panel title="Incentive statements · governed metrics">
          <p className="text-sm text-muted">
            Targets, coverage, distribution, availability, collection and
            settlement variance must all have versioned source facts. Missing
            sources stay unknown, never zero.
          </p>
          {incentives.data?.statements.map((s) => (
            <article key={s.id} className="border-b border-border pb-4">
              <h3 className="font-medium">
                {s.personName} · {s.planName}
              </h3>
              <p className="text-sm">
                {s.periodFrom} → {s.periodTo} · {peso(s.amountCentavos)} ·{" "}
                {words(s.status)}
              </p>
              <ul className="text-xs text-muted">
                {s.result.lines.map((l) => (
                  <li key={l.metric}>
                    {words(l.metric)}:{" "}
                    {l.excluded
                      ? "Excluded by plan"
                      : `${l.actual ?? "Unknown"} / ${l.target ?? "Unknown"}`}{" "}
                    → {peso(l.amountCentavos)}
                  </li>
                ))}
              </ul>
              {canApprove && s.status === "calculated" ? (
                <CommandForm
                  path="/api/v1/tpm/incentives/decide"
                  label="Approve statement"
                  build={() => ({ id: s.id, action: "approve" })}
                >
                  {null}
                </CommandForm>
              ) : null}
              {incentives.data?.adjustments
                ?.filter((a) => a.statement_id === s.id)
                .map((a) => (
                  <div
                    key={a.id}
                    className="mt-3 border-l border-border pl-3 text-sm"
                  >
                    <p>
                      {peso(Number(a.amount_centavos))} adjustment · {a.reason}{" "}
                      · {words(a.status)}
                    </p>
                    {canApprove && a.status === "pending" ? (
                      <CommandForm
                        path="/api/v1/tpm/incentives/approve-adjustment"
                        label="Independently approve adjustment"
                        build={() => ({ id: a.id })}
                      >
                        {null}
                      </CommandForm>
                    ) : null}
                  </div>
                ))}
              {canIntake ? (
                <CommandForm
                  path="/api/v1/tpm/incentives/adjust"
                  label="Request documented adjustment"
                  build={(d) => ({
                    id: s.id,
                    amountCentavos: signedCentavos(d.get("amount")),
                    reason: d.get("reason"),
                  })}
                >
                  <Field label="Adjustment · PHP (negative reduces)">
                    <input
                      name="amount"
                      className={input}
                      required
                      placeholder="0.00"
                    />
                  </Field>
                  <Field label="Source correction and reason">
                    <textarea
                      name="reason"
                      className={input}
                      required
                      maxLength={1000}
                    />
                  </Field>
                </CommandForm>
              ) : null}
            </article>
          ))}
          {canIntake && incentives.data && options.data ? (
            <CommandForm
              path="/api/v1/tpm/incentives/calculate"
              reuseCompleted={false}
              label="Calculate from governed sources"
              build={(d) => ({
                planId: d.get("plan"),
                profileId: d.get("person"),
                periodFrom: d.get("from"),
                periodTo: d.get("to"),
              })}
            >
              <Field label="Effective plan">
                <select name="plan" required className={input}>
                  <option value="">Choose plan</option>
                  {incentives.data.plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Employee / rep">
                <select name="person" required className={input}>
                  {options.data.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Period from">
                <input name="from" type="date" required className={input} />
              </Field>
              <Field label="Period to">
                <input name="to" type="date" required className={input} />
              </Field>
            </CommandForm>
          ) : null}
        </Panel>
      ) : null}
      {can("masterdata.manage") && policies.data && incentives.data ? (
        <PolicyEditors policies={policies.data} plans={incentives.data.plans} />
      ) : null}
    </div>
  );
}
function PolicyEditors({
  policies,
  plans,
}: {
  policies: Policies;
  plans: Incentives["plans"];
}) {
  return (
    <details className="rounded-lg border border-border p-5">
      <summary className="cursor-pointer font-semibold">
        Evidence, approval and incentive policy setup
      </summary>
      <div className="mt-5 grid gap-5">
        <Panel title="New effective claim type">
          <CommandForm
            path="/api/v1/tpm/policies/save"
            build={(d) => ({
              kind: "claim_type",
              code: d.get("code"),
              effectiveFrom: `${d.get("from")}T00:00:00+08:00`,
              effectiveTo: `${d.get("to")}T00:00:00+08:00`,
              requiredEvidence: d.getAll("required"),
              allowExecutionOverride: d.get("allowExecutionOverride") === "on",
              escalationHours: Number(d.get("escalationHours")),
              emailNotifications: d.get("emailNotifications") === "on",
            })}
          >
            <Field label="Type name">
              <input name="code" required className={input} />
            </Field>
            <Field label="Escalate after inactive hours · our sample starting rule">
              <input
                name="escalationHours"
                type="number"
                min="1"
                max="720"
                defaultValue="48"
                required
                className={input}
              />
            </Field>
            <label className="text-sm">
              <input name="emailNotifications" type="checkbox" defaultChecked />{" "}
              Email current authorized claimants and independent Finance
              approvers. Local development records messages without sending
              email.
            </label>
            <label className="text-sm">
              <input type="checkbox" name="allowExecutionOverride" /> Permit
              independently approved execution-proof exceptions. Monetary proof,
              quantities, ownership and changed sources can never be waived.
            </label>
            <PolicyDates />
            <fieldset className="grid gap-2">
              <legend className="text-xs text-muted">
                Required verified evidence
              </legend>
              {[
                "photo",
                "checklist",
                "posm",
                "secondary_sale",
                "source_document",
                "attendance",
              ].map((kind) => (
                <label className="text-sm" key={kind}>
                  <input type="checkbox" name="required" value={kind} />{" "}
                  {words(kind)}
                </label>
              ))}
            </fieldset>
          </CommandForm>
        </Panel>
        <Panel title="New value-based claim approval band">
          <CommandForm
            path="/api/v1/tpm/policies/save"
            build={(d) => ({
              kind: "approval",
              name: d.get("name"),
              partyType: d.get("partyType"),
              minCentavos: centavos(d.get("minimum")),
              maxCentavos: centavos(d.get("maximum")),
              approverRoles: d.getAll("roles"),
              effectiveFrom: `${d.get("from")}T00:00:00+08:00`,
              effectiveTo: `${d.get("to")}T00:00:00+08:00`,
            })}
          >
            <Field label="Band name">
              <input name="name" required className={input} />
            </Field>
            <Field label="Claimant type">
              <select name="partyType" className={input}>
                {["all", "distributor", "modern_trade", "agency"].map((v) => (
                  <option key={v} value={v}>
                    {words(v)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Minimum value · ₱">
              <input name="minimum" required className={input} />
            </Field>
            <Field label="Maximum value · ₱">
              <input name="maximum" required className={input} />
            </Field>
            <PolicyDates />
            <fieldset className="grid gap-2">
              <legend className="text-xs text-muted">
                Authorized app roles · no self approval
              </legend>
              {["super_admin", "manager", "approver"].map((role) => (
                <label className="text-sm" key={role}>
                  <input type="checkbox" name="roles" value={role} />{" "}
                  {words(role)}
                </label>
              ))}
            </fieldset>
          </CommandForm>
          <p className="text-xs text-muted">
            Overlapping applicable bands fail closed. End the old band before
            introducing its replacement. This is claim approval, not the
            separate Fiscal discount authority matrix.
          </p>
        </Panel>
        <Panel title="New effective incentive plan">
          <CommandForm
            path="/api/v1/tpm/incentives/plan"
            build={(d) => ({
              code: d.get("code"),
              name: d.get("name"),
              effectiveFrom: `${d.get("from")}T00:00:00+08:00`,
              effectiveTo: `${d.get("to")}T00:00:00+08:00`,
              baseCentavos: centavos(d.get("base")),
              source: d.get("source"),
              metrics: [
                "targets",
                "coverage",
                "distribution",
                "availability",
                "collection",
                "settlementVariance",
              ].map((metric) => ({
                metric,
                weightBps: centavos(d.get(metric)),
                capBps: centavos(d.get(metric + "Cap")),
                direction: d.get(metric + "Direction"),
                ...(d.get(metric + "Target")
                  ? { target: Number(d.get(metric + "Target")) }
                  : {}),
              })),
            })}
          >
            <Field label="Plan code">
              <input name="code" required className={input} />
            </Field>
            <Field label="Plan name">
              <input name="name" required className={input} />
            </Field>
            <Field label="Base award · ₱">
              <input name="base" required className={input} />
            </Field>
            <Field label="Policy source">
              <select name="source" className={input} defaultValue="sample">
                <option value="sample">
                  Sample policy — our provisional defaults
                </option>
                <option value="office">Office-approved policy</option>
              </select>
            </Field>
            <PolicyDates />
            {[
              "targets",
              "coverage",
              "distribution",
              "availability",
              "collection",
              "settlementVariance",
            ].map((metric, i) => (
              <div key={metric} className="grid gap-2">
                <Field key={metric} label={`${words(metric)} · weight %`}>
                  <input
                    name={metric}
                    required
                    defaultValue={i === 0 ? "50" : "10"}
                    className={input}
                  />
                </Field>
                <Field label="Attainment cap · %">
                  <input
                    name={metric + "Cap"}
                    defaultValue="100"
                    required
                    className={input}
                  />
                </Field>
                <Field label="Direction">
                  <select
                    name={metric + "Direction"}
                    defaultValue={
                      metric === "settlementVariance" ? "lower" : "higher"
                    }
                    className={input}
                  >
                    <option value="higher">Higher is better</option>
                    <option value="lower">Lower is better</option>
                  </select>
                </Field>
                <Field
                  label={`${words(metric)} target · canonical units (optional)`}
                >
                  <input
                    type="number"
                    min="1"
                    step="1"
                    name={metric + "Target"}
                    className={input}
                    defaultValue={
                      metric === "availability" || metric === "distribution"
                        ? "10000"
                        : metric === "collection"
                          ? "100000"
                          : metric === "settlementVariance"
                            ? "100"
                            : ""
                    }
                  />
                </Field>
              </div>
            ))}
          </CommandForm>
          <p className="text-xs text-muted">
            Weights must total 100%. Attainment uses the configured cap; zero
            weight explicitly excludes a non-applicable metric. Sales,
            collections and variance targets use centavos;
            distribution/availability use basis points; coverage uses calls.
            Blank sales/coverage targets use canonical target and approved-plan
            counts. Visible numeric defaults are sample assumptions, not client
            policy. settlement variance above tolerance lowers its component.
            Client compensation policies remain subject to Finance and HR
            ratification.
          </p>
        </Panel>
        <Panel title="Retire a policy prospectively">
          <CommandForm
            path="/api/v1/tpm/policies/end"
            build={(d) => {
              const [kind, id] = String(d.get("policy")).split(":");
              return { kind, id, effectiveTo: `${d.get("to")}T00:00:00+08:00` };
            }}
          >
            <Field label="Existing policy version">
              <select name="policy" required className={input}>
                <option value="">Choose policy</option>
                {policies.types.map((t) => (
                  <option key={t.id} value={`claim_type:${t.id}`}>
                    {t.code}
                  </option>
                ))}
                {policies.approvals.map((a) => (
                  <option key={a.id} value={`approval:${a.id}`}>
                    {a.name}
                  </option>
                ))}
                {plans.map((a) => (
                  <option key={a.id} value={`incentive:${a.id}`}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Retires at · exclusive Manila date">
              <input name="to" required type="date" className={input} />
            </Field>
          </CommandForm>
        </Panel>
      </div>
    </details>
  );
}
function PolicyDates() {
  return (
    <>
      <Field label="Effective from · Manila">
        <input type="date" name="from" required className={input} />
      </Field>
      <Field label="Effective to · exclusive Manila date">
        <input type="date" name="to" required className={input} />
      </Field>
    </>
  );
}

export function ClaimReview({
  claim,
  canIntake,
  canApprove,
  options,
}: {
  claim: Claim;
  canIntake: boolean;
  canApprove: boolean;
  options?: Options;
}) {
  const detail = useApi<{
    events: { action: string; created_at: string }[];
    evidence: EvidencePreview[];
    validation?: {
      passed: boolean;
      reasons: string[];
      waivedReasons?: string[];
      baseHash: string;
      exceptionEligible: boolean;
    };
    overrides?: {
      reason: string;
      evidence_reference: string;
      waived_reasons: string[];
    }[];
    settlements: { method: string; status: string; amount_centavos: string }[];
  }>(["tpm", "claim", claim.id], `/api/v1/tpm/claims/detail?id=${claim.id}`);
  const sources = useApi<{ rows: Options["evidence"]; truncated: boolean }>(
    ["tpm", "evidence-options", claim.id],
    `/api/v1/tpm/claims/evidence-options?id=${claim.id}`,
  );
  const [previewId, setPreviewId] = useState("");
  if (detail.error || sources.error)
    return <QueryState error={detail.error ?? sources.error} loading={false} />;
  const preview = sources.data?.rows.find((s) => s.id === previewId);
  return (
    <div className="grid gap-4">
      <QueryState
        error={detail.error ?? sources.error}
        loading={!detail.data}
      />
      {sources.data?.truncated ? (
        <p className="text-sm text-muted">
          Showing up to 100 inspected source records. Narrow the claim period if
          a required source is outside this page.
        </p>
      ) : null}
      <p className="text-sm">
        Current status: {words(claim.status)}. Evidence:{" "}
        {detail.data?.evidence.map((e) => words(e.kind)).join(", ") ||
          "None linked"}
      </p>
      {claim.quantityUnits != null ? (
        <p className="text-sm">
          Claimed source quantity: {claim.quantityUnits} {claim.uom}. The
          captured conversion and prorated value are checked before approval.
        </p>
      ) : null}
      {detail.data?.validation ? (
        <div className="rounded-lg border border-border p-3 text-sm">
          <p>
            {detail.data.validation.passed
              ? "Current source facts match."
              : "Source checks need attention."}
          </p>
          {detail.data.validation.reasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
          {detail.data.validation.waivedReasons?.map((reason) => (
            <p key={reason}>Approved execution exception: {reason}</p>
          ))}
        </div>
      ) : null}
      {detail.data?.evidence.length ? (
        <ClaimEvidencePreview
          claimId={claim.id}
          evidence={detail.data.evidence}
        />
      ) : null}
      <Field label="Preview source before linking">
        <select
          className={input}
          value={previewId}
          onChange={(e) => setPreviewId(e.target.value)}
        >
          <option value="">Choose source to inspect</option>
          {sources.data?.rows.map((e) => (
            <option key={`${e.kind}:${e.id}`} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </Field>
      {preview ? (
        <ClaimEvidencePreview
          claimId={claim.id}
          evidence={[
            {
              kind: preview.kind,
              source_id: preview.id,
              snapshot: preview.snapshot,
            },
          ]}
        />
      ) : null}
      {canApprove &&
      detail.data?.validation?.exceptionEligible &&
      !detail.data.validation.passed ? (
        <CommandForm
          path="/api/v1/tpm/claims/execution-override"
          label="Independently approve execution exception"
          build={(d) => ({
            id: claim.id,
            baseHash: detail.data?.validation?.baseHash,
            reason: d.get("reason"),
            evidenceReference: d.get("evidenceReference"),
          })}
        >
          <Field label="Exception reason">
            <textarea
              name="reason"
              required
              maxLength={1000}
              className={input}
            />
          </Field>
          <Field label="Alternative evidence reference">
            <input
              name="evidenceReference"
              required
              maxLength={500}
              className={input}
            />
          </Field>
          <p className="text-xs text-muted">
            Only the effective policy's missing execution proof may be excepted.
            Value, source ownership, quantities and changed records remain
            mandatory.
          </p>
        </CommandForm>
      ) : null}
      {detail.data?.overrides?.map((o, i) => (
        <p key={i} className="text-xs text-muted">
          Execution exception: {o.reason} · reference {o.evidence_reference}
        </p>
      ))}
      {canIntake &&
      [
        "submitted",
        "needs_evidence",
        "validated",
        "rejected",
        "approved",
      ].includes(claim.status) ? (
        <details>
          <summary className="cursor-pointer text-sm">
            Correct an unpaid claim or refresh its source version
          </summary>
          <CommandForm
            path="/api/v1/tpm/claims/amend"
            label="Save correction and require revalidation"
            build={(d) => ({
              id: claim.id,
              amountCentavos: centavos(d.get("amount")),
              reason: d.get("reason"),
              ...(claim.quantityUnits != null
                ? { quantityUnits: Number(d.get("quantity")) }
                : {}),
            })}
          >
            <Field label="Correct claimed value · PHP">
              <input name="amount" required className={input} />
            </Field>
            {claim.quantityUnits != null ? (
              <Field label={`Correct quantity · ${claim.uom}`}>
                <input
                  name="quantity"
                  type="number"
                  min="1"
                  step="1"
                  required
                  defaultValue={claim.quantityUnits}
                  className={input}
                />
              </Field>
            ) : null}
            <Field label="Correction reason">
              <input name="reason" required className={input} />
            </Field>
          </CommandForm>
          {detail.data?.evidence.map((e) => (
            <CommandForm
              key={`${e.kind}:${e.source_id}`}
              path="/api/v1/tpm/claims/refresh-evidence"
              label={`Refresh ${words(e.kind)} source version`}
              build={(d) => ({
                id: claim.id,
                kind: e.kind,
                sourceId: e.source_id,
                reason: d.get("reason"),
              })}
            >
              <Field label="Why the authoritative source changed">
                <input name="reason" required className={input} />
              </Field>
              <p className="text-xs text-muted">
                Appends a new version without rewriting the original proof;
                independent approval is required again. SAP-pending or paid
                cases cannot be revised.
              </p>
            </CommandForm>
          ))}
        </details>
      ) : null}
      {canIntake &&
      ["submitted", "needs_evidence"].includes(claim.status) &&
      options ? (
        <CommandForm
          path="/api/v1/tpm/claims/evidence"
          label="Link captured evidence"
          build={(d) => {
            const e = sources.data?.rows.find((e) => e.id === d.get("source"));
            if (!e) throw new Error("Choose captured evidence.");
            return { id: claim.id, kind: e.kind, sourceId: e.id };
          }}
        >
          <Field label="Captured evidence · period and outlet must match">
            <select name="source" required className={input}>
              <option value="">Choose source</option>
              {sources.data?.rows.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </Field>
        </CommandForm>
      ) : null}
      {canIntake &&
      ["submitted", "needs_evidence", "validated"].includes(claim.status) ? (
        <CommandForm
          path="/api/v1/tpm/claims/validate"
          reuseCompleted={false}
          label="Validate against source facts"
          build={() => ({ id: claim.id })}
        >
          {null}
        </CommandForm>
      ) : null}
      {canApprove && claim.status === "validated" ? (
        <CommandForm
          path="/api/v1/tpm/claims/approve"
          label="Independently approve"
          build={() => ({ id: claim.id })}
        >
          {null}
        </CommandForm>
      ) : null}
      {canApprove &&
      ["submitted", "needs_evidence", "validated"].includes(claim.status) ? (
        <CommandForm
          path="/api/v1/tpm/claims/reject"
          label="Reject with reason"
          build={(d) => ({ id: claim.id, reason: d.get("reason") })}
        >
          <Field label="Rejection reason">
            <input name="reason" required className={input} />
          </Field>
        </CommandForm>
      ) : null}
      {canApprove && ["approved", "part_settled"].includes(claim.status) ? (
        <CommandForm
          path="/api/v1/tpm/claims/settle"
          label="Request SAP settlement"
          build={(d) => ({
            id: claim.id,
            method: d.get("method"),
            amountCentavos: centavos(d.get("amount")),
          })}
        >
          <Field label="Method">
            <select name="method" className={input}>
              <option value="credit_memo">Credit memo</option>
              <option value="payment">Payment</option>
            </select>
          </Field>
          <Field label="Settlement amount · ₱">
            <input name="amount" required className={input} />
          </Field>
        </CommandForm>
      ) : null}
      <ul className="text-sm text-muted">
        {detail.data?.events.map((e, i) => (
          <li key={i}>
            {words(e.action)} ·{" "}
            {new Date(e.created_at).toLocaleDateString("en-PH", {
              timeZone: "Asia/Manila",
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}
