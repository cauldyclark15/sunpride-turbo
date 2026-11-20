"use client";
import { useState } from "react";
import {
  ENROLLMENT_KINDS,
  type EnrollmentField,
} from "@sunpride/customer-master";
import { apiFetch, mutate, useApi } from "../lib/api";
import { usePermissions } from "../lib/auth";
import { useCustomerReference } from "./customers/customer-editor";
import { buttonClass, primaryClass } from "./customers/customer-form";

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
export function EnrollmentFormAdmin() {
  const { can } = usePermissions();
  const form = useApi<EnrollmentForm>(
    can("admin.manage") ? ["customers", "enrollment-form"] : null,
    "/api/v1/customers/enrollment-form",
  );
  if (!can("admin.manage"))
    return <p>Only administrators can change the enrollment form.</p>;
  if (!form.data)
    return <p>{form.error?.message ?? "Loading enrollment form…"}</p>;
  return <FormEditor key={form.data.revision} initial={form.data} />;
}
function FormEditor({ initial }: { initial: EnrollmentForm }) {
  const { index } = useCustomerReference();
  const [fields, setFields] = useState(initial.fields);
  const [revision, setRevision] = useState(initial.revision);
  const [drag, setDrag] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  function change(i: number, next: EnrollmentField) {
    setFields(fields.map((f, n) => (n === i ? next : f)));
    setMessage("");
  }
  async function save() {
    setBusy(true);
    setMessage("");
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
      setMessage(
        "Enrollment form saved. On the Field app, sync once to download the changes.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save the form.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-4">
      <div>
        <h2>Enrollment form</h2>
        <p>
          Add information the office needs about each customer. The original
          customer and address fields stay unchanged.
        </p>
        <p>
          Fields are optional unless the customer matches any selected channel
          or type. Drag to reorder, or use Move up and Move down. Existing types
          and choices stay available to protect saved answers.
        </p>
      </div>
      <button
        type="button"
        className={buttonClass}
        disabled={busy || fields.length >= 30}
        onClick={() =>
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
          ])
        }
      >
        Add field
      </button>
      {fields.map((f, i) => (
        <fieldset
          key={f.key}
          disabled={busy}
          className="grid gap-3 rounded-xl border border-border p-4"
          draggable
          onDragStart={() => setDrag(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (drag !== null) setFields(reorderEnrollment(fields, drag, i));
            setDrag(null);
          }}
        >
          <legend>Field {i + 1}</legend>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={i === 0}
              onClick={() => setFields(reorderEnrollment(fields, i, i - 1))}
            >
              Move up
            </button>
            <button
              type="button"
              disabled={i === fields.length - 1}
              onClick={() => setFields(reorderEnrollment(fields, i, i + 1))}
            >
              Move down
            </button>
          </div>
          <label>
            Field name
            <input
              value={f.label}
              maxLength={100}
              onChange={(e) => change(i, { ...f, label: e.target.value })}
            />
          </label>
          <label>
            Field type
            <select
              value={f.kind}
              disabled={initial.fields.some((o) => o.key === f.key)}
              onChange={(e) =>
                change(i, {
                  ...f,
                  kind: e.target.value,
                  choices: e.target.value === "choice" ? ["First choice"] : [],
                })
              }
            >
              {ENROLLMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {
                    (
                      {
                        text: "Text",
                        number: "Number",
                        date: "Date",
                        choice: "Choice list",
                        boolean: "Yes / No",
                        photo: "Photo",
                      } as Record<string, string>
                    )[k]
                  }
                </option>
              ))}
            </select>
          </label>
          {f.kind === "choice" ? (
            <label>
              Choices (one per line)
              <textarea
                value={f.choices.join("\n")}
                onChange={(e) =>
                  change(i, { ...f, choices: e.target.value.split("\n") })
                }
              />
            </label>
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
            <fieldset key={key}>
              <legend>{label}</legend>
              {index
                .all(list)
                .filter(
                  (r, n, all) => all.findIndex((x) => x.code === r.code) === n,
                )
                .map((r) => (
                  <label key={r.code} className="mr-4 inline-flex gap-2">
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
            </fieldset>
          ))}
          {!initial.fields.some((o) => o.key === f.key) ? (
            <button
              type="button"
              onClick={() => setFields(fields.filter((_, n) => n !== i))}
            >
              Remove unsaved field
            </button>
          ) : null}
        </fieldset>
      ))}
      <button
        type="button"
        className={primaryClass}
        disabled={busy}
        onClick={save}
      >
        {busy ? "Saving…" : "Save enrollment form"}
      </button>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
