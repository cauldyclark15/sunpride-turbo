"use client";

/**
 * SP-0170 Customer editor: loads one customer (or starts a new one), runs the shared rules in
 * the browser for instant feedback, saves through /api/v1/customers, and — for approvers —
 * approves a prospect (server `complete` check, errors shown next to each field) or deactivates.
 */
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, mutate, useApi } from "../../lib/api";
import { DuplicatePanel, useDebounced } from "../store-gathering/add-store";
import type { Candidate } from "../store-gathering/model";
import { usePermissions, useSession } from "../../lib/auth";
import {
  CustomerForm,
  buttonClass,
  inputClass,
  primaryClass,
  type GeoLists,
} from "./customer-form";
import {
  STATUS_LABEL,
  awaitsApproval,
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
  const { profile } = useSession();
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
  if (!refLoaded) return <p className="text-sm text-muted">Loading lists…</p>;
  return (
    <EditorBody
      key={loaded.data ? loaded.data.id : "new"}
      customer={loaded.data ?? null}
      initialName={initialName}
      index={index}
      canEdit={canEdit}
      canApprove={canApprove}
      myProfileId={profile?.id ?? null}
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
  myProfileId = null,
  setup,
  onDone,
}: {
  customer: Customer | null;
  initialName: string;
  index: ReturnType<typeof indexReference>;
  canEdit: boolean;
  canApprove: boolean;
  myProfileId?: string | null;
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
    customer && awaitsApproval(customer)
      ? checkDraft(index, draftFromCustomer(customer), "complete")
      : {},
  );
  const [message, setMessage] = useState<{
    tone: "error" | "ok" | "info";
    text: string;
  } | null>(() => {
    if (!customer || !awaitsApproval(customer)) return null;
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
      const level = (customer ? awaitsApproval(customer) : false)
        ? "complete"
        : "draft";
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
              Pin{" "}
              {customer.pinStatus === "verified"
                ? "verified"
                : "waiting for a second person to verify"}
            </span>
          ) : null}
        </div>
      ) : null}
      {suggestNote ? (
        <p className="text-[12px] text-muted">{suggestNote}</p>
      ) : null}
    </div>
  );

  // WEB-047: a new customer is checked against existing customers and waiting field
  // captures (same name / phone / nearby pin) with the field app's duplicate logic.
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const dupName = useDebounced((v.customerName ?? "").trim(), 400);
  const dupPhone = useDebounced((v.mobileNo ?? "").trim(), 400);
  const dupLat = validPin?.latitude ?? null;
  const dupLng = validPin?.longitude ?? null;
  const dupTown = draft.names.municipalityCode ?? null;
  const dupBarangay = draft.names.barangayCode ?? null;
  useEffect(() => {
    if (customer || !canEdit || dupName.length < 2) return;
    const controller = new AbortController();
    apiFetch<{ candidates: Candidate[] }>(
      "/api/v1/masters/census/duplicate-check",
      {
        body: duplicateQuery(dupName, dupPhone, dupLat, dupLng, {
          municipality: dupTown,
          barangay: dupBarangay,
        }),
        signal: controller.signal,
      },
    )
      .then((r) => setCandidates(r.candidates ?? []))
      .catch(() => undefined);
    return () => controller.abort();
  }, [
    customer,
    canEdit,
    dupName,
    dupPhone,
    dupLat,
    dupLng,
    dupTown,
    dupBarangay,
  ]);
  const matches = !customer && dupName.length >= 2 ? candidates : [];

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
      if (
        code === "code_taken" ||
        code === "code_locked" ||
        code === "invalid_code"
      )
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
      setMessage({
        tone: "ok",
        text: `Approved. Customer Code ${approved.code}.`,
      });
      onDone?.(approved);
    } catch (e) {
      const { fields, message: text } = fieldErrorsFrom(e);
      setErrors(fields);
      setMessage({ tone: "error", text });
    } finally {
      setBusy(false);
    }
  }

  async function onReject(why: string) {
    if (!customer) return;
    setBusy(true);
    try {
      const done = await mutate<Customer>(
        `/api/v1/customers/${encodeURIComponent(customer.id)}/reject`,
        { reason: why.trim() },
        {
          idempotencyKey: crypto.randomUUID(),
          invalidate: [["customers"], ["stores"]],
        },
      );
      setCustomer(done);
      setErrors({});
      setMessage({ tone: "ok", text: "New customer rejected." });
      onDone?.(done);
    } catch (e) {
      setMessage({
        tone: "error",
        text: e instanceof Error ? e.message : "Could not reject.",
      });
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
      myProfileId={myProfileId}
      pinSlot={pinSlot}
      duplicates={matches}
      duplicatesAcknowledged={acknowledged}
      onAcknowledgeDuplicates={setAcknowledged}
      units={
        !customer && (setup?.units.length ?? 0) > 1 ? (setup?.units ?? []) : []
      }
      unitId={unitId || setup?.defaultUnitId || ""}
      onUnit={setUnitId}
      onSave={onSave}
      onApprove={onApprove}
      onReject={onReject}
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
  myProfileId = null,
  pinSlot,
  duplicates = [],
  duplicatesAcknowledged = false,
  onAcknowledgeDuplicates,
  units = [],
  unitId = "",
  onUnit,
  onSave,
  onApprove,
  onReject,
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
  /** WEB-059: the signed-in person; their own proposal cannot be decided by them. */
  myProfileId?: string | null;
  pinSlot?: React.ReactNode;
  /** WEB-047: possible existing matches for a NEW customer; Create waits for "It's a different store". */
  duplicates?: Candidate[];
  duplicatesAcknowledged?: boolean;
  onAcknowledgeDuplicates?: (v: boolean) => void;
  units?: { id: string; name: string }[];
  unitId?: string;
  onUnit?: (id: string) => void;
  onSave?: () => void;
  onApprove?: () => void;
  /** Field "Add customer" waiting for approval: reject with a reason (approvers). */
  onReject?: (reason: string) => void;
  deactivating?: boolean;
  reason?: string;
  onReason?: (v: string) => void;
  onDeactivateStart?: () => void;
  onDeactivateCancel?: () => void;
  onDeactivate?: () => void;
}) {
  const canReject =
    !!customer &&
    canApprove &&
    !!onReject &&
    customer.status !== "inactive" &&
    customer.enrolmentStatus === "provisional";
  const ownProposal =
    !!customer &&
    !!myProfileId &&
    customer.proposedByProfileId === myProfileId;
  const ownNote = ownProposal ? (
    <span className="text-xs text-muted">
      {OWN_PROPOSAL_WORDS}
    </span>
  ) : null;
  const dupBlocked =
    !customer && duplicates.length > 0 && !duplicatesAcknowledged;
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
          {customer.status === "active" &&
          customer.enrolmentStatus === "provisional" ? (
            <span className="text-muted">
              Provisional code · awaiting approval
            </span>
          ) : null}
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
        <p
          role="status"
          className={`rounded-lg border px-3 py-2 text-[13px] ${tone}`}
        >
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
      {!customer && canEdit && duplicates.length ? (
        <DuplicatePanel
          candidates={duplicates}
          acknowledged={duplicatesAcknowledged}
          onAcknowledge={(v) => onAcknowledgeDuplicates?.(v)}
        />
      ) : null}
      {canEdit && customer?.status !== "inactive" ? (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-border bg-surface py-3">
          <button
            type="submit"
            className={primaryClass}
            disabled={busy || dupBlocked}
          >
            Save
          </button>
          {dupBlocked ? (
            <span className="text-xs text-muted">
              Check the possible matches first.
            </span>
          ) : null}
          {(customer ? awaitsApproval(customer) : false) && canApprove ? (
            <button
              type="button"
              className={buttonClass}
              disabled={busy || ownProposal}
              onClick={onApprove}
            >
              Approve
            </button>
          ) : null}
          {canReject ? (
            <RejectControl
              busy={busy || ownProposal}
              onReject={(r) => onReject?.(r)}
            />
          ) : null}
          {(customer ? awaitsApproval(customer) : false) && canApprove
            ? ownNote
            : null}
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
      ) : (customer ? awaitsApproval(customer) : false) && canApprove ? (
        <div className="flex gap-2">
          <button
            type="button"
            className={primaryClass}
            disabled={busy || ownProposal}
            onClick={onApprove}
          >
            Approve
          </button>
          {canReject ? (
            <RejectControl
              busy={busy || ownProposal}
              onReject={(r) => onReject?.(r)}
            />
          ) : null}
          {ownNote}
        </div>
      ) : null}
    </form>
  );
}

export const OWN_PROPOSAL_WORDS =
  "Another approver must decide your own proposal.";

/** Reject a field capture: asks for the reason first (it goes to the enrolment record). */
function RejectControl({
  busy,
  onReject,
}: {
  busy: boolean;
  onReject: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  if (!open)
    return (
      <button
        type="button"
        className={`${buttonClass} text-[#b4101f]`}
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        Reject
      </button>
    );
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input
        aria-label="Reason for rejecting"
        className={`${inputClass} w-56 border-border`}
        placeholder="Reason (e.g. duplicate store)"
        value={why}
        onChange={(e) => setWhy(e.target.value)}
      />
      <button
        type="button"
        className={buttonClass}
        disabled={busy || !why.trim()}
        onClick={() => onReject(why)}
      >
        Confirm reject
      </button>
      <button
        type="button"
        className={buttonClass}
        onClick={() => setOpen(false)}
      >
        Cancel
      </button>
    </span>
  );
}

/** Body of the shared duplicate check (same endpoint and fields as the field app). */
export function duplicateQuery(
  name: string,
  phone: string,
  latitude: number | null,
  longitude: number | null,
  /** SP-0175: near-miss names only warn in the same barangay / municipality. */
  place: { municipality?: string | null; barangay?: string | null } = {},
) {
  return {
    name,
    phone: phone || null,
    latitude,
    longitude,
    placeId: null,
    ...(place.municipality ? { municipality: place.municipality } : {}),
    ...(place.barangay ? { barangay: place.barangay } : {}),
  };
}
