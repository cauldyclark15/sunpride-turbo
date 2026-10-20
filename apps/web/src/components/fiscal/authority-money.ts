/** F-511: exact peso entry, with no floating-point conversion. */
export function authorityMinor(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text))
    throw new Error(
      "Enter a nonnegative peso amount with at most two decimals.",
    );
  const [whole, part = ""] = text.split(".");
  return (BigInt(whole!) * 100n + BigInt(part.padEnd(2, "0"))).toString();
}
export function authorityPeso(value: unknown): string {
  const minor = BigInt(String(value ?? "0"));
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`;
}
/** F-108/F-511: transaction and authority amounts keep every centavo, including bigint bands. */
export function fiscalMoney(value: unknown): string {
  if (
    !["string", "number", "bigint"].includes(typeof value) ||
    (typeof value === "string" && !value.trim()) ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  )
    return "—";
  try {
    const minor = BigInt(String(value)),
      negative = minor < 0n,
      absolute = negative ? -minor : minor;
    return `${negative ? "−" : ""}₱${(absolute / 100n).toLocaleString("en-PH")}.${(absolute % 100n).toString().padStart(2, "0")}`;
  } catch {
    return "—";
  }
}
