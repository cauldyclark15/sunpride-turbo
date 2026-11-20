"use client";

import {
  enrollmentRequired,
  ENROLLMENT_PHOTO_MAX,
  type EnrollmentField,
} from "@sunpride/customer-master";
import { useState } from "react";

export function EnrollmentFields({
  fields,
  values,
  customer,
  onChange,
  readOnly = false,
  errors = {},
}: {
  fields: EnrollmentField[];
  values: Record<string, string>;
  customer: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  readOnly?: boolean;
  errors?: Record<string, string>;
}) {
  const [problem, setProblem] = useState("");
  if (!fields.length) return null;
  return (
    <fieldset className="grid gap-4 rounded-xl border border-border p-4">
      <legend>Additional information</legend>
      {fields.map((f) => {
        const value = values[f.key] ?? "";
        const required = enrollmentRequired(f, customer);
        const set = (v: string) => onChange({ ...values, [f.key]: v });
        return (
          <div key={f.key} className="grid gap-1">
            <label htmlFor={`enrollment-${f.key}`}>
              {f.label}
              {required ? " *" : " (optional)"}
            </label>
            {f.kind === "choice" || f.kind === "boolean" ? (
              <select
                id={`enrollment-${f.key}`}
                value={value}
                disabled={readOnly}
                required={required}
                onChange={(e) => set(e.target.value)}
                aria-invalid={Boolean(errors[`customFields.${f.key}`])}
              >
                <option value="">Choose…</option>
                {(f.kind === "boolean" ? ["true", "false"] : f.choices).map(
                  (v) => (
                    <option key={v} value={v}>
                      {f.kind === "boolean" ? (v === "true" ? "Yes" : "No") : v}
                    </option>
                  ),
                )}
              </select>
            ) : f.kind === "photo" ? (
              <>
                {!readOnly ? (
                  <input
                    id={`enrollment-${f.key}`}
                    type="file"
                    accept="image/jpeg"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (
                        file.type !== "image/jpeg" ||
                        file.size > ENROLLMENT_PHOTO_MAX
                      ) {
                        setProblem(
                          `${f.label}: choose a JPEG photo no larger than 100 KB.`,
                        );
                        return;
                      }
                      const reader = new FileReader();
                      reader.onload = () => {
                        set(String(reader.result));
                        setProblem("");
                      };
                      reader.onerror = () =>
                        setProblem("Could not read the photo.");
                      reader.readAsDataURL(file);
                    }}
                  />
                ) : null}
                {value ? (
                  <>
                    <a href={value} target="_blank" rel="noreferrer">
                      View {f.label}
                    </a>
                    {!readOnly ? (
                      <button type="button" onClick={() => set("")}>
                        Clear photo
                      </button>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : (
              <input
                id={`enrollment-${f.key}`}
                type={
                  f.kind === "number"
                    ? "number"
                    : f.kind === "date"
                      ? "date"
                      : "text"
                }
                step={f.kind === "number" ? "any" : undefined}
                value={value}
                required={required}
                disabled={readOnly}
                maxLength={500}
                aria-invalid={Boolean(errors[`customFields.${f.key}`])}
                onChange={(e) => set(e.target.value)}
              />
            )}
            {errors[`customFields.${f.key}`] ? (
              <p role="alert">{errors[`customFields.${f.key}`]}</p>
            ) : null}
          </div>
        );
      })}
      {problem ? <p role="alert">{problem}</p> : null}
    </fieldset>
  );
}
