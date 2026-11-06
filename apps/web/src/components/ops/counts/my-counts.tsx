"use client";

import { apiFetch, useApi, useLive } from "@/lib/api";
import { DocNumber } from "../doc-number";
import { StatusPill } from "../status-pill";
import { Chip, MicroLabel, Panel, PrimaryButton, ProgressBar, SecondaryButton } from "./ui";
import { COUNTS_KEY, COUNTS_PATH, type CountCard, type MyCounts } from "./model";

/** "Planned for 6 Nov" / "Waiting since …" in plain words. */
function when(card: CountCard): string | null {
  if (card.scheduledFor) {
    const d = new Date(`${card.scheduledFor}T00:00:00+08:00`);
    return `For ${d.toLocaleDateString("en-PH", { day: "numeric", month: "short" })}`;
  }
  return null;
}

function CountRow({
  card,
  action,
  actionLabel,
  extra,
}: {
  card: CountCard;
  action: () => void;
  actionLabel: string;
  extra?: string;
}) {
  const { progress } = card;
  return (
    <Panel className="grid gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <span className="text-lg font-semibold">
            {card.title ?? card.location ?? "Stock count"}
          </span>
          <span className="text-sm text-muted">
            {card.location ?? "—"} · {card.scope}
          </span>
          <DocNumber value={card.number} className="text-sm text-muted" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {card.blindCount ? <Chip tone="info">Blind count</Chip> : null}
          {progress.recount > 0 ? (
            <Chip tone="warn">
              {progress.recount} to recount
            </Chip>
          ) : null}
          <StatusPill state={card.status} />
        </div>
      </div>
      <ProgressBar
        done={progress.counted}
        total={progress.total}
        label={`${progress.counted} of ${progress.total} counted`}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted">
          {[when(card), extra].filter(Boolean).join(" · ")}
        </span>
        <PrimaryButton onClick={action}>{actionLabel}</PrimaryButton>
      </div>
    </Panel>
  );
}

/**
 * My counts: the counts handed to me, and (for supervisors) the counts waiting for a decision.
 * Queue first: the next thing to do is the biggest button on the card.
 */
export function MyCounts({
  onOpen,
  onReview,
  onPlan,
}: {
  onOpen: (sessionId: string) => void;
  onReview?: (sessionId: string) => void;
  /** Shows "Plan a count" for people who may plan. */
  onPlan?: () => void;
}) {
  const result = useApi<MyCounts>([...COUNTS_KEY, "mine"], ({ signal }) =>
    apiFetch<MyCounts>(`${COUNTS_PATH}/mine`, { signal }),
  );
  useLive("inventory", [COUNTS_KEY]);
  const data = result.data;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">My counts</h1>
        {onPlan ? (
          <SecondaryButton onClick={onPlan}>Plan a count</SecondaryButton>
        ) : null}
      </div>
      {result.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          Could not load your counts. Check your connection and try again.
        </p>
      ) : null}
      {result.isLoading || !data ? (
        <p className="text-muted">Loading your counts…</p>
      ) : (
        <>
          <section className="grid gap-3" aria-label="Counts to do">
            <MicroLabel>To count · {data.mine.length}</MicroLabel>
            {data.mine.length ? (
              data.mine.map((c) => (
                <CountRow
                  key={c.id}
                  card={c}
                  action={() => onOpen(c.id)}
                  actionLabel={
                    c.progress.counted === 0 ? "Start counting" : "Continue counting"
                  }
                />
              ))
            ) : (
              <Panel>
                <p className="text-base">
                  No counts waiting for you. When a supervisor plans one for
                  you, it shows up here.
                </p>
              </Panel>
            )}
          </section>
          {data.toReview.length ? (
            <section className="grid gap-3" aria-label="Counts to review">
              <MicroLabel>Waiting for your review · {data.toReview.length}</MicroLabel>
              {data.toReview.map((c) => (
                <CountRow
                  key={c.id}
                  card={c}
                  action={() => onReview?.(c.id)}
                  actionLabel="Review count"
                  extra={
                    c.progress.needsReview
                      ? `${c.progress.needsReview} ${c.progress.needsReview === 1 ? "line needs" : "lines need"} a decision`
                      : "Nothing to decide, ready to approve"
                  }
                />
              ))}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
