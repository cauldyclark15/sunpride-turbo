"use client";

import { Button } from "@heroui/react";
import { FormField, Notice } from "@sunpride/ui";
import { useState } from "react";
import { useApi, useMutate } from "@/lib/api";
import { Drawer } from "../../cockpit/kit/drawer";
import {
  enteredStockQuantity,
  type StockUnits,
} from "../../inventory-workspace";
import { useIntent } from "./use-intent";

export type TransferPlace = {
  id: string;
  code: string;
  name: string;
  type: string;
  active: boolean;
};
export type TransferProduct = {
  id: string;
  code: string;
  name: string;
  units: StockUnits;
};
export type AddTransferForm = {
  source: string;
  destination: string;
  productId: string;
  cases: string;
  pieces: string;
};
export const emptyAddTransfer: AddTransferForm = {
  source: "",
  destination: "",
  productId: "",
  cases: "",
  pieces: "",
};

const field =
  "min-h-12 w-full rounded-[10px] border border-field-border bg-field-background px-3 text-base";

/** Places a transfer can start or end at (not the in-transit place). */
export const transferPlaces = (places: TransferPlace[]) =>
  places.filter(
    (p) => p.active && p.type !== "virtual_boundary" && p.type !== "in_transit",
  );

/** What stops Save, in plain words; empty when the form can be sent. */
export function addTransferProblems(
  form: AddTransferForm,
  places: TransferPlace[],
  products: TransferProduct[],
): string[] {
  const out: string[] = [];
  if (!places.some((p) => p.active && p.type === "in_transit"))
    out.push("Set up an in-transit place first.");
  if (!form.source) out.push("Pick where it comes from.");
  if (!form.destination) out.push("Pick where it goes.");
  if (form.source && form.source === form.destination)
    out.push("From and To must be different.");
  const product = products.find((p) => p.id === form.productId);
  if (!product) out.push("Pick a product.");
  else
    try {
      enteredStockQuantity(form.cases, form.pieces, product.units);
    } catch (e) {
      out.push(e instanceof Error ? e.message : "Check the quantity.");
    }
  return out;
}

/** Body for POST /api/v1/inventory/transfers/request (same request the old /inventory form sent). */
export function addTransferPayload(
  form: AddTransferForm,
  places: TransferPlace[],
  products: TransferProduct[],
) {
  const product = products.find((p) => p.id === form.productId)!;
  const transit = places.find((p) => p.active && p.type === "in_transit")!;
  return {
    sourceLocationId: form.source,
    destinationLocationId: form.destination,
    inTransitLocationId: transit.id,
    lines: [
      {
        productId: product.id,
        quantityBase: enteredStockQuantity(
          form.cases,
          form.pieces,
          product.units,
        ),
      },
    ],
  };
}

/** Pure form: From, To, product, cases + pieces, Save / Cancel. */
export function AddTransferFormView({
  form,
  onForm,
  places,
  products,
  onSave,
  onCancel,
  pending = false,
  error = null,
}: {
  form: AddTransferForm;
  onForm: (f: AddTransferForm) => void;
  places: TransferPlace[];
  products: TransferProduct[];
  onSave: () => void;
  onCancel: () => void;
  pending?: boolean;
  error?: string | null;
}) {
  const problems = addTransferProblems(form, places, products);
  const choices = transferPlaces(places);
  const product = products.find((p) => p.id === form.productId);
  const place = (key: "source" | "destination", label: string) => (
    <FormField label={label}>
      <select
        aria-label={label}
        className={field}
        value={form[key]}
        onChange={(e) => onForm({ ...form, [key]: e.target.value })}
      >
        <option value="">Choose</option>
        {choices.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </FormField>
  );
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problems.length) onSave();
      }}
    >
      {place("source", "From")}
      {place("destination", "To")}
      <FormField label="Product">
        <select
          aria-label="Product"
          className={field}
          value={form.productId}
          onChange={(e) => onForm({ ...form, productId: e.target.value })}
        >
          <option value="">Choose</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.name}
            </option>
          ))}
        </select>
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Cases">
          <input
            aria-label="Cases"
            inputMode="numeric"
            className={field}
            value={form.cases}
            disabled={!product?.units.basePerCase}
            onChange={(e) => onForm({ ...form, cases: e.target.value })}
          />
        </FormField>
        <FormField label="Pieces">
          <input
            aria-label="Pieces"
            inputMode="decimal"
            className={field}
            value={form.pieces}
            disabled={!product?.units.basePerPiece}
            onChange={(e) => onForm({ ...form, pieces: e.target.value })}
          />
        </FormField>
      </div>
      {error ? (
        <Notice tone="danger" title="This could not be saved." meta={error} />
      ) : null}
      <div className="sticky bottom-0 grid gap-2 bg-surface pt-2">
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            className="min-h-12 flex-1 text-base"
            isDisabled={problems.length > 0}
            isPending={pending}
          >
            Save
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="min-h-12 flex-1 text-base"
            onPress={onCancel}
          >
            Cancel
          </Button>
        </div>
        {problems.length ? (
          <p className="text-sm text-muted" data-testid="add-transfer-why">
            {problems[0]}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** "Add transfer" drawer: loads places and products, posts transfers/request. */
export function AddTransferDrawer({
  open,
  onClose,
  onSaved,
  initial = {},
}: {
  open: boolean;
  onClose: () => void;
  onSaved?: (id: string | null) => void;
  /** Prefill, e.g. from a stock row (?from=&product=). */
  initial?: Partial<AddTransferForm>;
}) {
  const [form, setForm] = useState<AddTransferForm>({
    ...emptyAddTransfer,
    ...initial,
  });
  const [error, setError] = useState<string | null>(null);
  const write = useMutate();
  const intent = useIntent();
  const places = useApi<TransferPlace[]>(
    open ? ["inventory", "locations"] : null,
    "/api/v1/inventory/locations",
  );
  const products = useApi<TransferProduct[]>(
    open ? ["inventory", "products"] : null,
    "/api/v1/inventory/products",
  );
  const close = () => {
    setForm(emptyAddTransfer);
    setError(null);
    onClose();
  };
  const save = async () => {
    const path = "/api/v1/inventory/transfers/request";
    setError(null);
    try {
      const body = addTransferPayload(
        form,
        places.data ?? [],
        products.data ?? [],
      );
      const res = (await write.mutate(path, intent.withKey(path, body), {
        invalidate: [["inventory"]],
      })) as { id?: string } | undefined;
      intent.done(path, body);
      setForm(emptyAddTransfer);
      onSaved?.(res?.id ?? null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Try again.");
    }
  };
  return (
    <Drawer open={open} title="Add transfer" onClose={close}>
      {places.error || products.error ? (
        <Notice
          tone="danger"
          title="The form could not load."
          meta="Check your connection and try again."
        />
      ) : !places.data || !products.data ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <AddTransferFormView
          form={form}
          onForm={setForm}
          places={places.data}
          products={products.data}
          onSave={() => void save()}
          onCancel={close}
          pending={write.pending}
          error={error}
        />
      )}
    </Drawer>
  );
}

