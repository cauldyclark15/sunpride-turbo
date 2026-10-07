"use client";

import { Button } from "@heroui/react";
import { Card, FormField, WorkspaceIcon } from "@sunpride/ui";
import { api } from "@sunpride/backend/api";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useState, type FormEvent } from "react";

/** Mirrors `VOID_REASONS` in `convex/van/model.ts` (parity-tested). */
export const VAN_VOID_REASONS = [
  { code: "wrong_items", label: "Wrong items" },
  { code: "wrong_quantity", label: "Wrong quantity" },
  { code: "wrong_customer", label: "Wrong customer" },
  { code: "wrong_payment", label: "Wrong payment" },
  { code: "customer_cancelled", label: "Customer cancelled" },
  { code: "other", label: "Other" },
] as const;

/** "1,234.50" / "₱ 1234.5" / "1234" → centavos as a decimal string; null when not an exact peso amount. */
export function pesosToCentavos(text: string): string | null {
  const value = text.replace(/[₱P,\s]/gi, "");
  const match = /^(\d{1,16})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const centavos =
    BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return centavos.toString();
}

type IssuedCode = FunctionReturnType<typeof api.van.voids.issueApprovalCode>;
type Issue = (
  args: FunctionArgs<typeof api.van.voids.issueApprovalCode>,
) => Promise<IssuedCode>;

/** Form boundary: receipt number, exact peso total and a known reason, or a plain-words error. */
export async function requestVoidCode(
  issue: Issue,
  data: Pick<FormData, "get">,
) {
  const receiptNumber = String(data.get("receiptNumber") ?? "").trim();
  if (!receiptNumber) throw new Error("Enter the receipt number");
  const totalMinor = pesosToCentavos(String(data.get("total") ?? ""));
  if (totalMinor === null)
    throw new Error("Enter the receipt total in pesos, e.g. 1,234.50");
  const reasonCode = String(data.get("reason") ?? "");
  if (!VAN_VOID_REASONS.some((reason) => reason.code === reasonCode))
    throw new Error("Choose the reason the seller gave");
  return issue({ receiptNumber, totalMinor, reasonCode });
}

/**
 * VAN-021: a van seller voids a sale on the handheld, offline. When a supervisor must approve,
 * the seller reads out the receipt number, total and reason; the supervisor enters them here and
 * reads back the 8-digit code. The code works only for that receipt, total and reason.
 */
export function VanVoidApproval() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const issue = useMutation(api.van.voids.issueApprovalCode);
  const [result, setResult] = useState<IssuedCode | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!permissions?.capabilities.includes("van.void.approve")) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(
        await requestVoidCode(issue, new FormData(event.currentTarget)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const reasonLabel = (code: string) =>
    VAN_VOID_REASONS.find((reason) => reason.code === code)?.label ?? code;
  return (
    <Card
      label="Van sale void approval"
      icon={<WorkspaceIcon name="approvals" />}
    >
      <div className="grid gap-4 p-4">
        <p className="text-sm text-muted">
          Ask the seller for the receipt number, the total and the reason. Give
          them the code only if the void is correct. Your approval is recorded.
        </p>
        <form
          onSubmit={submit}
          aria-label="Van void approval"
          className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
        >
          <FormField label="Receipt number">
            <input
              name="receiptNumber"
              required
              autoComplete="off"
              placeholder="TRIP-20261007-V014-1-1A2B3C4D-0001"
            />
          </FormField>
          <FormField label="Total (₱)">
            <input name="total" required inputMode="decimal" />
          </FormField>
          <FormField label="Reason">
            <select name="reason" required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {VAN_VOID_REASONS.map((reason) => (
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
              For receipt {result.receiptNumber} · trip {result.tripNumber} ·{" "}
              {reasonLabel(result.reasonCode)}. The code fails if the total or
              reason on the handheld differs.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
