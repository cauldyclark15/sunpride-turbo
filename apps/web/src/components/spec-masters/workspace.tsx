"use client";
import { formatDateTime, formatStatus } from "../../lib/format";
import { useState, type FormEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { Button } from "@heroui/react";
import { CensusReview, OutletClassification } from "./review";
import { CatalogueEditor } from "./catalogue-editor";
import { TaxonomyMigration } from "./taxonomy-migration";
import { Card, Notice } from "@sunpride/ui";
import { mutate, useApi, useLive } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import {
  MASTER_SECTIONS,
  masterDataFromForm,
  masterEffectiveDate,
  type Master,
  type MasterKind,
  type Choice,
  type Options,
  type Polygon,
  type Setup,
} from "./model";
const BoundaryMap = dynamic(() => import("./boundary-map"), { ssr: false });
const control =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground";
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted">
      {label}
      {children}
    </label>
  );
}
function Select({
  name,
  label,
  choices,
  value,
  optional = false,
  onChange,
}: {
  name: string;
  label: string;
  choices: Choice[];
  value?: string | null;
  optional?: boolean;
  onChange?: (s: string) => void;
}) {
  return (
    <Field label={label}>
      <select
        name={name}
        className={control}
        defaultValue={value ?? ""}
        required={!optional}
        onChange={(e) => onChange?.(e.target.value)}
      >
        <option value="">{optional ? "Not set" : "Choose…"}</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </Field>
  );
}
const named = (rows: Master[] = []) =>
  rows
    .filter((r) => r.status === "active")
    .map((r) => ({ id: r.id, name: r.label }));

/** F-009/F-010/F-013/F-014/F-017/F-305 maintenance within the existing admin shell. */
export function MastersWorkspace() {
  const session = usePermissions(),
    canManage = session.can("masterdata.manage");
  const [kind, setKind] = useState<MasterKind>("geography"),
    [selected, setSelected] = useState("");
  const setup = useApi<Setup>(
    canManage ? ["masters", "setup"] : null,
    "/api/v1/masters/setup",
  );
  const options = useApi<Options>(
    canManage ? ["masters", "options"] : null,
    "/api/v1/masters/options",
  );
  useLive(["masters"], [["masters"]]);
  if (!canManage)
    return (
      <Notice
        title="Master-data setup requires administration access"
        tone="warning"
      />
    );
  if (setup.error || options.error)
    return (
      <Notice
        title={
          (setup.error ?? options.error)?.message ?? "Setup could not load"
        }
        tone="danger"
      />
    );
  if (!setup.data || !options.data)
    return <Card label="Field masters">Loading…</Card>;
  const sections = setup.data.sections,
    rows = sections[kind],
    current = rows.find((r) => r.id === selected);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2" aria-label="Field master sections">
        {MASTER_SECTIONS.map(([id, label]) => (
          <button
            key={id}
            className={`rounded-lg border px-3 py-2 text-sm ${kind === id ? "border-foreground bg-foreground text-background" : "border-border"}`}
            onClick={() => {
              setKind(id);
              setSelected("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
        <Card
          label={MASTER_SECTIONS.find((s) => s[0] === kind)?.[1] ?? "Masters"}
          actions={
            <Button variant="primary" onPress={() => setSelected("")}>
              Add
            </Button>
          }
        >
          <div className="grid gap-1">
            {rows.length ? (
              rows.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelected(r.id)}
                  className={`rounded-lg border p-3 text-left ${selected === r.id ? "border-foreground" : "border-border"}`}
                >
                  <span className="block text-sm font-medium">{r.label}</span>
                  <span className="text-xs text-muted">
                    Version {r.version} · {formatStatus(r.status)}
                    {r.sample ? " · Sample" : ""}
                  </span>
                </button>
              ))
            ) : (
              <p className="text-sm text-muted">Nothing here yet.</p>
            )}
          </div>
        </Card>
        <MasterEditor
          key={`${kind}:${current?.id ?? "new"}:${current?.version ?? 0}`}
          kind={kind}
          current={current}
          sections={sections}
          options={options.data}
          onSaved={(r) => setSelected(r.id)}
        />
      </div>
      <TaxonomyMigration />
      <CatalogueEditor />
      <CensusReview units={options.data.units} />
      <OutletClassification outlets={options.data.outlets} />
      <OutletReview options={options.data} />
    </div>
  );
}
function MasterEditor({
  kind,
  current,
  sections,
  options,
  onSaved,
}: {
  kind: MasterKind;
  current?: Master;
  sections: Setup["sections"];
  options: Options;
  onSaved: (m: Master) => void;
}) {
  const [polygon, setPolygon] = useState<Polygon | null>(
    current?.data.polygon ?? null,
  );
  const [channelId, setChannelId] = useState(current?.data.channelId ?? "");
  const [geoType, setGeoType] = useState(current?.data.type ?? "region");
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const history = useApi<{
    rows: (Master & { reason: string; actorName: string })[];
    truncated: boolean;
  }>(
    current ? ["masters", "history", current.id] : null,
    `/api/v1/masters/history/${current?.id ?? ""}`,
  );
  const data = current?.data ?? {};
  function input(
    name: string,
    label: string,
    value: string | number | undefined,
    type = "text",
    step?: string,
  ) {
    return (
      <Field label={label}>
        <input
          name={name}
          className={control}
          defaultValue={value ?? ""}
          type={type}
          step={step}
          required
        />
      </Field>
    );
  }
  const select = (
    name: string,
    label: string,
    choices: Choice[],
    value?: string | null,
    optional = false,
  ) => (
    <Select
      name={name}
      label={label}
      choices={choices}
      value={value}
      optional={optional}
    />
  );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setMessage("");
    const key = requestKey ?? crypto.randomUUID();
    setRequestKey(key);
    try {
      const body = {
        kind,
        code: String(form.get("code")),
        label: String(form.get("label")),
        orgUnitId: String(form.get("orgUnitId") ?? "") || null,
        status: String(form.get("status")),
        reason: String(form.get("reason")),
        baseVersion: current?.version ?? 0,
        effectiveFrom: masterEffectiveDate(
          String(form.get("effectiveFrom") ?? ""),
        ),
        data: masterDataFromForm(kind, form, polygon),
      };
      const saved = await mutate<Master>(
        "/api/v1/masters/definitions/save",
        body,
        { idempotencyKey: key, invalidate: [["masters"]] },
      );
      setRequestKey(null);
      setMessage("Saved. The previous version stays in history.");
      onSaved(saved);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Save failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card label={current ? `Edit ${current.label}` : "Add a definition"}>
      <form
        onSubmit={submit}
        onChange={() => setRequestKey(null)}
        className="grid gap-4"
      >
        <div className="grid gap-3 md:grid-cols-2">
          {input("code", "Stable code", current?.code)}
          {input("label", "Name", current?.label)}
          {!["channel", "subchannel", "class_policy", "msl"].includes(kind)
            ? select(
                "orgUnitId",
                "Organizational owner",
                options.units,
                current?.orgUnitId,
              )
            : null}
          <Field label="Status">
            <select
              name="status"
              className={control}
              defaultValue={current?.status ?? "active"}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </Field>
        </div>
        {kind === "geography" ? (
          <>
            <Field label="Geographic tier">
              <select
                name="type"
                className={control}
                defaultValue={geoType}
                onChange={(e) => setGeoType(e.target.value)}
              >
                {["region", "area", "territory", "zone"].map((t) => (
                  <option key={t} value={t}>
                    {t[0]?.toUpperCase()}
                    {t.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
            {geoType !== "region"
              ? select(
                  "parentId",
                  "Geographic parent",
                  named(
                    sections.geography.filter(
                      (r) =>
                        r.data.type ===
                        ["region", "area", "territory", "zone"][
                          ["region", "area", "territory", "zone"].indexOf(
                            geoType,
                          ) - 1
                        ],
                    ),
                  ),
                  data.parentId,
                )
              : null}
            <BoundaryMap
              initial={current?.data.polygon ?? null}
              onChange={setPolygon}
            />
            {data.territoryId ? (
              <input
                type="hidden"
                name="territoryId"
                value={data.territoryId}
              />
            ) : null}
          </>
        ) : null}
        {kind === "subchannel" || kind === "msl" ? (
          <Select
            name="channelId"
            label="Channel"
            choices={named(sections.channel)}
            value={data.channelId}
            onChange={setChannelId}
          />
        ) : null}
        {kind === "msl" ? (
          <>
            {select(
              "subchannelId",
              "Sub-channel (blank means channel default)",
              named(
                sections.subchannel.filter(
                  (r) => r.data.channelId === channelId,
                ),
              ),
              data.subchannelId,
              true,
            )}
            <Field label="Outlet potential class">
              <select
                className={control}
                name="outletClass"
                defaultValue={data.outletClass ?? "A"}
              >
                {["A", "B", "C", "D"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <fieldset className="grid max-h-72 gap-2 overflow-auto rounded-lg border border-border p-3">
              <legend className="px-1 text-xs">
                Required products (up to 200)
              </legend>
              {options.products.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="productIds"
                    value={p.id}
                    defaultChecked={data.productIds?.includes(p.id) ?? false}
                  />
                  {p.name}
                </label>
              ))}
            </fieldset>
            <p className="text-xs text-muted">
              This defines the framework. Outlet assignment and availability
              checks use these frozen versions.
            </p>
          </>
        ) : null}
        {kind === "class_policy" ? (
          <>
            <p className="text-sm text-muted">
              Classify estimated monthly revenue potential, not current sales.
              Inputs are potential transactions/day × basket × trading days ×
              capture share.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {["A", "B", "C", "D"].map((c) => (
                <div key={c}>
                  {input(
                    `threshold-${c}`,
                    `Class ${c}: minimum monthly potential (₱)`,
                    (data.bands?.find((b) => b.class === c)
                      ?.minPotentialCentavos ?? 0) / 100,
                    "number",
                    "0.01",
                  )}
                </div>
              ))}
            </div>
          </>
        ) : null}
        {kind === "beat" ? (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              {select("routeId", "Route", options.routes, data.routeId)}
              {select(
                "geographyId",
                "Territory or zone",
                named(
                  sections.geography.filter((r) =>
                    ["territory", "zone"].includes(r.data.type ?? ""),
                  ),
                ),
                data.geographyId,
              )}
              {select(
                "repId",
                "Assigned rep (leave blank for a van)",
                options.people,
                data.repId,
                true,
              )}
              {select(
                "vanId",
                "Assigned van (leave blank for a rep)",
                options.vans,
                data.vanId,
                true,
              )}
              {input(
                "cycleWeeks",
                "Repeat every (weeks)",
                data.cycleWeeks ?? 1,
                "number",
              )}
              {input(
                "expectedOutlets",
                "Expected outlet count",
                data.expectedOutlets ?? 25,
                "number",
              )}
              {input(
                "distanceKm",
                "Planned travel distance (km)",
                (data.distanceMeters ?? 0) / 1000,
                "number",
                "0.001",
              )}
            </div>
            <fieldset className="flex flex-wrap gap-3">
              <legend className="text-xs">Days of the week</legend>
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                (day, i) => (
                  <label key={day} className="text-sm">
                    <input
                      type="checkbox"
                      name="weekdays"
                      value={i}
                      defaultChecked={data.weekdays?.includes(i) ?? false}
                    />{" "}
                    {day}
                  </label>
                ),
              )}
            </fieldset>
            {(["start", "end"] as const).map((end) => (
              <fieldset key={end} className="grid gap-2 md:grid-cols-3">
                <legend>{end === "start" ? "Start point" : "End point"}</legend>
                {input(`${end}Label`, "Place name", data[end]?.label)}
                {input(
                  `${end}Latitude`,
                  "Latitude",
                  data[end]?.latitude,
                  "number",
                  "any",
                )}
                {input(
                  `${end}Longitude`,
                  "Longitude",
                  data[end]?.longitude,
                  "number",
                  "any",
                )}
              </fieldset>
            ))}
          </>
        ) : null}
        {kind === "banner"
          ? select(
              "chainId",
              "Parent chain",
              named(sections.chain),
              data.chainId,
            )
          : null}
        {kind === "branch" ? (
          <>
            {select(
              "bannerId",
              "Parent banner",
              named(sections.banner),
              data.bannerId,
            )}
            {select(
              "outletId",
              "Physical branch store",
              options.outlets,
              data.outletId,
            )}
            {select(
              "sapCustomerId",
              "SAP accounting customer",
              options.customers,
              data.sapCustomerId,
            )}
            <p className="text-xs text-muted">
              The customer must match the store's effective accounting link.
              This does not create a second customer ledger.
            </p>
          </>
        ) : null}
        <Field label="Effective from (Manila; blank means now)">
          <input
            className={control}
            name="effectiveFrom"
            type="datetime-local"
          />
        </Field>
        {input("reason", "Reason for this version", "")}
        <Button type="submit" variant="outline" isDisabled={busy}>
          Save version
        </Button>
        {message ? (
          <p role="status" className="text-sm">
            {message}
          </p>
        ) : null}
        {history.error ? (
          <Notice title={history.error.message} tone="danger" />
        ) : history.data ? (
          <section className="grid gap-2 border-t border-border pt-3">
            <h3 className="text-sm font-semibold">Decision history</h3>
            {history.data.rows.map((r) => (
              <div key={r.versionId} className="text-sm">
                <p>
                  Version {r.version} · {r.label} ·{" "}
                  {formatDateTime(r.effectiveFrom)}
                </p>
                <p className="text-xs text-muted">
                  {r.actorName} · {r.reason}
                </p>
              </div>
            ))}
            {history.data.truncated ? (
              <p className="text-xs text-muted">
                Showing the latest 100 versions.
              </p>
            ) : null}
          </section>
        ) : null}
      </form>
    </Card>
  );
}
function OutletReview({ options }: { options: Options }) {
  const session = usePermissions(),
    [outletId, setOutletId] = useState(""),
    [message, setMessage] = useState("");
  const canReview = session.can("outlet.verify");
  const duplicates = useApi<{
    source: { name: string };
    candidates: {
      id: string;
      name: string;
      distanceMeters: number | null;
      sameContact: boolean;
    }[];
  }>(
    canReview && outletId ? ["masters", "duplicates", outletId] : null,
    `/api/v1/masters/outlets/${outletId}/duplicates`,
  );
  async function merge(id: string) {
    const reason = window.prompt(
      "Why are these the same physical store? Historical records will retain their original store IDs.",
    );
    if (!reason?.trim()) return;
    try {
      await mutate(
        "/api/v1/masters/outlets/merge",
        { sourceOutletId: outletId, survivorOutletId: id, reason },
        { idempotencyKey: crypto.randomUUID(), invalidate: [["masters"]] },
      );
      setOutletId("");
      setMessage(
        "Merged. The survivor is active and original histories are preserved.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Merge failed.");
    }
  }
  if (!canReview) return null;
  return (
    <Card label="Duplicate-store review">
      <Select
        name="reviewOutlet"
        label="Store to review"
        choices={options.outlets}
        value={outletId}
        onChange={setOutletId}
      />
      <p className="mt-2 text-xs text-muted">
        Candidates use matching contact numbers, or similar names within 150
        metres. Review before merging; shared accounting accounts alone are
        never a match.
      </p>
      {duplicates.error ? (
        <Notice title={duplicates.error.message} tone="danger" />
      ) : null}
      {duplicates.data?.candidates.map((c) => (
        <div
          key={c.id}
          className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-3"
        >
          <div>
            <p className="text-sm">{c.name}</p>
            <p className="text-xs text-muted">
              {c.sameContact ? "Matching contact · " : "Similar name · "}
              {c.distanceMeters === null
                ? "Distance unavailable"
                : `${c.distanceMeters} m apart`}
            </p>
          </div>
          <Button variant="outline" onPress={() => void merge(c.id)}>
            Keep this store; merge source
          </Button>
        </div>
      ))}
      {duplicates.data && !duplicates.data.candidates.length ? (
        <p className="py-3 text-sm text-muted">
          No candidates under these rules. This is not a certification that the
          store is unique.
        </p>
      ) : null}
      {message ? (
        <p role="status" className="mt-2 text-sm">
          {message}
        </p>
      ) : null}
    </Card>
  );
}
