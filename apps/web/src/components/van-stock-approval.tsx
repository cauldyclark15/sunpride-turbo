"use client";

import { Button } from "@heroui/react";
import { Card, FormField, WorkspaceIcon } from "@sunpride/ui";
import { api } from "@sunpride/backend/api";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useState, type FormEvent } from "react";

type IssuedCode = FunctionReturnType<
  typeof api.van.stock_count.issueApprovalCode
>;
type Issue = (
  args: FunctionArgs<typeof api.van.stock_count.issueApprovalCode>,
) => Promise<IssuedCode>;

/** The count code as read out ("abcd-ef12 3456") → "ABCDEF123456", or null unless 12 hex characters. */
export function normalizeCountCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  return /^[0-9A-F]{12}$/.test(code) ? code : null;
}

/** "ABCDEF123456" → "ABCD-EF12-3456", as the handheld shows it. */
export const groupedCountCode = (code: string) =>
  `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;

/** A whole number of units ("0", "12"), or null. */
const units = (value: FormDataEntryValue | null): string | null => {
  const text = String(value ?? "")
    .trim()
    .replaceAll(",", "");
  return /^\d{1,18}$/.test(text) ? String(BigInt(text)) : null;
};

/** Form boundary: trip number, count code, lines that differ and units short/over, or a plain-words error. */
export async function requestStockCode(
  issue: Issue,
  data: Pick<FormData, "get">,
) {
  const tripNumber = String(data.get("tripNumber") ?? "").trim();
  if (!tripNumber) throw new Error("Enter the trip number");
  const countCode = normalizeCountCode(String(data.get("countCode") ?? ""));
  if (!countCode)
    throw new Error(
      "Enter the 12-character count code from the phone, e.g. 7ACD-2B0F-A14F",
    );
  const lines = units(data.get("varianceLines"));
  if (lines === null || BigInt(lines) < 1n || BigInt(lines) > 1000n)
    throw new Error("Enter how many lines differ (1 or more)");
  const shortBase = units(data.get("short"));
  if (shortBase === null)
    throw new Error("Enter the units short as a whole number (0 if none)");
  const overBase = units(data.get("over"));
  if (overBase === null)
    throw new Error("Enter the units over as a whole number (0 if none)");
  if (shortBase === "0" && overBase === "0")
    throw new Error("The stock matches; no approval is needed");
  return issue({
    tripNumber,
    countCode,
    varianceLines: Number(lines),
    shortBase,
    overBase,
  });
}

/**
 * VAN-023: at the end of a trip the van seller counts the truck stock on the handheld. When any
 * product differs from the stock the phone expects, the seller reads out the trip number, the
 * count code, how many lines differ and the units short and over; the supervisor enters them here
 * and reads back the 8-digit code. The count code stands for the whole count (every product,
 * quantity and reason), so the code approves only that exact count.
 */
export function VanStockApproval() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const issue = useMutation(api.van.stock_count.issueApprovalCode);
  const [result, setResult] = useState<IssuedCode | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!permissions?.capabilities.includes("van.stock.approve")) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(
        await requestStockCode(issue, new FormData(event.currentTarget)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      label="Van stock count approval"
      icon={<WorkspaceIcon name="approvals" />}
    >
      <div className="grid gap-4 p-4">
        <p className="text-sm text-muted">
          Ask the seller for the trip number, the count code on their phone, how
          many lines differ, the units short and over, and the reason for each
          difference. Give them the code only if you accept the count. Your
          approval is recorded.
        </p>
        <form
          onSubmit={submit}
          aria-label="Van stock count approval"
          className="grid gap-3 sm:grid-cols-[2fr_2fr_1fr_1fr_1fr_auto] sm:items-end"
        >
          <FormField label="Trip number">
            <input
              name="tripNumber"
              required
              autoComplete="off"
              placeholder="TRIP-20261007-V014-1"
            />
          </FormField>
          <FormField label="Count code">
            <input
              name="countCode"
              required
              autoComplete="off"
              placeholder="XXXX-XXXX-XXXX"
            />
          </FormField>
          <FormField label="Lines that differ">
            <input name="varianceLines" required inputMode="numeric" />
          </FormField>
          <FormField label="Units short">
            <input name="short" required inputMode="numeric" />
          </FormField>
          <FormField label="Units over">
            <input name="over" required inputMode="numeric" />
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
              For trip {result.tripNumber} · count{" "}
              {groupedCountCode(result.countCode)} · {result.varianceLines}{" "}
              {result.varianceLines === 1 ? "line differs" : "lines differ"} ·{" "}
              {result.shortBase} short · {result.overBase} over. The code fails
              if the count on the handheld changes.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
