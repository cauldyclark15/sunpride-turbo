export function routeMoney(minor: string | null | undefined) {
  if (minor == null || !/^-?\d+$/.test(minor)) return "Value needs review";
  const amount = BigInt(minor),
    absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? "−" : ""}₱${(absolute / 100n).toLocaleString("en-PH")}.${String(absolute % 100n).padStart(2, "0")}`;
}
export function routeQuantity(
  base: string,
  scale: string,
  caseBase = "0",
  uom = "pieces",
) {
  const q = BigInt(base),
    s = BigInt(scale),
    c = BigInt(caseBase);
  if (s <= 0n) return "Unit setup needed";
  const decimal = (n: bigint) => {
    const places = String(s).length - 1;
    const fraction = String(n % s)
      .padStart(places, "0")
      .replace(/0+$/, "");
    return `${n / s}${fraction ? `.${fraction}` : ""}`;
  };
  return c > 0n
    ? `${q / c} cases + ${decimal(q % c)} ${uom}`
    : `${decimal(q)} ${uom}`;
}
/** Exact conversion from a typed piece quantity; rejects imprecise/negative values, never rounds an input. */
export function routeBase(value: string, scale: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value))
    throw new Error("Enter a non-negative quantity");
  const [whole = "0", fraction = ""] = value.split(".");
  const denominator = 10n ** BigInt(fraction.length),
    numerator = BigInt(whole + fraction) * BigInt(scale);
  if (numerator % denominator)
    throw new Error(
      "This quantity is smaller than the product's supported unit",
    );
  return String(numerator / denominator);
}
