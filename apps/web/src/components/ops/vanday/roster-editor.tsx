"use client";

import { Button } from "@heroui/react";
import { Card, FormField, Notice } from "@sunpride/ui";
import { useState } from "react";
import { apiFetch, useApi, useMutate } from "@/lib/api";
import { useIntent } from "../transfers/use-intent";
import {
  emptyRosterForm,
  rosterPayload,
  rosterProblems,
  toggleDay,
  WEEKDAYS,
  type RosterForm,
  type RosterRow,
} from "./vanday-model";

export type RosterChoices = {
  vehicles: { vehicleId: string; name: string | null; plateNumber: string }[];
  sellers: { profileId: string; name: string }[];
  routes: { routeId: string; name: string; code: string }[];
};

const field =
  "min-h-12 w-full rounded-[10px] border border-field-border bg-field-background px-3 text-base";

/** The weekly roster: which seller and helper drive which truck on which route on which days. */
export function RosterEditorView({
  rows,
  choices,
  form,
  onForm,
  onSave,
  onEdit,
  onEnd,
  pending,
  error,
}: {
  rows: RosterRow[];
  choices: RosterChoices;
  form: RosterForm;
  onForm: (f: RosterForm) => void;
  onSave: () => void;
  onEdit: (r: RosterRow) => void;
  onEnd: (r: RosterRow) => void;
  pending?: boolean;
  error?: string | null;
}) {
  const problems = rosterProblems(form);
  const person = (key: keyof RosterForm, label: string, optional = false) => (
    <FormField label={label}>
      <select
        className={field}
        value={String(form[key] ?? "")}
        onChange={(e) => onForm({ ...form, [key]: e.target.value })}
      >
        <option value="">{optional ? "None" : "Choose"}</option>
        {choices.sellers.map((s) => (
          <option key={s.profileId} value={s.profileId}>
            {s.name}
          </option>
        ))}
      </select>
    </FormField>
  );
  return (
    <div className="grid gap-4">
      <Card label="Weekly roster" count={rows.length} flush>
        {rows.length ? (
          <ul className="divide-y divide-separator">
            {rows.map((r) => (
              <li key={r.rosterId} className="grid gap-1 px-4 py-3">
                <span className="text-base">
                  <span className="font-semibold">{r.vehicleCode}</span> {r.plateNumber} ·{" "}
                  {r.routeName ?? "No route"}
                </span>
                <span className="text-base">
                  {r.sellerName}
                  {r.helperName ? ` + ${r.helperName}` : ""}
                  {r.driverName ? ` · driver ${r.driverName}` : ""}
                </span>
                <span className="text-sm text-muted">
                  {r.weekdayLabel} · from {r.effectiveFrom}
                  {r.effectiveTo ? ` to ${r.effectiveTo}` : ""}
                  {r.status === "ended" ? " · ended" : ""}
                </span>
                {r.status === "active" ? (
                  <span className="flex gap-2">
                    <Button variant="secondary" className="min-h-12 text-base" onPress={() => onEdit(r)}>
                      Change
                    </Button>
                    <Button variant="secondary" className="min-h-12 text-base" onPress={() => onEnd(r)}>
                      End
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-4 text-sm text-muted">No roster yet. Add a truck below.</p>
        )}
      </Card>
      <Card label={form.rosterId ? "Change roster line" : "Add roster line"}>
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Truck">
              <select
                className={field}
                value={form.vehicleId}
                onChange={(e) => onForm({ ...form, vehicleId: e.target.value })}
              >
                <option value="">Choose</option>
                {choices.vehicles.map((v) => (
                  <option key={v.vehicleId} value={v.vehicleId}>
                    {v.name ?? v.plateNumber} ({v.plateNumber})
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Route">
              <select
                className={field}
                value={form.routeId}
                onChange={(e) => onForm({ ...form, routeId: e.target.value })}
              >
                <option value="">No route</option>
                {choices.routes.map((r) => (
                  <option key={r.routeId} value={r.routeId}>
                    {r.name}
                  </option>
                ))}
              </select>
            </FormField>
            {person("sellerProfileId", "Seller")}
            {person("helperProfileId", "Helper", true)}
            {person("driverProfileId", "Driver", true)}
            <FormField label="From">
              <input
                type="date"
                className={field}
                value={form.effectiveFrom}
                onChange={(e) => onForm({ ...form, effectiveFrom: e.target.value })}
              />
            </FormField>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Days of the week">
            {WEEKDAYS.map((d) => (
              <button
                key={d.n}
                type="button"
                aria-pressed={form.weekdays.includes(d.n)}
                className={`min-h-12 min-w-14 rounded-full border px-4 text-base ${
                  form.weekdays.includes(d.n)
                    ? "border-accent bg-accent-soft font-medium"
                    : "border-border bg-surface"
                }`}
                onClick={() => onForm({ ...form, weekdays: toggleDay(form.weekdays, d.n) })}
              >
                {d.label}
              </button>
            ))}
          </div>
          {problems.length ? (
            <ul className="grid gap-1 text-sm text-danger" role="alert">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          {error ? <Notice tone="danger" title="This could not be saved." meta={error} /> : null}
          <Button
            variant="primary"
            className="min-h-12 text-base"
            isDisabled={problems.length > 0}
            isPending={pending}
            onPress={onSave}
          >
            Save roster line
          </Button>
        </div>
      </Card>
    </div>
  );
}

export function RosterEditor({ today, unitId }: { today: string; unitId?: string }) {
  const [form, setForm] = useState<RosterForm>(emptyRosterForm(today));
  const [error, setError] = useState<string | null>(null);
  const write = useMutate();
  const intent = useIntent();
  const list = useApi<{ items: RosterRow[] }>(["van", "rosters", unitId ?? ""], ({ signal }) =>
    apiFetch<{ items: RosterRow[] }>("/api/v1/van/rosters", {
      query: unitId ? { unitId } : {},
      signal,
    }),
  );
  const choices = useApi<RosterChoices>(["van", "planning", today], ({ signal }) =>
    apiFetch<RosterChoices>("/api/v1/van/planning", { query: { date: today }, signal }),
  );
  if (list.error || choices.error)
    return <Notice tone="danger" title="The roster could not load." meta="Check your connection and try again." />;
  if (!list.data || !choices.data) return <p className="p-4 text-muted">Loading the roster…</p>;
  const post = async (body: Record<string, unknown>) => {
    const path = "/api/v1/van/rosters/save";
    setError(null);
    try {
      await write.mutate(path, intent.withKey(path, body), { invalidate: [["van"]] });
      intent.done(path, body);
      setForm(emptyRosterForm(today));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Try again");
    }
  };
  return (
    <RosterEditorView
      rows={list.data.items}
      choices={choices.data}
      form={form}
      onForm={setForm}
      pending={write.pending}
      error={error}
      onSave={() => post(rosterPayload(form))}
      onEdit={(r) =>
        setForm({
          rosterId: r.rosterId,
          vehicleId: r.vehicleId,
          routeId: "",
          sellerProfileId: r.sellerProfileId,
          helperProfileId: r.helperProfileId ?? "",
          driverProfileId: r.driverProfileId ?? "",
          weekdays: r.weekdays,
          effectiveFrom: r.effectiveFrom,
        })
      }
      onEnd={(r) => post({ rosterId: r.rosterId, vehicleId: r.vehicleId, end: true })}
    />
  );
}
