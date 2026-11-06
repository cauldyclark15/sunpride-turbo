"use client";

import { Card, Notice } from "@sunpride/ui";
import Link from "next/link";
import { useState } from "react";
import { apiFetch, useApi } from "@/lib/api";
import { DocNumber } from "./doc-number";
import { Peso } from "./peso";
import type { BoardRow, DayBoard } from "./vanday";

const field =
  "min-h-12 w-full rounded-[10px] border border-field-border bg-field-background px-3 text-base";

/** Today in Manila as YYYY-MM-DD (the van day is a Manila day). */
export function manilaToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(
    now,
  );
}

/** A stock card needs a product and a place; this is how a person picks them when they open the card tab directly. */
export function StockCardPicker({
  onPick,
}: {
  onPick: (productId: string, locationId: string) => void;
}) {
  const [q, setQ] = useState("");
  const [locationId, setLocationId] = useState("");
  const places = useApi<Array<{ id: string; name: string; active: boolean }>>(
    ["inventory", "locations"],
    ({ signal }) =>
      apiFetch<Array<{ id: string; name: string; active: boolean }>>(
        "/api/v1/inventory/locations",
        { signal },
      ),
  );
  const products = useApi<
    Array<{ id: string; code: string; name: string }>
  >(["inventory", "products"], ({ signal }) =>
    apiFetch<Array<{ id: string; code: string; name: string }>>(
      "/api/v1/inventory/products",
      { signal },
    ),
  );
  const needle = q.trim().toLowerCase();
  const shown = (products.data ?? [])
    .filter(
      (p) =>
        needle.length >= 2 &&
        `${p.code} ${p.name}`.toLowerCase().includes(needle),
    )
    .slice(0, 12);
  return (
    <Card label="Open a stock card">
      <div className="grid gap-3">
        <p className="text-base text-muted">
          Choose a place and a product to see every movement of that product
          there. You can also open a card from a row in Stock on hand.
        </p>
        <select
          className={field}
          aria-label="Place"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        >
          <option value="">Choose a place</option>
          {(places.data ?? [])
            .filter((p) => p.active)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        <input
          className={field}
          aria-label="Find a product"
          placeholder="Type a product name or code"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {needle.length >= 2 && !shown.length ? (
          <p className="text-sm text-muted">No product matches “{q}”.</p>
        ) : null}
        <ul className="grid gap-1">
          {shown.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                disabled={!locationId}
                className="min-h-12 w-full rounded-[10px] border border-border px-3 text-left text-base disabled:opacity-50"
                onClick={() => onPick(p.id, locationId)}
              >
                <span className="font-mono text-sm">{p.code}</span> {p.name}
              </button>
            </li>
          ))}
        </ul>
        {!locationId && shown.length ? (
          <p className="text-sm text-muted">Choose a place first.</p>
        ) : null}
      </div>
    </Card>
  );
}

type ReviewCard = {
  id: string;
  number: string;
  title: string | null;
  location: string | null;
  submittedAt: number | null;
  progress: { total: number; counted: number; needsReview: number };
};

/** The counts waiting for a different person to review. */
export function ReviewList({ hrefFor }: { hrefFor: (id: string) => string }) {
  const mine = useApi<{ mine: ReviewCard[]; toReview: ReviewCard[] }>(
    ["inventory", "counts", "mine"],
    ({ signal }) =>
      apiFetch<{ mine: ReviewCard[]; toReview: ReviewCard[] }>(
        "/api/v1/inventory/counts/mine",
        { signal },
      ),
  );
  if (mine.error)
    return (
      <Notice
        tone="danger"
        title="The counts to review could not load."
        meta="Check your connection and try again."
      />
    );
  if (!mine.data) return <p className="text-sm text-muted">Loading…</p>;
  const list = mine.data.toReview;
  return (
    <Card label="Counts waiting for your review" count={list.length} flush>
      {list.length ? (
        <ul className="divide-y divide-separator">
          {list.map((c) => (
            <li key={c.id}>
              <Link
                href={hrefFor(c.id)}
                className="grid min-h-16 gap-1 px-4 py-3"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <DocNumber value={c.number} />
                  <span className="text-base font-medium">
                    {c.title ?? "Stock count"}
                  </span>
                </span>
                <span className="text-sm text-muted">
                  {c.location ?? "A place"} · {c.progress.counted} of{" "}
                  {c.progress.total} lines counted ·{" "}
                  {c.progress.needsReview} to decide
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="p-4 text-base text-muted">
          No counts are waiting for you. A count you counted yourself is never
          shown here: someone else must review it.
        </p>
      )}
    </Card>
  );
}

/** Today's trips that have a suggested load, so a planner can open one. */
export function LoadsPicker({
  date,
  hrefFor,
}: {
  date: string;
  hrefFor: (tripId: string) => string;
}) {
  const board = useApi<DayBoard>(["van", "day-board", date, ""], ({ signal }) =>
    apiFetch<DayBoard>("/api/v1/van/day-board", { query: { date }, signal }),
  );
  if (board.error)
    return (
      <Notice
        tone="danger"
        title="The van day could not load."
        meta="Check your connection and try again."
      />
    );
  if (!board.data) return <p className="text-sm text-muted">Loading…</p>;
  const rows: BoardRow[] = board.data.rows.filter(
    (r) => r.tripId && r.load.state !== "none",
  );
  return (
    <Card label={`Suggested loads for ${date}`} count={rows.length} flush>
      {rows.length ? (
        <ul className="divide-y divide-separator">
          {rows.map((r) => (
            <li key={r.vehicleId}>
              <Link
                href={hrefFor(r.tripId as string)}
                className="grid min-h-16 gap-1 px-4 py-3"
              >
                <span className="flex flex-wrap items-center gap-2 text-base font-medium">
                  {r.vehicleCode} · {r.routeName}
                  <span className="text-sm font-normal text-muted">
                    {r.load.label}
                  </span>
                </span>
                <span className="text-sm text-muted">
                  {r.sellerName ?? "No seller yet"} · {r.load.products}{" "}
                  products · {r.load.cases} cs {r.load.pieces} pc{" "}
                  {r.load.differenceCentavos ? (
                    <>
                      · difference{" "}
                      <Peso centavos={r.load.differenceCentavos} />
                    </>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="p-4 text-base text-muted">
          No trip has a load yet. The night plan makes tomorrow's loads at
          8 pm, or plan a trip on the Board.
        </p>
      )}
    </Card>
  );
}
