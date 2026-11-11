"use client";

/**
 * SP-0170 Customer form: the client's "Customer Information template" — same sections, same
 * field order, same labels. Dropdowns show "Description (Code)". Pure view: the editor
 * (customer-editor.tsx) owns loading, saving and approval.
 */
import type { ReactNode } from "react";
import {
  FIELDS,
  SECTIONS,
  SHIP_TO_FIELDS,
  addShipTo,
  applies,
  optionLabel,
  optionsFor,
  removeShipTo,
  requiredMarks,
  resolvedShipTo,
  sectionFields,
  setField,
  setShipTo,
  type Draft,
  type FieldErrors,
  type FieldSpec,
  type GeoOption,
  type ReferenceIndex,
  type ShipTo,
} from "./model";

export type GeoLists = {
  regions: GeoOption[];
  provinces: GeoOption[];
  municipalities: GeoOption[];
  barangays: GeoOption[];
  postalCodes: GeoOption[];
};

export const inputClass =
  "w-full rounded-lg border bg-surface px-3 py-2 text-sm disabled:bg-default-soft disabled:text-muted";
export const buttonClass =
  "inline-flex h-9 items-center justify-center rounded-lg border border-border bg-surface px-3 text-[13px] font-medium text-foreground hover:bg-default-soft disabled:opacity-50";
export const primaryClass =
  "inline-flex h-9 items-center justify-center rounded-lg border border-foreground bg-foreground px-3 text-[13px] font-medium text-background hover:opacity-90 disabled:opacity-50";

const GEO_LIST: Record<string, keyof GeoLists> = {
  regionCode: "regions",
  provinceCode: "provinces",
  municipalityCode: "municipalities",
  barangayCode: "barangays",
  postalCode: "postalCodes",
};
const GEO_PARENT: Record<string, string> = {
  regionCode: "countryCode",
  provinceCode: "regionCode",
  municipalityCode: "provinceCode",
  barangayCode: "municipalityCode",
  postalCode: "municipalityCode",
};

const fieldId = (key: string) => `cm-${key.replace(/[^a-zA-Z0-9]/g, "-")}`;

function Label({
  htmlFor,
  label,
  required,
}: {
  htmlFor: string;
  label: string;
  required: boolean;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-[12px] font-medium text-foreground"
    >
      {label}
      {required ? (
        <span className="text-[#b4101f]" title="Required">
          {" *"}
        </span>
      ) : null}
    </label>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={`${id}-error`} role="alert" className="text-[12px] text-[#b4101f]">
      {message}
    </p>
  );
}

function Select({
  id,
  value,
  options,
  disabled,
  invalid,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  options: { code: string; label: string }[];
  disabled?: boolean;
  invalid?: boolean;
  placeholder: string;
  onChange: (code: string, label: string) => void;
}) {
  const known = options.some((o) => o.code === value);
  return (
    <select
      id={id}
      className={`${inputClass} ${invalid ? "border-[#b4101f]" : "border-border"}`}
      value={value}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${id}-error` : undefined}
      onChange={(e) =>
        onChange(
          e.target.value,
          options.find((o) => o.code === e.target.value)?.label ?? "",
        )
      }
    >
      <option value="">{placeholder}</option>
      {value && !known ? <option value={value}>{value}</option> : null}
      {options.map((o) => (
        <option key={o.code} value={o.code}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export type CustomerFormProps = {
  draft: Draft;
  onChange: (next: Draft) => void;
  index: ReferenceIndex;
  geo: GeoLists;
  errors?: FieldErrors;
  readOnly?: boolean;
  /** Show the Customer Code box (system key) — editable until SAP sync. */
  codeEditable?: boolean;
  /** Map + "suggest from address" for Geographical Coordinates. */
  pinSlot?: ReactNode;
};

/** The six sections of the client's sheet, in their order. */
export function CustomerForm({
  draft,
  onChange,
  index,
  geo,
  errors = {},
  readOnly = false,
  codeEditable = true,
  pinSlot,
}: CustomerFormProps) {
  const a = applies(index, draft);
  const marks = requiredMarks(index, draft);
  const set = (key: string, value: string, name?: string) =>
    onChange(setField(draft, key, value, name));

  function control(f: FieldSpec) {
    const id = fieldId(f.key);
    const value = draft.values[f.key] ?? "";
    const invalid = Boolean(errors[f.key]);
    if (f.kind === "list") {
      const list = f.list as string;
      const opts = optionsFor(index, list, draft).map((o) => ({
        code: o.code,
        label: optionLabel(o),
      }));
      let disabled = readOnly;
      let placeholder = "Choose…";
      if (
        f.key === "salesOfficeCode" ||
        f.key === "distributionChannelCode" ||
        f.key === "deliveringPlantCode"
      ) {
        if (!draft.values.salesOrgCode) {
          disabled = true;
          placeholder = "Choose Sales Organization first";
        }
      }
      if (f.key === "customerGroup1Code") {
        if (!draft.values.distributionChannelCode) {
          disabled = true;
          placeholder = "Choose Distribution Channel first";
        } else if (a.group1 === false) {
          disabled = true;
          placeholder = "None for this channel";
        }
      }
      if (f.key === "customerGroup2Code") {
        if (a.group1 === false || a.group2 === false) {
          disabled = true;
          placeholder = "None for this group";
        } else if (!draft.values.customerGroup1Code) {
          disabled = true;
          placeholder = "Choose Customer Grp 1 first";
        }
      }
      return (
        <Select
          id={id}
          value={value}
          options={opts}
          disabled={disabled}
          invalid={invalid}
          placeholder={placeholder}
          onChange={(code) => set(f.key, code)}
        />
      );
    }
    if (f.kind === "geo") {
      const parentKey = GEO_PARENT[f.key] as string;
      const parentChosen = Boolean(draft.values[parentKey]);
      const opts = (
        parentChosen ? geo[GEO_LIST[f.key] as keyof GeoLists] : []
      ).map((o) => ({
        code: o.code,
        label:
          f.key === "postalCode"
            ? o.name && o.name !== o.code
              ? `${o.code} (${o.name})`
              : o.code
            : o.name,
      }));
      const parentLabel =
        FIELDS.find((x) => x.key === parentKey)?.label ?? "the parent";
      return (
        <Select
          id={id}
          value={value}
          options={opts}
          disabled={readOnly || !parentChosen}
          invalid={invalid}
          placeholder={parentChosen ? "Choose…" : `Choose ${parentLabel} first`}
          onChange={(code, label) =>
            set(f.key, code, f.key === "postalCode" ? undefined : label)
          }
        />
      );
    }
    if (f.kind === "coordinates") {
      const latId = `${id}-lat`;
      return (
        <div className="grid gap-2">
          <div className="grid grid-cols-2 gap-2">
            <input
              id={latId}
              aria-label="Latitude"
              placeholder="Latitude"
              inputMode="decimal"
              className={`${inputClass} ${invalid ? "border-[#b4101f]" : "border-border"}`}
              value={draft.latitude}
              disabled={readOnly}
              aria-invalid={invalid || undefined}
              onChange={(e) => onChange({ ...draft, latitude: e.target.value })}
            />
            <input
              aria-label="Longitude"
              placeholder="Longitude"
              inputMode="decimal"
              className={`${inputClass} ${invalid ? "border-[#b4101f]" : "border-border"}`}
              value={draft.longitude}
              disabled={readOnly}
              onChange={(e) =>
                onChange({ ...draft, longitude: e.target.value })
              }
            />
          </div>
          {pinSlot}
        </div>
      );
    }
    const isAddress = f.key === "customerAddress";
    return (
      <input
        id={id}
        className={`${inputClass} ${invalid ? "border-[#b4101f]" : "border-border"}`}
        value={value}
        disabled={readOnly}
        maxLength={f.max ?? undefined}
        inputMode={
          f.kind === "money" || f.kind === "tin" || f.kind === "mobile"
            ? f.kind === "money"
              ? "decimal"
              : "tel"
            : undefined
        }
        type={f.kind === "email" ? "email" : "text"}
        placeholder={
          f.kind === "mobile"
            ? "09XXXXXXXXX"
            : f.kind === "tin"
              ? "###-###-###"
              : isAddress
                ? "Built from the location below"
                : undefined
        }
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(e) => set(f.key, e.target.value)}
      />
    );
  }

  function fieldBlock(f: FieldSpec) {
    const id = fieldId(f.key);
    return (
      <div
        key={f.key}
        className={`grid content-start gap-1 ${f.kind === "coordinates" || f.key === "customerAddress" ? "sm:col-span-2" : ""}`}
        data-field={f.key}
      >
        <Label
          htmlFor={f.kind === "coordinates" ? `${id}-lat` : id}
          label={f.label}
          required={Boolean(marks[f.key])}
        />
        {control(f)}
        {f.key === "customerAddress" && !readOnly ? (
          <p className="text-[12px] text-muted">
            {draft.addressCustom
              ? "Typed by hand. Clear it to build it from the location again."
              : "Built from the location parts. You can type over it."}
          </p>
        ) : null}
        <FieldError id={id} message={errors[f.key]} />
      </div>
    );
  }

  return (
    <div className="grid gap-5" data-testid="customer-form">
      <fieldset className="grid gap-1">
        <Label htmlFor="cm-code" label="Customer Code" required={false} />
        <input
          id="cm-code"
          className={`${inputClass} ${errors.code ? "border-[#b4101f]" : "border-border"} max-w-xs tabular-nums`}
          value={draft.code}
          disabled={readOnly || !codeEditable}
          placeholder="Numbered automatically"
          onChange={(e) => onChange({ ...draft, code: e.target.value })}
        />
        <FieldError id="cm-code" message={errors.code} />
      </fieldset>
      {SECTIONS.map((section) => {
        if (section === "ADP Specific" && !a.adp) return null;
        const fields = sectionFields(section);
        return (
          <fieldset
            key={section}
            className="grid gap-3 rounded-2xl border border-border p-4"
            data-section={section}
          >
            <legend className="px-1 text-[14px] font-semibold text-foreground">
              {section}
              {section === "ADP Specific" ? (
                <span className="ml-2 text-[12px] font-normal text-muted">
                  Distributive Trade (40) only
                </span>
              ) : null}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {fields.map(fieldBlock)}
            </div>
            {section === "Delivery Arrangement" ? (
              <ShipToList
                draft={draft}
                onChange={onChange}
                errors={errors}
                marks={marks}
                readOnly={readOnly}
              />
            ) : null}
          </fieldset>
        );
      })}
    </div>
  );
}

function ShipToList({
  draft,
  onChange,
  errors,
  marks,
  readOnly,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  errors: FieldErrors;
  marks: Record<string, boolean>;
  readOnly: boolean;
}) {
  const copied = new Set(["shipToParty", "shipToAddress", "mobileNo", "email"]);
  return (
    <div className="grid gap-3" data-testid="ship-to-list">
      {draft.shipTos.map((raw, i) => {
        const s = resolvedShipTo(draft, raw);
        return (
          <div
            key={raw.id ?? `new-${i}`}
            className="grid gap-3 rounded-xl border border-dashed border-border p-3"
            data-ship-to={i}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-foreground">
                Ship-to {i + 1}
              </span>
              <div className="flex items-center gap-3">
                <label className="inline-flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={raw.sameAsCustomer}
                    disabled={readOnly}
                    onChange={(e) =>
                      onChange(
                        setShipTo(draft, i, "sameAsCustomer", e.target.checked),
                      )
                    }
                  />
                  Same as customer
                </label>
                {!readOnly && draft.shipTos.length > 1 ? (
                  <button
                    type="button"
                    className={buttonClass}
                    aria-label={`Remove ship-to ${i + 1}`}
                    onClick={() => onChange(removeShipTo(draft, i))}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {SHIP_TO_FIELDS.map((f) => {
                const key = `shipTos[${i}].${f.key}`;
                const id = fieldId(key);
                const locked = raw.sameAsCustomer && copied.has(f.key);
                return (
                  <div key={f.key} className="grid content-start gap-1">
                    <Label
                      htmlFor={id}
                      label={f.label}
                      required={Boolean(marks[f.key])}
                    />
                    <input
                      id={id}
                      className={`${inputClass} ${errors[key] ? "border-[#b4101f]" : "border-border"}`}
                      value={String(s[f.key as keyof ShipTo] ?? "")}
                      disabled={readOnly || locked}
                      type={f.kind === "email" ? "email" : "text"}
                      aria-invalid={Boolean(errors[key]) || undefined}
                      onChange={(e) =>
                        onChange(
                          setShipTo(
                            draft,
                            i,
                            f.key as keyof ShipTo,
                            e.target.value,
                          ),
                        )
                      }
                    />
                    <FieldError id={id} message={errors[key]} />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {/* "Add at least one ship-to" comes back without an index. */}
      <FieldError id="cm-shipTos" message={errors.shipToParty} />
      {!readOnly ? (
        <div>
          <button
            type="button"
            className={buttonClass}
            onClick={() => onChange(addShipTo(draft))}
          >
            Add ship-to
          </button>
        </div>
      ) : null}
    </div>
  );
}
