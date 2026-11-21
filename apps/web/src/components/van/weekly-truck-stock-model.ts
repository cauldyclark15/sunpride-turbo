/** SP-0227 weekly truck stock DTOs and pure helpers (shared with tests; no React). */
import { formatDate, formatStatus, toInstant } from "../../lib/format";

export type TruckWeekLine = {
  productId: string;
  code: string;
  name: string;
  uom: string;
  requestedBase: number;
  servedBase: number;
  shortfallBase: number;
  soldBase: number;
  expectedLeftBase: number;
  countedBase: number | null;
  varianceBase: number | null;
  reasonId: string | null;
  reasonName: string | null;
  note: string | null;
  needsReason: boolean;
  /** Sold from the truck but never loaded through this form. */
  notLoaded?: boolean;
  quantityScale?: string;
  unitPriceMinor?: string | null;
  accountableBase?: number | null;
  accountableMinor?: string | null;
};
export type TruckWeekTotals = {
  requestedBase: number;
  servedBase: number;
  shortfallBase: number;
  soldBase: number;
  countedBase: number | null;
  varianceBase: number | null;
  missingReasons: number;
  notLoaded?: number;
};
export type TruckWeek = {
  id: string;
  weekStart: string;
  salespersonProfileId: string;
  seller: string;
  status: "open" | "counted" | "reviewed";
  countedAt: number | null;
  reviewedAt: number | null;
  reviewNote: string | null;
  updatedAt: string;
  requestFacts?: {
    vehicleId: string;
    vehicle: string;
    depot: string;
    priceChannel: string | null;
    sapOrderReference: string;
    trips: { id: string; number: string }[];
  } | null;
  cashier?: { amountMinor: string | null };
  lines: TruckWeekLine[];
  totals: TruckWeekTotals;
};
export type TruckWeekList = {
  weekStart: string;
  canManage: boolean;
  rows: (Omit<TruckWeek, "lines"> & { lineCount: number })[];
  sellers: { id: string; name: string }[];
  products: { id: string; code: string; name: string; uom: string }[];
  vehicles?: { id: string; name: string }[];
  trips?: {
    id: string;
    name: string;
    serviceDate?: string;
    vehicleId: string;
    salespersonProfileId: string;
  }[];
  priceChannels?: string[];
};

export function stockMoney(value: string | null | undefined): string {
  if (value == null)
    return "Unavailable until every price and count is recorded";
  const n = BigInt(value);
  return `PHP ${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
}

export const STATUS_LABELS: Record<TruckWeek["status"], string> = {
  open: "Waiting for Saturday count",
  counted: "Counted, office to check",
  reviewed: "Checked and closed",
};

/** Monday of the Manila week containing `day` (YYYY-MM-DD). */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(+d - back * 86400000).toISOString().slice(0, 10);
}
export function addDays(day: string, days: number): string {
  return new Date(+new Date(`${day}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function shiftWeek(monday: string, weeks: number): string {
  return addDays(monday, weeks * 7);
}

/** Plain words for a variance: served − sold − counted. */
export function varianceText(value: number | null): string {
  if (value === null) return "Not counted yet";
  if (value === 0) return "Balanced";
  return value > 0 ? `${value} missing` : `${-value} extra`;
}

export const NOT_LOADED_TEXT = "Sold but not loaded — check loading";

/** Reason cell: the salesman's reason, or what the office must do. */
export function reasonText(l: Pick<TruckWeekLine, "reasonName" | "needsReason" | "notLoaded" | "countedBase">): string {
  if (l.reasonName) return l.reasonName;
  if (l.notLoaded && l.countedBase !== null) return NOT_LOADED_TEXT;
  return l.needsReason ? "No reason given" : "—";
}

/** Status suffix on the weeks list. */
export function weekFlags(t: Pick<TruckWeekTotals, "missingReasons" | "notLoaded">): string {
  const bits: string[] = [];
  if (t.missingReasons > 0) bits.push(`${t.missingReasons} without reason`);
  if ((t.notLoaded ?? 0) > 0)
    bits.push(`${t.notLoaded} sold but not loaded`);
  return bits.map((b) => ` · ${b}`).join("");
}

/** "Should be left" never shows a negative stock: more sold than loaded is flagged in words. */
export function expectedLeftText(value: number): string {
  return value < 0 ? `0 (sold ${-value} more than loaded)` : String(value);
}

/** A trip as office staff read it: "Mon, Nov 16, 2026 · trip 0" instead of the stored code. */
export function tripLabel(t: { name: string; serviceDate?: string }): string {
  if (!t.serviceDate) return formatStatus(t.name);
  const day = formatDate(t.serviceDate);
  const weekday = new Intl.DateTimeFormat("en-PH", {
    weekday: "short",
    timeZone: "Asia/Manila",
  }).format(toInstant(t.serviceDate) ?? 0);
  const n = /-(\d+)$/.exec(t.name)?.[1];
  return `${weekday}, ${day}${n !== undefined ? ` · trip ${Number(n) + 1}` : ""}`;
}

export type DraftLine = {
  productId: string;
  requested: string;
  served: string;
};
/** Validates the office form into the save command; returns an error message instead of throwing. */
export function weekSaveBody(
  sellerId: string,
  weekStart: string,
  lines: DraftLine[],
  baseUpdatedAt?: string,
):
  | {
      ok: true;
      body: {
        salespersonProfileId: string;
        weekStart: string;
        lines: {
          productId: string;
          requestedBase: number;
          servedBase: number;
        }[];
        baseUpdatedAt?: string;
      };
    }
  | { ok: false; error: string } {
  if (!sellerId) return { ok: false, error: "Choose the salesman." };
  const used = lines.filter((l) => l.productId);
  if (!used.length) return { ok: false, error: "Add at least one product." };
  if (new Set(used.map((l) => l.productId)).size !== used.length)
    return { ok: false, error: "Each product can appear once." };
  const whole = (v: string) => /^\d+$/.test(v.trim());
  if (used.some((l) => !whole(l.requested) || !whole(l.served)))
    return {
      ok: false,
      error: "Requested and served must be whole numbers from 0.",
    };
  return {
    ok: true,
    body: {
      salespersonProfileId: sellerId,
      weekStart,
      lines: used.map((l) => ({
        productId: l.productId,
        requestedBase: Number(l.requested),
        servedBase: Number(l.served),
      })),
      ...(baseUpdatedAt ? { baseUpdatedAt } : {}),
    },
  };
}
