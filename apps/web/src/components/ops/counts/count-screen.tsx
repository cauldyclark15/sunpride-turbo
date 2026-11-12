"use client";
import { formatDate } from "../../../lib/format";

import { useEffect, useRef, useState } from "react";
import {
  apiFetch,
  normalizeError,
  useApi,
  useApiPages,
  useLive,
  useMutate,
} from "@/lib/api";
import { CasesPiecesStepper, formatCasesPieces } from "../qty-cases-pieces";
import { DocNumber } from "../doc-number";
import {
  ErrorLine,
  Chip,
  MicroLabel,
  Panel,
  PrimaryButton,
  ProgressBar,
  SecondaryButton,
} from "./ui";
import {
  applyScan,
  COUNT_TABS,
  COUNTS_KEY,
  COUNTS_PATH,
  draftFromLine,
  entryFromDraft,
  FINDING_CHOICES,
  FINDING_LABEL,
  groupByBin,
  isCounted,
  type CountHead,
  type CountLine,
  type CountTab,
  type Draft,
  type Finding,
} from "./model";

const SAVE_DELAY_MS = 700;

/** Days left on a batch, in plain words. */
export function expiryText(expiresAt: number | null, now = Date.now()) {
  if (expiresAt == null) return null;
  const days = Math.ceil((expiresAt - now) / 86400000);
  const date = formatDate(expiresAt);
  return days < 0
    ? `expired ${date}`
    : `expires ${date} (${days} ${days === 1 ? "day" : "days"})`;
}

const SAVE_TEXT: Record<Draft["state"], string> = {
  idle: "Not counted yet",
  editing: "Not saved yet",
  saving: "Saving…",
  saved: "Saved",
  error: "Couldn't save",
};

/** One line to count. Presentational: the screen owns the drafts and the saving. */
export function CountLineCard({
  line,
  draft,
  showExpected,
  onChange,
  onRetry,
  onPickPhoto,
}: {
  line: CountLine;
  /** What is on screen for this line (the saved number, or what is being typed). */
  draft: Draft;
  showExpected: boolean;
  onChange: (next: Draft) => void;
  onRetry: () => void;
  onPickPhoto?: () => void;
}) {
  const counted = isCounted(line, draft);
  const expiry = expiryText(line.expiresAt);
  return (
    <li
      className={`grid gap-3 rounded-2xl border bg-surface p-4 ${line.needsRecount ? "border-warning" : "border-border"}`}
      data-line-id={line.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <span className="text-sm tabular-nums text-muted">{line.code}</span>
          <span className="line-clamp-2 text-lg font-semibold">
            {line.name}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {line.lotNumber ? (
              <Chip>
                Batch {line.lotNumber}
                {expiry ? ` · ${expiry}` : ""}
              </Chip>
            ) : null}
            {line.stockStatus !== "available" ? (
              <Chip tone="warn">{line.stockStatus.replaceAll("_", " ")}</Chip>
            ) : null}
            {line.source === "found" ? (
              <Chip tone="info">Found item</Chip>
            ) : null}
          </div>
        </div>
        <div className="grid justify-items-end gap-1 text-right">
          {showExpected && line.expected ? (
            <span className="text-sm text-muted">
              Books say{" "}
              <strong className="tabular-nums text-foreground">
                {formatCasesPieces(line.expected.base, line.basePerCase)}
              </strong>
            </span>
          ) : null}
          <span
            className={`text-sm font-medium ${draft.state === "error" ? "text-danger" : counted ? "text-success" : "text-muted"}`}
          >
            {SAVE_TEXT[draft.state]}
          </span>
        </div>
      </div>

      {line.needsRecount ? (
        <p className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">
          Please count this again.
          {line.recountNote ? ` “${line.recountNote}”` : ""}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <CasesPiecesStepper
          value={{ cases: draft.cases, pieces: draft.pieces }}
          basePerCase={line.basePerCase}
          onChange={(next) => onChange({ ...draft, ...next, state: "editing" })}
        />
        <SecondaryButton
          onClick={() =>
            onChange({ ...draft, cases: 0, pieces: 0, state: "editing" })
          }
        >
          None here
        </SecondaryButton>
      </div>

      {draft.state === "error" ? (
        <SecondaryButton onClick={onRetry}>
          Couldn’t save. Tap to try again
        </SecondaryButton>
      ) : null}

      <details className="text-sm">
        <summary className="cursor-pointer select-none py-2 font-medium text-accent">
          {draft.finding
            ? `Problem: ${FINDING_LABEL[draft.finding]}`
            : "Something wrong with it?"}
        </summary>
        <div className="grid gap-3 pt-2">
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="What is wrong"
          >
            {FINDING_CHOICES.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={draft.finding === f.value}
                className={`min-h-12 rounded-xl border px-4 font-medium ${draft.finding === f.value ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface"}`}
                onClick={() =>
                  onChange({
                    ...draft,
                    finding:
                      draft.finding === f.value ? null : (f.value as Finding),
                    state: "editing",
                  })
                }
              >
                {f.label}
              </button>
            ))}
          </div>
          <label className="grid gap-1">
            <MicroLabel>Note (optional)</MicroLabel>
            <textarea
              className="min-h-20 rounded-[10px] border border-field-border bg-field-background p-3 text-base"
              value={draft.note}
              maxLength={500}
              onChange={(e) =>
                onChange({ ...draft, note: e.target.value, state: "editing" })
              }
            />
          </label>
          {onPickPhoto ? (
            <div className="flex items-center gap-3">
              <SecondaryButton onClick={onPickPhoto}>
                {draft.photoFileId ? "Change photo" : "Add photo"}
              </SecondaryButton>
              {draft.photoFileId ? (
                <span className="text-sm text-success">Photo added</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </details>
    </li>
  );
}

type Found = {
  id: string;
  code: string;
  name: string;
  tracking: string;
  basePerCase: number | null;
};

/** Add something the list did not have: a found item, or a batch that is on the shelf but not on the list. */
export function FoundItemPanel({
  sessionId,
  onClose,
  onAdded,
}: {
  sessionId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Found | null>(null);
  const [lot, setLot] = useState("");
  const [qty, setQty] = useState({ cases: 0, pieces: 0 });
  const [note, setNote] = useState("");
  const [wrongBatch, setWrongBatch] = useState(false);
  const { mutate, pending, error } = useMutate();
  const results = useApi<Found[]>(
    search.trim().length >= 2 && !picked
      ? [...COUNTS_KEY, "find-products", search.trim()]
      : null,
    ({ signal }) =>
      apiFetch<Found[]>(`${COUNTS_PATH}/find-products`, {
        query: { q: search.trim() },
        signal,
      }),
  );
  const key = useRef(crypto.randomUUID());
  async function add() {
    if (!picked) return;
    const base =
      qty.cases *
        (picked.basePerCase && picked.basePerCase > 1
          ? picked.basePerCase
          : 0) +
      qty.pieces;
    await mutate(
      `${COUNTS_PATH}/add-line`,
      {
        sessionId,
        productId: picked.id,
        ...(lot.trim() ? { lotNumber: lot.trim() } : {}),
        countedBase: base,
        ...(wrongBatch ? { finding: "wrong_lot" } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        clientOpId: key.current,
      },
      { idempotencyKey: key.current, invalidate: [COUNTS_KEY] },
    );
    onAdded();
  }
  return (
    <Panel className="grid gap-3" aria-label="Found item">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Found item</h2>
        <SecondaryButton onClick={onClose}>Close</SecondaryButton>
      </div>
      {!picked ? (
        <>
          <label className="grid gap-1">
            <MicroLabel>Find the product</MicroLabel>
            <input
              className="min-h-12 rounded-[10px] border border-field-border bg-field-background px-3 text-base"
              placeholder="Type a code or a name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <ul className="grid gap-2">
            {(results.data ?? []).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="min-h-12 w-full rounded-xl border border-border bg-surface px-4 text-left"
                  onClick={() => setPicked(p)}
                >
                  <span className="text-sm text-muted">{p.code}</span>{" "}
                  <span className="font-semibold">{p.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="text-base">
            <span className="text-sm text-muted">{picked.code}</span>{" "}
            <strong>{picked.name}</strong>
          </p>
          {picked.tracking === "lot" ? (
            <label className="grid gap-1">
              <MicroLabel>Batch number</MicroLabel>
              <input
                className="min-h-12 rounded-[10px] border border-field-border bg-field-background px-3 text-base"
                value={lot}
                onChange={(e) => setLot(e.target.value)}
              />
            </label>
          ) : null}
          <CasesPiecesStepper
            value={qty}
            basePerCase={picked.basePerCase}
            onChange={setQty}
          />
          <label className="flex min-h-12 items-center gap-3">
            <input
              type="checkbox"
              className="size-6"
              checked={wrongBatch}
              onChange={(e) => setWrongBatch(e.target.checked)}
            />
            <span>This is the wrong batch for this shelf</span>
          </label>
          <label className="grid gap-1">
            <MicroLabel>Note (optional)</MicroLabel>
            <input
              className="min-h-12 rounded-[10px] border border-field-border bg-field-background px-3 text-base"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <ErrorLine message={error?.message} />
          <div className="flex justify-between gap-2">
            <SecondaryButton onClick={() => setPicked(null)}>
              Back
            </SecondaryButton>
            <PrimaryButton
              disabled={pending || (qty.cases === 0 && qty.pieces === 0)}
              onClick={() => void add().catch(() => undefined)}
            >
              Add to count
            </PrimaryButton>
          </div>
        </>
      )}
    </Panel>
  );
}

/**
 * Count: the counter's screen. Bin order, scan, cases + pieces, every line saves on its own.
 * On a blind count it never shows what the books say. Mount it under any route; it needs only a session id.
 */
export function CountScreen({
  sessionId,
  onFinished,
  onPickPhoto,
  deviceLabel,
}: {
  sessionId: string;
  onFinished?: () => void;
  /** Host supplies the camera/upload; returns the uploaded file id, or null if cancelled. */
  onPickPhoto?: (lineId: string) => Promise<string | null>;
  deviceLabel?: string;
}) {
  const [tab, setTab] = useState<CountTab>("todo");
  const [query, setQuery] = useState("");
  const [scan, setScan] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [foundOpen, setFoundOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const latest = useRef<{
    drafts: Record<string, Draft>;
    lines: Map<string, CountLine>;
  }>({
    drafts: {},
    lines: new Map(),
  });
  const { mutate, pending, error } = useMutate();
  const headKey = [...COUNTS_KEY, "lines", sessionId, "head"];

  const head = useApi<CountHead>(headKey, ({ signal }) =>
    apiFetch<CountHead>(`${COUNTS_PATH}/lines`, {
      query: { sessionId, limit: 1 },
      signal,
    }),
  );
  const pages = useApiPages<CountLine>(
    [...COUNTS_KEY, "lines", sessionId, { tab, q: query }],
    async (cursor, { signal }) => {
      const r = await apiFetch<CountHead>(`${COUNTS_PATH}/lines`, {
        query: {
          sessionId,
          filter: tab,
          q: query || undefined,
          limit: 50,
          cursor: cursor ?? undefined,
        },
        signal,
      });
      return { items: r.lines, nextCursor: r.nextCursor };
    },
  );
  useLive("inventory", [COUNTS_KEY]);

  const lines = pages.items ?? [];
  const info = head.data;
  const showExpected = info?.canSeeExpected ?? false;
  const loaded = pages.items;
  useEffect(() => {
    // Saving reads the lines from here (event handlers only), never during render.
    for (const l of loaded ?? []) latest.current.lines.set(l.id, l);
  }, [loaded]);

  function setDraft(lineId: string, next: Draft) {
    setDrafts((d) => {
      const all = { ...d, [lineId]: next };
      latest.current.drafts = all;
      return all;
    });
  }
  function patchDrafts(ids: string[], state: Draft["state"]) {
    setDrafts((d) => {
      const all = { ...d };
      for (const id of ids) if (all[id]) all[id] = { ...all[id], state };
      latest.current.drafts = all;
      return all;
    });
  }
  async function saveLines(ids: string[]) {
    const entries = ids.flatMap((id) => {
      const line = latest.current.lines.get(id);
      const draft = latest.current.drafts[id];
      return line && draft
        ? [entryFromDraft(line, draft, crypto.randomUUID())]
        : [];
    });
    if (!entries.length) return;
    patchDrafts(ids, "saving");
    try {
      await mutate(
        `${COUNTS_PATH}/save-lines`,
        { sessionId, lines: entries, ...(deviceLabel ? { deviceLabel } : {}) },
        { idempotencyKey: crypto.randomUUID(), invalidate: [headKey] },
      );
      patchDrafts(ids, "saved");
      setNotice(null);
    } catch (e) {
      patchDrafts(ids, "error");
      setNotice(normalizeError(e).message);
    }
  }
  function change(lineId: string, next: Draft) {
    setDraft(lineId, next);
    clearTimeout(timers.current[lineId]);
    timers.current[lineId] = setTimeout(
      () => void saveLines([lineId]),
      SAVE_DELAY_MS,
    );
  }
  function runScan() {
    const r = applyScan(lines, latest.current.drafts, scan);
    if ("error" in r) {
      setNotice(r.error);
      return;
    }
    setNotice(null);
    setScan("");
    change(r.lineId, r.draft);
  }
  async function finish(allowUncounted: boolean) {
    for (const t of Object.values(timers.current)) clearTimeout(t);
    const dirty = Object.entries(latest.current.drafts)
      .filter(([, d]) => d.state === "editing" || d.state === "error")
      .map(([id]) => id);
    await saveLines(dirty);
    try {
      await mutate(
        `${COUNTS_PATH}/submit`,
        { sessionId, ...(allowUncounted ? { allowUncounted: true } : {}) },
        { idempotencyKey: crypto.randomUUID(), invalidate: [COUNTS_KEY] },
      );
      onFinished?.();
    } catch (e) {
      setNotice(normalizeError(e).message);
    }
  }

  const progress = info?.progress;
  const todo = progress ? progress.total - progress.counted : 0;
  const groups = groupByBin(lines);
  return (
    <div className="grid gap-4 pb-28">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="grid gap-1">
            <h1 className="text-2xl font-semibold">
              {info?.session.title ?? "Count stock"}
            </h1>
            {info ? (
              <span className="text-sm text-muted">
                <DocNumber value={info.session.number} /> · {info.session.scope}
              </span>
            ) : null}
          </div>
          {info?.session.blindCount ? (
            <Chip tone="info">
              Blind count: you count, the books stay hidden
            </Chip>
          ) : null}
        </div>
        {progress ? (
          <ProgressBar
            done={progress.counted}
            total={progress.total}
            label={`${progress.counted} of ${progress.total} counted`}
          />
        ) : null}
      </header>

      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            runScan();
          }}
        >
          <input
            className="min-h-12 w-full rounded-[10px] border border-field-border bg-field-background px-3 text-base"
            placeholder="Scan or type a product code, then Enter"
            aria-label="Scan a product"
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            autoComplete="off"
          />
          <PrimaryButton type="submit">Add 1</PrimaryButton>
        </form>
        <SecondaryButton onClick={() => setFoundOpen((o) => !o)}>
          Found item
        </SecondaryButton>
      </div>
      {notice ? (
        <p
          role="status"
          className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground"
        >
          {notice}
        </p>
      ) : null}
      <ErrorLine message={error && !notice ? error.message : null} />

      {foundOpen ? (
        <FoundItemPanel
          sessionId={sessionId}
          onClose={() => setFoundOpen(false)}
          onAdded={() => setFoundOpen(false)}
        />
      ) : null}

      <div
        className="flex flex-wrap items-center gap-2"
        role="tablist"
        aria-label="Show"
      >
        {COUNT_TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            type="button"
            aria-selected={tab === t.value}
            className={`min-h-12 rounded-full border px-4 font-medium ${tab === t.value ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface"}`}
            onClick={() => setTab(t.value)}
          >
            {t.label}
            {t.value === "recount" && progress?.recount
              ? ` · ${progress.recount}`
              : ""}
          </button>
        ))}
        <input
          className="min-h-12 min-w-40 flex-1 rounded-[10px] border border-field-border bg-field-background px-3 text-base"
          placeholder="Search this count"
          aria-label="Search this count"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {pages.status === "loading" ? (
        <p className="text-muted">Loading the list…</p>
      ) : null}
      {pages.status === "error" ? (
        <p role="alert" className="text-sm font-medium text-danger">
          Could not load the list. Check your connection and try again.
        </p>
      ) : null}
      {groups.map((g) => (
        <section key={g.bin} className="grid gap-3" aria-label={`Bin ${g.bin}`}>
          <MicroLabel>Bin {g.bin}</MicroLabel>
          <ul className="grid gap-3">
            {g.lines.map((line) => (
              <CountLineCard
                key={line.id}
                line={line}
                draft={drafts[line.id] ?? draftFromLine(line)}
                showExpected={showExpected}
                onChange={(next) => change(line.id, next)}
                onRetry={() => void saveLines([line.id])}
                onPickPhoto={
                  onPickPhoto
                    ? () =>
                        void onPickPhoto(line.id).then((fileId) => {
                          if (fileId)
                            change(line.id, {
                              ...(drafts[line.id] ?? draftFromLine(line)),
                              photoFileId: fileId,
                              state: "editing",
                            });
                        })
                    : undefined
                }
              />
            ))}
          </ul>
        </section>
      ))}
      {pages.status === "exhausted" && !lines.length ? (
        <Panel>
          <p>
            {tab === "todo"
              ? "Everything on the list has a number. Tap Finish counting."
              : "Nothing here."}
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
            {progress ? (
              todo > 0 ? (
                <>
                  <strong className="tabular-nums">{todo}</strong> still to
                  count
                </>
              ) : (
                "All counted"
              )
            ) : (
              "Loading…"
            )}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {todo > 0 ? (
              <SecondaryButton
                disabled={pending}
                onClick={() => void finish(true)}
              >
                Leave {todo} out and finish
              </SecondaryButton>
            ) : null}
            <PrimaryButton
              disabled={pending || !progress || todo > 0}
              onClick={() => void finish(false)}
            >
              Finish counting
            </PrimaryButton>
          </div>
        </div>
      </footer>
    </div>
  );
}
