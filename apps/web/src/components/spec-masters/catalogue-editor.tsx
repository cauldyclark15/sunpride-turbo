"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@heroui/react";
import { Card, Notice } from "@sunpride/ui";
import { mutate, useApi } from "../../lib/api";
import { masterEffectiveDate } from "./model";
import { catalogueJpeg } from "./catalogue-image";
import Image from "next/image";

type Content = {
  revision: number;
  source: string;
  sample: boolean;
  description: string;
  ingredients: string;
  allergens: string;
  storage: string;
  shelfLifeDays: number;
  caseSpecifications: string;
  image?: { path: string; sha256: string; bytes: number } | null;
};
type Product = {
  id: string;
  code: string;
  name: string;
  catalogue: Content | null;
};
const fields = [
  ["description", "Description"],
  ["ingredients", "Ingredients"],
  ["allergens", "Allergens"],
  ["storage", "Storage"],
  ["caseSpecifications", "Case specifications"],
] as const;
const input =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";
/** F-616 maintain dated, explicitly marked beta content; SAP content stays read-only. */
export function CatalogueEditor() {
  const data = useApi<{ rows: Product[] }>(
    ["masters", "catalogue"],
    "/api/v1/masters/catalogue",
  );
  const [selected, setSelected] = useState("");
  if (data.error) return <Notice title={data.error.message} tone="warning" />;
  const product = data.data?.rows.find((p) => p.id === selected);
  return (
    <Card label="Product catalogue content">
      <div className="grid gap-4">
        <p className="text-sm text-muted">
          What will a rep read offline? Keep descriptions and food-label details
          current. Beta content is always marked as sample; SAP-owned content is
          not overwritten here.
        </p>
        <label className="grid gap-1 text-sm">
          Product
          <select
            aria-label="Catalogue product"
            className={input}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Choose a product…</option>
            {data.data?.rows.map((p) => (
              <option value={p.id} key={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
        </label>
        {product && (
          <ContentForm
            key={`${product.id}:${product.catalogue?.revision ?? 0}`}
            product={product}
          />
        )}
      </div>
    </Card>
  );
}
function ContentForm({ product }: { product: Product }) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const c = product.catalogue;
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      let imageFileId: string | undefined;
      const image = form.get("image");
      if (image instanceof File && image.size > 0) {
        const uploaded = await mutate<{ id: string }>(
          "/api/v1/masters/catalogue/image",
          { productId: product.id, jpegBase64: await catalogueJpeg(image) },
          { idempotencyKey: crypto.randomUUID() },
        );
        imageFileId = uploaded.id;
      }
      await mutate(
        "/api/v1/masters/catalogue/save",
        {
          productId: product.id,
          ...(imageFileId ? { imageFileId } : {}),
          baseRevision: c?.revision ?? 0,
          ...Object.fromEntries(
            fields.map(([key]) => [key, String(form.get(key) ?? "")]),
          ),
          shelfLifeDays: Number(form.get("shelfLifeDays")),
          effectiveFrom: masterEffectiveDate(
            String(form.get("effectiveFrom") ?? ""),
          ),
          reason: String(form.get("reason") ?? ""),
        },
        { idempotencyKey: crypto.randomUUID(), invalidate: [["masters"]] },
      );
      setMessage(
        "Catalogue revision saved. Phones receive it on their next verified download.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Content could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} className="grid gap-3">
      <p className="text-sm">
        {c
          ? `Revision ${c.revision} · ${c.source === "sample" ? "Invented sample content" : "SAP replica"}`
          : "No content yet"}
      </p>
      {c?.image && (
        <Image
          src={c.image.path}
          alt="Current catalogue product image"
          width={160}
          height={160}
          unoptimized
          className="rounded-lg border border-border object-contain"
        />
      )}
      <label className="grid gap-1 text-sm">
        Product image (optional; blank keeps the current image)
        <input
          name="image"
          type="file"
          accept="image/jpeg,image/png"
          disabled={c?.source === "sap"}
        />
        <span className="text-xs text-muted">
          JPEG or PNG up to 8 MiB; resized to 960 px and a 512 KiB JPEG before
          upload. Earlier revisions keep their own image.
        </span>
      </label>
      {fields.map(([key, label]) => (
        <label className="grid gap-1 text-sm" key={key}>
          {label}
          <textarea
            className={input}
            name={key}
            required
            maxLength={2000}
            defaultValue={c?.[key] ?? ""}
            disabled={c?.source === "sap"}
          />
        </label>
      ))}
      <label className="grid gap-1 text-sm">
        Shelf life in days
        <input
          className={input}
          name="shelfLifeDays"
          type="number"
          min={0}
          max={3650}
          required
          defaultValue={c?.shelfLifeDays ?? 0}
        />
      </label>
      <label className="grid gap-1 text-sm">
        Effective from (Manila; blank means now)
        <input className={input} name="effectiveFrom" type="datetime-local" />
      </label>
      <label className="grid gap-1 text-sm">
        Change reason
        <input className={input} name="reason" required maxLength={500} />
      </label>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <Button type="submit" isDisabled={busy || c?.source === "sap"}>
        {busy ? "Saving…" : "Save a new catalogue revision"}
      </Button>
    </form>
  );
}
