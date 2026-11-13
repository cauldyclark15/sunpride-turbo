"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import { usePermissions } from "../../lib/auth";
import { pesosToCentavos } from "../van-void-approval";
import { useVanCommand } from "./use-command";
import type { TripSettlement } from "./model";

/** The cashier confirms actual receipt, separately from a seller's device count. */
export function CashHandIn({ trip }: { trip: TripSettlement }) {
  const permission = usePermissions();
  const remit = useVanCommand<
    { tripId: string; amountMinor: string; reference: string },
    unknown
  >("/api/v1/van/cash/remit");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (
    !permission.can("van.cash.approve") ||
    trip.cash.declaredCentavos === null ||
    trip.cash.declaredCentavos === undefined ||
    trip.cash.remittedCentavos !== null
  )
    return null;
  const minor = BigInt(trip.cash.declaredCentavos);
  const counted = `${minor / 100n}.${String(minor % 100n).padStart(2, "0")}`;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget),
      amountMinor = pesosToCentavos(String(data.get("amount") ?? "")),
      reference = String(data.get("reference") ?? "").trim();
    if (amountMinor === null || !reference) {
      setError("Enter the received cash and hand-in reference");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await remit({ tripId: trip.tripId, amountMinor, reference });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cash receipt failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      aria-label="Office cash hand-in"
      onSubmit={submit}
      className="mt-4 grid gap-3 rounded-lg border border-separator p-4 print:hidden"
    >
      <strong className="text-sm">Waiting for cash receipt</strong>
      <p className="text-xs">
        The seller's phone cannot close this trip until the office confirms
        it received the cash. After you confirm, the phone sends the close
        again by itself.
      </p>
      <p className="text-xs text-muted">
        A seller's count is not a remittance. Confirm only after checking the
        cash and hand-in reference. A different person must receive it.
      </p>
      <div className="grid items-end gap-3 sm:grid-cols-3">
        <label className="text-xs">
          Received cash (₱)
          <input
            name="amount"
            required
            inputMode="decimal"
            defaultValue={counted}
          />
        </label>
        <label className="text-xs">
          Hand-in reference
          <input name="reference" required maxLength={100} />
        </label>
        <Button type="submit" isDisabled={busy}>
          Confirm cash received
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
