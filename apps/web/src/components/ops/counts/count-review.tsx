"use client";

import { useState } from "react";
import {
  apiFetch,
  normalizeError,
  useApi,
  useApiPages,
  useLive,
  useMutate,
} from "@/lib/api";
import { DocNumber } from "../doc-number";
import { Peso, formatPeso } from "../peso";
import { formatCasesPieces, QtyCasesPieces } from "../qty-cases-pieces";
import { ReasonSelect, reasonNeeds, type ReasonCode } from "../reason-select";
import { StatusPill } from "../status-pill";
import {
  Chip,
  ErrorLine,
  MicroLabel,
  Panel,
  PrimaryButton,
  SecondaryButton,
} from "./ui";
import {
  approveHint,
  COUNTS_KEY,
  COUNTS_PATH,
  FINDING_LABEL,
  groupByBin,
  toleranceChip,
  type CountReview,
  type ReviewLine,
} from "./model";

type ReviewFilter =
  | "needs_review"
  | "all"
  | "auto"
  | "accepted"
  | "rejected"
  | "recount";

const TABS: { value: ReviewFilter; label: string }[] = [
  { value: "needs_review", label: "Needs your decision" },
  { value: "all", label: "All lines" },
  { value: "auto", label: "Accepted automatically" },
  { value: "accepted", label: "Accepted by you" },
  { value: "recount", label: "Recount" },
  { value: "rejected", label: "Left out" },
];

/** The navy summary card (Itemcount "stock and locations" look): the net peso difference first. */
export function ReviewSummary({ review }: { review: CountReview }) {
  const s = review.summary;
  const tol = review.tolerance;
  return (
    <div className="grid gap-3 rounded-2xl bg-[#1B263B] p-5 text-white">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <span className="text-xs font-bold uppercase tracking-wider text-[#BABEC8]">
            Net difference
          </span>
          <Peso
            centavos={s.netCentavos}
            className="text-4xl font-bold"
            negativeClassName="text-[#ff9b9b]"
          />
          <span className="text-sm text-[#BABEC8]">
            {s.withDifference} of {s.total} lines differ from the books
          </span>
        </div>
        <div className="flex gap-3">
          <div className="grid gap-1 rounded-xl bg-[#323D52] px-4 py-3">
            <span className="text-sm text-[#BABEC8]">Short</span>
            <Peso
              centavos={-s.shortCentavos}
              className="text-xl font-bold"
              negativeClassName="text-[#ff9b9b]"
            />
          </div>
          <div className="grid gap-1 rounded-xl bg-[#323D52] px-4 py-3">
            <span className="text-sm text-[#BABEC8]">Over</span>
            <Peso centavos={s.overCentavos} className="text-xl font-bold" />
          </div>
        </div>
      </div>
      {s.unpricedLines ? (
        <p className="text-sm text-[#ffd79b]">
          {s.unpricedLines} {s.unpricedLines === 1 ? "line has" : "lines have"} no
          cost on file, so the pesos above are not complete.
        </p>
      ) : null}
      <p className="text-sm text-[#BABEC8]">
        {tol.maxCentavos != null || tol.maxPieces != null
          ? `Differences up to ${[
              tol.maxCentavos != null ? formatPeso(tol.maxCentavos) : null,
              tol.maxPieces != null ? `${tol.maxPieces} pc` : null,
            ]
              .filter(Boolean)
              .join(" and ")} a line are accepted automatically.`
          : "Every difference needs a decision."}
        {tol.isDefault ? " (Default limit, not confirmed by Sunpride.)" : ""}
      </p>
    </div>
  );
}

function Figure({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <MicroLabel>{label}</MicroLabel>
      <span className="text-base font-semibold">{children}</span>
    </div>
  );
}

type Action = "accept" | "recount" | "reject";

/** One line in review. Presentational: shows the numbers and hands decisions to the screen. */
export function ReviewLineCard({
  line,
  showExpected,
  canDecide,
  active,
  onOpen,
  onClose,
  onDecide,
  busy,
  error,
}: {
  line: ReviewLine;
  showExpected: boolean;
  canDecide: boolean;
  active: Action | null;
  onOpen: (a: Action) => void;
  onClose: () => void;
  onDecide: (a: Action, input: { reasonCode?: string; note?: string }) => void;
  busy: boolean;
  error: string | null;
}) {
  const chip = toleranceChip(line);
  const variance = line.variance?.base ?? 0;
  const [reason, setReason] = useState<{ code: string; reason: ReasonCode | null }>({
    code: line.reasonCode ?? "",
    reason: null,
  });
  const [note, setNote] = useState(line.reviewNote ?? "");
  const needs = reasonNeeds(reason.reason);
  const tone =
    chip.tone === "good" ? "good" : chip.tone === "bad" ? "bad" : chip.tone === "warn" ? "warn" : "neutral";
  return (
    <li className="grid gap-3 rounded-2xl border border-border bg-surface p-4" data-line-id={line.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <span className="text-sm tabular-nums text-muted">{line.code}</span>
          <span className="line-clamp-2 text-lg font-semibold">{line.name}</span>
          <div className="flex flex-wrap items-center gap-2">
            {line.lotNumber ? <Chip>Batch {line.lotNumber}</Chip> : null}
            {line.source === "found" ? <Chip tone="info">Found item</Chip> : null}
            {line.finding ? (
              <Chip tone="warn">{FINDING_LABEL[line.finding]}</Chip>
            ) : null}
            {line.photoFileId ? <Chip>Photo</Chip> : null}
          </div>
        </div>
        <Chip tone={tone}>{chip.label}</Chip>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {showExpected && line.expected ? (
          <Figure label="Books say">
            <QtyCasesPieces base={line.expected.base} basePerCase={line.basePerCase} />
          </Figure>
        ) : null}
        <Figure label="Counted">
          <QtyCasesPieces base={line.counted?.base ?? null} basePerCase={line.basePerCase} />
        </Figure>
        {showExpected && line.variance ? (
          <Figure label="Difference">
            <span className={variance < 0 ? "text-danger" : variance > 0 ? "text-success" : ""}>
              {variance > 0 ? "+" : ""}
              {formatCasesPieces(variance, line.basePerCase)}
            </span>
          </Figure>
        ) : null}
        {showExpected && line.variance ? (
          <Figure label="Worth">
            {line.diffCentavos == null ? (
              <span className="text-muted">No cost yet</span>
            ) : (
              <Peso
                centavos={variance < 0 ? -line.diffCentavos : line.diffCentavos}
              />
            )}
          </Figure>
        ) : null}
      </div>
      {line.note ? (
        <p className="text-sm text-muted">Counter’s note: “{line.note}”</p>
      ) : null}
      {line.reviewNote && line.decision ? (
        <p className="text-sm text-muted">Decision note: “{line.reviewNote}”</p>
      ) : null}

      {canDecide && !active ? (
        <div className="flex flex-wrap gap-2">
          <PrimaryButton onClick={() => onOpen("accept")}>
            {line.decision === "accepted" ? "Change reason" : "Accept"}
          </PrimaryButton>
          <SecondaryButton onClick={() => onOpen("recount")}>Recount</SecondaryButton>
          <SecondaryButton onClick={() => onOpen("reject")}>Leave out</SecondaryButton>
        </div>
      ) : null}

      {active ? (
        <div className="grid gap-3 rounded-xl bg-default-soft p-3">
          {active === "accept" ? (
            variance !== 0 ? (
              <>
                <ReasonSelect
                  value={reason.code}
                  direction={variance > 0 ? "in" : "out"}
                  label="Why is it different?"
                  onChange={(code, r) => setReason({ code, reason: r })}
                />
                {needs.length ? (
                  <p className="text-sm text-muted">This reason needs {needs.join(" and ")}.</p>
                ) : null}
              </>
            ) : (
              <p className="text-sm">The count matches the books. Nothing to explain.</p>
            )
          ) : null}
          <label className="grid gap-1">
            <MicroLabel>
              {active === "reject" ? "Why leave it out? (required)" : "Note"}
            </MicroLabel>
            <input
              className="min-h-12 rounded-[10px] border border-field-border bg-field-background px-3 text-base"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <ErrorLine message={error} />
          <div className="flex flex-wrap justify-end gap-2">
            <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
            <PrimaryButton
              disabled={
                busy ||
                (active === "accept" && variance !== 0 && !reason.code) ||
                (active === "reject" && !note.trim())
              }
              onClick={() =>
                onDecide(active, {
                  ...(active === "accept" && variance !== 0 ? { reasonCode: reason.code } : {}),
                  ...(note.trim() ? { note: note.trim() } : {}),
                })
              }
            >
              {active === "accept"
                ? "Accept this line"
                : active === "recount"
                  ? "Ask for a recount"
                  : "Leave it out"}
            </PrimaryButton>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Count review: lines sorted by peso difference, a tolerance chip on each, accept / recount / leave out per line,
 * then one approval that posts the adjustment. On a blind count the counter never gets here (the API refuses).
 */
export function CountReviewScreen({
  sessionId,
  onApproved,
}: {
  sessionId: string;
  onApproved?: (result: { adjustmentNumber: string | null }) => void;
}) {
  const [filter, setFilter] = useState<ReviewFilter>("needs_review");
  const [sort, setSort] = useState<"diff" | "bin">("diff");
  const [active, setActive] = useState<{ lineId: string; action: Action } | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);
  const { mutate, pending, error } = useMutate();
  const headKey = [...COUNTS_KEY, "review", sessionId, "head"];
  const head = useApi<CountReview>(headKey, ({ signal }) =>
    apiFetch<CountReview>(`${COUNTS_PATH}/review`, {
      query: { sessionId, limit: 1 },
      signal,
    }),
  );
  const pages = useApiPages<ReviewLine>(
    [...COUNTS_KEY, "review", sessionId, { filter, sort }],
    async (cursor, { signal }) => {
      const r = await apiFetch<CountReview>(`${COUNTS_PATH}/review`, {
        query: { sessionId, filter, sort, limit: 50, cursor: cursor ?? undefined },
        signal,
      });
      return { items: r.lines, nextCursor: r.nextCursor };
    },
  );
  useLive("inventory", [COUNTS_KEY]);
  const review = head.data;
  const lines = pages.items ?? [];

  async function decide(
    lineId: string,
    action: Action,
    input: { reasonCode?: string; note?: string },
  ) {
    setLineError(null);
    const body =
      action === "recount"
        ? { sessionId, lineIds: [lineId], ...(input.note ? { note: input.note } : {}) }
        : {
            sessionId,
            lineId,
            decision: action === "accept" ? "accepted" : "rejected",
            ...input,
          };
    try {
      await mutate(
        `${COUNTS_PATH}/${action === "recount" ? "request-recount" : "review"}`,
        body,
        { idempotencyKey: crypto.randomUUID(), invalidate: [COUNTS_KEY] },
      );
      setActive(null);
    } catch (e) {
      setLineError(normalizeError(e).message);
    }
  }
  async function approve() {
    setLineError(null);
    try {
      const r = await mutate<{ adjustmentNumber?: string | null }>(
        `${COUNTS_PATH}/approve`,
        { sessionId },
        { idempotencyKey: crypto.randomUUID(), invalidate: [COUNTS_KEY] },
      );
      onApproved?.({ adjustmentNumber: r.adjustmentNumber ?? null });
    } catch (e) {
      setLineError(normalizeError(e).message);
    }
  }

  const hint = review ? approveHint(review.summary) : null;
  const final = review?.session.status === "posted";
  return (
    <div className="grid gap-4 pb-28">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">
            Review {review?.session.title ?? "count"}
          </h1>
          {review ? (
            <span className="text-sm text-muted">
              <DocNumber value={review.session.number} /> · {review.session.scope}
            </span>
          ) : null}
        </div>
        {review ? <StatusPill state={review.session.status} /> : null}
      </header>

      {review ? <ReviewSummary review={review} /> : <p className="text-muted">Loading the count…</p>}

      {review && !review.canSeeExpected ? (
        <Panel>
          <p>
            You counted this one, so what the books say stays hidden. A
            different person needs to review and approve it.
          </p>
        </Panel>
      ) : null}

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Show lines">
        {TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            type="button"
            aria-selected={filter === t.value}
            className={`min-h-12 rounded-full border px-4 font-medium ${filter === t.value ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface"}`}
            onClick={() => setFilter(t.value)}
          >
            {t.label}
            {review && t.value === "needs_review" ? ` · ${review.summary.needsReview}` : ""}
            {review && t.value === "recount" && review.summary.recount
              ? ` · ${review.summary.recount}`
              : ""}
          </button>
        ))}
        <button
          type="button"
          className="ml-auto min-h-12 rounded-full border border-border bg-surface px-4 font-medium"
          onClick={() => setSort((s) => (s === "diff" ? "bin" : "diff"))}
        >
          {sort === "diff" ? "Biggest difference first" : "In bin order"}
        </button>
      </div>

      {pages.status === "loading" ? <p className="text-muted">Loading lines…</p> : null}
      {sort === "bin" ? (
        groupByBin(lines).map((g) => (
          <section key={g.bin} className="grid gap-3" aria-label={`Bin ${g.bin}`}>
            <MicroLabel>Bin {g.bin}</MicroLabel>
            <ul className="grid gap-3">
              {g.lines.map((l) => renderLine(l))}
            </ul>
          </section>
        ))
      ) : (
        <ul className="grid gap-3">{lines.map((l) => renderLine(l))}</ul>
      )}
      {pages.status === "exhausted" && !lines.length ? (
        <Panel>
          <p>
            {filter === "needs_review"
              ? "No lines need a decision."
              : "No lines here."}
          </p>
        </Panel>
      ) : null}
      {pages.status === "canLoadMore" || pages.status === "loadingMore" ? (
        <SecondaryButton
          disabled={pages.status === "loadingMore"}
          onClick={() => void pages.loadMore()}
        >
          Show more
        </SecondaryButton>
      ) : null}

      <footer className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
          <span className="text-base">
            {final
              ? "This count is posted."
              : hint ?? "Every line is decided. Approve to update the stock."}
          </span>
          <PrimaryButton
            disabled={pending || !review || !review.canApprove || Boolean(hint) || final}
            onClick={() => void approve()}
          >
            Approve count
          </PrimaryButton>
        </div>
        <ErrorLine message={!active ? (lineError ?? error?.message) : null} />
      </footer>
    </div>
  );

  function renderLine(l: ReviewLine) {
    return (
      <ReviewLineCard
        key={l.id}
        line={l}
        showExpected={review?.canSeeExpected ?? false}
        canDecide={Boolean(review?.canApprove) && !final}
        active={active?.lineId === l.id ? active.action : null}
        onOpen={(action) => {
          setLineError(null);
          setActive({ lineId: l.id, action });
        }}
        onClose={() => setActive(null)}
        onDecide={(action, input) => void decide(l.id, action, input)}
        busy={pending}
        error={active?.lineId === l.id ? lineError : null}
      />
    );
  }
}
