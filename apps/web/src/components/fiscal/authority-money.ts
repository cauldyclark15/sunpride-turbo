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
