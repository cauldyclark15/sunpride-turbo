"use client";

import { Button } from "@heroui/react";
import {
  Card,
  FormField,
  ListRow,
  Pager,
  StatusPill,
  WorkspaceIcon,
} from "@sunpride/ui";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import Image from "next/image";
import { useState, type FormEvent } from "react";
import { formatManilaDate } from "../lib/manila-date";

type Decision = "approved" | "rejected";
type Decide = (
  args: FunctionArgs<typeof api.outlets.enrolment.decide>,
) => Promise<{ code: string }>;

/** Form boundary: a decision always carries a trimmed, non-empty reason. */
export async function decideNewStore(
  decide: Decide,
  enrolmentId: Id<"outletEnrolments">,
  decision: Decision,
  data: Pick<FormData, "get">,
) {
  const reason = String(data.get("reason") ?? "").trim();
  if (!reason) throw new Error("Reason required");
  return decide({ enrolmentId, decision, reason });
}

const eventLabel = {
  proposed: "proposed",
  approved: "approved",
  rejected: "rejected",
} as const;

/**
 * CALL-07: approvers see pending new stores with their photo / customer information
 * sheet and approve (issuing the system customer code) or reject with a reason. Everyone
 * with outlet access sees the status-change feed; salespeople only their own stores.
 */
export function NewStoreApprovals() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const profile = useQuery(api.domains.profiles.current, {});
  const has = (name: string) =>
    permissions?.capabilities.includes(name) ?? false;
  const canRead = has("outlet.read");
  const canApprove = has("outlet.enrol.approve");
  const canPropose = has("outlet.enrol.propose");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const queue = useQuery(
    api.outlets.enrolment.pending,
    canApprove
      ? { paginationOpts: { cursor: cursors.at(-1) ?? null, numItems: 10 } }
      : "skip",
  );
  const mine = useQuery(
    api.outlets.enrolment.mine,
    canPropose && !canApprove
      ? { paginationOpts: { cursor: null, numItems: 10 } }
      : "skip",
  );
  const feed = useQuery(
    api.outlets.enrolment.notifications,
    canRead ? { limit: 10 } : "skip",
  );
  const format = useQuery(
    api.outlets.enrolment.codeFormat,
    canRead ? {} : "skip",
  );
  const decide = useMutation(api.outlets.enrolment.decide);
  const [target, setTarget] = useState<{
    id: Id<"outletEnrolments">;
    decision: Decision;
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  if (!canRead) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await decideNewStore(
        decide,
        target.id,
        target.decision,
        new FormData(event.currentTarget),
      );
      setNotice(
        target.decision === "approved"
          ? `Store approved. Customer code ${result.code}.`
          : "Store rejected and deactivated.",
      );
      setTarget(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const rows = canApprove ? queue?.page : mine?.page;
  return (
    <Card
      label={canApprove ? "New stores to approve" : "My new stores"}
      count={rows?.length}
      icon={<WorkspaceIcon name="field" />}
    >
      <div className="grid gap-4 p-4">
        {format && (
          <p className="text-sm text-muted">
            New customer codes are issued on approval, e.g. {format.example}.
            Existing stores keep their imported codes.
          </p>
        )}
        {(canApprove || canPropose) &&
          (rows === undefined ? (
            <p>Loading new stores…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted">
              {canApprove
                ? "No new stores waiting for approval."
                : "You have not proposed any new stores."}
            </p>
          ) : (
            <ul aria-label="New store list" className="grid gap-3">
              {rows.map((row) => {
                const own =
                  !!profile &&
                  (profile._id === row.enrolment.proposedByProfileId ||
                    profile.authSubject === row.enrolment.proposedBy);
                return (
                  <li
                    key={row.enrolment._id}
                    className="grid gap-2 rounded-xl border border-border p-3"
                  >
                    <ListRow
                      icon={<WorkspaceIcon name="field" />}
                      title={row.outlet.name}
                      meta={`${row.outlet.code} · ${row.outlet.channel ?? "No channel"} · proposed by ${row.proposerName} on ${formatManilaDate(row.enrolment.proposedAt)}`}
                      value={
                        <StatusPill
                          tone={
                            row.enrolment.status === "approved"
                              ? "success"
                              : row.enrolment.status === "rejected"
                                ? "danger"
                                : "warning"
                          }
                        >
                          {row.enrolment.status === "pending"
                            ? "Provisional"
                            : row.enrolment.status === "approved"
                              ? "Approved"
                              : "Rejected"}
                        </StatusPill>
                      }
                    />
                    <p className="text-sm">
                      {row.outlet.address ?? "No address"} · Contact:{" "}
                      {row.outlet.contacts?.[0]
                        ? `${row.outlet.contacts[0].name}${row.outlet.contacts[0].phone ? ` (${row.outlet.contacts[0].phone})` : ""}`
                        : "none"}
                      {row.pin &&
                        ` · GPS ${row.pin.latitude.toFixed(5)}, ${row.pin.longitude.toFixed(5)}`}
                    </p>
                    {row.enrolment.decisionReason && (
                      <p className="text-sm text-muted">
                        Decision: {row.enrolment.decisionReason}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {row.photoUrls.map((url, index) => (
                        <a
                          key={url}
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Store photo ${index + 1}`}
                        >
                          <Image
                            src={url}
                            alt={`Store photo ${index + 1} of ${row.outlet.name}`}
                            width={96}
                            height={96}
                            unoptimized
                            className="size-24 rounded-lg border border-border object-cover"
                          />
                        </a>
                      ))}
                      {row.cisUrl && (
                        <a
                          href={row.cisUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          Customer information sheet
                        </a>
                      )}
                    </div>
                    {canApprove && row.enrolment.status === "pending" && (
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          className="h-8"
                          isDisabled={own}
                          onPress={() =>
                            setTarget({
                              id: row.enrolment._id,
                              decision: "approved",
                            })
                          }
                        >
                          Approve
                        </Button>
                        <Button
                          variant="outline"
                          className="h-8"
                          isDisabled={own}
                          onPress={() =>
                            setTarget({
                              id: row.enrolment._id,
                              decision: "rejected",
                            })
                          }
                        >
                          Reject
                        </Button>
                        {own && (
                          <span className="text-sm text-muted">
                            Another approver must decide your own proposal.
                          </span>
                        )}
                      </div>
                    )}
                    {target?.id === row.enrolment._id && (
                      <form
                        onSubmit={submit}
                        aria-label="New store decision"
                        className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end"
                      >
                        <FormField
                          label={
                            target.decision === "approved"
                              ? "Approval reason"
                              : "Rejection reason"
                          }
                        >
                          <input name="reason" required />
                        </FormField>
                        <Button type="submit" className="h-8" isDisabled={busy}>
                          {target.decision === "approved"
                            ? "Approve and issue code"
                            : "Reject store"}
                        </Button>
                        <Button
                          variant="outline"
                          className="h-8"
                          onPress={() => setTarget(null)}
                        >
                          Cancel
                        </Button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          ))}
        {canApprove && (
          <Pager
            page={cursors.length}
            canPrevious={cursors.length > 1}
            canNext={!!queue && !queue.isDone}
            onPrevious={() => setCursors((old) => old.slice(0, -1))}
            onNext={() => {
              if (queue && !queue.isDone)
                setCursors((old) => [...old, queue.continueCursor]);
            }}
            label="New store pages"
          />
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <section aria-label="New store updates" className="grid gap-1">
          <h3 className="text-sm font-medium">Recent new-store updates</h3>
          {feed === undefined ? (
            <p className="text-sm text-muted">Loading updates…</p>
          ) : feed.length === 0 ? (
            <p className="text-sm text-muted">No new-store updates yet.</p>
          ) : (
            <ul className="grid gap-1 text-sm">
              {feed.map((item) => (
                <li key={item._id}>
                  {formatManilaDate(item.createdAt)} · {item.outletName} (
                  {item.outletCode}) {eventLabel[item.kind]} by {item.actorName}
                  {item.reason ? `: ${item.reason}` : ""}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Card>
  );
}
