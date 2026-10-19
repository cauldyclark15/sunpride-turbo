import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import {
  activeAt,
  dto,
  get,
  history,
  insert,
  instant,
  integer,
  ms,
  replaceInterval,
  required,
  rule,
} from "./model.js";
import { POSITIONS, DAILY, COACHING } from "./standard-seeds.js";

/** @typedef {import('./model.js').Ctx} Ctx */
/** @typedef {import('./model.js').Row} Row */
const SOURCE = "Sir Francis email 2026-09-30 / call 2026-10-02";
const WORK_SOURCE = "memo 2026-01-20 §III";
export const definition = {
  ruleVersion: "productive-call/2026-10-02",
  noSalesMarker: "no_sales_due_to_inventory",
  defaultSellingWeekdays: [1, 2, 3, 4, 5, 6],
  rules: [
    { code: "any_listed_activity", label: "Any listed productive activity" },
    {
      code: "truck_seller",
      label:
        "Truck seller: sale, or merchandising when no sales due to inventory",
    },
  ],
  activities: [
    ["purchase_order", "Purchase order"],
    ["merchandising", "Merchandising (display, price tags)"],
    ["inventory_retrieval", "Inventory retrieval"],
    ["suggested_order", "Suggested order (ICO)"],
    ["negotiation", "Negotiation leading to sales or uplift"],
    ["bad_order_pickup", "Bad order (BO) pickup"],
    ["collection", "Collection"],
    ["meeting", "Meeting"],
  ].map(([code, label]) => ({ code, label })),
};

/** Explicit, idempotent foundation; does not overwrite office standards. @param {Ctx} c */
export async function foundation(c) {
  await requireCapability(c, "admin.manage");
  await requireNationalScope(c, ["admin"]);
  const ids = new Map();
  let positionsCreated = 0,
    standardsCreated = 0,
    standardsSkipped = 0;
  for (const seed of POSITIONS) {
    const rows =
      await c.db`insert into positions(organization_id,code,label,category,active) values('sunpride',${seed.code},${seed.label},${seed.category},true) on conflict(organization_id,code) do nothing returning id`;
    if (rows.length) positionsCreated++;
    const [position] =
      await c.db`select id from positions where code=${seed.code} and organization_id='sunpride'`;
    ids.set(seed.code, position.id);
  }
  for (const [positionCode, calls, pct, productiveRule] of DAILY) {
    const id = ids.get(positionCode);
    const rows = await history(c.db, "position_standards", "position_id", id);
    if (rows.some((r) => r.source_ref === SOURCE)) continue;
    if (
      rows.some(
        (r) =>
          (r.effective_to == null || ms(r.effective_to) > c.now) &&
          ![SOURCE, WORK_SOURCE, "memo 2026-01-20 §I"].includes(r.source_ref),
      )
    ) {
      standardsSkipped++;
      continue;
    }
    await replaceInterval(
      c.db,
      "position_standards",
      "position_id",
      id,
      c.now,
      {
        organization_id: "sunpride",
        daily_calls_target: calls,
        productive_call_target_pct: pct,
        productive_call_rule: productiveRule,
        selling_weekdays: [1, 2, 3, 4, 5, 6],
        source_ref: SOURCE,
        notes: ["KAS", "BOOKING"].includes(String(positionCode))
          ? "Productive % TO CONFIRM: email says 85%, memo says 90%; memo value is provisional until confirmed. Saturday is a productive collection day."
          : productiveRule === "truck_seller"
            ? "30 calls/day at 85%; merchandising counts only with no sales due to inventory."
            : "30 calls/day at 85%; any listed productive activity.",
      },
    );
    standardsCreated++;
  }
  for (const [positionCode, weekly, monthly] of COACHING) {
    const id = ids.get(positionCode);
    const rows = await history(c.db, "position_standards", "position_id", id);
    if (rows.some((r) => r.source_ref === WORK_SOURCE)) continue;
    if (
      rows.some((r) => r.effective_to == null || ms(r.effective_to) > c.now)
    ) {
      standardsSkipped++;
      continue;
    }
    await insert(c.db, "position_standards", {
      organization_id: "sunpride",
      position_id: id,
      effective_from: instant(c.now),
      work_with_weekly_min: weekly,
      work_with_monthly_min: monthly,
      selling_weekdays: [1, 2, 3, 4, 5, 6],
      source_ref: WORK_SOURCE,
    });
    standardsCreated++;
  }
  return {
    positionCount: POSITIONS.length,
    positionsCreated,
    standardsCreated,
    standardsSkipped,
  };
}
/** @param {Ctx} c @param {Row} p */
export async function currentStandards(c, p) {
  await requireCapability(c, "mcp.read");
  const at = p.asOf ?? c.now;
  instant(at);
  /** @type {Row[]} */ const positions =
    await c.db`select * from positions where organization_id='sunpride' and active order by code limit 101`;
  if (positions.length > 100)
    rule("Position list exceeds supported size", "overflow");
  const rows = [];
  for (const position of positions)
    rows.push({
      positionId: position.id,
      code: position.code,
      label: position.label,
      category: position.category,
      standard: dto(
        (
          await history(c.db, "position_standards", "position_id", position.id)
        ).find((r) => !r.deleted_at && activeAt(r, at)) ?? null,
      ),
    });
  return { definition, positions: rows };
}
/** @param {Ctx} c @param {Row} b */
export async function setStandard(c, b) {
  await requireCapability(c, "admin.manage");
  await requireNationalScope(c, ["admin"]);
  const position = await get(c.db, "positions", b.positionId);
  if (!position.active) rule("Inactive position");
  const at = b.effectiveFrom;
  instant(at, c.now);
  /** @type {Row} */ const values = {
    organization_id: "sunpride",
    source_ref: required(b.sourceRef, "Source"),
    notes: b.notes,
  };
  for (const [key, col] of Object.entries({
    dailyCallsTarget: "daily_calls_target",
    workWithWeeklyMin: "work_with_weekly_min",
    workWithMonthlyMin: "work_with_monthly_min",
  }))
    if (b[key] != null) values[col] = integer(b[key], 0, 1000);
  if (b.productiveCallTargetPct != null) {
    if (
      !Number.isFinite(b.productiveCallTargetPct) ||
      b.productiveCallTargetPct < 0 ||
      b.productiveCallTargetPct > 100
    )
      rule("Invalid productive percentage");
    values.productive_call_target_pct = b.productiveCallTargetPct;
  }
  if (b.productiveCallRule) {
    if (!["any_listed_activity", "truck_seller"].includes(b.productiveCallRule))
      rule("Invalid productive rule");
    values.productive_call_rule = b.productiveCallRule;
  }
  const days = b.sellingWeekdays ?? [1, 2, 3, 4, 5, 6];
  if (
    !Array.isArray(days) ||
    new Set(days).size !== days.length ||
    days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
  )
    rule("Invalid selling weekdays");
  values.selling_weekdays = days;
  return (
    await replaceInterval(
      c.db,
      "position_standards",
      "position_id",
      position.id,
      at,
      values,
    )
  ).id;
}
