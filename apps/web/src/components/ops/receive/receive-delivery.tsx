"use client";

import { Button, Input } from "@heroui/react";
import { Card, FormField, Notice } from "@sunpride/ui";
import { useState } from "react";
import { apiFetch, useApi, useMutate } from "@/lib/api";
import { CasesPiecesStepper } from "../qty-cases-pieces";
import { ReasonSelect } from "../reason-select";
import { useIntent } from "../transfers/use-intent";
import { PhotoCount } from "./photo-count";
import {
  deliveryProblems,
  emptyHeader,
  findProduct,
  newLine,
  toReceiptBody,
  totals,
  type CatalogProduct,
  type DeliveryHeader,
  type DeliveryLine,
} from "./receive-model";

type Place = { id: string; code: string; name: string; type: string };

/** Pure view of the Receive delivery grid (SPEC 4.2): header, scan field, one row per product, one Post. */
export function ReceiveDeliveryView({
  header,
  onHeader,
  lines,
  onLines,
  locations,
  matches,
  query,
  onQuery,
  onScan,
  onAdd,
  problems,
  pending,
  error,
  onPost,
}: {
  header: DeliveryHeader;
  onHeader: (h: DeliveryHeader) => void;
  lines: DeliveryLine[];
  onLines: (l: DeliveryLine[]) => void;
  locations: Place[];
  matches: CatalogProduct[];
  query: string;
  onQuery: (q: string) => void;
  onScan: () => void;
  onAdd: (p: CatalogProduct) => void;
  problems: string[];
  pending?: boolean;
  error?: string | null;
  onPost: () => void;
}) {
  const field =
    "min-h-12 w-full rounded-[10px] border border-field-border bg-field-background px-3 text-base";
  const setLine = (key: string, patch: Partial<DeliveryLine>) =>
    onLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const t = totals(lines);
  return (
    <div className="grid gap-4 pb-24">
      <Card label="Delivery">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Receiving at">
            <select
              className={field}
              value={header.locationId}
              onChange={(e) =>
                onHeader({ ...header, locationId: e.target.value })
              }
            >
              <option value="">Choose a place</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Supplier">
            <Input
              className={field}
              value={header.supplierName}
              onChange={(e) =>
                onHeader({ ...header, supplierName: e.target.value })
              }
            />
          </FormField>
          <FormField label="Delivery receipt no.">
            <Input
              className={field}
              value={header.deliveryReceiptNo}
              onChange={(e) =>
                onHeader({ ...header, deliveryReceiptNo: e.target.value })
              }
            />
          </FormField>
          <FormField label="PO reference" hint="Leave empty if there is none.">
            <Input
              className={field}
              value={header.purchaseOrderRef}
              onChange={(e) =>
                onHeader({ ...header, purchaseOrderRef: e.target.value })
              }
            />
          </FormField>
        </div>
      </Card>

      <Card label="Scan or search">
        <div className="grid gap-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onScan();
            }}
          >
            <Input
              autoFocus
              aria-label="Scan or type a product code or name"
              placeholder="Scan a barcode or type a name"
              className={field}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
            />
            <Button type="submit" variant="outline" className="min-h-12">
              Add
            </Button>
          </form>
          {matches.length ? (
            <ul className="grid gap-2">
              {matches.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="flex min-h-12 w-full items-center justify-between rounded-xl border border-border px-3 text-left"
                    onClick={() => onAdd(p)}
                  >
                    <span>{p.name}</span>
                    <span className="font-mono text-sm text-muted">
                      {p.code}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Card>

      {lines.map((l) => (
        <div
          key={l.key}
          className="grid gap-3 rounded-2xl border border-border bg-surface p-4"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-base font-medium">{l.name}</p>
              <p className="font-mono text-sm text-muted">{l.code}</p>
            </div>
            <Button
              variant="outline"
              className="min-h-12 text-danger"
              onPress={() => onLines(lines.filter((x) => x.key !== l.key))}
            >
              Remove
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1">
              <span className="text-xs font-medium uppercase text-muted">
                Arrived
              </span>
              <CasesPiecesStepper
                value={l.accepted}
                basePerCase={l.basePerCase}
                onChange={(accepted) => setLine(l.key, { accepted })}
              />
            </div>
            <div className="grid gap-1">
              <span className="text-xs font-medium uppercase text-muted">
                Rejected
              </span>
              <CasesPiecesStepper
                value={l.rejected}
                basePerCase={l.basePerCase}
                hint="Counted separately; goes to Rejected stock."
                onChange={(rejected) => setLine(l.key, { rejected })}
              />
            </div>
          </div>
          {l.rejected.cases + l.rejected.pieces > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <ReasonSelect
                label="Why rejected"
                value={l.rejectedReason}
                onChange={(code, reason) =>
                  setLine(l.key, {
                    rejectedReason: code,
                    reasonNeedsPhoto: Boolean(reason?.requiresPhoto),
                  })
                }
              />
              {l.reasonNeedsPhoto ? (
                <PhotoCount
                  count={l.photoCount}
                  onChange={(photoCount) => setLine(l.key, { photoCount })}
                />
              ) : null}
            </div>
          ) : null}
          {l.tracking === "lot" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Batch number">
                <Input
                  className={field}
                  value={l.batch}
                  onChange={(e) => setLine(l.key, { batch: e.target.value })}
                />
              </FormField>
              <FormField label="Expiry date">
                <Input
                  type="date"
                  className={field}
                  value={l.expiry}
                  onChange={(e) => setLine(l.key, { expiry: e.target.value })}
                />
              </FormField>
            </div>
          ) : null}
        </div>
      ))}

      {problems.length && lines.length ? (
        <ul className="grid gap-1 text-sm text-danger" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <Notice
          tone="danger"
          title="The delivery was not posted."
          meta={error}
        />
      ) : null}
      <div className="fixed inset-x-0 bottom-0 z-10 flex items-center justify-between gap-3 border-t border-border bg-surface p-3">
        <p className="text-sm">
          <span className="font-medium">{t.lines}</span> line
          {t.lines === 1 ? "" : "s"}
          {t.rejectedLines ? ` · ${t.rejectedLines} with rejects` : ""}
        </p>
        <Button
          variant="primary"
          className="min-h-12 px-8 text-base"
          isDisabled={problems.length > 0}
          isPending={pending}
          onPress={onPost}
        >
          Post delivery
        </Button>
      </div>
    </div>
  );
}

/** Container: loads locations and the catalog, builds the grid, posts ONE receipt for all lines. */
export function ReceiveDelivery({
  defaultLocationId = "",
  onPosted,
}: {
  defaultLocationId?: string;
  onPosted?: (receipt: { id: string; number: string }) => void;
}) {
  const [header, setHeader] = useState(() => emptyHeader(defaultLocationId));
  const [lines, setLines] = useState<DeliveryLine[]>([]);
  const [query, setQuery] = useState("");
  const [posted, setPosted] = useState<{ id: string; number: string } | null>(
    null,
  );
  const intent = useIntent();
  const write = useMutate();
  const locations = useApi<Place[]>(["inventory", "locations"], ({ signal }) =>
    apiFetch<Place[]>("/api/v1/inventory/locations", { signal }),
  );
  const catalog = useApi<CatalogProduct[]>(
    ["inventory", "products"],
    ({ signal }) =>
      apiFetch<CatalogProduct[]>("/api/v1/inventory/products", { signal }),
  );
  const products = catalog.data ?? [];
  const q = query.trim().toLowerCase();
  const matches = q
    ? products
        .filter(
          (p) =>
            p.code.toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q),
        )
        .slice(0, 6)
    : [];
  const add = (p: CatalogProduct) => {
    setLines((cur) => [...cur, newLine(p)]);
    setQuery("");
  };
  const problems = deliveryProblems(header, lines);
  if (posted)
    return (
      <Card label="Delivery posted">
        <div className="grid gap-3">
          <Notice
            tone="success"
            title={`Posted as ${posted.number}`}
            meta="All lines are in stock."
          />
          <Button
            variant="primary"
            className="min-h-12"
            onPress={() => {
              setPosted(null);
              setLines([]);
              setHeader(emptyHeader(header.locationId));
            }}
          >
            Receive another delivery
          </Button>
        </div>
      </Card>
    );
  return (
    <ReceiveDeliveryView
      header={header}
      onHeader={setHeader}
      lines={lines}
      onLines={setLines}
      locations={(locations.data ?? []).filter(
        (l) => !["truck", "in_transit"].includes(l.type),
      )}
      matches={matches}
      query={query}
      onQuery={setQuery}
      onScan={() => {
        const hit = findProduct(products, query);
        if (hit) add(hit);
      }}
      onAdd={add}
      problems={problems}
      pending={write.pending}
      error={write.error?.message ?? null}
      onPost={async () => {
        const path = "/api/v1/inventory/receipts/post";
        const body = toReceiptBody(header, lines);
        try {
          const result = await write.mutate<{ id: string; number: string }>(
            path,
            intent.withKey(path, body),
            { invalidate: [["inventory"]] },
          );
          intent.done(path, body);
          setPosted(result);
          onPosted?.(result);
        } catch {
          // shown above; the same request can be retried safely
        }
      }}
    />
  );
}
