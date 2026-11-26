import { withParams } from "../cockpit/url";
import { LIST_FILTER_KEYS } from "./model";

const PERIOD_KEYS = [
  "period",
  "from",
  "to",
  "unitId",
  "channel",
  "compare",
  "fixture",
] as const;
const LIST_KEYS = [
  "tab",
  "view",
  "q",
  "status",
  "page",
  ...LIST_FILTER_KEYS,
  ...PERIOD_KEYS,
] as const;

function pickParams(params: URLSearchParams, keys: readonly string[]) {
  const picked = new URLSearchParams();
  for (const key of keys) {
    const value = params.get(key);
    if (value) picked.set(key, value);
  }
  return picked;
}

/** Keep the originating list separate from the record's own view and period controls. */
export function customerRecordHref(id: string, list: URLSearchParams): string {
  const saved = pickParams(list, LIST_KEYS).toString();
  return withParams("/customers/customer", pickParams(list, PERIOD_KEYS), {
    storeId: id,
    customerList: saved || null,
  });
}

/** Restore only known list state, never an arbitrary return address or record/editor params. */
export function customerListHref(record: URLSearchParams): string {
  const saved = new URLSearchParams(record.get("customerList") ?? "");
  return withParams("/customers", pickParams(saved, LIST_KEYS), {
    fixture: record.get("fixture") === "1" ? "1" : saved.get("fixture"),
  });
}
