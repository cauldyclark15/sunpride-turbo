export const SUNPRIDE_ORGANIZATION_ID = "sunpride";

export const DEFAULT_QUANTITY_SCALE = 1_000n;
export const DEFAULT_QUANTITY_SCALE_NUMBER = 1_000;

export const MAX_COMMAND_LINES = 100;
export const MAX_ALLOCATIONS_PER_LINE = 50;

export const usableStockStatuses = ["available"] as const;

export function displayQuantity(quantityBase: bigint, scale: bigint) {
  const negative = quantityBase < 0n;
  const absolute = negative ? -quantityBase : quantityBase;
  const whole = absolute / scale;
  const remainder = absolute % scale;
  if (remainder === 0n) return `${negative ? "-" : ""}${whole}`;
  const decimals = remainder
    .toString()
    .padStart(scale.toString().length - 1, "0");
  return `${negative ? "-" : ""}${whole}.${decimals.replace(/0+$/, "")}`;
}

export function parseQuantity(quantity: string, scale: bigint) {
  const normalized = quantity.trim();
  if (!/^-?\d+(\.\d+)?$/.test(normalized))
    throw new Error("Quantity must be a decimal number");
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = unsigned.split(".");
  const precision = scale.toString().length - 1;
  if (fraction.length > precision)
    throw new Error(`Quantity supports at most ${precision} decimal places`);
  const base =
    BigInt(whole ?? "0") * scale +
    BigInt(fraction.padEnd(precision, "0") || "0");
  return negative ? -base : base;
}
