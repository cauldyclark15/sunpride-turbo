import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { readCapped } from "../../core/router.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { nextDocNumber } from "../../core/docnum.js";
import { filesDir, MAX_MEDIA_BYTES } from "../../core/media.js";
import { commands, post } from "./commands.js";
import {
  blindStockGate,
  choice,
  id,
  integer,
  invalid,
  locationGate,
  notSelf,
  number,
  ORGANIZATION,
  productPolicy,
  snapshot,
  state,
  text,
  visibleLocations,
} from "./common.js";
import { requireReason } from "./reasons.js";
import { toleranceFor } from "./tolerances.js";
import { presenter } from "./units.js";

/**
 * Dispositions (SPEC 4.4) and the expiry board (SPEC 4.6).
 * Bad stock (damaged, expired, rejected, held) waits in its status; this module is the ONE place a
 * person decides what happens to it. The stock change itself is one postMovement call, on approval.
 */
export const DISPOSITION_DECISIONS = [
  "write_off",
  "return_to_supplier",
  "destroy",
  "release",
];
export const DISPOSITION_STATUSES = [
  "damaged",
  "expired",
  "rejected",
  "quarantine",
  "quality_hold",
];
/** Only stock that could be sold again can be released; expired and rejected stock cannot. */
const RELEASABLE = ["damaged", "quarantine", "quality_hold"];
const STATUS_LABEL = /** @type {Record<string,string>} */ ({
  damaged: "Damaged",
  expired: "Expired",
  rejected: "Rejected",
  quarantine: "On hold",
  quality_hold: "On hold",
});
const DECISION_LABEL = /** @type {Record<string,string>} */ ({
  write_off: "Write off",
  return_to_supplier: "Return to supplier",
  destroy: "Destroy",
  release: "Release to sale",
});
/** Default supervisor limit when neither the reason nor the tolerance table says otherwise: ₱1,000. */
const FALLBACK_LIMIT_CENTAVOS = 100000;

/** @param {number} base @param {any} wac @param {number} scale */
function valueOf(base, wac, scale) {
  const s = BigInt(scale);
  return Number((BigInt(base) * BigInt(wac ?? 0) * 2n + s) / (s * 2n));
}
const STATUS_FIELD = /** @type {Record<string,string>} */ ({
  damaged: "damaged_base",
  expired: "expired_base",
  rejected: "rejected_base",
  quarantine: "quarantine_base",
  quality_hold: "quality_hold_base",
  available: "available_stock_base",
});

/** Approval level for a value: reason limit first, then the damage tolerance, then ₱1,000.
 * @param {any} db @param {any} reason @param {number} valueCentavos @param {number} at */
export async function approvalFor(db, reason, valueCentavos, at) {
  let limit = reason?.approvalThresholdCentavos ?? null;
  let source = "reason";
  if (limit == null) {
    const t = await toleranceFor(db, ORGANIZATION, "truck_damage", at);
    limit = t.maxCentavos;
    source = t.isDefault ? "default damage limit" : "damage limit";
  }
  if (limit == null) {
    limit = FALLBACK_LIMIT_CENTAVOS;
    source = "default";
  }
  return {
    level: valueCentavos > limit ? "manager" : "supervisor",
    limit,
    source,
  };
}

/** Attach already-uploaded photos (matched by sha256, stored, owned by the actor).
 * @param {any} c @param {string} dispositionId @param {any} digests */
async function attachPhotos(c, dispositionId, digests) {
  if (digests == null) return 0;
  if (!Array.isArray(digests) || digests.length > 10)
    invalid("Add up to 10 photos");
  let added = 0;
  for (const digest of digests) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
      invalid("That photo could not be read. Take it again.");
    const [file] =
      await c.db`select id from files where sha256=${digest} and created_by=${c.actor.userId} and purpose='disposition-photo' and status='stored' and mime='image/jpeg' order by created_at desc limit 1`;
    if (!file) invalid("That photo is not uploaded yet. Upload it, then try again.", "photo_missing");
    const r =
      await c.db`insert into inventory_disposition_photos (disposition_id,file_id,sha256,added_by) values (${dispositionId},${file.id},${digest},${c.actor.userId}) on conflict (disposition_id,file_id) do nothing returning id`;
    added += r.length;
  }
  return added;
}
/** @param {any} db @param {string} dispositionId */
const photoCount = async (db, dispositionId) =>
  number(
    (
      await db`select count(*)::int as n from inventory_disposition_photos where disposition_id=${dispositionId}`
    )[0].n,
  );

/** Pieces still free to dispose of: stock in that status minus other open requests.
 * @param {any} db @param {any} r */
async function freeQuantity(db, r) {
  const field = STATUS_FIELD[r.statusFrom];
  let have;
  if (r.lotId) {
    const [lb] =
      await db`select physical_base from inventory_lot_balances where organization_id=${ORGANIZATION} and lot_id=${r.lotId} and location_id=${r.locationId} and stock_status=${r.statusFrom}`;
    have = number(lb?.physical_base ?? 0);
  } else {
    const [b] =
      await db`select * from inventory_balances where organization_id=${ORGANIZATION} and product_id=${r.productId} and location_id=${r.locationId}`;
    have = number(b?.[field] ?? 0);
  }
  const [open] =
    await db`select coalesce(sum(quantity_base),0)::bigint as q from inventory_dispositions where organization_id=${ORGANIZATION} and status='requested' and product_id=${r.productId} and location_id=${r.locationId} and from_stock_status=${r.statusFrom} and lot_id is not distinct from ${r.lotId ?? null} and id is distinct from ${r.exceptId ?? null}`;
  return { have, free: have - number(open.q) };
}

/** Quantity from base units or cases + pieces, using the product's own conversions.
 * @param {any} body @param {any} units */
function quantityFrom(body, units) {
  if (body.quantityBase != null)
    return integer(body.quantityBase, "Quantity", 1);
  const cases = integer(body.cases ?? 0, "Cases", 0),
    pieces = integer(body.pieces ?? 0, "Pieces", 0);
  if (cases && !units.basePerCase)
    invalid("Case size not set for this product", "uom_missing");
  if (pieces && !units.basePerPiece)
    invalid("Piece size not set for this product", "uom_missing");
  const base = cases * (units.basePerCase ?? 0) + pieces * (units.basePerPiece ?? 0);
  return integer(base, "Quantity", 1);
}

export function installDispositionCommands() {
  commands["dispositions/request"] = {
    cap: "inventory.adjustment.request",
    prepare: async (c, b) => {
      const locationId = id(b.locationId, "Location");
      await locationGate(c, "inventory.adjustment.request", locationId);
      return productPolicy(c.db, id(b.productId, "Product"));
    },
    run: async (c, b, { product, policy, tracking }) => {
      const decision = choice(b.decision, DISPOSITION_DECISIONS);
      const statusFrom = choice(b.fromStatus, DISPOSITION_STATUSES);
      if (decision === "release" && !RELEASABLE.includes(statusFrom))
        invalid(
          statusFrom === "expired"
            ? "Expired stock can't go back on sale."
            : "Rejected stock can't go back on sale.",
          "disposition_not_releasable",
        );
      const lotId = b.lotId ? id(b.lotId, "Batch") : null;
      if (tracking === "lot" && !lotId)
        invalid("Choose the batch for this product.", "lot_required");
      if (tracking !== "lot" && lotId)
        invalid("This product has no batches.", "lot_not_allowed");
      const p = await presenter(c.db, product.id, c.now);
      const quantityBase = quantityFrom(b, p.units);
      const free = await freeQuantity(c.db, {
        statusFrom,
        lotId,
        locationId: b.locationId,
        productId: product.id,
      });
      if (quantityBase > free.free)
        invalid(
          free.free <= 0
            ? "All of this stock already has a request waiting."
            : `Only ${p.quantity(free.free).display} left that is not already requested.`,
          "quantity_unavailable",
        );
      let reason = null;
      const note = typeof b.note === "string" ? b.note.trim() : "";
      const photosNow = Array.isArray(b.photoDigests) ? b.photoDigests.length : 0;
      if (decision === "release") {
        if (!note) invalid("Say why this stock is fine to sell again.", "note_required");
      } else {
        reason = await requireReason(c.db, ORGANIZATION, b.reasonCode, {
          direction: "out",
          note,
          photoCount: photosNow,
        });
      }
      if (decision === "return_to_supplier" && !String(b.supplierRef ?? "").trim())
        invalid("Add the supplier or return slip number.", "supplier_ref_required");
      const [bal] =
        await c.db`select weighted_average_cost_minor as wac from inventory_balances where organization_id=${ORGANIZATION} and product_id=${product.id} and location_id=${b.locationId}`;
      const value = valueOf(quantityBase, bal?.wac ?? 0, p.units.scale);
      const approval = await approvalFor(c.db, reason, value, c.now);
      const [loc] =
        await c.db`select code from inventory_locations where id=${b.locationId}`;
      const number_ = await nextDocNumber(c.db, ORGANIZATION, {
        type: "DSP",
        locationCode:
          String(loc.code).toUpperCase().replace(/[^A-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "LOC",
        at: c.now,
      });
      const [row] =
        await c.db`insert into inventory_dispositions (organization_id,disposition_number,product_id,lot_id,location_id,from_stock_status,quantity_base,unit_cost_minor,value_minor,decision,reason_code,note,supplier_ref,status,approval_level,threshold_minor,requested_by) values (${ORGANIZATION},${number_},${product.id},${lotId},${b.locationId},${statusFrom},${quantityBase},${bal?.wac ?? 0},${value},${decision},${reason?.code ?? null},${note || null},${String(b.supplierRef ?? "").trim() || null},'requested',${approval.level},${approval.limit},${c.actor.userId}) returning id`;
      const photos = await attachPhotos(c, row.id, b.photoDigests);
      return {
        id: row.id,
        number: number_,
        status: "requested",
        approvalLevel: approval.level,
        valueCentavos: value,
        photos,
      };
    },
  };

  commands["dispositions/photo"] = {
    cap: "inventory.adjustment.request",
    prepare: async (c, b) => {
      const [row] =
        await c.db`select * from inventory_dispositions where id=${id(b.dispositionId)} and organization_id=${ORGANIZATION} for update`;
      if (!row) throw new ApiError("not_found", 404, "Request not found");
      await locationGate(c, "inventory.adjustment.request", row.location_id);
      return row;
    },
    run: async (c, b, row) => {
      state(row, ["requested"]);
      const added = await attachPhotos(c, row.id, b.photoDigests);
      return { id: row.id, added, photos: await photoCount(c.db, row.id) };
    },
  };

  commands["dispositions/decide"] = {
    cap: "inventory.adjustment.approve",
    prepare: async (c, b) => {
      const [row] =
        await c.db`select * from inventory_dispositions where id=${id(b.dispositionId)} and organization_id=${ORGANIZATION} for update`;
      if (!row) throw new ApiError("not_found", 404, "Request not found");
      await locationGate(c, "inventory.adjustment.approve", row.location_id);
      if (row.approval_level === "manager")
        await requireCapability(c, "inventory.approve");
      return row;
    },
    run: async (c, b, row) => {
      state(row, ["requested"]);
      notSelf(c.actor, row.requested_by);
      const verdict = choice(b.verdict, ["approve", "reject"]);
      const note = typeof b.note === "string" ? b.note.trim() : "";
      if (verdict === "reject") {
        if (!note) invalid("Say why this is declined.", "note_required");
        await c.db`update inventory_dispositions set status='rejected',decided_by=${c.actor.userId},decided_at=now(),decision_note=${note} where id=${row.id}`;
        return { id: row.id, number: row.disposition_number, status: "rejected" };
      }
      const photos = await photoCount(c.db, row.id);
      if (row.decision === "destroy" && photos < 1)
        invalid("Destroying stock needs a photo as proof.", "photo_required");
      if (row.reason_code) {
        await requireReason(c.db, ORGANIZATION, row.reason_code, {
          direction: row.decision === "release" ? undefined : "out",
          note: row.note,
          photoCount: photos,
        });
      }
      const free = await freeQuantity(c.db, {
        statusFrom: row.from_stock_status,
        lotId: row.lot_id,
        locationId: row.location_id,
        productId: row.product_id,
        exceptId: row.id,
      });
      const qty = number(row.quantity_base);
      if (qty > free.have)
        invalid("The stock changed since this was requested. Ask again with today's quantity.", "stock_changed");
      if (row.decision === "release" && row.lot_id) {
        const [lot] =
          await c.db`select expires_at from inventory_lots where id=${row.lot_id}`;
        if (lot?.expires_at && new Date(lot.expires_at).getTime() <= c.now)
          invalid("This batch is past its expiry date. It can't go back on sale.", "disposition_not_releasable");
      }
      const line = {
        productId: row.product_id,
        quantityBase: qty,
        uom: "base",
        lotId: row.lot_id ?? undefined,
        fromLocationId: row.location_id,
        fromStockStatus: row.from_stock_status,
        ...(row.decision === "release"
          ? { toLocationId: row.location_id, toStockStatus: "available" }
          : { toLocationId: null }),
        unitCostMinor: number(row.unit_cost_minor),
      };
      const movement = await post(
        c,
        {
          idempotencyKey: `disposition:${row.id}`,
          note: `${DECISION_LABEL[row.decision]} ${row.disposition_number}`,
        },
        row.decision === "release"
          ? "status_change"
          : row.decision === "return_to_supplier"
            ? "inventory_issue"
            : "inventory_adjustment",
        "disposition",
        row.id,
        [line],
      );
      await c.db`update inventory_dispositions set status='posted',decided_by=${c.actor.userId},decided_at=now(),decision_note=${note || null},movement_id=${movement.movementId} where id=${row.id}`;
      return {
        id: row.id,
        number: row.disposition_number,
        status: "posted",
        movementId: movement.movementId,
      };
    },
  };

  /** Expiry board actions: hold, move to bad order, prioritise on the next load. */
  commands["expiry/act"] = {
    cap: "inventory.adjustment.request",
    prepare: async (c, b) => {
      const locationId = id(b.locationId, "Location");
      await locationGate(c, "inventory.adjustment.request", locationId);
      const action = choice(b.action, ["hold", "bad_order", "prioritise", "unprioritise"]);
      if (action === "hold" || action === "bad_order")
        await locationGate(c, "inventory.write", locationId);
      const [lot] =
        await c.db`select * from inventory_lots where id=${id(b.lotId, "Batch")} and organization_id=${ORGANIZATION}`;
      if (!lot) throw new ApiError("not_found", 404, "Batch not found");
      return { lot, action };
    },
    run: async (c, b, { lot, action }) => {
      const note = typeof b.note === "string" ? b.note.trim() : "";
      if (action === "unprioritise") {
        await c.db`update inventory_expiry_actions set cleared_at=now() where organization_id=${ORGANIZATION} and lot_id=${lot.id} and location_id=${b.locationId} and action='prioritise' and cleared_at is null`;
        return { id: lot.id, action };
      }
      if (action === "prioritise") {
        const [open] =
          await c.db`select id from inventory_expiry_actions where organization_id=${ORGANIZATION} and lot_id=${lot.id} and location_id=${b.locationId} and action='prioritise' and cleared_at is null`;
        if (open) return { id: open.id, action, duplicate: true };
        const [r] =
          await c.db`insert into inventory_expiry_actions (organization_id,lot_id,location_id,product_id,action,note,acted_by) values (${ORGANIZATION},${lot.id},${b.locationId},${lot.product_id},'prioritise',${note || null},${c.actor.userId}) returning id`;
        return { id: r.id, action };
      }
      const [lb] =
        await c.db`select available_base from inventory_lot_balances where organization_id=${ORGANIZATION} and lot_id=${lot.id} and location_id=${b.locationId} and stock_status='available'`;
      const free = number(lb?.available_base ?? 0);
      const qty = b.quantityBase == null ? free : integer(b.quantityBase, "Quantity", 1);
      if (qty < 1 || qty > free)
        invalid(free < 1 ? "There is nothing available from this batch to move." : "That is more than what is available from this batch.", "quantity_unavailable");
      if (action === "bad_order")
        await requireReason(c.db, ORGANIZATION, b.reasonCode ?? "EXP", { direction: "out", note });
      const movement = await post(
        c,
        {
          idempotencyKey: `expiry:${b.idempotencyKey}`,
          note: action === "hold" ? `Held for expiry check ${note}` : `Moved to bad order (expiry) ${note}`,
        },
        "status_change",
        "expiry_board",
        lot.id,
        [
          {
            productId: lot.product_id,
            lotId: lot.id,
            quantityBase: qty,
            uom: "base",
            fromLocationId: b.locationId,
            toLocationId: b.locationId,
            fromStockStatus: "available",
            toStockStatus: action === "hold" ? "quality_hold" : "expired",
          },
        ],
      );
      const [r] =
        await c.db`insert into inventory_expiry_actions (organization_id,lot_id,location_id,product_id,action,quantity_base,note,movement_id,acted_by) values (${ORGANIZATION},${lot.id},${b.locationId},${lot.product_id},${action},${qty},${note || null},${movement.movementId},${c.actor.userId}) returning id`;
      return { id: r.id, action, movementId: movement.movementId, quantityBase: qty };
    },
  };
}

/** Bad-order queue: stock waiting for a decision, plus the requests in flight.
 * @param {any} ctx */
export async function queue(ctx) {
  return snapshot(ctx.db, async (db) => {
    const c = { ...ctx, db };
    const actor = await requireCapability(c, "inventory.read");
    const status = choice(ctx.url.searchParams.get("status"), ["requested", "posted", "rejected", "all"], "requested");
    const locations = await visibleLocations(c);
    const ids = locations.map((l) => l.id);
    await blindStockGate(c, ids);
    const locName = new Map(locations.map((l) => [l.id, l]));
    /** @type {Map<string,any>} */ const pres = new Map();
    const present = async (/** @type {string} */ productId) => {
      if (!pres.has(productId)) pres.set(productId, await presenter(db, productId, ctx.now));
      return pres.get(productId);
    };
    const requests = ids.length
      ? await db`select d.*,p.code,p.name,lot.lot_number,lot.expires_at,
          (select count(*)::int from inventory_disposition_photos x where x.disposition_id=d.id) as photos,
          (select coalesce(jsonb_agg(x.id order by x.created_at),'[]'::jsonb) from inventory_disposition_photos x where x.disposition_id=d.id) as photo_ids
        from inventory_dispositions d join products p on p.id=d.product_id left join inventory_lots lot on lot.id=d.lot_id
        where d.organization_id=${ORGANIZATION} and d.location_id in ${db(ids)} and (${status}='all' or d.status=${status})
        order by d.requested_at desc,d.id limit 500`
      : [];
    const outRequests = [];
    for (const d of requests) {
      const p = await present(d.product_id);
      const canTouch =
        d.status === "requested" &&
        roleHas(actor.role, d.approval_level === "manager" ? "inventory.approve" : "inventory.adjustment.approve") &&
        actor.userId !== d.requested_by;
      outRequests.push({
        id: d.id,
        number: d.disposition_number,
        status: d.status,
        decision: d.decision,
        decisionLabel: DECISION_LABEL[d.decision],
        fromStatus: d.from_stock_status,
        fromStatusLabel: STATUS_LABEL[d.from_stock_status],
        productId: d.product_id,
        code: d.code,
        name: d.name,
        locationId: d.location_id,
        locationName: locName.get(d.location_id)?.name,
        lotId: d.lot_id,
        lotNumber: d.lot_number,
        expiresAt: d.expires_at ? new Date(d.expires_at).getTime() : null,
        quantity: p.quantity(number(d.quantity_base)),
        valueCentavos: number(d.value_minor),
        reasonCode: d.reason_code,
        note: d.note,
        supplierRef: d.supplier_ref,
        approvalLevel: d.approval_level,
        approvalLimitCentavos: d.threshold_minor == null ? null : number(d.threshold_minor),
        needsPhoto: d.decision === "destroy" && d.photos < 1,
        photos: d.photos,
        photoUrls: d.photo_ids.map((/** @type {string} */ x) => `/api/v1/inventory/dispositions/photo?id=${x}`),
        requestedBy: d.requested_by,
        requestedAt: new Date(d.requested_at).getTime(),
        decidedAt: d.decided_at ? new Date(d.decided_at).getTime() : null,
        decisionNote: d.decision_note,
        movementId: d.movement_id,
        canDecide: canTouch,
      });
    }
    // stock sitting in a bad status that nobody has asked about yet
    const waiting = [];
    if (ids.length) {
      const lotRows = await db`select lb.product_id,lb.location_id,lb.lot_id,lb.stock_status,lb.physical_base,l.lot_number,l.expires_at,p.code,p.name,b.weighted_average_cost_minor as wac
        from inventory_lot_balances lb join inventory_lots l on l.id=lb.lot_id join products p on p.id=lb.product_id
        left join inventory_balances b on b.organization_id=lb.organization_id and b.product_id=lb.product_id and b.location_id=lb.location_id
        where lb.organization_id=${ORGANIZATION} and lb.location_id in ${db(ids)} and lb.stock_status in ('damaged','expired','rejected','quarantine','quality_hold') and lb.physical_base>0`;
      const prodRows = await db`select b.product_id,b.location_id,b.damaged_base,b.expired_base,b.rejected_base,b.quarantine_base,b.quality_hold_base,b.weighted_average_cost_minor as wac,p.code,p.name
        from inventory_balances b join products p on p.id=b.product_id
        where b.organization_id=${ORGANIZATION} and b.location_id in ${db(ids)} and (b.damaged_base>0 or b.expired_base>0 or b.rejected_base>0 or b.quarantine_base>0 or b.quality_hold_base>0)`;
      /** @type {Map<string,number>} */ const lotSum = new Map();
      for (const r of lotRows) {
        const k = `${r.product_id}:${r.location_id}:${r.stock_status}`;
        lotSum.set(k, (lotSum.get(k) ?? 0) + number(r.physical_base));
      }
      const open = await db`select product_id,location_id,lot_id,from_stock_status,sum(quantity_base)::bigint as q from inventory_dispositions where organization_id=${ORGANIZATION} and status='requested' group by product_id,location_id,lot_id,from_stock_status`;
      /** @type {Map<string,number>} */ const pending = new Map();
      for (const o of open)
        pending.set(`${o.product_id}:${o.location_id}:${o.lot_id ?? ""}:${o.from_stock_status}`, number(o.q));
      const candidates = [
        ...lotRows.map((/** @type {any} */ r) => ({ ...r, lotKey: r.lot_id, qty: number(r.physical_base), st: r.stock_status })),
      ];
      for (const r of prodRows)
        for (const st of DISPOSITION_STATUSES) {
          const have = number(r[STATUS_FIELD[st]]);
          const rest = have - (lotSum.get(`${r.product_id}:${r.location_id}:${st}`) ?? 0);
          if (rest > 0) candidates.push({ ...r, lot_id: null, lotKey: null, lot_number: null, expires_at: null, qty: rest, st });
        }
      for (const r of candidates) {
        const wait = r.qty - (pending.get(`${r.product_id}:${r.location_id}:${r.lotKey ?? ""}:${r.st}`) ?? 0);
        if (wait <= 0) continue;
        const p = await present(r.product_id);
        waiting.push({
          productId: r.product_id,
          code: r.code,
          name: r.name,
          locationId: r.location_id,
          locationName: locName.get(r.location_id)?.name,
          lotId: r.lot_id,
          lotNumber: r.lot_number,
          expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
          status: r.st,
          statusLabel: STATUS_LABEL[r.st],
          quantity: p.quantity(wait),
          valueCentavos: valueOf(wait, r.wac ?? 0, p.units.scale),
          releasable: RELEASABLE.includes(r.st),
          units: p.units,
        });
      }
      waiting.sort((a, b) => b.valueCentavos - a.valueCentavos);
    }
    return {
      asOf: ctx.now,
      waiting,
      requests: outRequests,
      summary: {
        waitingValueCentavos: waiting.reduce((s, r) => s + r.valueCentavos, 0),
        requestedValueCentavos: outRequests
          .filter((r) => r.status === "requested")
          .reduce((s, r) => s + r.valueCentavos, 0),
        waitingCount: waiting.length,
        requestedCount: outRequests.filter((r) => r.status === "requested").length,
      },
    };
  });
}

/** Stream one disposition photo to anyone who can read stock at that location.
 * @param {any} ctx */
export async function photo(ctx) {
  const photoId = id(ctx.url.searchParams.get("id"), "Photo");
  const [row] =
    await ctx.db`select f.path,d.location_id from inventory_disposition_photos x join inventory_dispositions d on d.id=x.disposition_id join files f on f.id=x.file_id where x.id=${photoId} and f.status='stored'`;
  if (!row) return new Response("Not found", { status: 404 });
  await locationGate(ctx, "inventory.read", row.location_id);
  return new Response(Bun.file(join(filesDir(ctx.env), row.path)), {
    headers: { "content-type": "image/jpeg", "cache-control": "private, no-store" },
  });
}

/**
 * Office upload of a bad-order photo (the device-proved media route cannot be used from a browser).
 * Raw JPEG body; stored content-addressed like every other evidence file with purpose `disposition-photo`;
 * the answer is the SHA-256 the request form sends as `photoDigests`.
 * @param {any} ctx
 */
export async function uploadPhoto(ctx) {
  const actor = await requireCapability(ctx, "inventory.adjustment.request");
  const bytes = await readCapped(ctx.req, MAX_MEDIA_BYTES);
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff
  )
    invalid("That file is not a photo. Take the photo again.", "photo_unreadable");
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const rel = `${digest.slice(0, 2)}/${digest}`;
  const root = filesDir(ctx.env);
  await mkdir(join(root, digest.slice(0, 2)), { recursive: true });
  const tmp = join(root, `${digest}.${crypto.randomUUID()}.part`);
  await Bun.write(tmp, bytes);
  await rename(tmp, join(root, rel));
  await ctx.db`insert into files (owner_id,purpose,sha256,mime,size,path,status,created_by,stored_at)
    values (null,'disposition-photo',${digest},'image/jpeg',${bytes.byteLength},${rel},'stored',${actor.userId},now())
    on conflict (created_by,purpose,owner_id,sha256) do update set status='stored',path=excluded.path,stored_at=coalesce(files.stored_at,now())`;
  return { sha256: digest, size: bytes.byteLength };
}

const BUCKETS = [
  { key: "expired", label: "Already expired", max: 0 },
  { key: "30", label: "Within 30 days", max: 30 },
  { key: "60", label: "31 to 60 days", max: 60 },
  { key: "90", label: "61 to 90 days", max: 90 },
];
/** Expiry board: batches by days to expiry. @param {any} ctx */
export async function expiryBoard(ctx) {
  return snapshot(ctx.db, async (db) => {
    const c = { ...ctx, db };
    await requireCapability(c, "inventory.read");
    const locations = await visibleLocations(c);
    let ids = locations.map((l) => l.id);
    const only = ctx.url.searchParams.get("locationId");
    if (only) {
      await locationGate(c, "inventory.read", id(only));
      ids = ids.filter((x) => x === only);
    }
    await blindStockGate(c, ids);
    const now = ctx.now ?? Date.now();
    const days = integer(Number(ctx.url.searchParams.get("days") ?? 90), "Days", 1);
    const productFilter = ctx.url.searchParams.get("productId") ? id(ctx.url.searchParams.get("productId"), "Product") : null;
    const locName = new Map(locations.map((l) => [l.id, l]));
    const rows = ids.length
      ? await db`select lb.product_id,lb.location_id,lb.lot_id,lb.stock_status,lb.physical_base,lb.reserved_base,lb.available_base,l.lot_number,l.expires_at,p.code,p.name,b.weighted_average_cost_minor as wac,
          exists(select 1 from inventory_lot_holds h where h.lot_id=lb.lot_id and h.released_at is null) as recall_held,
          exists(select 1 from inventory_expiry_actions a where a.lot_id=lb.lot_id and a.location_id=lb.location_id and a.action='prioritise' and a.cleared_at is null) as prioritised
        from inventory_lot_balances lb join inventory_lots l on l.id=lb.lot_id join products p on p.id=lb.product_id
          left join inventory_balances b on b.organization_id=lb.organization_id and b.product_id=lb.product_id and b.location_id=lb.location_id
        where lb.organization_id=${ORGANIZATION} and lb.location_id in ${db(ids)} and lb.physical_base>0 and lb.stock_status in ('available','quality_hold','quarantine')
          and l.expires_at is not null and l.expires_at<=${new Date(now + days * 86400000)}
          and (${productFilter}::uuid is null or lb.product_id=${productFilter})
        order by l.expires_at,p.code`
      : [];
    /** @type {Map<string,any>} */ const pres = new Map();
    const buckets = BUCKETS.filter((b) => b.max === 0 || b.max - 30 < days).map((b) => ({
      ...b,
      rows: /** @type {any[]} */ ([]),
      valueCentavos: 0,
    }));
    for (const r of rows) {
      if (!pres.has(r.product_id)) pres.set(r.product_id, await presenter(db, r.product_id, now));
      const p = pres.get(r.product_id);
      const left = Math.ceil((new Date(r.expires_at).getTime() - now) / 86400000);
      const bucket = buckets.find((b) => (b.max === 0 ? left <= 0 : left <= b.max && left > b.max - 30)) ?? buckets[buckets.length - 1];
      const value = valueOf(number(r.physical_base), r.wac ?? 0, p.units.scale);
      bucket.rows.push({
        productId: r.product_id,
        code: r.code,
        name: r.name,
        locationId: r.location_id,
        locationName: locName.get(r.location_id)?.name,
        lotId: r.lot_id,
        lotNumber: r.lot_number,
        expiresAt: new Date(r.expires_at).getTime(),
        daysLeft: left,
        status: r.stock_status,
        quantity: p.quantity(number(r.physical_base)),
        availableToMove: p.quantity(r.stock_status === "available" ? number(r.available_base) : 0),
        valueCentavos: value,
        onRecall: r.recall_held,
        prioritised: r.prioritised,
      });
      bucket.valueCentavos += value;
    }
    return {
      asOf: now,
      days,
      buckets: buckets.map((b) => ({
        key: b.key,
        label: b.label,
        count: b.rows.length,
        valueCentavos: b.valueCentavos,
        rows: b.rows,
      })),
    };
  });
}

/** @param {import('../../core/router.js').Router} router */
export function installDispositionRoutes(router) {
  installDispositionCommands();
  const prefix = "/api/v1/inventory";
  router.get(`${prefix}/dispositions`, queue);
  router.get(`${prefix}/dispositions/photo`, photo);
  router.post(`${prefix}/dispositions/upload`, uploadPhoto, { raw: true });
  router.get(`${prefix}/expiry-board`, expiryBoard);
}
