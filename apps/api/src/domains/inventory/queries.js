import { tx } from "@sunpride/db/client";
import {
  requireCapability,
  requireNationalScope,
  roleHas,
} from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import {
  blindStockGate,
  choice,
  document,
  id,
  integer,
  locationGate,
  manilaDate,
  number,
  ORGANIZATION,
  snapshot,
  visibleLocations,
} from "./common.js";
import { presenter } from "./units.js";

/** @param {any[]} items @param {any} ctx */
function page(items, ctx) {
  const limit = integer(
    Number(ctx.url.searchParams.get("limit") ?? 25),
    "Page size",
    1,
  );
  if (limit > 100)
    throw new ApiError("invalid_request", 400, "Page size cannot exceed 100");
  const offset = integer(
    Number(ctx.url.searchParams.get("cursor") ?? 0),
    "Page cursor",
  );
  return {
    items: items.slice(offset, offset + limit),
    nextCursor: offset + limit < items.length ? String(offset + limit) : null,
  };
}
/** @param {any[]} rows @param {string} key */
function total(rows, key) {
  return rows.some((r) => r[key] == null)
    ? null
    : number(rows.reduce((s, r) => s + number(r[key]), 0));
}
/** @param {any} ctx */
export async function overview(ctx) {
  // IP-VALUE: a repeatable-read snapshot gives the same consistency the org-wide lock did, without
  // making every sale wait while a screen loads.
  return snapshot(ctx.db, async (db) => {
    const c = { ...ctx, db };
    let locations = await visibleLocations(c);
    const filter = ctx.url.searchParams.get("locationId");
    if (filter) {
      await locationGate(c, "inventory.read", id(filter));
      locations = locations.filter((l) => l.id === filter);
    }
    await blindStockGate(
      c,
      locations.map((l) => l.id),
    );
    const products =
      await db`select * from products where organization_id=${ORGANIZATION} and active and deleted_at is null order by code`;
    if (products.length * locations.length > 20000)
      throw new ApiError(
        "scope_too_large",
        422,
        "Narrow the location filter to view stock",
      );
    const ids = locations.map((l) => l.id);
    const now = ctx.now,
      windowStart = now - 28 * 86400000,
      priorStart = now - 56 * 86400000;
    const balances = ids.length
      ? await db`select * from inventory_balances where organization_id=${ORGANIZATION} and location_id in ${db(ids)}`
      : [];
    const policies =
      await db`select * from replenishment_policies where organization_id=${ORGANIZATION} and enabled`;
    // All source location permissions of a transfer must be visible, just like trace.
    const entries = ids.length
      ? await db`select e.*,m.movement_type,m.effective_at from inventory_ledger_entries e join inventory_movements m on m.id=e.movement_id where e.organization_id=${ORGANIZATION} and e.location_id in ${db(ids)} and e.effective_at>=${new Date(priorStart)} and e.effective_at<=${new Date(now)}`
      : [];
    /** @type {Map<string,any>} */ const presentations = new Map();
    for (const product of products)
      presentations.set(product.id, await presenter(db, product.id, now));
    /** @type {any[]} */ const rows = [];
    for (const location of locations)
      for (const product of products) {
        const b = balances.find(
          (/** @type {any} */ r) =>
            r.product_id === product.id && r.location_id === location.id,
        );
        const p = presentations.get(product.id),
          onHand = p.quantity(b?.physical_base ?? 0),
          available = p.quantity(b?.available_base ?? 0);
        const policy =
          policies.find(
            (/** @type {any} */ r) =>
              r.product_id === product.id && r.location_id === location.id,
          ) ??
          policies.find(
            (/** @type {any} */ r) =>
              r.product_id === product.id && r.location_id == null,
          );
        const history = entries.filter(
          (/** @type {any} */ e) =>
            e.product_id === product.id && e.location_id === location.id,
        );
        const issued = (/** @type {number} */ from, /** @type {number} */ to) =>
          history
            .filter(
              (/** @type {any} */ e) =>
                ["inventory_issue", "pos_sale"].includes(e.movement_type) &&
                number(e.quantity_delta_base) < 0 &&
                new Date(e.effective_at).getTime() >= from &&
                new Date(e.effective_at).getTime() < to,
            )
            .reduce(
              (/** @type {number} */ s, /** @type {any} */ e) =>
                s - number(e.quantity_delta_base),
              0,
            );
        const issues = issued(windowStart, now + 1),
          priorIssues = issued(priorStart, windowStart);
        const net = history
          .filter(
            (/** @type {any} */ e) =>
              new Date(e.effective_at).getTime() >= windowStart,
          )
          .reduce(
            (/** @type {number} */ s, /** @type {any} */ e) =>
              s + number(e.quantity_delta_base),
            0,
          );
        const target = policy ? p.quantity(policy.target_level_base) : null;
        rows.push({
          productId: product.id,
          code: product.code,
          name: product.name,
          category: product.category,
          locationId: location.id,
          locationCode: location.code,
          locationName: location.name,
          locationType: location.type,
          kind:
            location.type === "warehouse"
              ? "depot"
              : location.type === "truck"
                ? "truck"
                : "other",
          onHand,
          available,
          reserved: p.quantity(b?.reserved_base ?? 0),
          hold: p.quantity(
            number(b?.quality_hold_base) + number(b?.quarantine_base),
          ),
          badOrders: p.quantity(
            number(b?.damaged_base) +
              number(b?.rejected_base) +
              number(b?.expired_base),
          ),
          valueCentavos: onHand.valueCentavos,
          prior: p.quantity(onHand.base - net),
          issues28: p.quantity(issues),
          priorIssues28: p.quantity(priorIssues),
          avgDailyIssueBase: issues / 28,
          daysCover: issues
            ? Math.max(0, available.base) / (issues / 28)
            : null,
          target,
          reorderPoint: policy ? p.quantity(policy.reorder_point_base) : null,
          suggested: policy
            ? p.quantity(
                Math.max(0, number(policy.target_level_base) - available.base),
              )
            : null,
          status:
            available.base <= 0
              ? "out"
              : policy
                ? available.base <= number(policy.reorder_point_base)
                  ? "low"
                  : "ok"
                : "needs_setup",
          units: p.units,
          priceSource: p.priceSource,
          version: b?.version ?? 0,
        });
      }
    const nearRows = ids.length
      ? await db`select b.*,l.lot_number,l.expires_at,p.code,p.name from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id join products p on p.id=b.product_id where b.organization_id=${ORGANIZATION} and b.location_id in ${db(ids)} and b.physical_base>0 and l.expires_at>${new Date(now)} and l.expires_at<=${new Date(now + 30 * 86400000)} order by l.expires_at,b.id`
      : [];
    const nearExpiry = nearRows.map((/** @type {any} */ r) => ({
      id: r.id,
      lotId: r.lot_id,
      lotNumber: r.lot_number,
      productId: r.product_id,
      code: r.code,
      name: r.name,
      locationId: r.location_id,
      locationName: locations.find((l) => l.id === r.location_id)?.name,
      expiresAt: new Date(r.expires_at).getTime(),
      quantity: presentations.get(r.product_id)?.quantity(r.physical_base),
    }));
    const locationTotals = locations.map((l) => {
      const subset = rows.filter((r) => r.locationId === l.id);
      return {
        id: l.id,
        code: l.code,
        name: l.name,
        type: l.type,
        kind:
          l.type === "warehouse"
            ? "depot"
            : l.type === "truck"
              ? "truck"
              : "other",
        valueCentavos: total(subset, "valueCentavos"),
        priorValueCentavos: total(
          subset.map((r) => ({ v: r.prior.valueCentavos })),
          "v",
        ),
        out: subset.filter((r) => r.status === "out").length,
        low: subset.filter((r) => r.status === "low").length,
      };
    });
    const trend = [];
    for (let d = 13; d >= 0; d--) {
      const end = new Date(
        `${manilaDate(now - d * 86400000)}T23:59:59.999+08:00`,
      ).getTime();
      const values = rows.map((r) => {
        const net = entries
          .filter(
            (/** @type {any} */ e) =>
              e.product_id === r.productId &&
              e.location_id === r.locationId &&
              new Date(e.effective_at).getTime() > end,
          )
          .reduce(
            (/** @type {number} */ s, /** @type {any} */ e) =>
              s + number(e.quantity_delta_base),
            0,
          );
        return {
          value: presentations.get(r.productId).quantity(r.onHand.base - net)
            .valueCentavos,
        };
      });
      trend.push({
        date: manilaDate(now - d * 86400000),
        valueCentavos: total(values, "value"),
      });
    }
    return {
      asOf: now,
      period: {
        from: manilaDate(windowStart),
        to: manilaDate(now),
        definition:
          "Trailing 28 days of inventory issues and POS sales; transfers do not count as demand",
      },
      valuation: "Default price-list selling value, not accounting cost",
      nearExpiryDays: 30,
      locations: locationTotals,
      rows,
      out: rows.filter((r) => r.status === "out"),
      low: rows.filter((r) => r.status === "low"),
      nearExpiry,
      trend,
      summary: {
        valueCentavos: total(rows, "valueCentavos"),
        priorValueCentavos: total(
          rows.map((r) => ({ v: r.prior.valueCentavos })),
          "v",
        ),
        outAtDepot: rows.filter((r) => r.kind === "depot" && r.status === "out")
          .length,
        low: rows.filter((r) => r.status === "low").length,
        nearExpiry: nearExpiry.length,
        unknownPrices: rows.filter((r) => r.valueCentavos == null).length,
        policiesMissing: rows.filter((r) => !r.target).length,
      },
    };
  });
}

/** @param {any} ctx */
export async function catalog(ctx) {
  await requireCapability(ctx, "inventory.read");
  const products =
    await ctx.db`select id from products where organization_id=${ORGANIZATION} and active and deleted_at is null order by code`;
  const rows = [];
  for (const r of products) {
    const p = await presenter(ctx.db, r.id, ctx.now);
    rows.push({
      id: p.product.id,
      code: p.product.code,
      name: p.product.name,
      tracking: p.tracking,
      units: p.units,
    });
  }
  return rows;
}
/** @param {any} ctx */
export async function countDetail(ctx) {
  return tx(ctx.db, async (db) => {
    const session = await document(
      db,
      "stock_count_sessions",
      id(ctx.url.searchParams.get("sessionId")),
    );
    const actor = await requireCapability({ ...ctx, db }, "inventory.read");
    await locationGate({ ...ctx, db }, "inventory.read", session.location_id);
    const rows =
      await db`select l.*,p.code,p.name,lot.lot_number from stock_count_lines l join products p on p.id=l.product_id left join inventory_lots lot on lot.id=l.lot_id where l.session_id=${session.id} order by p.code,l.id`;
    const counter =
      session.created_by === actor.userId ||
      rows.some((/** @type {any} */ l) => l.counted_by === actor.userId);
    const showExpected =
      !session.blind_count ||
      (!counter && roleHas(actor.role, "inventory.count.approve"));
    const result = [];
    for (const l of rows) {
      const p = await presenter(db, l.product_id, ctx.now);
      result.push({
        id: l.id,
        productId: l.product_id,
        code: l.code,
        name: l.name,
        lotNumber: l.lot_number,
        stockStatus: l.stock_status,
        counted: l.counted_base == null ? null : p.quantity(l.counted_base),
        ...(showExpected
          ? {
              expected: p.quantity(l.system_base),
              variance:
                l.variance_base == null ? null : p.quantity(l.variance_base),
            }
          : {}),
      });
    }
    return {
      session: {
        id: session.id,
        number: session.count_number,
        locationId: session.location_id,
        status: session.status,
        blindCount: session.blind_count,
        createdBy: session.created_by,
      },
      canApprove:
        roleHas(actor.role, "inventory.count.approve") &&
        !counter &&
        session.status === "submitted",
      lines: result,
    };
  });
}
/** @param {any} ctx @param {string} [onlyMovement] */
export async function movements(ctx, onlyMovement) {
  const locations = await visibleLocations(ctx),
    ids = locations.map((l) => l.id);
  await blindStockGate(ctx, ids);
  const productId = ctx.url.searchParams.get("productId");
  if (productId) id(productId);
  const all =
    await ctx.db`select * from inventory_movements where organization_id=${ORGANIZATION} order by posted_at desc,id desc`;
  const result = [];
  for (const m of all) {
    if (onlyMovement && m.id !== onlyMovement) continue;
    if (m.source_type === "stock_count") {
      const [count] =
        await ctx.db`select s.id from inventory_adjustments a join stock_count_sessions s on s.id=a.source_count_id where a.id=${m.source_document_id}::uuid and (s.created_by=${ctx.actor?.userId} or exists (select 1 from stock_count_lines l where l.session_id=s.id and l.counted_by=${ctx.actor?.userId}))`;
      if (count) continue;
    }
    const rows =
      await ctx.db`select * from inventory_movement_lines where movement_id=${m.id} order by line_number`;
    if (
      !rows.length ||
      rows.some((/** @type {any} */ l) =>
        [l.from_location_id, l.to_location_id]
          .filter(Boolean)
          .some((k) => !ids.includes(k)),
      )
    )
      continue;
    if (
      productId &&
      !rows.some((/** @type {any} */ l) => l.product_id === productId)
    )
      continue;
    const output = [];
    for (const l of rows) {
      const p = await presenter(ctx.db, l.product_id, ctx.now);
      output.push({
        id: l.id,
        productId: l.product_id,
        code: p.product.code,
        name: p.product.name,
        quantity: p.quantity(l.quantity_base),
        from:
          locations.find((/** @type {any} */ r) => r.id === l.from_location_id)
            ?.name ?? null,
        to:
          locations.find((/** @type {any} */ r) => r.id === l.to_location_id)
            ?.name ?? null,
        fromStatus: l.from_stock_status,
        toStatus: l.to_stock_status,
      });
    }
    result.push({
      id: m.id,
      number: m.movement_number,
      kind: m.movement_type,
      status: m.status,
      at: new Date(m.effective_at).getTime(),
      lines: output,
    });
  }
  return page(result, ctx);
}
/** @param {any} ctx */
export async function trace(ctx) {
  const movementId = id(ctx.url.searchParams.get("movementId"));
  const found = await movements(ctx, movementId);
  if (!found.items.length)
    throw new ApiError(
      "not_found",
      404,
      "Movement not found in your stock scope",
    );
  const allocations =
    await ctx.db`select a.*,l.lot_number from inventory_allocations a join inventory_lots l on l.id=a.lot_id where a.movement_id=${movementId} order by a.allocation_sequence`;
  const ledger =
    await ctx.db`select * from inventory_ledger_entries where movement_id=${movementId} order by created_at,id`;
  const allocationRows = [];
  for (const a of allocations) {
    const p = await presenter(ctx.db, a.product_id, ctx.now);
    allocationRows.push({
      id: a.id,
      lotNumber: a.lot_number,
      quantity: p.quantity(a.quantity_base),
    });
  }
  const ledgerRows = [];
  for (const e of ledger) {
    const p = await presenter(ctx.db, e.product_id, ctx.now);
    ledgerRows.push({
      id: e.id,
      productId: e.product_id,
      locationId: e.location_id,
      status: e.stock_status,
      delta: p.quantity(e.quantity_delta_base),
      reservedDelta: p.quantity(e.reserved_delta_base),
      before: p.quantity(e.quantity_before_base),
      after: p.quantity(e.quantity_after_base),
      balanceVersion: e.balance_version,
    });
  }
  return {
    movement: found.items[0],
    allocations: allocationRows,
    ledger: ledgerRows,
  };
}
/** @param {any} ctx */
export async function productDetail(ctx) {
  const productId = id(ctx.url.searchParams.get("productId"));
  const all = await overview(ctx),
    p = await presenter(ctx.db, productId, ctx.now);
  return {
    product: {
      id: productId,
      code: p.product.code,
      name: p.product.name,
      units: p.units,
    },
    stock: all.rows.filter((r) => r.productId === productId),
    nearExpiry: all.nearExpiry.filter(
      (/** @type {any} */ r) => r.productId === productId,
    ),
    movements: await movements(ctx),
  };
}

/** @param {any} ctx @param {string} kind */
export async function documents(ctx, kind) {
  const locations = await visibleLocations(ctx),
    ids = locations.map((l) => l.id);
  const config =
    /** @type {Record<string,{table:string,number:string,locations:string[]}>} */ ({
      receipts: {
        table: "goods_receipts",
        number: "receipt_number",
        locations: ["receiving_location_id"],
      },
      transfers: {
        table: "stock_transfers",
        number: "transfer_number",
        locations: [
          "source_location_id",
          "destination_location_id",
          "in_transit_location_id",
        ],
      },
      counts: {
        table: "stock_count_sessions",
        number: "count_number",
        locations: ["location_id"],
      },
      adjustments: {
        table: "inventory_adjustments",
        number: "adjustment_number",
        locations: [],
      },
      reservations: {
        table: "inventory_reservations",
        number: "reservation_number",
        locations: [],
      },
    })[kind];
  if (!config) throw new ApiError("not_found", 404, "Stock list not found");
  const rows = await ctx.db.unsafe(
    `select * from ${config.table} where organization_id=$1 order by created_at desc,id desc`,
    [ORGANIZATION],
  );
  const result = [];
  for (const row of rows) {
    let locationIds = config.locations.map((k) => row[k]);
    if (kind === "adjustments") {
      const ls =
        await ctx.db`select location_id from inventory_adjustment_lines where adjustment_id=${row.id}`;
      locationIds = ls.map((/** @type {any} */ l) => l.location_id);
      if (!locationIds.length && row.source_count_id) {
        const [s] =
          await ctx.db`select location_id from stock_count_sessions where id=${row.source_count_id}`;
        if (s) locationIds = [s.location_id];
      }
    }
    if (kind === "reservations") {
      const ls =
        await ctx.db`select location_id from inventory_reservation_lines where reservation_id=${row.id}`;
      locationIds = ls.map((/** @type {any} */ l) => l.location_id);
    }
    if (!locationIds.length || locationIds.some((k) => !ids.includes(k)))
      continue;
    const actor = ctx.actor;
    const self = [row.requested_by, row.created_by].includes(actor?.userId);
    const approvalCap =
      kind === "counts" ? "inventory.count.approve" : "inventory.approve";
    result.push({
      id: row.id,
      number: row[config.number],
      status: row.status,
      locations: locationIds.map(
        (k) => locations.find((l) => l.id === k)?.name,
      ),
      canApprove: actor && roleHas(actor.role, approvalCap) && !self,
      requestedBy: row.requested_by ?? row.created_by ?? null,
    });
  }
  return page(result, ctx);
}
/** @param {any} ctx */
export async function negative(ctx) {
  const locations = await visibleLocations(ctx),
    ids = locations.map((l) => l.id);
  await blindStockGate(ctx, ids);
  let canManage = false;
  try {
    await requireNationalScope(ctx, ["admin"]);
    canManage = true;
  } catch {}
  const requested = ctx.url.searchParams.get("locationIds");
  const requestedIds =
    requested == null
      ? ids
      : requested
        ? requested
            .split(",")
            .map((/** @type {string} */ value) => id(value, "Location"))
        : [];
  if (requested != null && requestedIds.length > 200)
    throw new ApiError(
      "invalid_request",
      422,
      "Ask for at most 200 allowance locations",
    );
  const allowanceIds = [...new Set(requestedIds)].filter((value) =>
    ids.includes(value),
  );
  const flagStatus = choice(
    ctx.url.searchParams.get("status"),
    ["open", "resolved"],
    "open",
  );
  const allowances = allowanceIds.length
    ? await ctx.db`select * from negative_stock_allowances where organization_id=${ORGANIZATION} and location_id in ${ctx.db(allowanceIds)} and deleted_at is null`
    : [];
  const rows = ids.length
    ? await ctx.db`select f.*,p.code,p.name,l.name as location_name,m.movement_number,b.available_base from negative_stock_flags f join products p on p.id=f.product_id join inventory_locations l on l.id=f.location_id join inventory_movements m on m.id=f.movement_id left join inventory_balances b on b.organization_id=f.organization_id and b.product_id=f.product_id and b.location_id=f.location_id where f.organization_id=${ORGANIZATION} and f.location_id in ${ctx.db(ids)} and f.status=${flagStatus} order by f.created_at desc,f.id`
    : [];
  const flags = [];
  for (const f of rows) {
    const p = await presenter(ctx.db, f.product_id, ctx.now);
    flags.push({
      id: f.id,
      number: f.movement_number,
      code: f.code,
      name: f.name,
      locationName: f.location_name,
      shortfall: p.quantity(f.shortfall_base),
      current: p.quantity(f.available_base ?? 0),
      status: f.status,
      canResolve:
        f.status === "open" &&
        ctx.actor &&
        roleHas(ctx.actor.role, "inventory.adjustment.approve") &&
        ctx.actor.userId !== f.posted_by,
    });
  }
  return {
    canManage,
    allowances: allowances.map((/** @type {any} */ a) => ({
      id: a.id,
      locationId: a.location_id,
      active: a.active,
      movementTypes: a.movement_types,
      limitBase: a.limit_base == null ? null : number(a.limit_base),
      sourceRef: a.source_ref,
    })),
    flags: page(flags, ctx),
  };
}
/** @param {any} ctx */
export async function suggestions(ctx) {
  const all = await overview(ctx);
  return all.rows
    .filter((r) => r.suggested && r.available.base <= r.reorderPoint.base)
    .map((r) => ({
      productId: r.productId,
      code: r.code,
      name: r.name,
      locationId: r.locationId,
      locationName: r.locationName,
      available: r.available,
      target: r.target,
      reorderPoint: r.reorderPoint,
      suggested: r.suggested,
    }));
}
