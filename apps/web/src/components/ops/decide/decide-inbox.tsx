"use client";

import { Button } from "@heroui/react";
import { Card, FormField, Notice } from "@sunpride/ui";
import Link from "next/link";
import { useState } from "react";
import { apiFetch, useApi, useLive, useMutate } from "@/lib/api";
import { DocNumber } from "../doc-number";
import { Peso } from "../peso";
import { StatusPill } from "../status-pill";
import { useIntent } from "../transfers/use-intent";
import {
  ageText,
  CHARGE_CHOICES,
  decideBody,
  decideProblems,
  filterItems,
  openLabel,
  verdictLabels,
  type DecideForm,
  type DecideInboxData,
  type DecideItem,
  type DecideKind,
} from "./decide-model";

const field =
  "min-h-12 w-full rounded-[10px] border border-field-border bg-field-background px-3 text-base";

/** One approval: what, who asked, how much, how old, the rule that sent it here, and one Approve / Reject. */
export function DecideRow({
  item,
  now,
  open,
  form,
  onOpen,
  onForm,
  onCancel,
  onSend,
  pending,
  error,
}: {
  item: DecideItem;
  now: number;
  open: boolean;
  form: DecideForm;
  onOpen: (verdict: "approve" | "reject") => void;
  onForm: (form: DecideForm) => void;
  onCancel: () => void;
  onSend: () => void;
  pending?: boolean;
  error?: string | null;
}) {
  const labels = verdictLabels(item.kind, item.extra?.forced === true);
  const problems = open ? decideProblems(item, form) : [];
  return (
    <li className="grid gap-3 px-4 py-4" data-kind={item.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-border bg-surface px-3 py-1 text-sm font-medium">
          {item.kindLabel}
        </span>
        {item.documentNumber ? <DocNumber value={item.documentNumber} /> : null}
        {item.sentBack ? (
          <StatusPill state="needs_review">Sent back</StatusPill>
        ) : null}
        <span className="ml-auto text-sm text-muted">
          waiting {ageText(item.askedAt, now)}
        </span>
      </div>
      <p className="text-base font-medium">{item.title}</p>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
        <span>
          Asked by{" "}
          <span className="font-medium text-foreground">
            {item.askedBy ?? "the system"}
          </span>
        </span>
        {item.valueCentavos != null ? (
          <span>
            Worth <Peso centavos={item.valueCentavos} className="font-medium text-foreground" />
          </span>
        ) : null}
      </p>
      {item.lines.length ? (
        <dl className="grid gap-1 text-sm sm:grid-cols-2">
          {item.lines.map((l) => (
            <div key={l.label} className="flex gap-2">
              <dt className="text-muted">{l.label}:</dt>
              <dd className="font-medium">{l.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {item.rule ? (
        <p className="text-sm">
          <span className="font-medium">Why it is here:</span> {item.rule}
        </p>
      ) : null}
      {item.sentBack ? (
        <p className="text-sm text-warning">
          Sent back{item.sentBack.by ? ` by ${item.sentBack.by}` : ""}:{" "}
          {item.sentBack.reason}
        </p>
      ) : null}
      <p
        className={`text-sm ${item.canDecide || item.openOnly ? "text-muted" : "font-medium text-danger"}`}
      >
        {item.canDecide || item.openOnly
          ? item.makerChecker
          : (item.blockedReason ?? item.makerChecker)}
      </p>
      {open ? (
        <div className="grid gap-3 rounded-[10px] border border-border bg-surface p-3">
          {form.verdict === "approve" && item.needs.chargeTo ? (
            <FormField label="Who carries the difference">
              <select
                className={field}
                value={form.chargeTo}
                onChange={(e) => onForm({ ...form, chargeTo: e.target.value })}
              >
                <option value="">Choose</option>
                {CHARGE_CHOICES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </FormField>
          ) : null}
          <FormField
            label={
              form.verdict === "reject"
                ? "Why are you rejecting this?"
                : "Note (optional)"
            }
          >
            <input
              className={field}
              value={form.reason}
              maxLength={300}
              onChange={(e) => onForm({ ...form, reason: e.target.value })}
            />
          </FormField>
          {problems.length ? (
            <p role="status" className="text-sm text-danger">
              {problems[0]}
            </p>
          ) : null}
          {error ? <Notice tone="danger" title={error} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant={form.verdict === "approve" ? "primary" : "danger"}
              isDisabled={pending || problems.length > 0}
              onPress={onSend}
              className="min-h-12"
            >
              {pending
                ? "Sending…"
                : form.verdict === "approve"
                  ? labels.approve
                  : labels.reject}
            </Button>
            <Button variant="secondary" onPress={onCancel} className="min-h-12">
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {item.canDecide ? (
            <>
              <Button
                variant="primary"
                className="min-h-12"
                onPress={() => onOpen("approve")}
              >
                {labels.approve}
              </Button>
              <Button
                variant="secondary"
                className="min-h-12"
                onPress={() => onOpen("reject")}
              >
                {labels.reject}
              </Button>
            </>
          ) : null}
          {item.link ? (
            <Link
              href={item.link}
              className="inline-flex min-h-12 items-center rounded-[10px] border border-border px-4 text-base font-medium"
            >
              {openLabel(item.kind, item.openOnly)}
            </Link>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** The whole inbox as a pure view: filter chips with counts, one row per approval, recent decisions. */
export function DecideInboxView({
  heading = true,
  data,
  kind,
  onKind,
  openId,
  form,
  onOpen,
  onForm,
  onCancel,
  onSend,
  pending,
  error,
}: {
  /** Off when a page already has the heading. */
  heading?: boolean;
  data: DecideInboxData;
  kind: DecideKind | null;
  onKind: (kind: DecideKind | null) => void;
  openId: string | null;
  form: DecideForm;
  onOpen: (item: DecideItem, verdict: "approve" | "reject") => void;
  onForm: (form: DecideForm) => void;
  onCancel: () => void;
  onSend: (item: DecideItem) => void;
  pending?: boolean;
  error?: string | null;
}) {
  const kinds = (Object.keys(data.kinds) as DecideKind[]).filter(
    (k) => (data.counts[k] ?? 0) > 0,
  );
  const shown = filterItems(data.items, kind);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {heading ? <h1 className="text-2xl font-semibold">Decide</h1> : <span />}
        <p className="text-base text-muted">
          {data.total === 0
            ? "Nothing is waiting for you."
            : `${data.total} ${data.total === 1 ? "item is" : "items are"} waiting.`}
        </p>
      </div>
      {data.warnings.length ? (
        <Notice
          tone="warning"
          title="Some lists could not be read just now."
          meta={data.warnings.map((w) => w.message).join(" ")}
        />
      ) : null}
      <div
        className="flex gap-2 overflow-x-auto pb-1"
        role="tablist"
        aria-label="Kinds of approval"
      >
        <button
          type="button"
          role="tab"
          aria-selected={kind === null}
          onClick={() => onKind(null)}
          className={`min-h-12 shrink-0 rounded-full border px-4 text-base ${kind === null ? "border-accent bg-accent-soft font-medium" : "border-border bg-surface"}`}
        >
          Everything {data.total}
        </button>
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            onClick={() => onKind(kind === k ? null : k)}
            className={`min-h-12 shrink-0 rounded-full border px-4 text-base ${kind === k ? "border-accent bg-accent-soft font-medium" : "border-border bg-surface"}`}
          >
            {data.kinds[k]} {data.counts[k]}
          </button>
        ))}
      </div>
      <Card label="Waiting" count={shown.length} flush>
        {shown.length ? (
          <ul className="divide-y divide-separator">
            {shown.map((item) => (
              <DecideRow
                key={item.id}
                item={item}
                now={data.asOf}
                open={openId === item.id}
                form={form}
                onOpen={(v) => onOpen(item, v)}
                onForm={onForm}
                onCancel={onCancel}
                onSend={() => onSend(item)}
                pending={pending}
                error={openId === item.id ? error : null}
              />
            ))}
          </ul>
        ) : (
          <p className="p-4 text-base text-muted">
            {kind
              ? "Nothing of this kind is waiting."
              : "All clear. Approvals show up here the moment someone asks."}
          </p>
        )}
      </Card>
      {data.recent.length ? (
        <Card label="Decided recently" count={data.recent.length} flush>
          <ul className="divide-y divide-separator">
            {data.recent.map((r) => (
              <li
                key={`${r.kind}:${r.refId}:${r.at}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"
              >
                <span
                  className={`font-medium ${r.verdict === "approved" ? "text-success" : "text-danger"}`}
                >
                  {r.verdict === "approved" ? "Approved" : "Rejected"}
                </span>
                {r.documentNumber ? <DocNumber value={r.documentNumber} /> : null}
                <span>{r.reason}</span>
                {r.valueCentavos != null ? <Peso centavos={r.valueCentavos} /> : null}
                <span className="ml-auto text-muted">
                  {r.by} · {ageText(r.at, data.asOf)} ago
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

const EMPTY: DecideForm = { verdict: "approve", reason: "", chargeTo: "" };

/** The Decide inbox: one queue for every approval (loads, transfer differences, counts, bad orders, till counts, overrides). */
export function DecideInbox({ heading = true }: { heading?: boolean }) {
  const inbox = useApi<DecideInboxData>(["decide", "inbox"], ({ signal }) =>
    apiFetch<DecideInboxData>("/api/v1/decide/inbox", { signal }),
  );
  useLive(["inventory", "van", "storepos"], [["decide"]]);
  const [kind, setKind] = useState<DecideKind | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<DecideForm>(EMPTY);
  const [done, setDone] = useState<string | null>(null);
  const write = useMutate();
  const intent = useIntent();
  if (inbox.error)
    return (
      <Notice
        tone="danger"
        title="The Decide list could not load."
        meta="Check your connection and try again."
      />
    );
  if (!inbox.data) return <p className="text-sm text-muted">Loading…</p>;
  const path = "/api/v1/decide/act";
  return (
    <div className="grid gap-3">
      {done ? <Notice tone="success" title={done} /> : null}
      <DecideInboxView
        heading={heading}
        data={inbox.data}
        kind={kind}
        onKind={setKind}
        openId={openId}
        form={form}
        onOpen={(item, verdict) => {
          setDone(null);
          setOpenId(item.id);
          setForm({ ...EMPTY, verdict });
        }}
        onForm={setForm}
        onCancel={() => setOpenId(null)}
        pending={write.pending}
        error={write.error?.message ?? null}
        onSend={async (item) => {
          const { idempotencyKey: unused, ...rest } = decideBody(item, form, "");
          void unused;
          try {
            const res = await write.mutate<{ status: string }>(
              path,
              intent.withKey(path, rest),
              {
                invalidate: [
                  ["decide"],
                  ["inventory"],
                  ["van"],
                  ["storepos"],
                ],
              },
            );
            intent.done(path, rest);
            setOpenId(null);
            setDone(`${item.documentNumber ?? item.kindLabel}: ${res?.status ?? "Done."}`);
          } catch {
            // The server's own words are shown under the form.
          }
        }}
      />
    </div>
  );
}
