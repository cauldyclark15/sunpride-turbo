"use client";

import { useState } from "react";
import { CUSTOMER_NAME_FIELDS, FIELDS } from "@sunpride/customer-master";
import { useApi } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { useCustomerReference } from "./customer-editor";
import type { EnrollmentField } from "@sunpride/customer-master";

export type SharedCustomerDraft = {
  id: string;
  addedByName: string;
  updatedAt: number;
  status: "draft";
  canApprove: false;
  profile: {
    form?: Record<string, string>;
    details?: Record<string, string>;
    customFields?: Record<string, string>;
    sameAsCustomer?: boolean;
    shipToParty?: string;
    shipToAddress?: string;
    shipToMobileNo?: string;
    shipToEmail?: string;
    photoPresent?: boolean;
    fix?: { latitude?: number; longitude?: number };
  };
};

/** Read-only on purpose: a shared draft is not a customer awaiting approval. */
export function CustomerDraftRows({
  rows,
  fields = [],
}: {
  rows: SharedCustomerDraft[];
  fields?: EnrollmentField[];
}) {
  if (!rows.length) return <p>No customer drafts have been shared yet.</p>;
  return (
    <div className="grid gap-3">
      {rows.map((r) => {
        const p = r.profile;
        const values = { ...p.form, ...p.details };
        const name =
          values.registeredName ||
          [values.firstName, values.middleName, values.lastName]
            .filter(Boolean)
            .join(" ") ||
          values.customerName ||
          "Unnamed customer";
        const specs = [
          ...CUSTOMER_NAME_FIELDS,
          ...FIELDS.filter((f) => f.key !== "coordinates" && !f.shipTo),
        ];
        return (
          <details
            key={r.id}
            className="rounded-xl border border-border p-4"
            data-testid="customer-office-draft"
          >
            <summary className="cursor-pointer">
              <span className="font-semibold">{name}</span> · Draft — not for
              approval
              <span className="block text-[13px] text-muted">
                {r.addedByName} · Last shared{" "}
                {formatDateTime(r.updatedAt)}
              </span>
            </summary>
            <p className="my-3 text-[13px] text-muted">
              The salesman must finish this on the phone and tap Submit for
              approval. No customer code has been assigned.
            </p>
            <dl className="grid gap-2 text-[13px] sm:grid-cols-2">
              {specs
                .filter((f) => values[f.key])
                .map((f) => (
                  <div key={f.key}>
                    <dt className="text-muted">{f.label}</dt>
                    <dd className="break-words whitespace-pre-wrap">
                      {values[f.key]}
                    </dd>
                  </div>
                ))}
              {fields
                .filter((f) => p.customFields?.[f.key])
                .map((f) => (
                  <div key={f.key}>
                    <dt className="text-muted">{f.label}</dt>
                    <dd className="break-words whitespace-pre-wrap">
                      {p.customFields![f.key]}
                    </dd>
                  </div>
                ))}
              <div>
                <dt className="text-muted">Storefront photo</dt>
                <dd>
                  {p.photoPresent
                    ? "Kept on phone until submission"
                    : "Not taken yet"}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Location</dt>
                <dd>
                  {p.fix
                    ? `${p.fix.latitude ?? "—"}, ${p.fix.longitude ?? "—"}`
                    : "Not set yet"}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Ship-to</dt>
                <dd>
                  {p.sameAsCustomer !== false
                    ? "Same as customer"
                    : [
                        p.shipToParty,
                        p.shipToAddress,
                        p.form?.contactPerson,
                        p.shipToMobileNo,
                        p.shipToEmail,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Not filled yet"}
                </dd>
              </div>
            </dl>
          </details>
        );
      })}
    </div>
  );
}

export function CustomerDraftList() {
  const [page, setPage] = useState(0);
  const { enrollmentFields } = useCustomerReference();
  const result = useApi<{ rows: SharedCustomerDraft[]; hasMore: boolean }>(
    ["masters", "customer-drafts", page],
    `/api/v1/customers/drafts?offset=${page * 50}`,
  );
  return (
    <section className="grid gap-4" aria-label="Customer drafts">
      <p>
        Incomplete customers saved by the salesmen. Drafts appear here after the
        phone syncs; they are not available for approval.
      </p>
      {result.error ? (
        <p role="alert">{result.error.message}</p>
      ) : result.data ? (
        <CustomerDraftRows rows={result.data.rows} fields={enrollmentFields} />
      ) : (
        <p>Loading drafts…</p>
      )}
      <div className="flex gap-3">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!result.data?.hasMore}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
      </div>
    </section>
  );
}
