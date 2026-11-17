import type { FieldMissing } from "./model";

/** SP-0188: plain labels of the fields a field app save left for the office (no duplicates). */
export function fieldMissingLabels(missing: FieldMissing[] | null | undefined) {
  const out: string[] = [];
  for (const m of missing ?? []) {
    const label = m.field.startsWith("shipTos[")
      ? `Delivery: ${m.label}`
      : m.label;
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/** A value the agent typed, shown as text (nested lists and objects flattened). */
function shown(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "";
}

/** The agent's typed value for a missing field (`key` or `shipTos[i].key`). */
export function typedValue(
  submitted: Record<string, unknown> | null | undefined,
  field: string,
): string {
  if (!submitted) return "";
  const ship = /^shipTos\[(\d+)\]\.(\w+)$/.exec(field);
  if (ship) {
    const list = submitted.shipTos;
    const entry = Array.isArray(list) ? list[Number(ship[1])] : null;
    return entry && typeof entry === "object"
      ? shown((entry as Record<string, unknown>)[ship[2] as string])
      : "";
  }
  return shown(submitted[field]);
}

/** "Incomplete — from field app": what the office must finish, with what the salesman typed. */
export function FieldIncompleteNote({
  missing,
  submitted,
}: {
  missing: FieldMissing[] | null | undefined;
  submitted?: Record<string, unknown> | null;
}) {
  if (!missing?.length) return null;
  const seen = new Set<string>();
  const items = missing.filter((m) =>
    seen.has(m.field) ? false : (seen.add(m.field), true),
  );
  return (
    <section
      data-testid="field-incomplete-note"
      className="rounded-lg border border-[#f0d9b5] bg-[#fdf3e1] px-3 py-2 text-[13px] text-foreground"
    >
      <p className="font-semibold text-[#a15c07]">
        Incomplete — from field app
      </p>
      <p className="mt-1 text-muted">
        The salesman saved this customer with some details missing or not
        accepted. Fill these in before approving:
      </p>
      <ul className="mt-2 grid gap-1">
        {items.map((m) => {
          const typed = typedValue(submitted, m.field);
          return (
            <li key={m.field}>
              <span className="font-medium">
                {fieldMissingLabels([m])[0]}
              </span>
              {typed ? (
                <span className="text-muted">
                  {" "}
                  — the salesman typed &ldquo;{typed}&rdquo;
                </span>
              ) : (
                <span className="text-muted"> — left blank</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
