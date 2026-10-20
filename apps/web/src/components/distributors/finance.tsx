"use client";
import type {
  Claim,
  Command,
  Finance,
  PartnerDocument,
  Workspace,
} from "./types";
import {
  ActionForm,
  Cell,
  Empty,
  Field,
  fieldClass,
  fileBase64,
  fileInput,
  manilaToday,
  MiniMetric,
  money,
  number,
  Panel,
  State,
  Table,
  usePartnerQuery,
  value,
  when,
  words,
} from "./kit";

export function Documents({
  workspace,
  command,
  office,
  canWrite,
}: {
  workspace: Workspace;
  command: Command;
  office: boolean;
  canWrite: boolean;
}) {
  const docs = usePartnerQuery<{
    rows: PartnerDocument[];
    receipts: { document_id: string; name: string; created_at: string }[];
  }>(workspace.distributor.id, "documents");
  return (
    <>
      <State query={docs}>
        {(d) => (
          <Panel
            title="Document centre"
            detail="Published circulars, agreements, price notices and statements. Read receipts are bound to the exact version, never carried over to a revision."
          >
            {d.rows.length ? (
              <Table headers={["Document", "Version", "Receipt", "Action"]}>
                {d.rows.map((doc) => (
                  <tr key={doc.id}>
                    <Cell>
                      {doc.title}
                      <p className="text-xs text-muted">
                        {words(doc.kind)} · {when(doc.created_at)}
                      </p>
                    </Cell>
                    <Cell>{doc.version}</Cell>
                    <Cell>
                      {doc.read ? "Read" : "Unread"}
                      {office ? (
                        <ul className="mt-1 text-xs text-muted">
                          {d.receipts
                            .filter((r) => r.document_id === doc.id)
                            .map((r, i) => (
                              <li key={i}>
                                {r.name} · {when(r.created_at)}
                              </li>
                            ))}
                        </ul>
                      ) : null}
                    </Cell>
                    <Cell>
                      <a
                        className="text-sm underline"
                        href={`/api/v1/distributors/documents/${doc.id}?distributorId=${workspace.distributor.id}`}
                      >
                        Download
                      </a>
                      {doc.published && canWrite ? (
                        <ActionForm
                          title="Read receipt"
                          submitLabel="I have read this version"
                          onSubmit={() =>
                            command("documents/read", {
                              documentId: doc.id,
                              sha256: doc.sha256,
                            })
                          }
                        >
                          <p className="text-xs text-muted">
                            Version {doc.version} of {doc.title}
                          </p>
                        </ActionForm>
                      ) : null}
                    </Cell>
                  </tr>
                ))}
              </Table>
            ) : (
              <Empty>No documents have been shared with you.</Empty>
            )}
          </Panel>
        )}
      </State>
      {canWrite ? (
        <ActionForm
          title={
            office
              ? "Publish or upload a document"
              : "Upload accreditation or evidence"
          }
          submitLabel="Upload document"
          detail="PDF, PNG or JPEG, up to 600 KB. To publish a revision, select the previous document and use the same title."
          onSubmit={async (f) => {
            const previous = workspace.documents.find(
              (d) => d.id === value(f, "previous"),
            );
            await command("documents", {
              kind: value(f, "kind"),
              title: value(f, "title"),
              version: previous ? previous.version + 1 : 1,
              supersedesId: previous?.id,
              base64: await fileBase64(fileInput(f)),
              published: f.get("published") === "on",
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Document title">
              <input name="title" required className={fieldClass} />
            </Field>
            <Field label="Document type">
              <select name="kind" className={fieldClass}>
                {[
                  "registration",
                  "tax",
                  "credit",
                  "claim",
                  "deposit",
                  ...(office
                    ? [
                        "agreement",
                        "circular",
                        "price_notice",
                        "scheme_notice",
                        "statement",
                      ]
                    : []),
                ].map((k) => (
                  <option key={k} value={k}>
                    {words(k)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Previous version (optional)">
              <select name="previous" className={fieldClass}>
                <option value="">New document</option>
                {workspace.documents.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title} · version {d.version}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="File">
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                name="file"
                required
                className={fieldClass}
              />
            </Field>
          </div>
          {office ? (
            <label className="text-sm">
              <input type="checkbox" name="published" /> Publish to this
              distributor's users
            </label>
          ) : null}
        </ActionForm>
      ) : null}
    </>
  );
}
export function Claims({
  workspace,
  command,
  office,
  canWrite,
}: {
  workspace: Workspace;
  command: Command;
  office: boolean;
  canWrite: boolean;
}) {
  const query = usePartnerQuery<{ rows: Claim[] }>(
      workspace.distributor.id,
      "claims",
    ),
    evidence = workspace.documents.filter((d) => d.kind === "claim");
  return (
    <>
      {canWrite ? (
        <ActionForm
          title="Submit a claim"
          submitLabel="Submit claim for review"
          detail="Upload claim evidence in Documents first. W4 covers intake and tracking; SAP settlement is handled through the shared claims process."
          onSubmit={(f) =>
            command("claims", {
              claimNumber: value(f, "reference"),
              kind: value(f, "kind"),
              from: value(f, "from"),
              to: value(f, "to"),
              amountCentavos: Math.round(number(f, "amount") * 100),
              reason: value(f, "reason"),
              evidenceIds: f.getAll("evidence").map(String),
              campaignReference: value(f, "campaign") || undefined,
            })
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Claim reference">
              <input name="reference" required className={fieldClass} />
            </Field>
            <Field label="Claim type">
              <select name="kind" className={fieldClass}>
                {workspace.policy.claimTypes.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {words(k.kind)} · {k.minimumEvidence} evidence required
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Period starts">
              <input
                type="date"
                name="from"
                required
                defaultValue={manilaToday()}
                className={fieldClass}
              />
            </Field>
            <Field label="Period ends">
              <input
                type="date"
                name="to"
                required
                defaultValue={manilaToday()}
                className={fieldClass}
              />
            </Field>
            <Field label="Claim amount (₱)">
              <input
                type="number"
                min="0.01"
                step="0.01"
                name="amount"
                required
                className={fieldClass}
              />
            </Field>
            <Field label="Scheme or campaign reference (optional)">
              <input name="campaign" className={fieldClass} />
            </Field>
          </div>
          <Field label="What happened?">
            <textarea
              name="reason"
              required
              maxLength={2000}
              className={fieldClass}
            />
          </Field>
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Claim evidence</legend>
            {evidence.length ? (
              evidence.map((d) => (
                <label className="text-sm" key={d.id}>
                  <input type="checkbox" name="evidence" value={d.id} />{" "}
                  {d.title} · version {d.version}
                </label>
              ))
            ) : (
              <p className="text-sm text-muted">
                No claim evidence yet. Upload a claim document first.
              </p>
            )}
          </fieldset>
        </ActionForm>
      ) : null}
      <State query={query}>
        {(q) => (
          <Panel title="Claim status and settlement">
            {q.rows.length ? (
              <Table
                headers={[
                  "Reference",
                  "Type / reason",
                  "Amount",
                  "Status",
                  "Settlement",
                ]}
              >
                {q.rows.map((c) => (
                  <tr key={c.id}>
                    <Cell>{c.claim_number}</Cell>
                    <Cell>
                      {words(c.kind)}
                      <p className="mt-1 text-xs text-muted">{c.reason}</p>
                    </Cell>
                    <Cell>{money(c.amount_centavos)}</Cell>
                    <Cell>
                      {words(c.status)}
                      {office && canWrite ? (
                        <ActionForm
                          title="Intake review"
                          submitLabel="Save decision"
                          onSubmit={(f) =>
                            command("claims/review", {
                              claimId: c.id,
                              status: value(f, "status"),
                              reason: value(f, "reason"),
                            })
                          }
                        >
                          <Field label="Decision">
                            <select name="status" className={fieldClass}>
                              <option value="under_review">Under review</option>
                              <option value="evidence_requested">
                                More evidence required
                              </option>
                              <option value="rejected">Rejected</option>
                            </select>
                          </Field>
                          <Field label="Review reason">
                            <input
                              name="reason"
                              required
                              className={fieldClass}
                            />
                          </Field>
                        </ActionForm>
                      ) : null}
                    </Cell>
                    <Cell>
                      {c.settlement_reference
                        ? `${c.settlement_reference} · ${money(c.settled_centavos)}`
                        : "Not settled"}
                    </Cell>
                  </tr>
                ))}
              </Table>
            ) : (
              <Empty>No claims submitted.</Empty>
            )}
          </Panel>
        )}
      </State>
    </>
  );
}
export function Money({
  workspace,
  command,
  office,
  canWrite,
}: {
  workspace: Workspace;
  command: Command;
  office: boolean;
  canWrite: boolean;
}) {
  const query = usePartnerQuery<Finance>(workspace.distributor.id, "finance"),
    deposits = workspace.documents.filter((d) => d.kind === "deposit");
  return (
    <>
      <State query={query}>
        {(f) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <MiniMetric
                label="Credit limit"
                value={money(f.credit.limitCentavos)}
                note={`${f.credit.authority ?? "SAP"} · ${words(f.credit.status)}`}
              />
              <MiniMetric
                label="Exposure"
                value={money(f.credit.exposureCentavos)}
                note={`Checked ${when(f.credit.checkedAt)}`}
              />
              <MiniMetric
                label="Open statement items"
                value={money(
                  f.items.reduce((n, i) => n + Number(i.balance_centavos), 0),
                )}
                note="Replica only. Remittance advice never clears an invoice here."
              />
            </div>
            <Panel
              title="Statement of account"
              detail="SAP open items and due dates are visible to both parties. A pending remittance is not an applied bank receipt."
            >
              {f.items.length ? (
                <Table headers={["Invoice", "Due date", "Balance", "Source"]}>
                  {f.items.map((i) => (
                    <tr key={i.id}>
                      <Cell>{i.invoice_number}</Cell>
                      <Cell>{when(i.due_date)}</Cell>
                      <Cell>{money(i.balance_centavos)}</Cell>
                      <Cell>
                        {i.source === "sample" ? "Mock SAP" : "SAP"} · version{" "}
                        {i.version}
                      </Cell>
                    </tr>
                  ))}
                </Table>
              ) : (
                <Empty>
                  No statement items received. This is unknown, not a certified
                  zero AR balance.
                </Empty>
              )}
            </Panel>
            <Panel title="Remittance and matching queue">
              {f.remittances.length ? (
                <Table
                  headers={[
                    "Bank reference",
                    "Deposit",
                    "Status",
                    "Next action",
                  ]}
                >
                  {f.remittances.map((r) => (
                    <tr key={r.id}>
                      <Cell>
                        {r.deposit_reference}
                        <p className="text-xs text-muted">
                          {when(r.deposit_date)}
                        </p>
                      </Cell>
                      <Cell>{money(r.amount_centavos)}</Cell>
                      <Cell>
                        {words(r.status)}
                        {r.dispute ? (
                          <p className="text-xs">{r.dispute}</p>
                        ) : null}
                      </Cell>
                      <Cell>
                        {office &&
                        canWrite &&
                        ["submitted", "matched"].includes(r.status) ? (
                          <ActionForm
                            title="Match to a SAP open item"
                            submitLabel="Record allocation"
                            onSubmit={(data) =>
                              command("remittances/match", {
                                remittanceId: r.id,
                                allocations: [
                                  {
                                    itemId: value(data, "item"),
                                    amountCentavos: Math.round(
                                      number(data, "amount") * 100,
                                    ),
                                  },
                                ],
                              })
                            }
                          >
                            <Field label="Statement invoice">
                              <select name="item" className={fieldClass}>
                                {f.items.map((i) => (
                                  <option key={i.id} value={i.id}>
                                    {i.invoice_number} ·{" "}
                                    {money(i.balance_centavos)}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Field label="Allocation amount (₱)">
                              <input
                                type="number"
                                name="amount"
                                min="0.01"
                                step="0.01"
                                required
                                className={fieldClass}
                              />
                            </Field>
                          </ActionForm>
                        ) : null}
                        {canWrite &&
                        ["submitted", "matched"].includes(r.status) ? (
                          <ActionForm
                            title="Flag a dispute"
                            submitLabel="Send for reconciliation"
                            onSubmit={(data) =>
                              command("remittances/dispute", {
                                remittanceId: r.id,
                                reason: value(data, "reason"),
                              })
                            }
                          >
                            <Field label="Dispute reason">
                              <input
                                name="reason"
                                required
                                className={fieldClass}
                              />
                            </Field>
                          </ActionForm>
                        ) : (
                          <p className="text-xs text-muted">
                            {r.status === "acknowledged"
                              ? "SAP acknowledged; await refreshed statement"
                              : "Finance follow-up"}
                          </p>
                        )}
                      </Cell>
                    </tr>
                  ))}
                </Table>
              ) : (
                <Empty>No remittance advices yet.</Empty>
              )}
            </Panel>
          </>
        )}
      </State>
      {canWrite ? (
        <ActionForm
          title="Submit remittance advice"
          submitLabel="Submit deposit advice"
          detail="Upload deposit evidence in Documents first. This records advice, not a receipt or SAP posting."
          onSubmit={(f) =>
            command("remittances", {
              depositReference: value(f, "reference"),
              depositDate: value(f, "date"),
              amountCentavos: Math.round(number(f, "amount") * 100),
              evidenceId: value(f, "evidence"),
            })
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Bank deposit reference">
              <input name="reference" required className={fieldClass} />
            </Field>
            <Field label="Deposit date">
              <input
                type="date"
                name="date"
                defaultValue={manilaToday()}
                required
                className={fieldClass}
              />
            </Field>
            <Field label="Amount deposited (₱)">
              <input
                type="number"
                name="amount"
                min="0.01"
                step="0.01"
                required
                className={fieldClass}
              />
            </Field>
            <Field label="Deposit evidence">
              <select name="evidence" required className={fieldClass}>
                <option value="">Choose uploaded evidence</option>
                {deposits.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </ActionForm>
      ) : null}
    </>
  );
}
export function Accreditation({
  workspace,
  command,
  office,
  canWrite,
}: {
  workspace: Workspace;
  command: Command;
  office: boolean;
  canWrite: boolean;
}) {
  const application = workspace.application,
    agreement = workspace.documents
      .filter((d) => d.kind === "agreement" && d.published)
      .sort((a, b) => b.version - a.version)[0];
  return (
    <>
      <Panel
        title="Accreditation progress"
        detail="Application → document validation → SAP credit assessment → exact agreement acceptance → SAP customer-code request."
      >
        <p className="text-lg font-medium">
          {application
            ? words(application.stage)
            : words(workspace.distributor.status)}
        </p>
        <p className="text-sm text-muted">
          Required documents:{" "}
          {workspace.policy.requiredDocuments.map(words).join(", ")}. Upload
          them in Documents.
        </p>
        <p className="text-sm">
          SAP customer code:{" "}
          {workspace.distributor.sapCustomerCode ?? "Not yet allocated"}
        </p>
      </Panel>
      {!application &&
      workspace.distributor.status === "applicant" &&
      canWrite ? (
        <ActionForm
          title="Distributor application"
          submitLabel="Submit for accreditation"
          onSubmit={(f) =>
            command("apply", {
              legalName: value(f, "name"),
              taxReference: value(f, "tax"),
              contact: value(f, "contact"),
            })
          }
        >
          <Field label="Registered legal name">
            <input name="name" required className={fieldClass} />
          </Field>
          <Field label="Tax registration reference">
            <input name="tax" required className={fieldClass} />
          </Field>
          <Field label="Primary contact">
            <input name="contact" required className={fieldClass} />
          </Field>
        </ActionForm>
      ) : null}
      {application && office && canWrite ? (
        <ActionForm
          title="Channel Development review"
          submitLabel="Record next review step"
          onSubmit={(f) =>
            command("application/review", {
              action: value(f, "action"),
              reason: value(f, "reason"),
            })
          }
        >
          <Field label="Review action">
            <select name="action" className={fieldClass}>
              <option value="validate">Validate required documents</option>
              <option value="assess_credit">Assess SAP credit</option>
              <option value="request_code">Request SAP customer code</option>
              <option value="reject">Reject application</option>
            </select>
          </Field>
          <Field label="Review note">
            <input name="reason" className={fieldClass} />
          </Field>
        </ActionForm>
      ) : null}
      {application?.stage === "credit_assessed" &&
      !office &&
      canWrite &&
      agreement ? (
        <ActionForm
          title="Accept the published agreement"
          submitLabel="Accept this agreement version"
          onSubmit={(f) => {
            if (f.get("accepted") !== "on")
              throw new Error("Read and accept the agreement first.");
            return command("agreement/accept", {
              documentId: agreement.id,
              sha256: agreement.sha256,
              accepted: true,
            });
          }}
        >
          <a
            className="text-sm underline"
            href={`/api/v1/distributors/documents/${agreement.id}?distributorId=${workspace.distributor.id}`}
          >
            Read {agreement.title} · version {agreement.version}
          </a>
          <label className="text-sm">
            <input name="accepted" type="checkbox" required /> I accept this
            exact published agreement version.
          </label>
        </ActionForm>
      ) : null}
    </>
  );
}
