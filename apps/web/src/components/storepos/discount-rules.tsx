"use client";
import { formatDateTime } from "../../lib/format";

import { useState, type FormEvent } from "react";
import { mutate, useApi, useLive } from "../../lib/api";

/**
 * IP-SCPWD-CAP: two office settings that belong to the store tills, on one screen.
 *   1. The weekly purchase limit on the senior citizen / PWD discount (every store and van, per ID).
 *   1b. SC/PWD discount on or off per unit for its stores and its vans.
 *   2. The old way of closing the day without a supervisor PIN: the switch, and which tills are still on old app builds.
 * Everyone who can open Stores POS can read it; only the office (admin) can change it, and the server refuses anyone else.
 */

export type CapSetting = {
  enabled: boolean;
  capCentavos: number;
  accountantConfirmed: boolean;
  isDefault: boolean;
  note: string | null;
  effectiveFrom: number | null;
};
export type CapData = {
  setting: CapSetting;
  week: { start: string; endsAt: number; note: string };
  appliesTo: string[];
  history: Array<{
    enabled: boolean;
    capCentavos: number;
    accountantConfirmed: boolean;
    note: string | null;
    effectiveFrom: number;
    setBy: string;
  }>;
  card: {
    type: string;
    usedCentavos: number;
    leftCentavos: number | null;
    message: string | null;
  } | null;
  canManage: boolean;
};
export type LegacyZDevice = {
  deviceId: string;
  tag: string;
  person: string;
  store: string | null;
  register: string | null;
  buildCode: number | null;
  buildName: string | null;
  lastSeenAt: number | null;
  quiet: boolean;
  state: "current" | "signs_with_pin" | "older" | "unknown";
  stateWords: string;
  needsUpdate: boolean;
  lastLegacyZ: number | null;
  legacyZ30d: number;
};
export type LegacyZData = {
  gate: {
    mode: "older_builds_only" | "off";
    modeWords: string;
    minVersionCode: number;
    note: string | null;
    isDefault: boolean;
  };
  summary: {
    devices: number;
    needingUpdate: number;
    quietNeedingUpdate: number;
    legacyZLast30Days: number;
    safeToSwitchOff: boolean;
    advice: string;
  };
  devices: LegacyZDevice[];
  canManage: boolean;
  quietDays: number;
};

export type RefundPolicyData = {
  supervisorOverCentavos: number;
  isDefault: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  canManage: boolean;
};

export const DEFAULT_WORDS = "Default — confirm with Sunpride accountant";

/** ₱ with two decimals from centavos. */
export const peso = (centavos: number) =>
  `₱${(centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the amount is called on screen: the shipped default says so until the office records the accountant's confirmation. */
export function limitStatusWords(s: CapSetting): string {
  if (!s.enabled) return "Weekly limit is switched off";
  if (s.isDefault || !s.accountantConfirmed) return DEFAULT_WORDS;
  return "Confirmed with the accountant";
}

/** Pesos typed by the office to centavos, or null when it is not a usable amount. */
export function pesosToCentavos(text: string): number | null {
  const t = text.replace(/[,\s₱]/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const c = Math.round(Number(t) * 100);
  return c > 0 && c <= 100_000_000 ? c : null;
}

/** Refund amount typed in pesos to centavos; 0 is allowed (every refund needs a supervisor). */
export function refundPesosToCentavos(text: string): number | null {
  const t = text.replace(/[,\s₱]/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const c = Math.round(Number(t) * 100);
  return c >= 0 && c <= 100_000_000 ? c : null;
}

const when = (ms: number | null) =>
  ms === null ? "never" : formatDateTime(ms);
const control =
  "min-w-0 max-w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";
const button =
  "min-h-12 rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50";

/** The weekly limit: the amount, how sure we are of it, the form, and the history. */
export function WeeklyLimitCard({
  data,
  onSave,
  busy = false,
  notice = "",
}: {
  data: CapData;
  onSave?: (v: {
    enabled: boolean;
    capCentavos: number;
    accountantConfirmed: boolean;
    note: string;
  }) => void;
  busy?: boolean;
  notice?: string;
}) {
  const s = data.setting;
  const [enabled, setEnabled] = useState(s.enabled);
  const [amount, setAmount] = useState(String(s.capCentavos / 100));
  const [confirmed, setConfirmed] = useState(s.accountantConfirmed);
  const [note, setNote] = useState(s.isDefault ? "" : (s.note ?? ""));
  const centavos = pesosToCentavos(amount);
  const unconfirmed = s.enabled && (s.isDefault || !s.accountantConfirmed);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (centavos !== null && onSave)
      onSave({
        enabled,
        capCentavos: centavos,
        accountantConfirmed: confirmed,
        note,
      });
  };
  return (
    <section
      aria-labelledby="cap-title"
      className="grid gap-3 rounded-lg border border-border p-4"
    >
      <h2 id="cap-title" className="text-lg font-bold">
        Senior and PWD weekly limit
      </h2>
      <p className="text-sm text-muted">
        A senior citizen or PWD gets the discount on purchases up to this amount
        each week, added up across every store and van by ID number. The week
        runs Monday to Sunday (Manila time). When a sale goes past what is left,
        the discount is only worked out on the part that fits.
      </p>
      <p className="text-2xl font-bold" data-testid="cap-amount">
        {s.enabled ? `${peso(s.capCentavos)} a week` : "No weekly limit"}
      </p>
      <p
        className={`text-sm font-semibold ${unconfirmed ? "text-[#B45309]" : "text-muted"}`}
        data-testid="cap-status"
      >
        {limitStatusWords(s)}
      </p>
      <p className="text-xs text-muted">
        Applies to: senior citizen and PWD IDs. Current week starts{" "}
        {data.week.start}.
      </p>
      {data.canManage ? (
        <form
          onSubmit={submit}
          className="grid gap-3"
          aria-label="Edit the weekly limit"
        >
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="size-5"
            />
            Use a weekly limit
          </label>
          <label className="grid max-w-xs gap-1 text-sm">
            Limit in pesos per week
            <input
              inputMode="decimal"
              className={control}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={centavos === null}
            />
          </label>
          {centavos === null ? (
            <p role="alert" className="text-sm text-red-700">
              Enter the amount in pesos, for example 2500.
            </p>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="size-5"
            />
            Sunpride&apos;s accountant has confirmed this amount
          </label>
          <label className="grid gap-1 text-sm">
            Note (optional)
            <input
              className={control}
              value={note}
              maxLength={300}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div>
            <button
              type="submit"
              className={button}
              disabled={busy || centavos === null}
            >
              Save the limit
            </button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted" data-testid="cap-readonly">
          Only the office can change the limit.
        </p>
      )}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {data.history.length ? (
        <details>
          <summary className="cursor-pointer text-sm font-semibold">
            History of changes
          </summary>
          <ul className="mt-2 grid gap-1 text-sm">
            {data.history.map((h) => (
              <li key={`${h.effectiveFrom}-${h.capCentavos}`}>
                {when(h.effectiveFrom)}:{" "}
                {h.enabled ? peso(h.capCentavos) : "limit off"} by {h.setBy}
                {h.accountantConfirmed ? " (accountant confirmed)" : ""}
                {h.note ? ` — ${h.note}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** One ID's use this week, looked up by the office. */
export function CardLookup({
  card,
  onLookup,
}: {
  card: CapData["card"];
  onLookup?: (type: string, id: string) => void;
}) {
  const [type, setType] = useState("senior");
  const [id, setId] = useState("");
  return (
    <section
      aria-labelledby="lookup-title"
      className="grid gap-3 rounded-lg border border-border p-4"
    >
      <h2 id="lookup-title" className="text-lg font-bold">
        How much has an ID used this week?
      </h2>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (id.trim().length >= 3) onLookup?.(type, id.trim());
        }}
      >
        <label className="grid gap-1 text-sm">
          Type
          <select
            className={control}
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="senior">Senior citizen</option>
            <option value="pwd">PWD</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          ID number
          <input
            className={control}
            value={id}
            onChange={(e) => setId(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className={button}
          disabled={id.trim().length < 3}
        >
          Look up
        </button>
      </form>
      {card ? (
        <p data-testid="card-result" className="text-sm">
          Used {peso(card.usedCentavos)} this week.{" "}
          {card.message ?? "No weekly limit is set."}
        </p>
      ) : null}
    </section>
  );
}

/** The no-PIN Z switch and the tills still on old builds. */
export function LegacyZCard({
  data,
  onSave,
  busy = false,
  notice = "",
}: {
  data: LegacyZData;
  onSave?: (v: {
    mode: "older_builds_only" | "off";
    minVersionCode: number;
  }) => void;
  busy?: boolean;
  notice?: string;
}) {
  const [mode, setMode] = useState(data.gate.mode);
  const [min, setMin] = useState(String(data.gate.minVersionCode));
  const minNumber =
    /^\d{1,6}$/.test(min) && Number(min) > 0 ? Number(min) : null;
  return (
    <section
      aria-labelledby="z-title"
      className="grid gap-3 rounded-lg border border-border p-4"
    >
      <h2 id="z-title" className="text-lg font-bold">
        Closing the day without a supervisor PIN
      </h2>
      <p className="text-sm text-muted">
        Older app builds close the day with no PIN. They still work. Builds from
        beta.
        {data.gate.minVersionCode} can ask a supervisor for a PIN, so the old
        way is refused for them. When no till is left on an old build, switch
        the old way off for everyone.
      </p>
      <p className="text-sm font-semibold" data-testid="z-mode">
        Now: {data.gate.modeWords}
      </p>
      <p
        className={`rounded-lg px-3 py-2 text-sm ${data.summary.safeToSwitchOff ? "bg-green-50 text-green-900" : "bg-amber-50 text-amber-900"}`}
        role="status"
        data-testid="z-advice"
      >
        {data.summary.advice}
      </p>
      {data.devices.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Tills and the app build each is on
            </caption>
            <thead className="text-left text-xs uppercase text-muted">
              <tr>
                <th className="py-2 pr-3">Till</th>
                <th className="py-2 pr-3">Person</th>
                <th className="py-2 pr-3">App build</th>
                <th className="py-2 pr-3">Last seen</th>
                <th className="py-2 pr-3">Old way used (30 days)</th>
              </tr>
            </thead>
            <tbody>
              {data.devices.map((d) => (
                <tr key={d.deviceId} className="border-t border-separator">
                  <td className="py-2 pr-3">
                    {d.store ?? "No store"}
                    <span className="block text-xs text-muted">
                      {d.register ?? d.tag}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{d.person}</td>
                  <td
                    className={`py-2 pr-3 ${d.needsUpdate ? "font-semibold text-[#B45309]" : ""}`}
                  >
                    {d.stateWords}
                    {d.needsUpdate ? (
                      <span className="block text-xs">Needs an update</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">
                    {when(d.lastSeenAt)}
                    {d.quiet ? (
                      <span className="block text-xs text-muted">
                        Quiet for {data.quietDays}+ days
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">
                    {d.legacyZ30d}
                    {d.lastLegacyZ ? (
                      <span className="block text-xs text-muted">
                        last {when(d.lastLegacyZ)}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted">No store tills are set up yet.</p>
      )}
      {data.canManage ? (
        <form
          className="grid gap-3"
          aria-label="Edit the old Z way"
          onSubmit={(e) => {
            e.preventDefault();
            if (minNumber !== null && onSave)
              onSave({ mode, minVersionCode: minNumber });
          }}
        >
          <fieldset className="grid gap-2">
            <legend className="text-sm font-semibold">
              Old way of closing the day
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="z-mode"
                checked={mode === "older_builds_only"}
                onChange={() => setMode("older_builds_only")}
                className="size-5"
              />
              Allow it only on older builds
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="z-mode"
                checked={mode === "off"}
                onChange={() => setMode("off")}
                className="size-5"
              />
              Switch it off for every till
            </label>
          </fieldset>
          <label className="grid max-w-xs gap-1 text-sm">
            First build that can use a PIN (beta number)
            <input
              inputMode="numeric"
              className={control}
              value={min}
              onChange={(e) => setMin(e.target.value)}
              aria-invalid={minNumber === null}
            />
          </label>
          {mode === "off" && !data.summary.safeToSwitchOff ? (
            <p role="alert" className="text-sm text-red-700">
              Not everything is ready: tills that are still on an old build will
              not be able to close the day on the phone. A supervisor can still
              run the Z reading on the web.
            </p>
          ) : null}
          <div>
            <button
              type="submit"
              className={button}
              disabled={busy || minNumber === null}
            >
              Save
            </button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted">Only the office can change this.</p>
      )}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

/** The refund amount above which a supervisor has to approve. It counts what the receipt already had refunded. */
export function RefundPolicyCard({
  data,
  onSave,
  busy = false,
  notice = "",
}: {
  data: RefundPolicyData;
  onSave?: (v: { supervisorOverCentavos: number }) => void;
  busy?: boolean;
  notice?: string;
}) {
  const [amount, setAmount] = useState(
    String(data.supervisorOverCentavos / 100),
  );
  const centavos = refundPesosToCentavos(amount);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (centavos !== null && onSave)
      onSave({ supervisorOverCentavos: centavos });
  };
  return (
    <section
      aria-labelledby="refund-policy-title"
      className="grid gap-3 rounded-lg border border-border p-4"
    >
      <h2 id="refund-policy-title" className="text-lg font-bold">
        Refund approval amount
      </h2>
      <p className="text-sm text-muted">
        A refund by item needs a supervisor once it goes above this amount. The
        amount counts what the same receipt has already had refunded, so a
        receipt cannot be refunded in small pieces to get around it.
      </p>
      <p className="text-2xl font-bold" data-testid="refund-amount">
        {data.supervisorOverCentavos === 0
          ? "Every refund needs a supervisor"
          : `Above ${peso(data.supervisorOverCentavos)}`}
      </p>
      <p
        className={`text-sm font-semibold ${data.isDefault ? "text-[#B45309]" : "text-muted"}`}
        data-testid="refund-status"
      >
        {data.isDefault
          ? "Default — confirm with Sunpride"
          : `Set by ${data.updatedBy ?? "the office"}${data.updatedAt ? `, ${when(data.updatedAt)}` : ""}`}
      </p>
      {data.canManage ? (
        <form
          onSubmit={submit}
          className="grid gap-3"
          aria-label="Edit the refund approval amount"
        >
          <label className="grid max-w-xs gap-1 text-sm">
            Amount in pesos
            <input
              inputMode="decimal"
              className={control}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={centavos === null}
            />
          </label>
          {centavos === null ? (
            <p role="alert" className="text-sm text-red-700">
              Enter the amount in pesos, for example 500. Use 0 for every
              refund.
            </p>
          ) : null}
          <div>
            <button
              type="submit"
              className={button}
              disabled={busy || centavos === null}
            >
              Save the refund amount
            </button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted">
          Only the office can change the refund amount.
        </p>
      )}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

/** One row of `GET /api/v1/fiscal/privilege/settings` (append-only; the newest row in force wins). */
export type PrivilegeSettingRow = {
  id: string;
  org_unit_id: string;
  surface: "store" | "van";
  route_id: string | null;
  enabled: boolean;
  effective_from: string | number;
};
export type PrivilegeSettingsData = {
  settings: PrivilegeSettingRow[];
  defaults: { store: boolean; van: boolean };
  canManage: boolean;
};
export type PrivilegeUnit = { id: string; name: string };

/** Whether SC/PWD is on for one unit's stores or vans now, and whether that is the default (SPEC 6.2: stores on, vans off). */
export function privilegeState(
  data: PrivilegeSettingsData,
  unitId: string,
  surface: "store" | "van",
  now = Date.now(),
): { enabled: boolean; isDefault: boolean } {
  const row = data.settings
    .filter(
      (r) =>
        r.org_unit_id === unitId &&
        r.surface === surface &&
        r.route_id === null &&
        new Date(r.effective_from).getTime() <= now,
    )
    .sort(
      (a, b) =>
        new Date(b.effective_from).getTime() -
        new Date(a.effective_from).getTime(),
    )[0];
  return row
    ? { enabled: row.enabled, isDefault: false }
    : { enabled: data.defaults[surface], isDefault: true };
}

const SURFACE_WORDS = { store: "Stores (tills)", van: "Vans (van selling)" } as const;

/**
 * SC/PWD discount on or off per unit, for its stores and its vans (admin only; the server refuses anyone else).
 * The weekly limit card only limits the discount; this switch is what turns it on.
 */
export function PrivilegeSwitchCard({
  data,
  units,
  onSave,
  busy = false,
  notice = "",
  now,
}: {
  data: PrivilegeSettingsData;
  units: PrivilegeUnit[];
  onSave?: (v: { orgUnitId: string; surface: "store" | "van"; enabled: boolean }) => void;
  busy?: boolean;
  notice?: string;
  now?: number;
}) {
  const [unitId, setUnitId] = useState(units[0]?.id ?? "");
  const unit = units.find((u) => u.id === unitId);
  return (
    <section
      aria-labelledby="privilege-switch-title"
      className="grid gap-3 rounded-lg border border-border p-4"
    >
      <h2 id="privilege-switch-title" className="text-lg font-bold">
        Senior citizen / PWD discount on or off
      </h2>
      <p className="text-sm text-muted">
        The senior citizen and PWD discount is required by law wherever a unit
        sells to consumers. It is on for stores and off for vans unless the
        office changes it here. The weekly limit above does not switch the
        discount on; it only limits it.
      </p>
      {units.length ? (
        <label className="grid max-w-md gap-1 text-sm">
          Unit
          <select
            className={control}
            value={unitId}
            onChange={(e) => setUnitId(e.target.value)}
          >
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-sm text-muted">No units to show.</p>
      )}
      {unit ? (
        <table className="w-full max-w-xl text-sm">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-2 pr-3">Where</th>
              <th className="py-2 pr-3">SC/PWD discount</th>
              <th className="py-2 pr-3">
                <span className="sr-only">Change</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(["store", "van"] as const).map((surface) => {
              const st = privilegeState(data, unit.id, surface, now);
              return (
                <tr key={surface} className="border-t border-border">
                  <td className="py-2 pr-3">{SURFACE_WORDS[surface]}</td>
                  <td className="py-2 pr-3" data-testid={`privilege-${surface}`}>
                    {`${st.enabled ? "On" : "Off"}${st.isDefault ? " (default)" : ""}`}
                  </td>
                  <td className="py-2 pr-3">
                    {data.canManage && onSave ? (
                      <button
                        type="button"
                        className={button}
                        disabled={busy}
                        onClick={() =>
                          onSave({
                            orgUnitId: unit.id,
                            surface,
                            enabled: !st.enabled,
                          })
                        }
                      >
                        {st.enabled
                          ? `Switch off for ${surface === "store" ? "stores" : "vans"}`
                          : `Switch on for ${surface === "store" ? "stores" : "vans"}`}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {data.canManage ? (
        <p className="text-sm text-muted">
          Switch it off only where this unit does not sell to consumers.
        </p>
      ) : (
        <p className="text-sm text-muted">Only the office can change this.</p>
      )}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

const capKey = ["fiscal", "privilege-cap"] as const;
const zKey = ["storepos", "legacy-z"] as const;
const refundKey = ["fiscal", "refund-policy"] as const;
const privilegeKey = ["fiscal", "privilege-settings"] as const;
const unitsKey = ["fiscal", "privilege-units"] as const;

/** Stores POS ▸ Discount and Z rules. */
export function DiscountRulesScreen() {
  const [lookup, setLookup] = useState<{ type: string; id: string } | null>(
    null,
  );
  const capPath = lookup
    ? `/api/v1/fiscal/privilege/cap?type=${encodeURIComponent(lookup.type)}&idNumber=${encodeURIComponent(lookup.id)}`
    : "/api/v1/fiscal/privilege/cap";
  const cap = useApi<CapData>(
    [...capKey, lookup?.type ?? "", lookup?.id ?? ""],
    capPath,
  );
  const z = useApi<LegacyZData>(zKey, "/api/v1/storepos/legacy-z");
  const refund = useApi<RefundPolicyData>(
    refundKey,
    "/api/v1/fiscal/refunds/policy",
  );
  const privilege = useApi<PrivilegeSettingsData>(
    privilegeKey,
    "/api/v1/fiscal/privilege/settings",
  );
  const units = useApi<PrivilegeUnit[]>(unitsKey, "/api/v1/org/tree");
  useLive(["fiscal", "storepos"], [capKey, zKey, refundKey, privilegeKey]);
  const [privilegeNotice, setPrivilegeNotice] = useState("");
  const [refundNotice, setRefundNotice] = useState("");
  const [capNotice, setCapNotice] = useState("");
  const [zNotice, setZNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(
    path: string,
    body: Record<string, unknown>,
    done: (s: string) => void,
    ok: string,
    refresh: () => unknown,
  ) {
    setBusy(true);
    done("");
    try {
      await mutate(path, body);
      done(ok);
      await refresh();
    } catch (e) {
      done(e instanceof Error ? e.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-4">
      {cap.data ? (
        <>
          <WeeklyLimitCard
            data={cap.data}
            busy={busy}
            notice={capNotice}
            onSave={(v) =>
              run(
                "/api/v1/fiscal/privilege/cap",
                v,
                setCapNotice,
                "Saved. Phones get the new limit the next time they sync.",
                cap.refetch,
              )
            }
          />
          <CardLookup
            card={cap.data.card}
            onLookup={(type, id) => setLookup({ type, id })}
          />
        </>
      ) : (
        <p role={cap.error ? "alert" : undefined} className="text-sm">
          {cap.error
            ? "Could not load the weekly limit."
            : "Loading the weekly limit…"}
        </p>
      )}
      {privilege.data ? (
        <PrivilegeSwitchCard
          data={privilege.data}
          units={units.data ?? []}
          busy={busy}
          notice={privilegeNotice}
          onSave={(v) =>
            run(
              "/api/v1/fiscal/privilege/settings",
              v,
              setPrivilegeNotice,
              `Saved: SC/PWD discount ${v.enabled ? "on" : "off"} for ${v.surface === "store" ? "stores" : "vans"}. Phones get it the next time they sync.`,
              privilege.refetch,
            )
          }
        />
      ) : (
        <p role={privilege.error ? "alert" : undefined} className="text-sm">
          {privilege.error
            ? "Could not load the SC/PWD switches."
            : "Loading the SC/PWD switches…"}
        </p>
      )}
      {refund.data ? (
        <RefundPolicyCard
          data={refund.data}
          busy={busy}
          notice={refundNotice}
          onSave={(v) =>
            run(
              "/api/v1/fiscal/refunds/policy",
              v,
              setRefundNotice,
              "Saved. Phones get the new amount the next time they sync.",
              refund.refetch,
            )
          }
        />
      ) : (
        <p role={refund.error ? "alert" : undefined} className="text-sm">
          {refund.error
            ? "Could not load the refund amount."
            : "Loading the refund amount…"}
        </p>
      )}
      {z.data ? (
        <LegacyZCard
          data={z.data}
          busy={busy}
          notice={zNotice}
          onSave={(v) =>
            run(
              "/api/v1/storepos/legacy-z/gate",
              { ...v, requestKey: crypto.randomUUID() },
              setZNotice,
              "Saved.",
              z.refetch,
            )
          }
        />
      ) : (
        <p role={z.error ? "alert" : undefined} className="text-sm">
          {z.error
            ? "Could not load the tills report."
            : "Loading the tills report…"}
        </p>
      )}
    </div>
  );
}
