"use client";
import { useState } from "react";
import {
  ENROLLMENT_KINDS,
  type EnrollmentField,
} from "@sunpride/customer-master";
import { Card, FormField, WorkspaceIcon } from "@sunpride/ui";
import { apiFetch, mutate, useApi } from "../lib/api";
import { usePermissions } from "../lib/auth";
import { useCustomerReference } from "./customers/customer-editor";
import { buttonClass, primaryClass } from "./customers/customer-form";

const KIND_LABEL: Record<string, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  choice: "Choice list",
  boolean: "Yes / No",
  photo: "Photo",
};
export type EnrollmentForm = { revision: number; fields: EnrollmentField[] };
export function reorderEnrollment(
  fields: EnrollmentField[],
  from: number,
  to: number,
) {
  const copy = [...fields];
  const [field] = copy.splice(from, 1);
  if (field) copy.splice(to, 0, field);
  return copy;
}
export const ENROLLMENT_SAVED =
  "Enrollment form saved. On the Field app, sync once to download the changes.";
export function EnrollmentFormAdmin() {
  const { can } = usePermissions();
  // SP-0229: the saved message lives here, so the editor reloading with the new revision keeps it.
  const [notice, setNotice] = useState("");
  const form = useApi<EnrollmentForm>(
    can("admin.manage") ? ["customers", "enrollment-form"] : null,
    "/api/v1/customers/enrollment-form",
  );
  if (!can("admin.manage"))
    return <p>Only administrators can change the enrollment form.</p>;
  if (!form.data)
    return <p>{form.error?.message ?? "Loading enrollment form…"}</p>;
  return (
    <FormEditor
      key={form.data.revision}
      initial={form.data}
      notice={notice}
      onSaved={setNotice}
    />
  );
}
export function FormEditor({
  initial,
  notice = "",
  onSaved = () => {},
}: {
  initial: EnrollmentForm;
  notice?: string;
  onSaved?: (message: string) => void;
}) {
  const { index } = useCustomerReference();
  const [fields, setFields] = useState(initial.fields);
  const [revision, setRevision] = useState(initial.revision);
  const [drag, setDrag] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  function change(i: number, next: EnrollmentField) {
    setFields(fields.map((f, n) => (n === i ? next : f)));
    setMessage("");
    onSaved("");
  }
  async function save() {
    setBusy(true);
    setMessage("");
    onSaved("");
    try {
      await mutate<EnrollmentForm>(
        "/api/v1/customers/enrollment-form",
        { revision, fields },
        { method: "PUT", invalidate: [["customers"], ["masters"]] },
      );
      const saved = await apiFetch<EnrollmentForm>(
        "/api/v1/customers/enrollment-form",
      );
      setFields(saved.fields);
      setRevision(saved.revision);
      onSaved(ENROLLMENT_SAVED);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save the form.");
    } finally {
      setBusy(false);
    }
  }
  const addField = () => {
    setFields([
      ...fields,
      {
        key: `cf_${crypto.randomUUID().replaceAll("-", "")}`,
        label: "",
        kind: "text",
        choices: [],
        requiredChannels: [],
        requiredTypes: [],
      },
    ]);
    onSaved("");
  };
  return (
    <Card
      label="Enrollment form"
      count={fields.length}
      icon={<WorkspaceIcon name="field" />}
      actions={
        <button
          type="button"
          className={buttonClass}
          disabled={busy || fields.length >= 30}
          onClick={addField}
        >
          Add field
        </button>
      }
    >
      <div className="grid min-w-0 gap-4">
        <div className="grid gap-1 text-sm text-muted">
          <p>
            Add information the office needs about each customer. The original
            customer and address fields stay unchanged.
          </p>
          <p>
            Fields are optional unless the customer matches any selected channel
            or type. Drag to reorder, or use Move up and Move down. Existing
            types and choices stay available to protect saved answers.
          </p>
        </div>
        {fields.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">
            No additional fields yet. Use Add field to ask for more.
          </p>
        ) : null}
        {fields.map((f, i) => (
          <fieldset
            key={f.key}
            aria-label={`Field ${i + 1}`}
            disabled={busy}
            className="grid min-w-0 gap-3 rounded-xl border border-border bg-surface p-4"
            draggable
            onDragStart={() => setDrag(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (drag !== null) setFields(reorderEnrollment(fields, drag, i));
              setDrag(null);
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[13px] font-semibold text-foreground">
                Field {i + 1}
                {f.label ? ` · ${f.label}` : ""}
              </h3>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={i === 0}
                  onClick={() => setFields(reorderEnrollment(fields, i, i - 1))}
                >
                  Move up
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={i === fields.length - 1}
                  onClick={() => setFields(reorderEnrollment(fields, i, i + 1))}
                >
                  Move down
                </button>
                {!initial.fields.some((o) => o.key === f.key) ? (
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => setFields(fields.filter((_, n) => n !== i))}
                  >
                    Remove unsaved field
                  </button>
                ) : null}
              </div>
            </div>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <FormField label="Field name">
                <input
                  value={f.label}
                  maxLength={100}
                  onChange={(e) => change(i, { ...f, label: e.target.value })}
                />
              </FormField>
              <FormField
                label="Field type"
                hint={
                  initial.fields.some((o) => o.key === f.key)
                    ? "A saved field keeps its type."
                    : undefined
                }
              >
                <select
                  value={f.kind}
                  disabled={initial.fields.some((o) => o.key === f.key)}
                  onChange={(e) =>
                    change(i, {
                      ...f,
                      kind: e.target.value,
                      choices:
                        e.target.value === "choice" ? ["First choice"] : [],
                    })
                  }
                >
                  {ENROLLMENT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k] ?? k}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
            {f.kind === "choice" ? (
              <FormField label="Choices" hint="One choice per line.">
                <textarea
                  value={f.choices.join("\n")}
                  onChange={(e) =>
                    change(i, { ...f, choices: e.target.value.split("\n") })
                  }
                />
              </FormField>
            ) : null}
            {(
              [
                [
                  "distribution_channel",
                  "requiredChannels",
                  "Required for channels",
                ],
                [
                  "type_of_business",
                  "requiredTypes",
                  "Required for customer types",
                ],
              ] as const
            ).map(([list, key, label]) => (
              <fieldset key={key} className="grid gap-2">
                <legend className="text-[13px] font-medium text-foreground">
                  {label}
                </legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {index
                    .all(list)
                    .filter(
                      (r, n, all) =>
                        all.findIndex((x) => x.code === r.code) === n,
                    )
                    .map((r) => (
                      <label
                        key={r.code}
                        className="inline-flex items-center gap-2"
                      >
                        <input
                          type="checkbox"
                          checked={f[key].includes(r.code)}
                          onChange={(e) =>
                            change(i, {
                              ...f,
                              [key]: e.target.checked
                                ? [...f[key], r.code]
                                : f[key].filter((v) => v !== r.code),
                            })
                          }
                        />
                        {r.name}
                      </label>
                    ))}
                </div>
              </fieldset>
            ))}
          </fieldset>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={primaryClass}
            disabled={busy}
            onClick={save}
          >
            {busy ? "Saving…" : "Save enrollment form"}
          </button>
          {notice ? (
            <p role="status" className="text-sm text-success">
              {notice}
            </p>
          ) : null}
          {message ? (
            <p role="alert" className="text-sm text-danger">
              {message}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
