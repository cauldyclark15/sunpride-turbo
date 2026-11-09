"use client";

import { FormField, Pager, StatusPill } from "@sunpride/ui";
import { api } from "./master-data/api";
import type { Id } from "./master-data/model";
import { useMutation, useQuery } from "./master-data/api";
import type { FunctionArgs } from "./master-data/api";
import Image from "next/image";
import { useCallback, useState, type FormEvent } from "react";
import { ListPage, type ListColumn } from "./list-page/list-page";

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
  proposed: "added",
  approved: "approved",
  rejected: "rejected",
} as const;

/** "Nov 9" in Manila time. */
export function shortDate(value: number) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
  }).format(value);
}

const btn =
  "inline-flex h-9 items-center rounded-lg border border-border px-3 text-[13px] font-medium text-foreground hover:bg-default-soft disabled:opacity-50";

type Row = {
  enrolment: {
    _id: Id<"outletEnrolments">;
    status: string;
    proposedAt: number;
    proposedBy?: string;
    proposedByProfileId?: string;
    decisionReason?: string;
  };
  outlet: {
    name: string;
    code: string;
    channel?: string;
    address?: string;
    contacts?: Array<{ name: string; phone?: string }>;
  };
  pin?: { latitude: number; longitude: number } | null;
  proposerName: string;
  cisUrl?: string | null;
  photoUrls: string[];
};

const statusText = (s: string) =>
  s === "pending" ? "Provisional" : s === "approved" ? "Approved" : "Rejected";
const statusTone = (s: string) =>
  s === "approved" ? "success" : s === "rejected" ? "danger" : "warning";

const COLUMNS: ListColumn<Row>[] = [
  {
    key: "name",
    label: "Store",
    primary: true,
    render: (r) => r.outlet.name,
    text: (r) => r.outlet.name,
  },
  {
    key: "code",
    label: "Code",
    render: (r) => r.outlet.code,
    text: (r) => r.outlet.code,
  },
  {
    key: "by",
    label: "Added by",
    render: (r) => `${r.proposerName} · ${shortDate(r.enrolment.proposedAt)}`,
    text: (r) => `${r.proposerName} ${shortDate(r.enrolment.proposedAt)}`,
  },
  {
    key: "status",
    label: "Status",
    render: (r) => (
      <StatusPill tone={statusTone(r.enrolment.status)}>
        {statusText(r.enrolment.status)}
      </StatusPill>
    ),
    text: (r) => statusText(r.enrolment.status),
  },
];

/** One new store: photos, sheet, GPS and (for approvers) Approve / Reject with a reason. */
export function NewStoreDetail({
  row,
  canApprove,
  own,
  target,
  busy = false,
  onTarget,
  onSubmit,
}: {
  row: Row;
  canApprove: boolean;
  own: boolean;
  target: Decision | null;
  busy?: boolean;
  onTarget: (decision: Decision | null) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const contact = row.outlet.contacts?.[0];
  return (
    <section
      aria-label={`New store ${row.outlet.name}`}
      className="grid gap-3 rounded-xl border border-border p-4"
    >
      <h3 className="text-[17px] font-semibold text-foreground">
        {row.outlet.name}
      </h3>
      <p className="text-[14px] text-muted">
        {row.outlet.code} · {row.outlet.channel ?? "No channel"} · added by{" "}
        {row.proposerName} on {shortDate(row.enrolment.proposedAt)}
      </p>
      <p className="text-[14px]">
        {row.outlet.address ?? "No address"} · Contact:{" "}
        {contact
          ? `${contact.name}${contact.phone ? ` (${contact.phone})` : ""}`
          : "none"}
        {row.pin &&
          ` · GPS ${row.pin.latitude.toFixed(5)}, ${row.pin.longitude.toFixed(5)}`}
      </p>
      {row.enrolment.decisionReason && (
        <p className="text-[14px] text-muted">
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
            className="text-[14px] underline"
          >
            Customer information sheet
          </a>
        )}
      </div>
      {canApprove && row.enrolment.status === "pending" && (
        <div className="grid gap-1">
          <div className="flex gap-2">
            <button
              type="button"
              className={btn}
              disabled={own}
              onClick={() => onTarget("approved")}
            >
              Approve
            </button>
            <button
              type="button"
              className={btn}
              disabled={own}
              onClick={() => onTarget("rejected")}
            >
              Reject
            </button>
          </div>
          {own && (
            <p className="text-[13px] text-muted">
              Another approver must decide your own proposal.
            </p>
          )}
        </div>
      )}
      {target && (
        <form
          onSubmit={onSubmit}
          aria-label="New store decision"
          className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end"
        >
          <FormField
            label={target === "approved" ? "Approval reason" : "Rejection reason"}
          >
            <input name="reason" required />
          </FormField>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex h-9 items-center rounded-lg bg-foreground px-4 text-[13px] font-semibold text-background disabled:opacity-50"
          >
            {target === "approved" ? "Approve and give code" : "Reject store"}
          </button>
          <button type="button" className={btn} onClick={() => onTarget(null)}>
            Cancel
          </button>
        </form>
      )}
    </section>
  );
}

const PAGE = 50;

/**
 * CALL-07: approvers see pending new stores (ListPage), open one to check photos and the
 * customer information sheet, then approve (gives the customer code) or reject with a reason.
 * Salespeople see only their own new stores.
 */
export function NewStoreApprovals() {
  const [search, setSearch] = useState("");
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
      ? {
          ...(search ? { q: search } : {}),
          paginationOpts: { cursor: cursors.at(-1) ?? null, numItems: PAGE },
        }
      : "skip",
  );
  const mine = useQuery(
    api.outlets.enrolment.mine,
    canPropose && !canApprove
      ? { paginationOpts: { cursor: null, numItems: PAGE } }
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
  const [openId, setOpenId] = useState("");
  const [target, setTarget] = useState<Decision | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const onSearch = useCallback((q: string) => {
    setSearch(q);
    setCursors([null]);
  }, []);
  if (!canRead || !(canApprove || canPropose)) return null;

  const page = canApprove ? queue : mine;
  const rows = (page?.page ?? null) as Row[] | null;
  const open =
    rows?.find((r) => r.enrolment._id === openId) ??
    (rows?.length === 1 ? rows[0] : undefined);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!open || !target || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await decideNewStore(
        decide,
        open.enrolment._id,
        target,
        new FormData(event.currentTarget),
      );
      setNotice(
        target === "approved"
          ? `Store approved. Customer code ${result.code}.`
          : "Store rejected.",
      );
      setTarget(null);
      setOpenId("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-3" aria-label="New stores">
      <h2 className="text-[19px] font-semibold text-foreground">
        {canApprove ? "New stores to approve" : "My new stores"}
      </h2>
      {format && (
        <p className="text-[13px] text-muted">
          Customer codes are given on approval, e.g. {format.example}.
        </p>
      )}
      <ListPage
        noun={{ one: "new store", many: "new stores" }}
        rows={rows}
        total={
          page && page.isDone && cursors.length === 1 ? page.page.length : null
        }
        page={1}
        onPage={() => {}}
        q={search}
        onSearch={onSearch}
        searchPlaceholder="Search new stores"
        columns={COLUMNS}
        rowKey={(r) => r.enrolment._id}
        rowEnd={(r) => (
          <button
            type="button"
            className={btn}
            aria-pressed={open?.enrolment._id === r.enrolment._id}
            onClick={() => {
              setOpenId(r.enrolment._id);
              setTarget(null);
            }}
          >
            Open
          </button>
        )}
        loading={page === undefined}
      />
      {canApprove && (cursors.length > 1 || (queue && !queue.isDone)) && (
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
      {open && (
        <NewStoreDetail
          row={open}
          canApprove={canApprove}
          own={
            !!profile &&
            (profile._id === open.enrolment.proposedByProfileId ||
              profile.authSubject === open.enrolment.proposedBy)
          }
          target={target}
          busy={busy}
          onTarget={setTarget}
          onSubmit={submit}
        />
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {feed && feed.length > 0 && (
        <details className="text-[13px]">
          <summary className="cursor-pointer font-medium text-foreground">
            Recent updates
          </summary>
          <ul className="mt-2 grid gap-1 text-muted">
            {feed.map((item) => (
              <li key={item._id}>
                {shortDate(item.createdAt)} · {item.outletName} (
                {item.outletCode}) {eventLabel[item.kind]} by {item.actorName}
                {item.reason ? `: ${item.reason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
