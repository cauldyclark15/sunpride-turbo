import { requireCapability } from "../../core/capabilities.js";
import { writeAudit } from "../org/audit.js";
import { ORGANIZATION, choice, invalid, text } from "./common.js";

export const REASON_CATEGORIES = Object.freeze([
  "shrink",
  "damage",
  "expiry",
  "found",
  "count_variance",
  "recall",
  "transit_short",
  "customer_return",
  "system",
]);
export const REASON_DIRECTIONS = Object.freeze(["in", "out", "both"]);

/** @typedef {{code:string,label:string,category:string,direction:string,requiresNote:boolean,requiresPhoto:boolean,approvalThresholdCentavos:number|null,active:boolean}} ReasonCode */

/** @param {any} r @returns {ReasonCode} */
const present = (r) => ({
  code: r.code,
  label: r.label,
  category: r.category,
  direction: r.direction,
  requiresNote: r.requires_note,
  requiresPhoto: r.requires_photo,
  approvalThresholdCentavos:
    r.approval_threshold_centavos == null
      ? null
      : Number(r.approval_threshold_centavos),
  active: r.active,
});

/** SPEC 3.4 shipped defaults. */
export const DEFAULT_REASON_CODES = Object.freeze([
  ["DMG-HANDLING", "Damaged in handling", "damage", "out", false, true],
  ["DMG-TRANSIT", "Damaged in transit", "damage", "out", false, true],
  ["EXP", "Expired", "expiry", "out", false, false],
  ["SHORT-PICK", "Short-picked at depot", "shrink", "both", false, false],
  ["SHORT-TRANSIT", "Missing in transit", "transit_short", "out", false, false],
  ["FOUND", "Found stock", "found", "in", true, false],
  [
    "COUNT-ERR",
    "Counting error corrected",
    "count_variance",
    "both",
    true,
    false,
  ],
  ["RECALL", "Recalled lot", "recall", "out", false, false],
  ["CUST-RETURN", "Customer return", "customer_return", "in", false, true],
  ["SAMPLE", "Free sample / promo use", "shrink", "out", true, false],
]);

/** Seed the shipped defaults for an organization that has no reason codes yet (a later new org).
 * Never overwrites edits: it only runs when the organization has no rows at all.
 * @param {any} db @param {string} org */
export async function ensureDefaultReasonCodes(db, org) {
  const [has] =
    await db`select 1 as x from inventory_reason_codes where organization_id=${org} limit 1`;
  if (has) return;
  for (const [
    code,
    label,
    category,
    direction,
    note,
    photo,
  ] of DEFAULT_REASON_CODES)
    await db`insert into inventory_reason_codes (organization_id,code,label,category,direction,requires_note,requires_photo) values (${org},${code},${label},${category},${direction},${note},${photo}) on conflict (organization_id,code) do nothing`;
}

/**
 * @param {any} db @param {string} org
 * @param {{category?:string, direction?:string, activeOnly?:boolean}} [filter]
 * @returns {Promise<ReasonCode[]>} a direction filter also returns codes marked "both"
 */
export async function listReasonCodes(
  db,
  org,
  { category, direction, activeOnly = true } = {},
) {
  await ensureDefaultReasonCodes(db, org);
  const rows =
    await db`select * from inventory_reason_codes where organization_id=${org} and (${activeOnly}::boolean is false or active) and (${category ?? null}::text is null or category=${category ?? null}) and (${direction ?? null}::text is null or direction in (${direction ?? null},'both')) order by category,code`;
  return rows.map(present);
}

/**
 * Check a reason before a stock change is written; returns the reason row.
 * @param {any} db @param {string} org @param {string} code
 * @param {{direction?:'in'|'out', note?:string|null, photoCount?:number}} [ctx]
 * @returns {Promise<ReasonCode>}
 */
export async function requireReason(
  db,
  org,
  code,
  { direction, note, photoCount = 0 } = {},
) {
  await ensureDefaultReasonCodes(db, org);
  const [row] =
    typeof code === "string"
      ? await db`select * from inventory_reason_codes where organization_id=${org} and code=${code}`
      : [];
  if (!row || !row.active)
    return invalid("Choose a reason from the list.", "reason_code_invalid");
  if (direction && row.direction !== "both" && row.direction !== direction)
    return invalid(
      `"${row.label}" can't be used when stock goes ${direction === "in" ? "in" : "out"}. Choose another reason.`,
      "reason_code_invalid",
    );
  if (row.requires_note && !(typeof note === "string" && note.trim()))
    return invalid(
      `Add a short note: "${row.label}" needs one.`,
      "reason_code_invalid",
    );
  if (row.requires_photo && !(Number(photoCount) >= 1))
    return invalid(
      `Take a photo: "${row.label}" needs one.`,
      "reason_code_invalid",
    );
  return present(row);
}

/** @param {any} ctx */
async function listRoute(ctx) {
  await requireCapability(ctx, "inventory.read");
  const q = ctx.url.searchParams;
  const category = q.get("category") || undefined,
    direction = q.get("direction") || undefined;
  if (category) choice(category, [...REASON_CATEGORIES]);
  if (direction) choice(direction, [...REASON_DIRECTIONS]);
  const activeOnly = q.get("all") !== "1";
  return listReasonCodes(ctx.db, ORGANIZATION, {
    category,
    direction,
    activeOnly,
  });
}

/** Create or edit one code. Admin only (same capability as inventory policies).
 * @param {any} ctx */
async function saveRoute(ctx) {
  const actor = await requireCapability(ctx, "admin.manage");
  const b = ctx.body;
  if (!b || typeof b !== "object" || Array.isArray(b))
    return invalid("Supply a reason code object");
  const code = text(b.code, "Code", 40).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(code))
    return invalid("Code uses letters, digits and dashes only.");
  const label = text(b.label, "Label", 120);
  const category = choice(b.category, [...REASON_CATEGORIES]);
  const direction = choice(b.direction, [...REASON_DIRECTIONS]);
  const threshold = b.approvalThresholdCentavos ?? null;
  if (
    threshold !== null &&
    !(Number.isSafeInteger(threshold) && threshold >= 0)
  )
    return invalid("Approval limit must be zero or more pesos.");
  const note = b.requiresNote === true,
    photo = b.requiresPhoto === true,
    active = b.active !== false;
  const [r] =
    await ctx.db`insert into inventory_reason_codes (organization_id,code,label,category,direction,requires_note,requires_photo,approval_threshold_centavos,active) values (${ORGANIZATION},${code},${label},${category},${direction},${note},${photo},${threshold},${active}) on conflict (organization_id,code) do update set label=excluded.label,category=excluded.category,direction=excluded.direction,requires_note=excluded.requires_note,requires_photo=excluded.requires_photo,approval_threshold_centavos=excluded.approval_threshold_centavos,active=excluded.active,updated_at=now() returning *`;
  await writeAudit(ctx.db, {
    actor,
    action: "inventory.reason_code.save",
    entityType: "inventory_reason_codes",
    entityId: code,
    details: { code, active },
  });
  return present(r);
}

/** @param {import('../../core/router.js').Router} router */
export function installReasonRoutes(router) {
  router.get("/api/v1/inventory/reason-codes", listRoute);
  router.post("/api/v1/inventory/reason-codes/save", saveRoute);
}
