import { requireNationalScope } from "../../core/capabilities.js";
import { commands, post } from "./commands.js";
import {
  choice,
  document,
  id,
  integer,
  invalid,
  lines,
  locationGate,
  notSelf,
  ORGANIZATION,
  productPolicy,
  state,
  text,
} from "./common.js";

// Document-only commands still use execute()'s transaction, scope-before-replay,
// receipt, audit, publication and analytics refresh.
export function installCommandExtensions() {
  for (const kind of ["receipts", "adjustments"])
    commands[`${kind}/reverse`] = {
      cap: kind === "receipts" ? "inventory.write" : "inventory.approve",
      prepare: async (c, b) => {
        const row = await document(
          c.db,
          kind === "receipts" ? "goods_receipts" : "inventory_adjustments",
          id(kind === "receipts" ? b.receiptId : b.adjustmentId),
        );
        if (kind === "receipts")
          await locationGate(c, "inventory.write", row.receiving_location_id);
        else {
          const ls =
            await c.db`select * from inventory_adjustment_lines where adjustment_id=${row.id}`;
          for (const l of ls)
            await locationGate(c, "inventory.approve", l.location_id);
        }
        return row;
      },
      run: async (c, b, row) => {
        state(row, ["posted"]);
        if (kind === "adjustments") notSelf(c.actor, row.requested_by);
        text(b.reason, "Reversal reason", 500);
        if (!row.movement_id)
          invalid("This document has no stock movement to reverse");
        // IP-INT2 ask 7: a count adjustment bigger than the writer's 100-line limit is posted as several movements
        // (counts.js records them on the session); every one of them is reversed, or none.
        /** @type {string[]} */ let movementIds = [row.movement_id];
        if (kind === "adjustments" && row.source_count_id) {
          const [session] =
            await c.db`select movement_ids from stock_count_sessions where id=${row.source_count_id}`;
          if (Array.isArray(session?.movement_ids) && session.movement_ids.length)
            movementIds = session.movement_ids;
        }
        /** @type {any} */ let movement = null;
        /** @type {string[]} */ const reversalIds = [];
        for (const [n, movementId] of movementIds.entries()) {
          const [original] =
            await c.db`select * from inventory_movements where id=${movementId} for update`;
          if (original.status !== "posted")
            invalid("Movement has already been reversed");
          const rows =
            await c.db`select * from inventory_movement_lines where movement_id=${original.id} order by line_number`;
          /** @type {import('./posting.js').MovementLine[]} */ const posting = [];
          for (const l of rows) {
            const allocations =
              await c.db`select * from inventory_allocations where movement_line_id=${l.id} order by allocation_sequence`;
            for (const a of allocations.length
              ? allocations
              : [{ lot_id: null, quantity_base: l.quantity_base }])
              posting.push({
                productId: l.product_id,
                quantityBase: Number(a.quantity_base),
                fromLocationId: l.to_location_id,
                toLocationId: l.from_location_id,
                fromStockStatus: l.to_stock_status ?? "available",
                toStockStatus: l.from_stock_status ?? "available",
                lotId: a.lot_id,
                uom: l.entered_uom_code ?? "base",
                unitCostMinor: Number(l.unit_cost_minor ?? 0),
              });
          }
          // One reversal movement per original movement; the writer takes at most 100 lines.
          const key = n === 0 ? b.idempotencyKey : `${b.idempotencyKey}:r${n}`;
          const reversal = await post(
            c,
            { ...b, idempotencyKey: key, note: b.reason },
            "reversal",
            `${kind}_reversal`,
            row.id,
            posting,
          );
          movement ??= reversal;
          reversalIds.push(reversal.movementId);
          await c.db`update inventory_movements set status='reversed',reversed_by_movement_id=${reversal.movementId} where id=${original.id}`;
          await c.db`update inventory_movements set reverses_movement_id=${original.id} where id=${reversal.movementId}`;
        }
        if (kind === "receipts")
          await c.db`update goods_receipts set status='cancelled',note=${b.reason} where id=${row.id}`;
        else
          await c.db`update inventory_adjustments set status='reversed',note=${b.reason} where id=${row.id}`;
        return {
          id: row.id,
          ...movement,
          ...(reversalIds.length > 1 ? { movementIds: reversalIds } : {}),
        };
      },
    };
  commands["policies/save"] = {
    cap: "admin.manage",
    prepare: async (c, b) => {
      await requireNationalScope(c, ["admin"]);
      return productPolicy(c.db, id(b.productId));
    },
    run: async (c, b, { product, policy }) => {
      const tracking = choice(
        b.trackingMode,
        ["none", "lot"],
        policy?.tracking_mode ?? product.tracking_mode ?? "none",
      );
      const baseUomId = policy?.base_uom_id ?? product.base_uom_id,
        scale = Number(policy?.quantity_scale ?? product.quantity_scale ?? 1);
      if (!baseUomId)
        invalid("Set the product's base unit in the catalog first");
      if (
        tracking !== (policy?.tracking_mode ?? product.tracking_mode ?? "none")
      ) {
        const [stock] =
          await c.db`select 1 from inventory_balances where product_id=${product.id} and (physical_base<>0 or reserved_base<>0) limit 1`;
        if (stock) invalid("Tracking cannot change while stock exists");
      }
      const [r] =
        await c.db`insert into product_inventory_policies (organization_id,product_id,base_uom_id,quantity_scale,quantity_precision,tracking_mode,allocation_policy,allow_mixed_lots_per_line,allow_negative_stock,quality_release_required,expiry_date_required,manufacture_date_required,minimum_remaining_shelf_life_days,costing_method,version,active) values (${ORGANIZATION},${product.id},${baseUomId},${scale},0,${tracking},${choice(b.allocationPolicy, ["fefo", "fifo", "explicit_only"], "fefo")},${b.allowMixedLotsPerLine !== false},false,${b.qualityReleaseRequired === true},${b.expiryDateRequired === true},${b.manufactureDateRequired === true},${integer(b.minimumRemainingShelfLifeDays ?? 0, "Remaining shelf life")},'weighted_average',1,true) on conflict(organization_id,product_id) do update set tracking_mode=excluded.tracking_mode,allocation_policy=excluded.allocation_policy,allow_mixed_lots_per_line=excluded.allow_mixed_lots_per_line,quality_release_required=excluded.quality_release_required,expiry_date_required=excluded.expiry_date_required,manufacture_date_required=excluded.manufacture_date_required,minimum_remaining_shelf_life_days=excluded.minimum_remaining_shelf_life_days,version=product_inventory_policies.version+1 returning id`;
      return { id: r.id };
    },
  };
  commands["opening/post"] = {
    cap: "inventory.write",
    prepare: async (c, b) => {
      await requireNationalScope(c, ["admin"]);
      for (const l of lines(b.lines))
        await locationGate(c, "inventory.write", id(l.locationId));
      return null;
    },
    run: async (c, b) => {
      const sourceReference = text(
        b.sourceReference,
        "Opening-stock source",
        200,
      );
      const receipts = [];
      for (const l of b.lines) {
        const [existing] =
          await c.db`select * from inventory_balances where organization_id=${ORGANIZATION} and product_id=${id(l.productId)} and location_id=${l.locationId}`;
        if (
          existing &&
          (Number(existing.physical_base) !== 0 ||
            Number(existing.reserved_base) !== 0)
        )
          invalid(
            "Stock already exists; correct it through a count",
            "duplicate_stock",
          );
      }
      const groups = new Map();
      for (const l of b.lines)
        groups.set(l.locationId, [...(groups.get(l.locationId) ?? []), l]);
      for (const [locationId, ls] of groups) {
        const loc = await locationGate(c, "inventory.write", locationId);
        const run = /** @type {import('./commands.js').commands[string]} */ (
          commands["receipts/post"]
        ).run;
        receipts.push(
          await run(
            { ...c, openingStock: true },
            {
              ...b,
              idempotencyKey: `${b.idempotencyKey}:${locationId}`,
              deliveryReference: sourceReference,
              lines: ls,
            },
            loc,
          ),
        );
      }
      return { id: sourceReference, receipts };
    },
  };
}
