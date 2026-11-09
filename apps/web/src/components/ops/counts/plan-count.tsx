"use client";

import { useRef, useState } from "react";
import { apiFetch, normalizeError, useApi, useMutate } from "@/lib/api";
import {
  Chip,
  ErrorLine,
  MicroLabel,
  Panel,
  PrimaryButton,
  SecondaryButton,
} from "./ui";
import { COUNTS_KEY, COUNTS_PATH, planBody, type PlanForm } from "./model";

type Place = { id: string; code: string; name: string; type: string; active: boolean };
type Counter = { userId: string; name: string; role: string };
type Preview = { lines: number; products: number; places: number; tooLarge: boolean; scope: string };

const MODES: { value: PlanForm["mode"]; title: string; help: string }[] = [
  { value: "everything", title: "Everything", help: "Every product with stock in this place." },
  { value: "bins", title: "A range of bins", help: "From one bin to another, counted in bin order." },
  { value: "fast", title: "Fast movers", help: "The products that sold or left the most lately." },
  { value: "filter", title: "A product filter", help: "Products whose name or code matches, or one category." },
];
const REPEATS = [
  { value: 0, label: "Don’t repeat" },
  { value: 7, label: "Every week" },
  { value: 14, label: "Every 2 weeks" },
  { value: 30, label: "Every month" },
];

const field =
  "min-h-12 w-full rounded-[10px] border border-field-border bg-field-background px-3 text-base";

/** The query string the preview endpoint understands. */
export function previewQuery(f: PlanForm) {
  return {
    locationId: f.locationId,
    includeSublocations: f.mode === "bins" || f.includeSublocations ? "1" : undefined,
    binFrom: f.mode === "bins" && f.binFrom.trim() ? f.binFrom.trim() : undefined,
    binTo: f.mode === "bins" && f.binTo.trim() ? f.binTo.trim() : undefined,
    fastMovers: f.mode === "fast" ? "1" : undefined,
    days: f.mode === "fast" ? String(f.fastDays) : undefined,
    top: f.mode === "fast" ? String(f.fastTop) : undefined,
    search: f.mode === "filter" && f.search.trim() ? f.search.trim() : undefined,
    category: f.mode === "filter" && f.category.trim() ? f.category.trim() : undefined,
  };
}

/**
 * Add count (supervisor): where, what, who counts, blind or not, when, and whether it repeats.
 * Shows how many lines the choice gives before anything is created.
 */
export function PlanCount({
  onPlanned,
  initialLocationId = "",
}: {
  onPlanned?: (result: { id: string; number: string; lines: number }) => void;
  initialLocationId?: string;
}) {
  const [form, setForm] = useState<PlanForm>({
    locationId: initialLocationId,
    title: "",
    mode: "everything",
    includeSublocations: false,
    binFrom: "",
    binTo: "",
    fastDays: 30,
    fastTop: 50,
    search: "",
    category: "",
    assignedTo: "",
    blindCount: true,
    scheduledFor: "",
  });
  const [repeat, setRepeat] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const { mutate, pending } = useMutate();
  const set = <K extends keyof PlanForm>(k: K, v: PlanForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const places = useApi<Place[]>([...COUNTS_KEY, "places"], ({ signal }) =>
    apiFetch<Place[]>("/api/v1/inventory/locations", { signal }),
  );
  const counters = useApi<Counter[]>(
    form.locationId ? [...COUNTS_KEY, "counters", form.locationId] : null,
    ({ signal }) =>
      apiFetch<Counter[]>(`${COUNTS_PATH}/counters`, {
        query: { locationId: form.locationId },
        signal,
      }),
  );
  const q = previewQuery(form);
  const preview = useApi<Preview>(
    form.locationId ? [...COUNTS_KEY, "preview", q] : null,
    ({ signal }) =>
      apiFetch<Preview>(`${COUNTS_PATH}/preview`, { query: q, signal }),
  );

  async function submit() {
    setMessage(null);
    try {
      const made = await mutate<{ id: string; number: string; lines: number }>(
        `${COUNTS_PATH}/plan`,
        planBody(form),
        { idempotencyKey: key.current, invalidate: [COUNTS_KEY] },
      );
      if (repeat > 0) {
        const body = planBody(form);
        await mutate(
          `${COUNTS_PATH}/schedule-save`,
          {
            name: form.title.trim() || "Repeating count",
            locationId: body.locationId,
            scope: body.scope,
            includeSublocations: body.includeSublocations,
            countType: body.countType,
            blindCount: body.blindCount,
            ...(body.assignedTo ? { assignedTo: body.assignedTo } : {}),
            cadenceDays: repeat,
            nextDue: new Date(Date.now() + repeat * 86400000 + 8 * 3600000)
              .toISOString()
              .slice(0, 10),
          },
          { idempotencyKey: crypto.randomUUID(), invalidate: [COUNTS_KEY] },
        );
      }
      key.current = crypto.randomUUID();
      onPlanned?.(made);
    } catch (e) {
      setMessage(normalizeError(e).message);
    }
  }

  const ready =
    Boolean(form.locationId) &&
    !(form.mode === "bins" && !form.binFrom.trim() && !form.binTo.trim()) &&
    !(form.mode === "filter" && !form.search.trim() && !form.category.trim());
  return (
    <div className="grid gap-4 pb-28">
      <h1 className="text-2xl font-semibold">Add count</h1>

      <Panel className="grid gap-3">
        <label className="grid gap-1">
          <MicroLabel>Where</MicroLabel>
          <select
            className={field}
            value={form.locationId}
            onChange={(e) => set("locationId", e.target.value)}
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
        </label>
        <label className="grid gap-1">
          <MicroLabel>Name (optional)</MicroLabel>
          <input
            className={field}
            placeholder="Friday fast movers"
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
          />
        </label>
      </Panel>

      <Panel className="grid gap-3">
        <MicroLabel>What to count</MicroLabel>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="What to count">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={form.mode === m.value}
              className={`grid gap-1 rounded-xl border p-3 text-left ${form.mode === m.value ? "border-accent bg-accent-soft" : "border-border bg-surface"}`}
              onClick={() => set("mode", m.value)}
            >
              <span className="font-semibold">{m.title}</span>
              <span className="text-sm text-muted">{m.help}</span>
            </button>
          ))}
        </div>
        {form.mode === "bins" ? (
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1">
              <MicroLabel>From bin</MicroLabel>
              <input className={field} value={form.binFrom} onChange={(e) => set("binFrom", e.target.value)} />
            </label>
            <label className="grid gap-1">
              <MicroLabel>To bin</MicroLabel>
              <input className={field} value={form.binTo} onChange={(e) => set("binTo", e.target.value)} />
            </label>
          </div>
        ) : null}
        {form.mode === "fast" ? (
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1">
              <MicroLabel>Look back (days)</MicroLabel>
              <input className={field} inputMode="numeric" value={form.fastDays} onChange={(e) => set("fastDays", Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1))} />
            </label>
            <label className="grid gap-1">
              <MicroLabel>How many products</MicroLabel>
              <input className={field} inputMode="numeric" value={form.fastTop} onChange={(e) => set("fastTop", Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1))} />
            </label>
          </div>
        ) : null}
        {form.mode === "filter" ? (
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1">
              <MicroLabel>Name or code contains</MicroLabel>
              <input className={field} value={form.search} onChange={(e) => set("search", e.target.value)} />
            </label>
            <label className="grid gap-1">
              <MicroLabel>Category</MicroLabel>
              <input className={field} value={form.category} onChange={(e) => set("category", e.target.value)} />
            </label>
          </div>
        ) : null}
        {form.mode !== "bins" ? (
          <label className="flex min-h-12 items-center gap-3">
            <input
              type="checkbox"
              className="size-6"
              checked={form.includeSublocations}
              onChange={(e) => set("includeSublocations", e.target.checked)}
            />
            <span>Include the bins and zones inside this place</span>
          </label>
        ) : null}
        <div aria-live="polite">
          {preview.data ? (
            <Chip tone={preview.data.tooLarge ? "bad" : preview.data.lines ? "info" : "warn"}>
              {preview.data.tooLarge
                ? `${preview.data.lines} lines is too many. Narrow it down.`
                : preview.data.lines
                  ? `${preview.data.lines} lines · ${preview.data.products} products · ${preview.data.places} ${preview.data.places === 1 ? "place" : "places"}`
                  : "Nothing matches yet"}
            </Chip>
          ) : null}
        </div>
      </Panel>

      <Panel className="grid gap-3">
        <label className="grid gap-1">
          <MicroLabel>Who counts</MicroLabel>
          <select
            className={field}
            value={form.assignedTo}
            onChange={(e) => set("assignedTo", e.target.value)}
          >
            <option value="">Me</option>
            {(counters.data ?? []).map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-12 items-center gap-3">
          <input
            type="checkbox"
            className="size-6"
            checked={form.blindCount}
            onChange={(e) => set("blindCount", e.target.checked)}
          />
          <span>
            <strong>Blind count.</strong> The counter doesn’t see what the books say.
          </span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1">
            <MicroLabel>Count on (optional)</MicroLabel>
            <input
              type="date"
              className={field}
              value={form.scheduledFor}
              onChange={(e) => set("scheduledFor", e.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <MicroLabel>Repeat</MicroLabel>
            <select className={field} value={repeat} onChange={(e) => setRepeat(Number(e.target.value))}>
              {REPEATS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Panel>

      <ErrorLine message={message} />
      <footer className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-end gap-2">
          <SecondaryButton
            disabled={pending}
            onClick={() => setForm((f) => ({ ...f, title: "", assignedTo: "" }))}
          >
            Clear
          </SecondaryButton>
          <PrimaryButton
            disabled={pending || !ready || Boolean(preview.data?.tooLarge) || preview.data?.lines === 0}
            onClick={() => void submit()}
          >
            Save
          </PrimaryButton>
        </div>
      </footer>
    </div>
  );
}
