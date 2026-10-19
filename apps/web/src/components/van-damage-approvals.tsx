"use client";

import { Button, Input } from "@heroui/react";
import { apiFetch, useApiPages, useLive } from "../lib/api";
import { usePermissions } from "../lib/auth";
import { useVanCommand } from "./van/use-command";
import type { DamageRow } from "./van/model";
import { Card, Notice, StatusPill, WorkspaceIcon } from "@sunpride/ui";

import { useState } from "react";

/**
 * SP-0114 (VAN-020): truck damage records of 12 or more selling units wait here for a
 * supervisor. The stock already left sellable stock on the truck; approving keeps it
 * written off, rejecting returns it to sellable stock through a separate movement.
 */

const inputClass =
  "h-10 w-full rounded-[10px] border border-field-border bg-field-background px-3 text-sm shadow-none";

const REASONS: Record<string, string> = {
  crushed: "Crushed",
  leaking: "Leaking",
  expired: "Expired",
  spoiled: "Spoiled",
  other: "Other",
};

export function damageReasonLabel(reason: string) {
  return REASONS[reason] ?? reason;
}

/** Base quantity in selling units (base / scale), without floating-point rounding. */
export function formatDamageQuantity(base: bigint, scale: bigint) {
  if (scale <= 1n) return base.toString();
  const whole = base / scale;
  const rest = base % scale;
  if (rest === 0n) return whole.toString();
  const digits = scale.toString().length - 1;
  const exact = 10n ** BigInt(digits) === scale;
  if (!exact) return `${base.toString()}/${scale.toString()}`;
  const fraction = rest.toString().padStart(digits, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fraction}`;
}

export function damageErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  const data = (error as { data?: unknown } | null)?.data;
  return typeof data === "string" && data.trim()
    ? data.trim()
    : "Action failed. Try again.";
}

const manilaTime = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  dateStyle: "medium",
  timeStyle: "short",
});

export function VanDamageApprovals() {
  const permissions = usePermissions();
  const { items, status, loadMore, error } = useApiPages<DamageRow>(
    permissions.can("van.read") ? ["van", "damage"] : null,
    (cursor, { signal }) =>
      apiFetch("/api/v1/van/damage", { query: { cursor }, signal }),
  );
  const results = items ?? [];
  useLive(["van"], [["van"]]);
  const decide = useVanCommand<
    { damageId: string; decision: "approve" | "reject"; note?: string },
    unknown
  >("/api/v1/van/damage/decide");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(damageId: string, decision: "approve" | "reject") {
    const note = notes[damageId]?.trim();
    if (decision === "reject" && !note) {
      setNotice("Say why the damage is rejected");
      return;
    }
    setBusy(damageId);
    try {
      await decide({ damageId, decision, ...(note ? { note } : {}) });
      setNotice(null);
    } catch (error) {
      setNotice(damageErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card label="Truck damage" icon={<WorkspaceIcon name="inventory" />}>
      {notice || error ? (
        <Notice
          title={notice ?? error?.message ?? "Could not load damage"}
          tone="danger"
        />
      ) : null}
      <section aria-label="Truck damage waiting" className="grid gap-2">
        {results.map((row) => (
          <div
            key={row.damageId}
            className="grid gap-2 border-b border-separator px-4 pb-3 last:border-b-0"
          >
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
              <div>
                <strong className="text-sm font-medium">
                  {row.productName}{" "}
                  <span className="font-mono text-xs text-muted">
                    {row.productCode}
                  </span>
                </strong>
                <small className="block text-[13px] text-muted">
                  {formatDamageQuantity(
                    BigInt(row.quantityBase),
                    BigInt(row.quantityScale),
                  )}{" "}
                  {row.uomCode} · {damageReasonLabel(row.reason)} ·{" "}
                  {row.sellerName} · {row.tripNumber} ·{" "}
                  {manilaTime.format(row.recordedAt)}
                </small>
                {row.note ? (
                  <small className="block text-[13px]">{row.note}</small>
                ) : null}
              </div>
              <StatusPill tone="warning">Waiting</StatusPill>
            </div>
            {row.photoUrl ? (
              <a
                href={row.photoUrl}
                target="_blank"
                rel="noreferrer"
                className="w-fit"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived storage URL */}
                <img
                  src={row.photoUrl}
                  alt={`Damage photo for ${row.productCode}`}
                  className="h-24 w-24 rounded-[10px] border border-border object-cover"
                />
              </a>
            ) : (
              <small className="text-[13px] text-muted">No photo</small>
            )}
            {row.canDecide ? (
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
                <Input
                  className={inputClass}
                  aria-label={`Decision note for ${row.productCode}`}
                  placeholder="Note (required to reject)"
                  maxLength={300}
                  value={notes[row.damageId] ?? ""}
                  onChange={(event) =>
                    setNotes({ ...notes, [row.damageId]: event.target.value })
                  }
                />
                <Button
                  size="sm"
                  variant="outline"
                  isDisabled={busy !== null}
                  onPress={() => void run(row.damageId, "reject")}
                >
                  Reject
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  isDisabled={busy !== null}
                  onPress={() => void run(row.damageId, "approve")}
                >
                  Approve
                </Button>
              </div>
            ) : (
              <small className="text-[13px] text-muted">
                Another supervisor decides this one
              </small>
            )}
          </div>
        ))}
        {results.length === 0 && status !== "loading" && !error ? (
          <p className="text-[13px] text-muted">No truck damage waiting</p>
        ) : null}
        {status === "canLoadMore" ? (
          <Button
            size="sm"
            variant="secondary"
            className="w-fit"
            onPress={() => void loadMore()}
          >
            Show older
          </Button>
        ) : null}
      </section>
    </Card>
  );
}
