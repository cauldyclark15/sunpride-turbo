"use client";

import { Button } from "@heroui/react";
import { Card, FormField, WorkspaceIcon } from "@sunpride/ui";
import { usePermissions } from "../lib/auth";
import { useVanCommand } from "./van/use-command";
import { pesosToCentavos } from "./van-void-approval";
import { useState, type FormEvent } from "react";

/** The refund reasons the office seeds (`inventory_reason_codes.refund_destination`); the seller may also read out one an admin added. */
export const VAN_REFUND_REASONS = [
  { code: "RF-CHANGED-MIND", label: "Customer changed mind" },
  { code: "RF-WRONG-ITEM", label: "Wrong item sold" },
  { code: "RF-DAMAGED", label: "Damaged when sold" },
  { code: "RF-EXPIRED", label: "Expired or near expiry" },
  { code: "RF-QUALITY", label: "Quality problem" },
] as const;

export type RefundCodeInput = {
  receiptNumber: string;
  totalMinor: string;
  reasonCode: string;
  refundNumber: number;
};
export type RefundCode = RefundCodeInput & { code: string; tripNumber: string };
type Issue = (args: RefundCodeInput) => Promise<RefundCode>;

/** Form boundary: receipt number, exact peso refund amount, a reason code and which refund of the receipt this is. */
export async function requestRefundCode(
  issue: Issue,
  data: Pick<FormData, "get">,
) {
  const receiptNumber = String(data.get("receiptNumber") ?? "").trim();
  if (!receiptNumber) throw new Error("Enter the receipt number");
  const totalMinor = pesosToCentavos(String(data.get("total") ?? ""));
  if (totalMinor === null || totalMinor === "0")
    throw new Error("Enter the refund amount in pesos, e.g. 1,234.50");
  const reasonCode = String(data.get("reason") ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/.test(reasonCode))
    throw new Error("Enter the reason code the seller reads out");
  const refundNumber = Number(String(data.get("refundNumber") ?? "1").trim());
  if (!Number.isInteger(refundNumber) || refundNumber < 1 || refundNumber > 1000)
    throw new Error("Enter which refund of this receipt it is (1 for the first)");
  return issue({ receiptNumber, totalMinor, reasonCode, refundNumber });
}

/**
 * IP-REFUND: a van seller refunds some items of a sale on the handheld, offline. Above the office's amount a supervisor
 * approves: the seller reads out the receipt number, the refund amount, the reason and which refund this is; the supervisor
 * enters them here and reads back the 8-digit code. The code works for that refund only.
 */
export function VanRefundApproval() {
  const permissions = usePermissions();
  const issue = useVanCommand<RefundCodeInput, RefundCode>(
    "/api/v1/van/refund/approval-code",
  );
  const [result, setResult] = useState<RefundCode | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!permissions.can("van.refund.approve")) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(
        await requestRefundCode(issue, new FormData(event.currentTarget)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      label="Van item refund approval"
      icon={<WorkspaceIcon name="approvals" />}
    >
      <div className="grid gap-4 p-4">
        <p className="text-sm text-muted">
          Ask the seller for the receipt number, the refund amount, the reason
          and which refund of that receipt this is. Give them the code only if
          the refund is correct. Your approval is recorded.
        </p>
        <form
          onSubmit={submit}
          aria-label="Van refund approval"
          className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] sm:items-end"
        >
          <FormField label="Receipt number">
            <input
              name="receiptNumber"
              required
              autoComplete="off"
              placeholder="TRIP-20261007-V014-1-1A2B3C4D-0001"
            />
          </FormField>
          <FormField label="Refund (₱)">
            <input name="total" required inputMode="decimal" />
          </FormField>
          <FormField label="Reason code">
            <input
              name="reason"
              required
              list="van-refund-reasons"
              autoComplete="off"
            />
            <datalist id="van-refund-reasons">
              {VAN_REFUND_REASONS.map((reason) => (
                <option key={reason.code} value={reason.code}>
                  {reason.label}
                </option>
              ))}
            </datalist>
          </FormField>
          <FormField label="Refund no.">
            <input
              name="refundNumber"
              required
              inputMode="numeric"
              defaultValue="1"
            />
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
              For receipt {result.receiptNumber} · trip {result.tripNumber} ·
              refund {result.refundNumber} · {result.reasonCode}. The code
              fails if the amount, reason or refund number on the handheld
              differs.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
