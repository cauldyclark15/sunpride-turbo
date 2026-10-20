import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { ApiError, invalid } from "../../core/errors.js";
import {
  integer,
  text,
  choice,
  VOID_REASONS,
  CASH_VARIANCE_REASONS,
} from "./model.js";
import { tripFor, notSelf } from "./access.js";
import { audit } from "./facts.js";

/** v1 algorithms deliberately retained so existing offline handheld codes still agree. @param {any} env @param {string} tripId @param {string} kind */
export function approvalKey(env, tripId, kind) {
  const secret = env.SYNC_CURSOR_SECRET;
  if (!secret || secret.length < 32)
    throw new ApiError(
      "approval_unavailable",
      503,
      "Approval codes are not configured",
    );
  return createHmac("sha256", secret)
    .update(`sunpride/van-${kind}-approval/v1|${tripId}`)
    .digest("base64url");
}
/** @param {string} key @param {string} message */
export function approvalCodeFor(key, message) {
  const h = createHmac("sha256", Buffer.from(key, "base64url"))
    .update(message)
    .digest();
  const offset = /** @type {number} */ (h[31]) & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 100000000).padStart(
    8,
    "0",
  );
}
/** @param {string} kind @param {string} tripId @param {any} p */
export function approvalMessage(kind, tripId, p) {
  if (kind === "void")
    return `VOID|v1|${tripId}|${p.receiptNumber}|${p.totalMinor}|${p.reasonCode}`;
  if (kind === "cash")
    return `CASH|v1|${tripId}|${p.expectedMinor}|${p.declaredMinor}|${p.reasonCode}`;
  if (kind === "stock")
    return `STOCK|v1|${tripId}|${p.countCode}|${p.varianceLines}|${p.shortBase}|${p.overBase}`;
  return `DISCOUNT|v1|${tripId}|${canonicalJson(p)}`;
}
/** @param {string} kind @param {any} p @returns {any} */
export function approvalFacts(kind, p) {
  if (kind === "void")
    return {
      receiptNumber: text(p.receiptNumber, 100, true),
      totalMinor: String(integer(p.totalMinor)),
      reasonCode: choice(p.reasonCode, VOID_REASONS),
    };
  if (kind === "cash")
    return {
      expectedMinor: String(integer(p.expectedMinor)),
      declaredMinor: String(integer(p.declaredMinor)),
      reasonCode: choice(p.reasonCode, CASH_VARIANCE_REASONS),
    };
  if (kind === "stock") {
    if (
      typeof p.countCode !== "string" ||
      !/^[0-9A-F]{12}$/.test(p.countCode) ||
      !Number.isInteger(p.varianceLines) ||
      p.varianceLines < 1 ||
      p.varianceLines > 1000
    )
      throw invalid("Enter the exact count code and number of differences");
    return {
      countCode: p.countCode,
      varianceLines: p.varianceLines,
      shortBase: String(integer(p.shortBase)),
      overBase: String(integer(p.overBase)),
    };
  }
  throw invalid("Unsupported approval kind");
}
/** @param {any} db @param {any} actor @param {any} env @param {string} kind @param {any} input */
export async function issueApproval(db, actor, env, kind, input) {
  const facts = approvalFacts(kind, input);
  let tripId = input.tripId;
  if (!tripId) {
    const tripNumber =
      kind === "void"
        ? /^(.+)-[0-9A-F]{8}-\d{4,9}$/.exec(input.receiptNumber)?.[1]
        : input.tripNumber;
    const [r] =
      kind === "void"
        ? await db`select t.id from van_trips t join van_sales s on s.trip_id=t.id where s.receipt_number=${input.receiptNumber} and t.deleted_at is null`
        : await db`select id from van_trips where trip_number=${tripNumber ?? ""} and deleted_at is null`;
    tripId = r?.id;
  }
  if (!tripId) throw invalid("No trip matches this reference");
  const trip = await tripFor(db, actor, tripId, `van.${kind}.approve`, true);
  notSelf(actor, trip);
  if (
    !["loaded", "active", "closing", "reconciling", "review_required"].includes(
      trip.status,
    )
  )
    throw invalid("This trip is not on the road");
  const hash = sha256Hex(canonicalJson(facts));
  const code = approvalCodeFor(
    approvalKey(env, trip.id, kind),
    approvalMessage(kind, trip.id, facts),
  );
  await db`insert into van_approval_codes(trip_id,kind,facts_hash,facts,issuer_profile_id,issuer_name)
    values(${trip.id},${kind},${hash},${facts},${actor.profileId},${actor.name}) on conflict(trip_id,kind,facts_hash) do nothing`;
  await audit(db, trip, actor, `van.${kind}.approval_issued`, trip.id, facts);
  return {
    ...facts,
    code,
    tripNumber: trip.trip_number,
    ...(kind === "cash"
      ? {
          varianceMinor: String(
            BigInt(facts.declaredMinor) - BigInt(facts.expectedMinor),
          ),
        }
      : {}),
  };
}
/** Issued AND exact code/facts required; a holder of the offline trip key is not an approver. @param {any} db @param {any} env @param {any} trip @param {string} kind @param {any} facts @param {any} approval @param {string} opId */
export async function consumeApproval(
  db,
  env,
  trip,
  kind,
  facts,
  approval,
  opId,
) {
  if (
    !approval ||
    approval.method !== "supervisor_code" ||
    typeof approval.code !== "string" ||
    !/^\d{8}$/.test(approval.code)
  )
    throw invalid("A supervisor approval code is required");
  const expected = approvalCodeFor(
    approvalKey(env, trip.id, kind),
    approvalMessage(kind, trip.id, facts),
  );
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(approval.code)))
    throw invalid("The approval code does not match these facts");
  const hash = sha256Hex(canonicalJson(facts));
  const [row] =
    await db`select * from van_approval_codes where trip_id=${trip.id} and kind=${kind} and facts_hash=${hash} for update`;
  if (
    !row ||
    row.issuer_profile_id === trip.salesperson_profile_id ||
    (row.consumed_by && row.consumed_by !== opId)
  )
    throw invalid("The office has not approved these exact facts");
  await db`update van_approval_codes set consumed_by=${opId},updated_at=now() where id=${row.id}`;
  return row.id;
}
/** @param {string} tripId @param {string} countId @param {any[]} lines */
export function stockCountCode(tripId, countId, lines) {
  // Kotlin StockReconciliationRules canonical byte format (see countCode).
  const sorted = [...lines].sort(
    (a, b) =>
      a.productId.localeCompare(b.productId) ||
      a.status.localeCompare(b.status),
  );
  return sha256Hex(
    `STOCKCOUNT|v1|${tripId}|${countId}\n` +
      sorted
        .map(
          (l) =>
            `${l.productId}|${l.status}|${l.expectedBase}|${l.countedBase}|${l.reasonCode ?? ""}`,
        )
        .join("\n"),
  )
    .slice(0, 12)
    .toUpperCase();
}
