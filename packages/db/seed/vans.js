import { ACTOR, ORGANIZATION as org, at, plusDays, weekday } from "./store.js";

/** Financial settlement has no canonical table in the frozen base schema. Its exact
 * centavo facts are preserved as tracked sample.van_settlement audit records, never
 * disguised as SAP events or a different domain's stock values.
 * @param {import('./store.js').Dataset} d @param {import('./company.js').Company} c @param {import('./stock.js').StockBook} stock
 * @param {{daily?:boolean,historical?:boolean,vehicles?:import('./store.js').Row[],sellers?:import('./company.js').Company["agents"]}} [options] */
export function vans(d, c, stock, options = {}) {
  const vehicles =
    options.vehicles ??
    [0, 1].map((i) =>
      d.add("vehicles", String(i), {
        organization_id: org,
        org_unit_id: c.units[i + 1].id,
        vehicle_code: `SMP-VAN-${i + 1}`,
        plate_number: `DEMO-${i + 1}`,
        name: `Sample Cebu Truck ${i + 1}`,
        truck_location_id: stock.locations[i + 1].id,
        home_location_id: stock.locations[0].id,
        status: "active",
        created_by: ACTOR,
      }),
    );
  const sellers = options.sellers ?? [c.agents[4], c.agents[7]];
  const yesterday = plusDays(d.anchorDate, -1),
    shortDate = plusDays(d.anchorDate, -3);
  // A Sunday shortage is recorded against Saturday's selling trip; never invent
  // a negative remittance on a Sunday trip with no field sales.
  const shortTripDate =
    weekday(shortDate) === 0 ? plusDays(shortDate, -1) : shortDate;
  const dates = Array.from({ length: d.days }, (_, i) =>
    plusDays(d.start, i),
  ).filter(
    (date) => weekday(date) !== 0 || [yesterday, d.anchorDate].includes(date),
  );
  for (const date of dates)
    for (const [vi, vehicle] of vehicles.entries()) {
      const seller = sellers[vi],
        key = `${date}-${vi}`,
        today = !options.historical && date === d.anchorDate;
      const unclosed = !options.daily && vi === 1 && date === yesterday;
      const start = new Date(at(date, 6 * 60)).toISOString(),
        end = new Date(at(date, 18 * 60)).toISOString();
      const routeSession = d.add(
        "truck_route_sessions",
        key,
        {
          organization_id: org,
          route_code: c.routes[seller.index].code,
          truck_location_id: stock.locations[vi + 1].id,
          salesperson_subject: seller.auth_subject,
          assigned_device_id: `sample-van-${vi}`,
          status: today ? "open" : unclosed ? "reconciling" : "closed",
          opened_at: start,
          closed_at: today || unclosed ? null : end,
          last_acknowledged_sequence: 1,
          lease_expires_at: new Date(at(date, 22 * 60)).toISOString(),
        },
        start,
      );
      const trip = d.add(
        "van_trips",
        key,
        {
          organization_id: org,
          org_unit_id: seller.org_unit_id,
          trip_number: `SMP-TRIP-${key}`,
          vehicle_id: vehicle.id,
          truck_location_id: stock.locations[vi + 1].id,
          source_location_id: stock.locations[0].id,
          route_id: c.routes[seller.index].id,
          service_date: date,
          salesperson_profile_id: seller.id,
          salesperson_subject: seller.auth_subject,
          driver_name: `Sample Driver ${vi + 1}`,
          helper_name: `Sample Helper ${vi + 1}`,
          status: today ? "active" : unclosed ? "reconciling" : "closed",
          started_at: start,
          route_session_id: routeSession.id,
          closed_at: today || unclosed ? null : end,
          created_by: ACTOR,
        },
        start,
      );
      const orders = d
        .rows("orders")
        .filter(
          (o) =>
            o.salesperson_subject === seller.auth_subject &&
            Date.parse(o.created_at) >= at(date) &&
            Date.parse(o.created_at) < at(plusDays(date, 1)) &&
            o.order_type === "field",
        );
      const posted = orders.filter((o) => o.status === "posted");
      const sold = new Map();
      for (const order of orders) {
        order.route_session_id = routeSession.id;
        order.source_location_id = stock.locations[vi + 1].id;
        order.order_type = "pos";
        if (order.status === "posted") stock.routeOrder(order.id, vi + 1);
      }
      for (const order of posted)
        for (const line of d
          .rows("order_lines")
          .filter((l) => l.order_id === order.id))
          sold.set(
            line.product_code,
            (sold.get(line.product_code) ?? 0) + Number(line.quantity),
          );
      // Each truck carries the sold range plus two cases of shelf stock per SKU.
      const range = c.products.filter(
        (p) => sold.has(p.code) || (p.index >= vi * 5 && p.index < vi * 5 + 6),
      );
      const loadLines = range.map((p) => ({
        p: p.index,
        qty: (sold.get(p.code) ?? 0) + p.caseQty * 2,
        from: 0,
        to: vi + 1,
      }));
      const loadMovement = stock.movement({
        key: `van-load-${key}`,
        kind: "van_load",
        sourceId: trip.id,
        time: at(date, 6 * 60),
        lines: loadLines,
      });
      const load = d.add(
        "van_trip_loads",
        key,
        {
          organization_id: org,
          trip_id: trip.id,
          load_number: 1,
          status: "posted",
          created_by: ACTOR,
          confirmed_by: seller.auth_subject,
          confirmed_at: start,
          approved_by: c.people.admin.auth_subject,
          approved_at: start,
          confirm_request_id: `sample:${key}`,
          command_key: `sample:van-load-${key}`,
          movement_id: loadMovement,
        },
        start,
      );
      for (const [ordinal, l] of loadLines.entries())
        d.add(
          "van_trip_load_lines",
          `${key}-${ordinal}`,
          {
            organization_id: org,
            load_id: load.id,
            trip_id: trip.id,
            line_number: ordinal + 1,
            product_id: c.products[l.p].id,
            product_code: c.products[l.p].code,
            uom_code: "PC",
            quantity_scale: 1,
            lot_id: stock.lots[l.p].id,
            lot_number: stock.lots[l.p].lot_number,
            expected_base: l.qty,
            actual_base: l.qty,
          },
          start,
        );
      const frozen = (/** @type {any} */ p) => ({
        productId: p.id,
        code: p.code,
        name: p.name,
        uomCode: "PC",
        quantityScale: "1",
        caseBase: String(p.caseQty),
        pieceBase: "1",
      });
      for (const l of loadLines)
        d.add(
          "van_stock_events",
          `load-${key}-${l.p}`,
          {
            trip_id: trip.id,
            source_id: load.id,
            kind: "load",
            product_id: c.products[l.p].id,
            stock_status: "available",
            delta_base: l.qty,
            facts: frozen(c.products[l.p]),
          },
          start,
        );
      for (const order of posted) {
        const lines = d
          .rows("order_lines")
          .filter((l) => l.order_id === order.id);
        const store = c.stores.find(
          (s) => s.customer.code === order.customer_code,
        );
        const receiptNumber = `SMP-RECEIPT-${order.order_number}`;
        // The retained invoice carries the same complete line facts a phone sale writes:
        // office voids, refunds and SAP posting read `receipt.lines`, never re-price.
        const saleLines = lines.map((line, ordinal) => {
          const product = c.products.find((p) => p.code === line.product_code);
          if (!product) throw new Error("Sample van product missing");
          const totalMinor = Math.round(Number(line.line_total) * 100);
          return {
            product,
            line,
            ordinal,
            facts: {
              ...frozen(product),
              quantityBase: String(line.quantity),
              unitPriceMinor: String(Math.round(Number(line.unit_price) * 100)),
              grossMinor: String(totalMinor),
              discountMinor: "0",
              totalMinor: String(totalMinor),
              lineNumber: ordinal,
            },
          };
        });
        const sale = d.add(
          "van_sales",
          order.id,
          {
            trip_id: trip.id,
            receipt_number: receiptNumber,
            outlet_id: store?.id ?? null,
            customer_code: order.customer_code,
            total_centavos: Math.round(Number(order.total) * 100),
            discount_centavos: 0,
            receipt: {
              receiptNumber,
              customer: {
                name: store?.name ?? "Sample account",
                code: order.customer_code,
                address: store?.address ?? "",
              },
              seller: { name: seller.name },
              truck: {
                name: vehicle.name,
                code: vehicle.vehicle_code,
                plateNumber: vehicle.plate_number,
              },
              tripNumber: trip.trip_number,
              currency: "PHP",
              totalMinor: String(Math.round(Number(order.total) * 100)),
              discountMinor: "0",
              lines: saleLines.map((l) => l.facts),
              payment: { kind: "cash", label: "Cash" },
              source: "sample",
              soldAt: Date.parse(order.created_at),
            },
            captured_request: { source: "sample", orderId: order.id },
          },
          order.created_at,
        );
        d.add(
          "van_payments",
          order.id,
          {
            trip_id: trip.id,
            sale_id: sale.id,
            kind: "sale",
            method: "cash",
            amount_centavos: Math.round(Number(order.total) * 100),
            facts: { source: "sample" },
          },
          order.created_at,
        );
        for (const { product, line, ordinal, facts } of saleLines) {
          d.add(
            "van_sale_lines",
            `${order.id}-${ordinal}`,
            {
              sale_id: sale.id,
              ordinal,
              product_id: product.id,
              quantity_base: line.quantity,
              total_centavos: Math.round(Number(line.line_total) * 100),
              facts,
            },
            order.created_at,
          );
          d.add(
            "van_stock_events",
            `sale-${order.id}-${ordinal}`,
            {
              trip_id: trip.id,
              source_id: sale.id,
              kind: "sale",
              product_id: product.id,
              stock_status: "available",
              delta_base: -Number(line.quantity),
              facts,
            },
            order.created_at,
          );
        }
      }
      if (today) continue;
      const returned = loadLines.map((l) => ({
        p: l.p,
        qty: l.qty - (sold.get(c.products[l.p].code) ?? 0),
        from: vi + 1,
        to: 0,
      }));
      const count = d.add(
        "stock_count_sessions",
        key,
        {
          organization_id: org,
          count_number: `SMP-COUNT-${key}`,
          count_type: "route_close",
          location_id: stock.locations[vi + 1].id,
          status: "approved",
          blind_count: true,
          snapshot_at: end,
          created_by: seller.auth_subject,
          approved_by: c.people.approver.auth_subject,
        },
        end,
      );
      for (const l of returned)
        d.add(
          "stock_count_lines",
          `${key}-${l.p}`,
          {
            organization_id: org,
            session_id: count.id,
            product_id: c.products[l.p].id,
            lot_id: stock.lots[l.p].id,
            stock_status: "available",
            system_base: l.qty,
            counted_base: l.qty,
            variance_base: 0,
            counted_by: seller.auth_subject,
            counted_at: end,
          },
          end,
        );
      const unload = stock.movement({
        key: `van-unload-${key}`,
        kind: "van_unload",
        sourceId: trip.id,
        time: at(date, 18 * 60 + 5),
        lines: returned,
      });
      const expected = posted.reduce(
        (sum, o) => sum + Math.round(Number(o.total) * 100),
        0,
      );
      const short =
        !options.daily && vi === 0 && date === shortTripDate ? 125_000 : 0;
      const vanCount = d.add(
        "van_stock_counts",
        key,
        {
          trip_id: trip.id,
          count_code: `SMP-COUNT-${key}`,
          variance_lines: 0,
          short_base: 0,
          over_base: 0,
          facts: { source: "sample" },
        },
        end,
      );
      for (const l of returned) {
        const facts = frozen(c.products[l.p]);
        d.add(
          "van_stock_count_lines",
          `${key}-${l.p}`,
          {
            count_id: vanCount.id,
            product_id: c.products[l.p].id,
            stock_status: "available",
            expected_base: l.qty,
            counted_base: l.qty,
            variance_base: 0,
            value_centavos: 0,
            facts,
          },
          end,
        );
        d.add(
          "van_stock_events",
          `unload-${key}-${l.p}`,
          {
            trip_id: trip.id,
            source_id: unload,
            kind: "unload",
            product_id: c.products[l.p].id,
            stock_status: "available",
            delta_base: -l.qty,
            facts,
          },
          end,
        );
      }
      const cashCount = d.add(
        "van_cash_counts",
        key,
        {
          trip_id: trip.id,
          expected_centavos: expected,
          declared_centavos: expected - short,
          variance_centavos: -short,
          facts: {
            source: "sample",
            reasonCode: short ? "cash_short" : "balanced",
          },
        },
        end,
      );
      if (!unclosed)
        d.add(
          "van_cash_remittances",
          key,
          {
            trip_id: trip.id,
            count_id: cashCount.id,
            amount_centavos: expected - short,
            received_by: c.people.approver.id,
            received_by_name: c.people.approver.name,
            reference: `Sample hand-in ${key}`,
          },
          at(short ? shortDate : date, 18 * 60 + 10),
        );
      d.event(
        "van_settlement",
        `settlement-${key}`,
        {
          tripId: trip.id,
          routeSessionId: routeSession.id,
          serviceDate: date,
          settlementDate: short ? shortDate : date,
          vehicleId: vehicle.id,
          sellerProfileId: seller.id,
          currency: "PHP",
          cashExpectedMinor: expected,
          cashRemittedMinor: unclosed ? 0 : expected - short,
          cashVarianceMinor: unclosed ? null : -short,
          status: unclosed
            ? "awaiting_remittance"
            : short
              ? "short"
              : "settled",
          countSessionId: count.id,
          unloadMovementId: unload,
          loadedBase: loadLines.reduce((n, l) => n + l.qty, 0),
          soldBase: [...sold.values()].reduce((n, q) => n + q, 0),
          returnedBase: returned.reduce((n, l) => n + l.qty, 0),
          stockVarianceBase: 0,
        },
        at(short ? shortDate : date, 18 * 60 + 10),
      );
    }
  return vehicles;
}
