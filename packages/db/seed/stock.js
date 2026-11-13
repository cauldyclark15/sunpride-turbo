import { ACTOR, ORGANIZATION as org, at, plusDays, rowId } from "./store.js";

/** Seed-only ledger builder: domain posting is deliberately a placeholder in this isolated
 * lane. Never used by HTTP handlers. It materializes the same movement/line/allocation/
 * command/ledger/balance facts atomically, without touching production posting seams.
 * @param {import('./store.js').Dataset} d @param {import('./company.js').Company} c */
export function stockBook(d, c) {
  const locations = ["depot", "truck-1", "truck-2"].map((key, i) =>
    d.add("inventory_locations", key, {
      organization_id: org,
      org_unit_id:
        i === 0 ? c.units[0].id : c.agents[i === 1 ? 4 : 7].org_unit_id,
      site_code: "SMP-CEBU",
      code: `SMP-${key.toUpperCase()}`,
      name: `Sample Cebu ${key}`,
      type: i ? "truck" : "warehouse",
      truck_code: i ? `SMP-VAN-${i}` : null,
      active: true,
      allows_picking: true,
      allows_receiving: true,
      allows_sale: true,
      allows_production: false,
    }),
  );
  const lots = c.products.map((p, i) => {
    d.add("product_inventory_policies", p.code, {
      organization_id: org,
      product_id: p.id,
      base_uom_id: c.uoms[0].id,
      quantity_scale: 1,
      quantity_precision: 0,
      tracking_mode: "lot",
      allocation_policy: "fefo",
      allow_mixed_lots_per_line: true,
      allow_negative_stock: false,
      quality_release_required: false,
      shelf_life_days: 365,
      expiry_date_required: true,
      manufacture_date_required: false,
      minimum_remaining_shelf_life_days: 1,
      costing_method: "weighted_average",
      version: 1,
      active: true,
    });
    d.add("replenishment_policies", p.code, {
      organization_id: org,
      product_id: p.id,
      location_id: locations[0].id,
      enabled: true,
      reorder_point_base: p.caseQty * 5,
      target_level_base: p.caseQty * 30,
      safety_stock_base: p.caseQty * 2,
      lead_time_days: 2,
      alert_cooldown_ms: 86_400_000,
    });
    return d.add("inventory_lots", p.code, {
      organization_id: org,
      product_id: p.id,
      lot_number: `SMP-LOT-${i}`,
      normalized_lot_number: `SMP-LOT-${i}`,
      source_type: "sample",
      manufactured_at: new Date(at(plusDays(d.start, -180))).toISOString(),
      received_at: d.epoch,
      expires_at: new Date(
        at(plusDays(d.anchorDate, i === 8 ? 7 : i === 9 ? 12 : 180)),
      ).toISOString(),
      quality_status: "released",
      unit_cost_minor: p.cost,
    });
  });
  /** @typedef {{key:string,kind:string,sourceId:string,time:number, lines:{p:number,qty:number,from:number|null,to:number|null}[]}} StockEvent */
  /** @type {StockEvent[]} */
  const events = [];
  /** @param {StockEvent} e */
  function movement(e) {
    events.push(e);
    return rowId("inventory_movements", e.key);
  }
  function finish() {
    // Provision opening + weekly replenishment from the generated demand, not from a
    // separately fabricated balance. This leaves exact, intentional closing stock.
    const desired = c.products.map((p, i) =>
      i < 3 ? 0 : i < 8 ? p.caseQty * 2 : p.caseQty * (20 + (i % 10)),
    );
    const demand = [...events].sort(
      (a, b) => a.time - b.time || a.key.localeCompare(b.key),
    );
    const weeks = Math.ceil(d.days / 7);
    const carried = c.products.map(() => 0);
    for (let w = 0; w < weeks; w++) {
      const start = at(plusDays(d.start, w * 7));
      const end = at(plusDays(d.start, (w + 1) * 7));
      const net = c.products.map(() => 0),
        peak = c.products.map(() => 0);
      for (const e of demand)
        if (e.time >= start && e.time < end)
          for (const l of e.lines) {
            net[l.p] += l.from === 0 ? l.qty : 0;
            net[l.p] -= l.to === 0 ? l.qty : 0;
            peak[l.p] = Math.max(peak[l.p], net[l.p]);
          }
      const lines = c.products
        .map((p, i) => {
          const buffer = w === weeks - 1 ? desired[i] : p.caseQty * 20;
          const qty = Math.max(
            0,
            peak[i] - carried[i],
            net[i] + buffer - carried[i],
          );
          carried[i] += qty - net[i];
          return { p: i, qty, from: null, to: 0 };
        })
        .filter((l) => l.qty > 0);
      if (lines.length)
        movement({
          key: `supply-${w}`,
          kind: w === 0 ? "opening_balance" : "goods_receipt",
          sourceId: `SMP-SUPPLY-${w}`,
          time: start,
          lines,
        });
    }
    // Peak funding can leave a little depot stock after yesterday's truck returns.
    // Put that excess on today's truck as an explicit, confirmed second load, rather
    // than overwriting a balance to manufacture the three stock-out flags.
    const excess = carried
      .map((qty, p) => ({ p, qty: qty - desired[p], from: 0, to: 1 }))
      .filter((l) => l.qty > 0);
    if (excess.length) {
      const trip = d
        .rows("van_trips")
        .find(
          (t) =>
            t.service_date === d.anchorDate &&
            t.truck_location_id === locations[1].id,
        );
      if (!trip)
        throw new Error("Sample final replenishment needs today's truck");
      const time = at(d.anchorDate, 12 * 60);
      const movementId = movement({
        key: "final-truck-replenishment",
        kind: "van_load",
        sourceId: trip.id,
        time,
        lines: excess,
      });
      const load = d.add(
        "van_trip_loads",
        "final-truck-replenishment",
        {
          organization_id: org,
          trip_id: trip.id,
          load_number: 2,
          status: "posted",
          created_by: ACTOR,
          confirmed_by: trip.salesperson_subject,
          confirmed_at: new Date(time).toISOString(),
          approved_by: c.people.admin.auth_subject,
          approved_at: new Date(time).toISOString(),
          confirm_request_id: "sample:final-truck-replenishment",
          command_key: "sample:final-truck-replenishment",
          movement_id: movementId,
        },
        time,
      );
      for (const [ordinal, l] of excess.entries())
        d.add(
          "van_trip_load_lines",
          `final-truck-${l.p}`,
          {
            organization_id: org,
            load_id: load.id,
            trip_id: trip.id,
            line_number: ordinal + 1,
            product_id: c.products[l.p].id,
            product_code: c.products[l.p].code,
            uom_code: "PC",
            quantity_scale: 1,
            lot_id: lots[l.p].id,
            lot_number: lots[l.p].lot_number,
            expected_base: l.qty,
            actual_base: l.qty,
          },
          time,
        );
      // r6van4: the trip's own stock ledger (van_stock_events) must carry this load too. Without it the office's
      // expected truck stock (ledger) and the truck balance disagree, so every stock count and trip close on today's
      // sample trip was refused with "Canonical truck stock changed".
      for (const l of excess)
        d.add(
          "van_stock_events",
          `final-truck-${l.p}`,
          {
            trip_id: trip.id,
            source_id: load.id,
            kind: "load",
            product_id: c.products[l.p].id,
            stock_status: "available",
            delta_base: l.qty,
            facts: {
              productId: c.products[l.p].id,
              code: c.products[l.p].code,
              name: c.products[l.p].name,
              uomCode: "PC",
              quantityScale: "1",
              caseBase: String(c.products[l.p].caseQty),
              pieceBase: "1",
            },
          },
          time,
        );
    }
    /** @type {Map<string,{qty:number,version:number,last:string}>} */
    const states = new Map();
    for (const e of events.sort(
      (a, b) => a.time - b.time || a.key.localeCompare(b.key),
    )) {
      const stamp = new Date(e.time).toISOString();
      const m = d.add(
        "inventory_movements",
        e.key,
        {
          organization_id: org,
          movement_number: `SMP-MOV-${e.key}`,
          movement_type: e.kind,
          source_type: "sample",
          source_document_id: e.sourceId,
          status: "posted",
          effective_at: stamp,
          posted_at: stamp,
          posted_by: ACTOR,
          idempotency_key: `sample:${e.key}`,
          note: "Demo data, not a live stock posting",
          schema_version: 1,
        },
        e.time,
      );
      for (const [ordinal, l] of e.lines.entries()) {
        const p = c.products[l.p];
        const line = d.add(
          "inventory_movement_lines",
          `${e.key}-${ordinal}`,
          {
            organization_id: org,
            movement_id: m.id,
            line_number: ordinal + 1,
            product_id: p.id,
            base_uom_id: c.uoms[0].id,
            quantity_base: l.qty,
            entered_quantity: String(l.qty),
            entered_uom_code: "PC",
            from_location_id: l.from === null ? null : locations[l.from].id,
            to_location_id: l.to === null ? null : locations[l.to].id,
            from_stock_status: l.from === null ? null : "available",
            to_stock_status: l.to === null ? null : "available",
            unit_cost_minor: p.cost,
            total_cost_minor: p.cost * l.qty,
            effective_at: stamp,
          },
          e.time,
        );
        const allocation = d.add(
          "inventory_allocations",
          `${e.key}-${ordinal}`,
          {
            organization_id: org,
            movement_id: m.id,
            movement_line_id: line.id,
            product_id: p.id,
            lot_id: lots[l.p].id,
            quantity_base: l.qty,
            from_location_id: line.from_location_id,
            to_location_id: line.to_location_id,
            from_stock_status: line.from_stock_status,
            to_stock_status: line.to_stock_status,
            allocation_sequence: ordinal + 1,
            allocation_policy: "fefo",
            user_selected: false,
            effective_at: stamp,
          },
          e.time,
        );
        for (const [location, sign] of [
          [l.from, -1],
          [l.to, 1],
        ]) {
          if (location === null) continue;
          const key = `${l.p}-${location}`;
          const state = states.get(key) ?? { qty: 0, version: 0, last: "" };
          const before = state.qty;
          state.qty += l.qty * Number(sign);
          if (state.qty < 0)
            throw new Error(`Negative sample stock: ${key} at ${e.key}`);
          state.version++;
          state.last = m.id;
          states.set(key, state);
          d.add(
            "inventory_ledger_entries",
            `${e.key}-${ordinal}-${location}`,
            {
              organization_id: org,
              movement_id: m.id,
              movement_line_id: line.id,
              allocation_id: allocation.id,
              product_id: p.id,
              lot_id: lots[l.p].id,
              location_id: locations[Number(location)].id,
              stock_status: "available",
              quantity_delta_base: l.qty * Number(sign),
              reserved_delta_base: 0,
              value_delta_minor: l.qty * Number(sign) * p.cost,
              balance_version: state.version,
              quantity_before_base: before,
              quantity_after_base: state.qty,
              effective_at: stamp,
              posted_at: stamp,
            },
            e.time,
          );
        }
      }
      d.add(
        "inventory_commands",
        e.key,
        {
          organization_id: org,
          idempotency_key: `sample:${e.key}`,
          command_type: e.kind,
          schema_version: 1,
          payload_hash: new Bun.CryptoHasher("sha256")
            .update(JSON.stringify(e))
            .digest("hex"),
          actor_subject: ACTOR,
          status: "posted",
          source_document_id: e.sourceId,
          movement_id: m.id,
          result: { movementId: m.id, sample: true },
          committed_at: stamp,
        },
        e.time,
      );
      d.event(
        "stock_posted",
        `stock-${e.key}`,
        { movementId: m.id, sourceId: e.sourceId, kind: e.kind },
        e.time,
      );
      if (e.kind === "goods_receipt") {
        const receipt = d.add(
          "goods_receipts",
          e.key,
          {
            organization_id: org,
            receipt_number: `SMP-GR-${e.key}`,
            receipt_type: "unplanned",
            receiving_location_id: locations[0].id,
            status: "posted",
            received_by: ACTOR,
            movement_id: m.id,
            note: "Sample weekly replenishment",
          },
          e.time,
        );
        for (const l of e.lines)
          d.add(
            "goods_receipt_lines",
            `${e.key}-${l.p}`,
            {
              organization_id: org,
              receipt_id: receipt.id,
              product_id: c.products[l.p].id,
              accepted_base: l.qty,
              rejected_base: 0,
              lot_id: lots[l.p].id,
              destination_status: "available",
              unit_cost_minor: c.products[l.p].cost,
              movement_line_id: rowId(
                "inventory_movement_lines",
                `${e.key}-${e.lines.indexOf(l)}`,
              ),
            },
            e.time,
          );
      }
    }
    for (const [pi, p] of c.products.entries())
      for (const [li, loc] of locations.entries()) {
        const state = states.get(`${pi}-${li}`) ?? {
          qty: 0,
          version: 0,
          last: null,
        };
        d.add("inventory_balances", `${pi}-${li}`, {
          product_code: p.code,
          warehouse_code: loc.code,
          on_hand: state.qty,
          reserved: 0,
          available: state.qty,
          as_of: d.noon,
          organization_id: org,
          product_id: p.id,
          location_id: loc.id,
          physical_base: state.qty,
          available_stock_base: state.qty,
          reserved_base: 0,
          available_base: state.qty,
          quality_hold_base: 0,
          quarantine_base: 0,
          damaged_base: 0,
          expired_base: 0,
          rejected_base: 0,
          wip_base: 0,
          in_transit_base: 0,
          weighted_average_cost_minor: p.cost,
          inventory_value_minor: state.qty * p.cost,
          version: state.version,
          last_movement_id: state.last,
        });
        if (state.last)
          d.add("inventory_lot_balances", `${pi}-${li}`, {
            organization_id: org,
            product_id: p.id,
            lot_id: lots[pi].id,
            location_id: loc.id,
            stock_status: "available",
            physical_base: state.qty,
            reserved_base: 0,
            available_base: state.qty,
            expiry_sort_key: Date.parse(lots[pi].expires_at),
            receipt_sequence: pi + 1,
            version: state.version,
            last_movement_id: state.last,
          });
      }
  }
  /** @param {string} orderId @param {number} location */
  function routeOrder(orderId, location) {
    const event = events.find((e) => e.sourceId === orderId);
    if (!event) throw new Error("Posted sample van order has no movement");
    event.kind = "pos_sale";
    for (const line of event.lines) line.from = location;
  }
  return { locations, lots, movement, finish, routeOrder };
}
/** @typedef {ReturnType<typeof stockBook>} StockBook */
