"use client";

import { Button } from "@heroui/react";
import { Card, FormField, WorkspaceIcon } from "@sunpride/ui";
import { api } from "@sunpride/backend/api";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useState, type FormEvent } from "react";
import { pesosToCentavos } from "./van-void-approval";

/** Mirrors `CASH_VARIANCE_REASONS` in `convex/van/model.ts` (parity-tested). */
export const VAN_CASH_VARIANCE_REASONS = [
  { code: "counting_error", label: "Counting error" },
  { code: "change_error", label: "Wrong change given" },
  { code: "customer_short_paid", label: "Customer paid short" },
  { code: "customer_overpaid", label: "Customer overpaid" },
  { code: "lost_or_stolen", label: "Cash lost or stolen" },
  { code: "counterfeit", label: "Fake bill or coin" },
  { code: "other", label: "Other" },
] as const;

type IssuedCode = FunctionReturnType<typeof api.van.cash.issueApprovalCode>;
type Issue = (
  args: FunctionArgs<typeof api.van.cash.issueApprovalCode>,
) => Promise<IssuedCode>;

/** "-145.50" centavos string → "₱145.50 short"; positive → over. */
export function varianceLabel(varianceMinor: string): string {
  const value = BigInt(varianceMinor);
  const abs = value < 0n ? -value : value;
  const pesos = `₱${(abs / 100n).toLocaleString("en-PH")}.${String(abs % 100n).padStart(2, "0")}`;
  return value < 0n ? `${pesos} short` : `${pesos} over`;
}

/** Form boundary: trip number, exact peso amounts and a known reason, or a plain-words error. */
export async function requestCashCode(
  issue: Issue,
  data: Pick<FormData, "get">,
) {
  const tripNumber = String(data.get("tripNumber") ?? "").trim();
  if (!tripNumber) throw new Error("Enter the trip number");
  const expectedMinor = pesosToCentavos(String(data.get("expected") ?? ""));
  if (expectedMinor === null)
    throw new Error("Enter the expected cash in pesos, e.g. 12,345.50");
  const declaredMinor = pesosToCentavos(String(data.get("declared") ?? ""));
  if (declaredMinor === null)
    throw new Error("Enter the counted cash in pesos, e.g. 12,300.00");
  if (expectedMinor === declaredMinor)
    throw new Error("The cash matches; no approval is needed");
  const reasonCode = String(data.get("reason") ?? "");
  if (!VAN_CASH_VARIANCE_REASONS.some((reason) => reason.code === reasonCode))
    throw new Error("Choose the reason the seller gave");
  return issue({ tripNumber, expectedMinor, declaredMinor, reasonCode });
}

/**
 * VAN-022: at the end of a trip the van seller counts the cash on the handheld. When the count
 * differs from the expected cash by more than the tolerance, the seller reads out the trip number,
 * expected cash, counted cash and reason; the supervisor enters them here and reads back the
 * 8-digit code. The code works only for those amounts and that reason.
 */
export function VanCashApproval() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const issue = useMutation(api.van.cash.issueApprovalCode);
  const [result, setResult] = useState<IssuedCode | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!permissions?.capabilities.includes("van.cash.approve")) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(
        await requestCashCode(issue, new FormData(event.currentTarget)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const reasonLabel = (code: string) =>
    VAN_CASH_VARIANCE_REASONS.find((reason) => reason.code === code)?.label ??
    code;
  return (
    <Card
      label="Van cash count approval"
      icon={<WorkspaceIcon name="approvals" />}
    >
      <div className="grid gap-4 p-4">
        <p className="text-sm text-muted">
          Ask the seller for the trip number, the expected cash, the cash they
          counted and the reason for the difference. Give them the code only if
          you accept the difference. Your approval is recorded.
        </p>
        <form
          onSubmit={submit}
          aria-label="Van cash count approval"
          className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] sm:items-end"
        >
          <FormField label="Trip number">
            <input
              name="tripNumber"
              required
              autoComplete="off"
              placeholder="TRIP-20261007-V014-1"
            />
          </FormField>
          <FormField label="Expected cash (₱)">
            <input name="expected" required inputMode="decimal" />
          </FormField>
          <FormField label="Counted cash (₱)">
            <input name="declared" required inputMode="decimal" />
          </FormField>
          <FormField label="Reason">
            <select name="reason" required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {VAN_CASH_VARIANCE_REASONS.map((reason) => (
                <option key={reason.code} value={reason.code}>
                  {reason.label}
                </option>
              ))}
            </select>
          </FormField>
          <Button type="submit" className="h-8" isDisabled={busy}>
            Get code
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {result && (
          <div role="status" className="grid gap-1">
            <p className="font-mono text-2xl tracking-[0.2em] text-foreground">
              {result.code.slice(0, 4)} {result.code.slice(4)}
            </p>
            <p className="text-sm text-muted">
              For trip {result.tripNumber} ·{" "}
              {varianceLabel(result.varianceMinor)} ·{" "}
              {reasonLabel(result.reasonCode)}. The code fails if the amounts or
              reason on the handheld differ.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
