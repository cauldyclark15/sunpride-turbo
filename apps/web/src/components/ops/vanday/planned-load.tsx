"use client";

import { Button } from "@heroui/react";
import { Card, Notice } from "@sunpride/ui";
import { useState } from "react";
import { apiFetch, useApi, useMutate } from "@/lib/api";
import { usePermissions } from "@/lib/auth";
import { DocNumber } from "../doc-number";
import {
  CasesPiecesStepper,
  QtyCasesPieces,
  splitCasesPieces,
  type CasesPieces,
} from "../qty-cases-pieces";
import { StatusPill } from "../status-pill";
import { useIntent } from "../transfers/use-intent";
import {
  approvalRefusal,
  editPayload,
  reasonsFor,
  type PlanDetail,
} from "./vanday-model";

/** The suggested load of one truck: each line with its reason, editable while it is still a suggestion. */
export function PlannedLoadView({
  detail,
  edits,
  onEdit,
  onSave,
  onApprove,
  onCopy,
  pending,
  error,
  canManage = true,
}: {
  detail: PlanDetail;
  edits: Record<string, CasesPieces>;
  onEdit: (productId: string, next: CasesPieces) => void;
  onSave: () => void;
  onApprove: () => void;
  onCopy: () => void;
  pending?: boolean;
  error?: string | null;
  /** van.manage: plan, edit, copy and approve loads (WEB-082/084). */
  canManage?: boolean;
}) {
  if (!detail.plan)
    return (
      <div className="grid gap-3">
        <Notice
          tone="neutral"
          title="This trip has no suggested load yet."
          meta={
            canManage
              ? "Copy the load this truck last went out with, or wait for the night plan at 8 pm."
              : "The office (operations or an administrator) plans van loads."
          }
        />
        {error ? (
          <Notice tone="danger" title="That could not be done." meta={error} />
        ) : null}
        {canManage ? (
          <div>
            <Button
              variant="secondary"
              className="min-h-12 text-base"
              isPending={pending}
              onPress={onCopy}
            >
              Copy yesterday
            </Button>
          </div>
        ) : null}
      </div>
    );
  const editable = detail.plan.state === "suggested";
  const dirty =
    editPayload(detail.tripId, detail.lines, edits).lines.length > 0;
  return (
    <Card
      label={`Load for ${detail.tripNumber ?? "this trip"}`}
      count={detail.lines.length}
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill state={editable ? "planned" : "approved"}>
            {detail.plan.label}
          </StatusPill>
          {detail.document ? (
            <DocNumber value={detail.document.number} />
          ) : null}
          {detail.plan.source === "copy" ? (
            <span className="text-sm text-muted">
              Copied from an earlier trip
            </span>
          ) : null}
        </div>
        {detail.plan.attention.map((a) => (
          <Notice key={a} tone="warning" title={a} />
        ))}
        <ul className="grid gap-3">
          {detail.lines.map((l) => {
            const value =
              edits[l.productId] ?? splitCasesPieces(l.loadBase, l.caseBase);
            return (
              <li
                key={l.productId}
                className="grid gap-2 border-b border-separator pb-3"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-base font-medium">{l.name}</span>
                  <span className="text-sm text-muted">{l.code}</span>
                  {l.flags.includes("ship_first") ? (
                    <StatusPill state="needs_review">Ship first</StatusPill>
                  ) : null}
                  {l.edited ? (
                    <span className="text-sm text-muted">Edited</span>
                  ) : null}
                </div>
                {editable ? (
                  <CasesPiecesStepper
                    value={value}
                    basePerCase={l.caseBase}
                    onChange={(n) => onEdit(l.productId, n)}
                  />
                ) : (
                  <QtyCasesPieces base={l.loadBase} basePerCase={l.caseBase} />
                )}
                <ul className="text-sm text-muted">
                  {reasonsFor(l).map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
        {error ? (
          <Notice tone="danger" title="That could not be done." meta={error} />
        ) : null}
        {editable && canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              className="min-h-12 text-base"
              onPress={onCopy}
            >
              Copy yesterday
            </Button>
            <Button
              variant="secondary"
              className="min-h-12 text-base"
              isDisabled={!dirty}
              isPending={pending}
              onPress={onSave}
            >
              Save changes
            </Button>
            <Button
              variant="primary"
              className="min-h-12 text-base"
              isDisabled={dirty}
              isPending={pending}
              onPress={onApprove}
            >
              Approve load
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export function PlannedLoad({
  tripId,
  onDone,
}: {
  tripId: string;
  onDone?: () => void;
}) {
  const [edits, setEdits] = useState<Record<string, CasesPieces>>({});
  const [error, setError] = useState<string | null>(null);
  const write = useMutate();
  const intent = useIntent();
  const { can } = usePermissions();
  const detail = useApi<PlanDetail>(["van", "plan", tripId], ({ signal }) =>
    apiFetch<PlanDetail>("/api/v1/van/loads/plan", {
      query: { tripId },
      signal,
    }),
  );
  if (detail.error)
    return (
      <Notice
        tone="danger"
        title="The load could not load."
        meta="Check your connection and try again."
      />
    );
  if (!detail.data) return <p className="p-4 text-muted">Loading the load…</p>;
  const post = async (path: string, body: Record<string, unknown>) => {
    setError(null);
    try {
      const result = await write.mutate(path, intent.withKey(path, body), {
        invalidate: [["van"]],
      });
      intent.done(path, body);
      setEdits({});
      const refused = approvalRefusal(result);
      if (refused) {
        setError(refused);
        return;
      }
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Try again");
    }
  };
  return (
    <PlannedLoadView
      detail={detail.data}
      edits={edits}
      onEdit={(id, n) => setEdits({ ...edits, [id]: n })}
      pending={write.pending}
      error={error}
      onSave={() =>
        post(
          "/api/v1/van/loads/edit",
          editPayload(tripId, detail.data?.lines ?? [], edits),
        )
      }
      onApprove={() =>
        post("/api/v1/van/loads/approve-plan", { tripIds: [tripId] })
      }
      onCopy={() => post("/api/v1/van/loads/copy", { tripId })}
      canManage={can("van.manage")}
    />
  );
}
