const pesos = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

/** 125000 -> "₱1,250.00". The API speaks centavos; people only ever see pesos. */
export function formatPeso(centavos: number | null | undefined): string {
  if (centavos == null || !Number.isFinite(centavos)) return "—";
  return pesos.format(centavos / 100);
}

/** Money for tables and totals: right-aligned, fixed-width digits so columns line up. */
export function Peso({
  centavos,
  className = "",
  negativeClassName = "text-danger",
}: {
  centavos: number | null | undefined;
  className?: string;
  /** Applied when the amount is below zero (a shortage, a refund). */
  negativeClassName?: string;
}) {
  const negative = centavos != null && centavos < 0;
  return (
    <span
      className={`inline-block text-right tabular-nums ${negative ? negativeClassName : ""} ${className}`.trim()}
    >
      {formatPeso(centavos)}
    </span>
  );
}
