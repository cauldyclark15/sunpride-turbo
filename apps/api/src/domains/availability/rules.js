import { conflict, invalid } from "../../core/errors.js";
import { isUuid } from "../../core/util.js";

export const VERSION = "availability/2026-10-v1";
/** @param {any} n @param {number} [max] */
export function quantity(n, max = 1_000_000_000) {
  if (!Number.isSafeInteger(n) || n < 0 || n > max)
    throw invalid("Use a whole, non-negative base quantity");
  return n;
}
/** @param {any} value @param {number} [max] */
export function ids(value, max = 1000) {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    new Set(value).size !== value.length ||
    value.some((v) => !isUuid(v))
  )
    throw invalid("Choose distinct valid records");
  return /** @type {string[]} */ (value);
}
/** F-211: explicit outlet override > specificity > priority; ties are setup errors.
 * @param {any} outlet @param {any[]} releases */
export function resolveSet(outlet, releases) {
  let candidates = releases.filter(
    (r) =>
      matches(outlet, r.payload) && (!r.sample || outlet.is_sample === true),
  );
  if (candidates.some((r) => !r.sample))
    candidates = candidates.filter((r) => !r.sample);
  const rank = (/** @type {any} */ r) =>
    (r.payload.outletIds?.length ? 1000 : 0) +
    [
      "channel",
      "subchannel",
      "classification",
      "channelId",
      "subchannelId",
    ].filter((k) => r.payload[k] != null).length *
      100 +
    (r.payload.priority ?? 0);
  candidates.sort((a, b) => rank(b) - rank(a));
  if (candidates.length > 1 && rank(candidates[0]) === rank(candidates[1]))
    throw conflict(
      "Two MSL sets have equal precedence. Change the priority or audience.",
      "msl_ambiguous",
    );
  return candidates[0] ?? null;
}
/** @param {any} outlet @param {any} audience */
export function matches(outlet, audience) {
  return (
    (!audience.outletIds?.length || audience.outletIds.includes(outlet.id)) &&
    (!audience.territoryIds?.length ||
      audience.territoryIds.includes(outlet.territory_id)) &&
    [
      "channel",
      "subchannel",
      "classification",
      "channelId",
      "subchannelId",
    ].every(
      (k) =>
        audience[k] == null ||
        audience[k] ===
          outlet[
            { channelId: "channel_id", subchannelId: "subchannel_id" }[k] ?? k
          ],
    )
  );
}
/** F-212: enumerate the frozen required set, including every omitted/unmeasured row.
 * @param {any[]} required @param {any[]} input @param {boolean} complete */
export function checklist(required, input, complete) {
  if (
    !required.length ||
    required.length > 200 ||
    !Array.isArray(input) ||
    input.length > 200
  )
    throw invalid("This call needs an MSL set with 1–200 lines");
  const allowed = new Set(required.map((r) => r.productId));
  if (
    new Set(input.map((r) => r.productId)).size !== input.length ||
    input.some((r) => !allowed.has(r.productId))
  )
    throw invalid("Checklist does not match the downloaded MSL");
  const lines = required.map((r) => {
    const l = input.find((l) => l.productId === r.productId) ?? {
      productId: r.productId,
      state: "not_checked",
    };
    if (
      !["present", "absent", "not_checked"].includes(l.state) ||
      !["tap", "scan"].includes(l.method ?? "tap")
    )
      throw invalid("Choose present, absent or not checked");
    const shelfBase = l.shelfBase == null ? null : quantity(l.shelfBase);
    const backroomBase =
      l.backroomBase == null ? null : quantity(l.backroomBase);
    if (
      (l.state === "absent" && shelfBase != null && shelfBase !== 0) ||
      (l.state === "present" && shelfBase === 0) ||
      (l.state === "not_checked" && (shelfBase != null || backroomBase != null))
    )
      throw invalid("Shelf quantity contradicts the availability answer");
    return {
      productId: r.productId,
      state: l.state,
      method: l.method ?? "tap",
      shelfBase,
      backroomBase,
      deliveredBase: l.deliveredBase == null ? null : quantity(l.deliveredBase),
      returnsBase: l.returnsBase == null ? null : quantity(l.returnsBase),
    };
  });
  const checked = lines.filter((l) => l.state !== "not_checked").length;
  if (complete && checked !== required.length)
    throw invalid(
      "Check every MSL line before completing availability",
      "availability_incomplete",
    );
  return {
    lines,
    required: required.length,
    checked,
    present: lines.filter((l) => l.state === "present").length,
  };
}
/** F-217: stock conservation; inconsistent intervals stay unknown, never clamped to zero.
 * @param {any} before @param {any} after */
export function deriveOfftake(before, after) {
  if (
    !before ||
    [
      before.shelfBase,
      before.backroomBase,
      after.shelfBase,
      after.backroomBase,
      after.deliveredBase,
      after.returnsBase,
    ].some((n) => n == null) ||
    after.at <= before.at
  )
    return null;
  const units =
    before.shelfBase +
    before.backroomBase +
    after.deliveredBase -
    after.returnsBase -
    after.shelfBase -
    after.backroomBase;
  return units < 0
    ? null
    : {
        quantityBase: units,
        days: (after.at - before.at) / 86_400_000,
        from: before.at,
        to: after.at,
      };
}
/** F-218: one base-unit calculator for every surface. Never sets price or posts a sale.
 * @param {any} f @param {any} policy */
export function suggest(f, policy) {
  const reasons = [];
  const demand = f.offtake
    ? f.offtake.quantityBase / f.offtake.days
    : f.historyDailyBase;
  const stock = f.stockBase;
  let qty =
    demand == null
      ? 0
      : Math.max(
          0,
          Math.ceil(
            demand * policy.coverDays * (1 + (f.upliftPct ?? 0) / 100) -
              (stock ?? 0),
          ),
        );
  if (demand != null)
    reasons.push(
      `${f.offtake ? "Measured offtake" : "Attributed order history"}: ${Math.round(demand * 100) / 100} base units/day × ${policy.coverDays} cover days; ${stock == null ? "stock unknown" : `${stock} shelf + back-room base units`}`,
    );
  if (f.absent) {
    qty = Math.max(qty, f.minimumBase);
    reasons.push(
      `Absent MSL line: propose at least ${f.minimumBase} base units`,
    );
  }
  if (f.focus) {
    qty = Math.max(qty, f.focus.minimumBase);
    reasons.push(`Focus SKU: ${f.focus.objective}`);
  }
  if (f.upliftPct)
    reasons.push(`Active promotion: ${f.upliftPct}% demand uplift`);
  if (demand == null)
    reasons.push(
      "Demand unknown; no measured offtake or attributed order history",
    );
  if (f.availableBase != null && qty > f.availableBase) {
    qty = f.availableBase;
    reasons.push("Limited to available van stock");
  }
  return {
    quantityBase: quantity(Math.ceil(qty)),
    reasons,
    status: qty > 0 ? "suggest" : demand == null ? "unknown" : "enough_stock",
    daysCover:
      stock != null && demand > 0
        ? Math.round((stock / demand) * 10) / 10
        : null,
  };
}
/** F-214: shelf absence is not outlet absence; an uncounted back room stays unknown.
 * @param {any} line @returns {boolean|null} */
export function stocking(line) {
  if (!line || line.state === "not_checked") return null;
  if (line.state === "present" || (line.backroomBase ?? 0) > 0) return true;
  return line.state === "absent" && line.backroomBase === 0 ? false : null;
}
/** F-214: ONE universe and unknown-inclusive bounds. Missing weights never become equal weights.
 * @param {any[]} members @param {Map<string, any>} observations */
export function distribution(members, observations) {
  const present = members.filter(
    (m) => stocking(observations.get(m.outletId)) === true,
  );
  const absent = members.filter(
    (m) => stocking(observations.get(m.outletId)) === false,
  );
  const unknown = members.length - present.length - absent.length;
  const pct = (/** @type {number} */ a, /** @type {number} */ b) =>
    b ? Math.round((a / b) * 1000) / 10 : null;
  const weightsKnown = members.every(
    (m) => Number.isSafeInteger(m.turnoverWeight) && m.turnoverWeight > 0,
  );
  const total = weightsKnown
    ? members.reduce((n, m) => n + m.turnoverWeight, 0)
    : 0;
  const weighted = weightsKnown
    ? present.reduce((n, m) => n + m.turnoverWeight, 0)
    : 0;
  return {
    universe: members.length,
    stocking: present.length,
    absent: absent.length,
    unknown,
    ndPct: unknown ? null : pct(present.length, members.length),
    ndLowerPct: pct(present.length, members.length),
    wdPct: unknown || !weightsKnown ? null : pct(weighted, total),
    wdLowerPct: weightsKnown ? pct(weighted, total) : null,
    weightsKnown,
  };
}
