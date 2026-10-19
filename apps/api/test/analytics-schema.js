import { expect } from "bun:test";

/** @param {any} value @param {string[]} keys */
export function keys(value, keys) {
  for (const k of keys)
    expect(Object.hasOwn(value, k), `missing ${k}`).toBe(true);
}
/** @param {any} r */
export function assertHeader(r) {
  expect(Object.keys(r).slice(0, 5)).toEqual([
    "period",
    "compare",
    "scope",
    "freshness",
    "demo",
  ]);
  keys(r.period, ["from", "to", "days", "elapsedDays", "remainingSellingDays"]);
  keys(r.compare, ["from", "to"]);
  keys(r.scope, ["unitId", "label"]);
  keys(r.freshness, ["asOf", "devicesBehind", "oldestDeviceSyncAt"]);
  expect(typeof r.freshness.asOf).toBe("number");
  expect(typeof r.demo).toBe("boolean");
}
/** @param {any} r @param {string[]} expected */
export function assertKpis(r, expected) {
  expect(r.kpis.map((/** @type {any} */ k) => k.key)).toEqual(expected);
  for (const k of r.kpis) {
    expect(Object.keys(k).sort()).toEqual(
      [
        "key",
        "label",
        "value",
        "unit",
        "target",
        "prior",
        "deltaPct",
        "status",
        "definition",
      ].sort(),
    );
    expect(["php", "pct", "count", "cases", "minutes"]).toContain(k.unit);
    expect(["ok", "watch", "behind", "unknown"]).toContain(k.status);
    for (const v of ["value", "target", "prior", "deltaPct"])
      expect(k[v] === null || typeof k[v] === "number").toBe(true);
    if (k.unit === "php")
      for (const v of ["value", "target", "prior"])
        if (k[v] !== null) expect(Number.isSafeInteger(k[v])).toBe(true);
    if (k.value === null) expect(k.status).toBe("unknown");
  }
}
/** @param {any} e */
export function assertException(e) {
  expect(Object.keys(e).sort()).toEqual(
    [
      "id",
      "kind",
      "severity",
      "title",
      "detail",
      "subject",
      "owner",
      "dueAt",
      "openedAt",
      "evidence",
      "action",
    ].sort(),
  );
  keys(e.subject, ["type", "id", "label"]);
  keys(e.action, ["label", "href"]);
  expect(["high", "medium", "low"]).toContain(e.severity);
  expect(e.action.href.startsWith("/")).toBe(true);
  if (e.owner !== null) keys(e.owner, ["profileId", "name"]);
}
