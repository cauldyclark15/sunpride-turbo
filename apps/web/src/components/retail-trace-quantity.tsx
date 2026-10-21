export function TraceQuantity({
  quantity,
  scale,
  uom,
}: {
  quantity: number | string;
  scale?: number | null;
  uom?: string | null;
}) {
  return (
    <>
      <span>
        {scale && scale > 0 ? Number(quantity) / scale : quantity} base units
      </span>
      <small className="block text-xs text-muted">
        {scale
          ? `Frozen base-unit scale ${scale}${uom ? ` · original selling unit ${uom}` : ""}`
          : "Original unit scale was not captured; no conversion to current packs is assumed."}
      </small>
    </>
  );
}
