"use client";

/**
 * SP-0170 Customer editor: loads one customer (or starts a new one), runs the shared rules in
 * the browser for instant feedback, saves through /api/v1/customers, and — for approvers —
 * approves a prospect (server `complete` check, errors shown next to each field) or deactivates.
 */
import dynamic from "next/dynamic";
import { useMemo, useRef, useState } from "react";
import { apiFetch, mutate, useApi } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import {
  CustomerForm,
  buttonClass,
  inputClass,
  primaryClass,
  type GeoLists,
} from "./customer-form";
import {
  STATUS_LABEL,
  applies,
  checkDraft,
  draftFromCustomer,
  emptyDraft,
  fieldErrorsFrom,
  indexReference,
  setField,
  toPayload,
  type Customer,
  type Draft,
  type FieldErrors,
  type GeoOption,
  type RefOption,
} from "./model";

const PinMap = dynamic(
  () => import("../store-gathering/pin-map").then((m) => m.PinMap),
  {
    ssr: false,
    loading: () => (
      <div className="h-64 rounded-xl border border-border bg-default-soft" />
    ),
  },
);
const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
const CEBU = { latitude: 10.3157, longitude: 123.8854 };

type Setup = {
  units: { id: string; name: string }[];
  defaultUnitId: string | null;
  addressSearch: boolean;
};

const geoKey = (path: string, param: string, code: string) =>
  code ? (["customers", "geo", path, code] as const) : null;

function useGeo(path: string, param: string, code: string) {
  return useApi<{ options: GeoOption[] }>(geoKey(path, param, code), (ctx) =>
    apiFetch(`/api/v1/geography/${path}`, {
      query: { [param]: code },
      signal: ctx.signal,
    }),
  );
}

/** Reference lists for every dropdown (one call; filtered in the browser). */
export function useCustomerReference() {
  const ref = useApi<{ lists: Record<string, RefOption[]> }>(
    ["customers", "reference"],
    "/api/v1/customers/reference",
  );
  const index = useMemo(
    () => indexReference(Object.values(ref.data?.lists ?? {}).flat()),
    [ref.data],
  );
  return { index, loaded: Boolean(ref.data), error: ref.error };
}

export function CustomerEditor({
  customerId,
  initialName = "",
  onDone,
}: {
  /** Omit to create a new customer. */
  customerId?: string;
  initialName?: string;
  onDone?: (customer: Customer) => void;
}) {
  const { can } = usePermissions();
  const canEdit = can("outlet.manage");
  const canApprove = can("outlet.enrol.approve");
  const loaded = useApi<Customer>(
    customerId ? ["customers", "one", customerId] : null,
    customerId ? `/api/v1/customers/${encodeURIComponent(customerId)}` : "",
  );
  const { index, loaded: refLoaded } = useCustomerReference();
  const setup = useApi<Setup>(
    canEdit && !customerId ? ["masters", "store-setup"] : null,
    "/api/v1/masters/store-setup",
  );
  if (customerId && !loaded.data)
    return (
      <p className="text-sm text-muted">
        {loaded.error ? loaded.error.message : "Loading customer…"}
      </p>
    );
  if (!refLoaded)
    return <p className="text-sm text-muted">Loading lists…</p>;
  return (
    <EditorBody
      key={loaded.data ? loaded.data.id : "new"}
      customer={loaded.data ?? null}
      initialName={initialName}
      index={index}
      canEdit={canEdit}
      canApprove={canApprove}
      setup={setup.data ?? null}
      onDone={onDone}
    />
  );
}

function EditorBody({
  customer: initial,
  initialName,
  index,
  canEdit,
  canApprove,
  setup,
  onDone,
}: {
  customer: Customer | null;
  initialName: string;
  index: ReturnType<typeof indexReference>;
  canEdit: boolean;
  canApprove: boolean;
  setup: Setup | null;
  onDone?: (customer: Customer) => void;
}) {
  const [customer, setCustomer] = useState<Customer | null>(initial);
  const readOnly = !canEdit || customer?.status === "inactive";
  const [draft, setDraft] = useState<Draft>(() => {
    if (customer) return draftFromCustomer(customer);
    return setField(emptyDraft(), "customerName", initialName);
  });
  // A field-captured prospect opens with the fields still missing for approval highlighted.
  const [errors, setErrors] = useState<FieldErrors>(() =>
    customer?.status === "prospect"
      ? checkDraft(index, draftFromCustomer(customer), "complete")
      : {},
  );
  const [message, setMessage] = useState<{
    tone: "error" | "ok" | "info";
    text: string;
  } | null>(() => {
    if (customer?.status !== "prospect") return null;
    const n = Object.keys(
      checkDraft(index, draftFromCustomer(customer), "complete"),
    ).length;
    return n
      ? {
          tone: "info",
          text: `${n} field${n === 1 ? "" : "s"} still needed before approval (highlighted).`,
        }
      : { tone: "info", text: "Complete. Ready for approval." };
  });
  const [busy, setBusy] = useState(false);
  const [unitId, setUnitId] = useState("");
  const [deactivating, setDeactivating] = useState(false);
  const [reason, setReason] = useState("");
  const [suggestNote, setSuggestNote] = useState("");
  const saveKey = useRef("");
  const dirty = useRef(false);

  const v = draft.values;
  const regions = useApi<{ options: GeoOption[] }>(
    ["customers", "geo", "regions"],
    "/api/v1/geography/regions",
  );
  const provinces = useGeo("provinces", "regionCode", v.regionCode ?? "");
  const municipalities = useGeo(
    "municipalities",
    "provinceCode",
    v.provinceCode ?? "",
  );
  const barangays = useGeo(
    "barangays",
    "municipalityCode",
    v.municipalityCode ?? "",
  );
  const postal = useGeo(
    "postal-codes",
    "municipalityCode",
    v.municipalityCode ?? "",
  );
  const geo: GeoLists = {
    regions: regions.data?.options ?? [],
    provinces: provinces.data?.options ?? [],
    municipalities: municipalities.data?.options ?? [],
    barangays: barangays.data?.options ?? [],
    postalCodes: postal.data?.options ?? [],
  };

  function change(next: Draft) {
    dirty.current = true;
    saveKey.current = "";
    setDraft(next);
    // Re-check only the fields already flagged, so the highlight clears as people fix them.
    if (Object.keys(errors).length) {
      const level = customer?.status === "prospect" ? "complete" : "draft";
      const now = checkDraft(index, next, level);
      setErrors((prev) => {
        const out: FieldErrors = {};
        for (const k of Object.keys(prev)) if (now[k]) out[k] = now[k];
        return out;
      });
    }
  }

  const pin =
    draft.latitude.trim() && draft.longitude.trim()
      ? { latitude: Number(draft.latitude), longitude: Number(draft.longitude) }
      : null;
  const validPin =
    pin && Number.isFinite(pin.latitude) && Number.isFinite(pin.longitude)
      ? pin
      : null;

  async function suggestFromAddress() {
    const address = v.customerAddress?.trim();
    if (!address) {
      setSuggestNote("Fill the location first.");
      return;
    }
    try {
      const session = crypto.randomUUID();
      const r = await apiFetch<{
        predictions: { placeId: string; description: string }[];
      }>("/api/v1/places/autocomplete", {
        query: { input: address, session },
      });
      const first = r.predictions[0];
      if (!first) {
        setSuggestNote("No match for this address. Place the pin by hand.");
        return;
      }
      const d = await apiFetch<{ latitude: number; longitude: number }>(
        "/api/v1/places/details",
        { query: { placeId: first.placeId, session } },
      );
      change({
        ...draft,
        latitude: d.latitude.toFixed(6),
        longitude: d.longitude.toFixed(6),
      });
      setSuggestNote(
        `Suggested from “${first.description}”. Drag the pin onto the store if needed.`,
      );
    } catch (e) {
      setSuggestNote(
        e instanceof Error ? e.message : "Address search is not available.",
      );
    }
  }

  const pinSlot = (
    <div className="grid gap-2">
      <PinMap
        pin={validPin}
        draggable={!readOnly}
        onMove={(at) =>
          change({
            ...draft,
            latitude: at.latitude.toFixed(6),
            longitude: at.longitude.toFixed(6),
          })
        }
        label="Customer location"
        googleKey={GOOGLE_KEY}
      />
      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          {setup?.addressSearch !== false ? (
            <button
              type="button"
              className={buttonClass}
              onClick={suggestFromAddress}
            >
              Suggest from address
            </button>
          ) : null}
          {!validPin ? (
            <button
              type="button"
              className={buttonClass}
              onClick={() =>
                change({
                  ...draft,
                  latitude: CEBU.latitude.toFixed(6),
                  longitude: CEBU.longitude.toFixed(6),
                })
              }
            >
              Place a pin to drag
            </button>
          ) : null}
          {customer?.pinStatus ? (
            <span className="text-[12px] text-muted">
              Pin {customer.pinStatus === "verified" ? "verified" : "waiting for a second person to verify"}
            </span>
          ) : null}
        </div>
      ) : null}
      {suggestNote ? (
        <p className="text-[12px] text-muted">{suggestNote}</p>
      ) : null}
    </div>
  );

  async function save(): Promise<Customer | null> {
    const local = checkDraft(index, draft, "draft");
    if (Object.keys(local).length) {
      setErrors(local);
      setMessage({
        tone: "error",
        text: Object.values(local)[0] ?? "Check the highlighted fields.",
      });
      return null;
    }
    const customerBody = toPayload(draft, applies(index, draft));
    if (!saveKey.current) saveKey.current = crypto.randomUUID();
    const units = setup?.units ?? [];
    const custodian = unitId || setup?.defaultUnitId || units[0]?.id || "";
    try {
      const saved = customer
        ? await mutate<Customer>(
            `/api/v1/customers/${encodeURIComponent(customer.id)}`,
            {
              customer: customerBody,
              ...(draft.code.trim() && draft.code.trim() !== customer.code
                ? { code: draft.code.trim() }
                : {}),
            },
            {
              method: "PUT",
              idempotencyKey: saveKey.current,
              invalidate: [["customers"], ["stores"]],
            },
          )
        : await mutate<Customer>(
            "/api/v1/customers",
            {
              custodianOrgUnitId: custodian,
              customer: customerBody,
              ...(draft.code.trim() ? { code: draft.code.trim() } : {}),
            },
            {
              idempotencyKey: saveKey.current,
              invalidate: [["customers"], ["stores"]],
            },
          );
      dirty.current = false;
      setCustomer(saved);
      setDraft(draftFromCustomer(saved));
      return saved;
    } catch (e) {
      const { fields, message: text } = fieldErrorsFrom(e);
      const code = (e as { code?: string }).code;
      if (code === "code_taken" || code === "code_locked" || code === "invalid_code")
        fields.code = text;
      setErrors(fields);
      setMessage({ tone: "error", text });
      return null;
    }
  }

  async function onSave() {
    setBusy(true);
    setMessage(null);
    const saved = await save();
    setBusy(false);
    if (saved) {
      setErrors({});
      setMessage({
        tone: "ok",
        text: customer
          ? "Saved."
          : `Customer ${saved.code} created as a prospect.`,
      });
      onDone?.(saved);
    }
  }

  async function onApprove() {
    if (!customer) return;
    setBusy(true);
    setMessage(null);
    // Save pending edits first so approval checks what is on screen.
    if (dirty.current && !(await save())) {
      setBusy(false);
      return;
    }
    try {
      const approved = await mutate<Customer>(
        `/api/v1/customers/${encodeURIComponent(customer.id)}/approve`,
        {},
        {
          idempotencyKey: crypto.randomUUID(),
          invalidate: [["customers"], ["stores"]],
        },
      );
      setCustomer(approved);
      setDraft(draftFromCustomer(approved));
      setErrors({});
      setMessage({ tone: "ok", text: `Approved. Customer Code ${approved.code}.` });
      onDone?.(approved);
    } catch (e) {
      const { fields, message: text } = fieldErrorsFrom(e);
      setErrors(fields);
      setMessage({ tone: "error", text });
    } finally {
      setBusy(false);
    }
  }

  async function onDeactivate() {
    if (!customer) return;
    setBusy(true);
    try {
      const done = await mutate<Customer>(
        `/api/v1/customers/${encodeURIComponent(customer.id)}/deactivate`,
        { reason: reason.trim() || null },
        {
          idempotencyKey: crypto.randomUUID(),
          invalidate: [["customers"], ["stores"]],
        },
      );
      setCustomer(done);
      setDeactivating(false);
      setMessage({ tone: "ok", text: "Customer deactivated." });
      onDone?.(done);
    } catch (e) {
      setMessage({
        tone: "error",
        text: e instanceof Error ? e.message : "Could not deactivate.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <CustomerEditorView
      customer={customer}
      draft={draft}
      onChange={change}
      index={index}
      geo={geo}
      errors={errors}
      message={message}
      readOnly={readOnly}
      busy={busy}
      canEdit={canEdit}
      canApprove={canApprove}
      pinSlot={pinSlot}
      units={!customer && (setup?.units.length ?? 0) > 1 ? (setup?.units ?? []) : []}
      unitId={unitId || setup?.defaultUnitId || ""}
      onUnit={setUnitId}
      onSave={onSave}
      onApprove={onApprove}
      deactivating={deactivating}
      reason={reason}
      onReason={setReason}
      onDeactivateStart={() => setDeactivating(true)}
      onDeactivateCancel={() => setDeactivating(false)}
      onDeactivate={onDeactivate}
    />
  );
}

/** Header (status), the form, then the actions the person may take. */
export function CustomerEditorView({
  customer,
  draft,
  onChange,
  index,
  geo,
  errors,
  message,
  readOnly,
  busy,
  canEdit,
  canApprove,
  pinSlot,
  units = [],
  unitId = "",
  onUnit,
  onSave,
  onApprove,
  deactivating = false,
  reason = "",
  onReason,
  onDeactivateStart,
  onDeactivateCancel,
  onDeactivate,
}: {
  customer: Customer | null;
  draft: Draft;
  onChange: (d: Draft) => void;
  index: ReturnType<typeof indexReference>;
  geo: GeoLists;
  errors: FieldErrors;
  message: { tone: "error" | "ok" | "info"; text: string } | null;
  readOnly: boolean;
  busy: boolean;
  canEdit: boolean;
  canApprove: boolean;
  pinSlot?: React.ReactNode;
  units?: { id: string; name: string }[];
  unitId?: string;
  onUnit?: (id: string) => void;
  onSave?: () => void;
  onApprove?: () => void;
  deactivating?: boolean;
  reason?: string;
  onReason?: (v: string) => void;
  onDeactivateStart?: () => void;
  onDeactivateCancel?: () => void;
  onDeactivate?: () => void;
}) {
  const tone =
    message?.tone === "error"
      ? "border-[#f3c1c6] bg-[#fdf2f3] text-[#8a0d18]"
      : message?.tone === "ok"
        ? "border-[#bfe3cc] bg-[#f1faf4] text-[#1f5c36]"
        : "border-[#f1d9a8] bg-[#fdf8ec] text-[#7a4a05]";
  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSave?.();
      }}
    >
      {customer ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span
            className={`rounded-full px-2 py-0.5 text-[12px] font-medium ${customer.status === "active" ? "bg-[#e6f4ea] text-[#1f7a43]" : customer.status === "prospect" ? "bg-[#fdf3e1] text-[#a15c07]" : "bg-default-soft text-muted"}`}
          >
            {STATUS_LABEL[customer.status]}
          </span>
          <span className="text-muted">
            {customer.completeness === "complete"
              ? "All required fields filled"
              : "Incomplete (draft)"}
          </span>
          {readOnly && !canEdit ? (
            <span className="text-muted">· Read only</span>
          ) : null}
        </div>
      ) : null}
      {message ? (
        <p role="status" className={`rounded-lg border px-3 py-2 text-[13px] ${tone}`}>
          {message.text}
        </p>
      ) : null}
      {units.length ? (
        <label className="grid max-w-sm gap-1 text-[12px] font-medium">
          Area
          <select
            className={`${inputClass} border-border`}
            value={unitId}
            onChange={(e) => onUnit?.(e.target.value)}
          >
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <CustomerForm
        draft={draft}
        onChange={onChange}
        index={index}
        geo={geo}
        errors={errors}
        readOnly={readOnly}
        pinSlot={pinSlot}
      />
      {canEdit && customer?.status !== "inactive" ? (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-border bg-surface py-3">
          <button type="submit" className={primaryClass} disabled={busy}>
            {customer ? "Save" : "Create customer"}
          </button>
          {customer?.status === "prospect" && canApprove ? (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={onApprove}
            >
              Approve
            </button>
          ) : null}
          {customer ? (
            deactivating ? (
              <span className="flex flex-wrap items-center gap-2">
                <input
                  aria-label="Reason for deactivating"
                  className={`${inputClass} w-56 border-border`}
                  placeholder="Reason (e.g. store closed)"
                  value={reason}
                  onChange={(e) => onReason?.(e.target.value)}
                />
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={onDeactivate}
                >
                  Confirm deactivate
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  onClick={onDeactivateCancel}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className={`${buttonClass} ml-auto text-[#b4101f]`}
                onClick={onDeactivateStart}
              >
                Deactivate
              </button>
            )
          ) : null}
        </div>
      ) : customer?.status === "prospect" && canApprove ? (
        <div className="flex gap-2">
          <button
            type="button"
            className={primaryClass}
            disabled={busy}
            onClick={onApprove}
          >
            Approve
          </button>
        </div>
      ) : null}
    </form>
  );
}
