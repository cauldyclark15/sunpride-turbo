"use client";

import { Button } from "@heroui/react";
import { Card, FormField, Notice } from "@sunpride/ui";
import { useState } from "react";
import { useMutate } from "@/lib/api";
import { Peso } from "../peso";
import { QtyCasesPieces } from "../qty-cases-pieces";
import { ReasonSelect } from "../reason-select";
import {
  CHARGE_OPTIONS,
  emptyResolveForm,
  openDifferences,
  resolvePayload,
  resolveProblems,
  type ResolveForm,
  type Transfer,
} from "./transfer-model";
import { useIntent } from "./use-intent";

/** Pure view: who carries a short / over, why, and one button. Only a person who is neither the sender nor the receiver can post it. */
export function VarianceResolutionView({
  transfer,
  form,
  onForm,
  problems,
  pending,
  error,
  onResolve,
}: {
  transfer: Pick<Transfer, "number" | "varianceValueCentavos" | "lines">;
  form: ResolveForm;
  onForm: (f: ResolveForm) => void;
  problems: string[];
  pending?: boolean;
  error?: string | null;
  onResolve: () => void;
}) {
  const { shortBase, overBase, damagedBase } = openDifferences(transfer);
  const field =
    "min-h-12 w-full rounded-[10px] border border-field-border bg-field-background px-3 text-base";
  return (
    <Card label="Decide the difference">
      <div className="grid gap-4">
        <ul className="grid gap-1">
          {transfer.lines
            .filter((l) => l.shortBase || l.overBase || l.receivedDamagedBase)
            .map((l) => (
              <li key={l.id} className="text-base">
                <span className="font-medium">{l.name}</span>
                {l.shortBase ? (
                  <span className="text-danger">
                    {" "}
                    · short{" "}
                    <QtyCasesPieces
                      base={l.shortBase}
                      basePerCase={l.basePerCase}
                    />
                  </span>
                ) : null}
                {l.receivedDamagedBase ? (
                  <span className="text-warning">
                    {" "}
                    · damaged{" "}
                    <QtyCasesPieces
                      base={l.receivedDamagedBase}
                      basePerCase={l.basePerCase}
                    />
                  </span>
                ) : null}
                {l.overBase ? (
                  <span className="text-warning">
                    {" "}
                    · over{" "}
                    <QtyCasesPieces
                      base={l.overBase}
                      basePerCase={l.basePerCase}
                    />
                  </span>
                ) : null}
              </li>
            ))}
        </ul>
        <p className="text-sm text-muted">
          Value of the difference:{" "}
          <Peso centavos={transfer.varianceValueCentavos} />
        </p>
        {shortBase === 0 && overBase === 0 && damagedBase > 0 ? (
          <Notice
            tone="warning"
            title="Only damaged items. They are already in Damaged stock."
            meta="Confirm to close this document."
          />
        ) : null}
        {shortBase > 0 || overBase > 0 ? (
          <FormField label="Who carries the difference">
            <select
              className={field}
              value={form.chargeTo}
              onChange={(e) => onForm({ ...form, chargeTo: e.target.value })}
            >
              <option value="">Choose</option>
              {CHARGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </FormField>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {shortBase > 0 ? (
            <ReasonSelect
              direction="out"
              label="Why it is short"
              value={form.shortReason}
              onChange={(code, reason) =>
                onForm({
                  ...form,
                  shortReason: code,
                  shortNeedsNote: Boolean(reason?.requiresNote),
                })
              }
            />
          ) : null}
          {overBase > 0 ? (
            <ReasonSelect
              direction="in"
              label="Why it is over"
              value={form.overReason}
              onChange={(code, reason) =>
                onForm({
                  ...form,
                  overReason: code,
                  overNeedsNote: Boolean(reason?.requiresNote),
                })
              }
            />
          ) : null}
        </div>
        <FormField label="Note">
          <textarea
            className={`${field} py-2`}
            rows={2}
            value={form.note}
            onChange={(e) => onForm({ ...form, note: e.target.value })}
          />
        </FormField>
        {problems.length ? (
          <ul className="grid gap-1 text-sm text-danger" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <Notice tone="danger" title="This could not be saved." meta={error} />
        ) : null}
        <Button
          variant="primary"
          className="min-h-12 text-base"
          isDisabled={problems.length > 0}
          isPending={pending}
          onPress={onResolve}
        >
          {shortBase > 0 || overBase > 0
            ? "Clear the difference and close"
            : "Confirm and close"}
        </Button>
      </div>
    </Card>
  );
}

export function VarianceResolution({
  transfer,
  onDone,
}: {
  transfer: Transfer;
  onDone?: () => void;
}) {
  const [form, setForm] = useState<ResolveForm>(emptyResolveForm);
  const intent = useIntent();
  const write = useMutate();
  return (
    <VarianceResolutionView
      transfer={transfer}
      form={form}
      onForm={setForm}
      problems={resolveProblems(transfer, form)}
      pending={write.pending}
      error={write.error?.message ?? null}
      onResolve={async () => {
        const path = "/api/v1/inventory/transfers/resolve-variance";
        const body = resolvePayload(transfer, form);
        try {
          await write.mutate(path, intent.withKey(path, body), {
            invalidate: [["inventory"]],
          });
          intent.done(path, body);
          onDone?.();
        } catch {
          // shown in the panel
        }
      }}
    />
  );
}
