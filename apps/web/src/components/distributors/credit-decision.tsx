"use client";
import { money, words } from "./kit";
export type CreditException = {
  id: string;
  phase: string;
  status: string;
  source: string | null;
  sourceId: string | null;
  sourceType: string;
  customerCode: string;
  amountCentavos: number;
  reference: string | null;
  expiresAt: number | null;
  providerReason?: string | null;
  exposure?: {
    limitCentavos?: number | null;
    exposureCentavos?: number | null;
    projectedExposureCentavos?: number | null;
  };
};
/** F-404 a local approval never masquerades as the provider's credit permission. */
export function CreditDecision({ request }: { request: CreditException }) {
  const risk = request.exposure;
  const state =
    request.phase === "approved" &&
    request.status === "approved" &&
    request.reference
      ? "SAP exception approved"
      : request.phase === "awaiting_finance"
        ? "Waiting for another Finance approver"
        : request.phase === "awaiting_sap"
          ? "Finance approved · waiting for SAP"
          : request.phase === "rejected"
            ? "Credit exception refused"
            : "Refresh current authority with the office";
  return (
    <div
      className="grid gap-2 rounded-lg border border-border p-4 text-sm"
      data-testid="credit-exception-state"
    >
      <p className="font-medium">
        {request.source === "sample" ? "SAMPLE · " : ""}
        {state}
      </p>
      <p>
        {request.customerCode} · requested {money(request.amountCentavos)}
      </p>
      {risk && (
        <p>
          Account limit {money(risk.limitCentavos)} · exposure at request{" "}
          {money(risk.exposureCentavos)} · projected{" "}
          {money(risk.projectedExposureCentavos)}
        </p>
      )}
      {request.sourceType === "distributor_order" && request.sourceId && (
        <p>Purchase order {request.sourceId}</p>
      )}
      {request.reference && <p>Provider reference {request.reference}</p>}
      {request.expiresAt && (
        <p>
          Valid until{" "}
          {new Date(request.expiresAt).toLocaleString("en-PH", {
            timeZone: "Asia/Manila",
          })}
        </p>
      )}
      {request.providerReason && <p>{request.providerReason}</p>}
      <p>
        The ordinary account limit is unchanged. Confirmation rechecks the exact
        amount and can use the exception for one matching document only.
      </p>
      <span className="sr-only">{words(request.phase)}</span>
    </div>
  );
}
