import {
  ACTOR,
  ORGANIZATION as org,
  at,
  nextMonth,
  plusDays,
  rowId,
  weekday,
} from "./store.js";

/** Sample SQL signature binds the whole plan, assignment, roster and snapshots.
 * COVERAGE must reconcile this with its signer after integration; no signing seam
 * exists in the isolated wave-three base.
 * @param {import('./store.js').Dataset} d @param {import('./store.js').Row} plan */
function planDigest(d, plan) {
  const payload = {
    format: "sample-sql-v1",
    plan: Object.fromEntries(
      [
        "id",
        "organization_id",
        "assignee_profile_id",
        "local_month",
        "version",
        "cycle_type",
        "org_unit_id",
        "requested_from",
        "requested_to",
        "effective_from",
        "effective_to",
        "based_on_plan_id",
        "revision_reason",
        "prepared_by",
        "content_revision",
      ].map((key) => [key, plan[key] ?? null]),
    ),
    territories: d
      .rows("coverage_plan_territories")
      .filter((r) => r.coverage_plan_id === plan.id)
      .sort((a, b) => a.ordinal - b.ordinal),
    assignments: d
      .rows("coverage_assignments")
      .filter((r) => r.plan_id === plan.id)
      .sort((a, b) => a.id.localeCompare(b.id)),
    outlets: d
      .rows("coverage_plan_outlets")
      .filter((r) => r.plan_id === plan.id)
      .sort((a, b) => a.outlet_id.localeCompare(b.outlet_id)),
    slots: d
      .rows("coverage_plan_slots")
      .filter((r) => r.plan_id === plan.id)
      .sort((a, b) => a.slot_key.localeCompare(b.slot_key)),
  };
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

/** @param {import('./store.js').Dataset} d @param {import('./company.js').Company} c @param {import('./stock.js').StockBook} stock */
export function execution(d, c, stock) {
  const dates = Array.from({ length: d.days }, (_, i) => plusDays(d.start, i));
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
  /** @type {Map<string, import('./store.js').Row>} */
  const plans = new Map();
  for (const month of months)
    for (const a of c.agents) {
      const first = `${month}-01` < d.start ? d.start : `${month}-01`;
      const end = `${nextMonth(month)}-01`;
      const plan = d.add("coverage_plans", `${a.index}-${month}`, {
        organization_id: org,
        assignee_profile_id: a.id,
        local_month: month,
        version: 1,
        cycle_type: "monthly",
        org_unit_id: a.org_unit_id,
        requested_from: new Date(at(first)).toISOString(),
        requested_to: new Date(at(end)).toISOString(),
        effective_from: new Date(at(first)).toISOString(),
        effective_to: new Date(at(end)).toISOString(),
        status: "active",
        prepared_by: a.auth_subject,
        prepared_at: new Date(at(first) - 3_600_000).toISOString(),
        submitted_by: a.auth_subject,
        submitted_at: new Date(at(first) - 1_800_000).toISOString(),
        approved_by: c.people.manager.auth_subject,
        approved_at: new Date(at(first) - 60_000).toISOString(),
        approver_profile_id: c.people.manager.id,
        approval_capacity: "scope_approver",
        activated_at: new Date(at(first)).toISOString(),
        content_revision: 1,
        created_by: a.auth_subject,
        updated_by: ACTOR,
      });
      plans.set(`${a.index}-${month}`, plan);
      d.add("coverage_plan_territories", plan.id, {
        coverage_plan_id: plan.id,
        ordinal: 0,
        territory_id: c.territories[a.territoryIndex].id,
      });
      d.add("coverage_assignments", plan.id, {
        plan_id: plan.id,
        assignee_profile_id: a.id,
        org_unit_id: a.org_unit_id,
        is_primary: true,
        effective_from: plan.effective_from,
        effective_to: plan.effective_to,
        actor_subject: ACTOR,
        reason: "Sample approved MCP",
      });
      for (const s of c.stores.filter(
        (s) => s.territoryIndex === a.territoryIndex,
      ))
        d.add("coverage_plan_outlets", `${plan.id}-${s.id}`, {
          plan_id: plan.id,
          outlet_id: s.id,
          route_id: s.route.id,
          territory_id: c.territories[a.territoryIndex].id,
          frequency: "custom",
          preferred_weekdays: [],
          custom_local_dates: [],
          priority: 1,
          expected_duration_minutes: a.positionCode === "KAS" ? 45 : 10,
          required_objectives: ["sell"],
          content_revision: 1,
          updated_by: ACTOR,
        });
    }
  /** @type {Map<string, any[]>} */
  const invoices = new Map();
  /** @type {Map<string, number>} */
  const monthlySales = new Map();
  /** @type {Map<string, number>} */
  const agentSales = new Map();
  /** @type {Map<string, number>} */
  const channelSales = new Map();
  /** @type {Map<string, any>} */
  const dayFacts = new Map();
  /** @type {any[]} */
  const todayOrders = [];
  let productiveCounter = 0,
    completedCounter = 0,
    orderCounter = 0;
  /** @param {Map<string, number>} map @param {string} key @param {number} amount */
  const addSum = (map, key, amount) =>
    map.set(key, (map.get(key) ?? 0) + amount);
  for (const [dayIndex, date] of dates.entries()) {
    if (weekday(date) === 0) continue;
    const today = date === d.anchorDate,
      month = date.slice(0, 7);
    for (const a of c.agents) {
      const plan = /** @type {import('./store.js').Row} */ (
        plans.get(`${a.index}-${month}`)
      );
      const eligible = c.stores.filter(
        (s) =>
          s.territoryIndex === a.territoryIndex &&
          (a.positionCode === "KAS"
            ? ["kas", "supermarket"].includes(s.channel)
            : a.positionCode.startsWith("PMOT")
              ? ["gt", "pmot"].includes(s.channel)
              : true),
      );
      const visitsDone =
        Math.floor((dayIndex + 1) * a.dailyCalls * a.compliance) -
        Math.floor(dayIndex * a.dailyCalls * a.compliance);
      const todayMode = [1, 9].includes(a.index)
        ? "not_started"
        : [0, 2, 5, 8].includes(a.index)
          ? "done"
          : a.index === 10
            ? "idle"
            : "in_call";
      const done = today
        ? todayMode === "not_started"
          ? 0
          : todayMode === "done"
            ? a.dailyCalls
            : todayMode === "idle"
              ? 4
              : Math.floor(a.dailyCalls / 2)
        : visitsDone;
      /** @type {any} */
      const f = {
        a,
        date,
        planned: a.dailyCalls,
        calls: done,
        productive: 0,
        sales: 0,
        orders: 0,
        returnOrders: 0,
        collections: 0,
        collectionMinor: 0,
        first: null,
        last: null,
        duration: 0,
        open: today && todayMode === "in_call" ? 1 : 0,
        todayMode,
        lastVisitId: null,
      };
      dayFacts.set(`${a.index}-${date}`, f);
      for (let sequence = 0; sequence < a.dailyCalls; sequence++) {
        // Rotate a 75-store universe without duplicate stores on a person's day.
        const s =
          eligible[(dayIndex * 7 + a.index * 13 + sequence) % eligible.length];
        const key = `${a.index}-${date}-${sequence}`;
        const snapshot = {
          source: "sample",
          outletId: s.id,
          outletCode: s.code,
          outletName: s.name,
          customerId: s.customer.id,
          outletCustomerLinkId: rowId("outlet_customer_links", String(s.index)),
          territoryId: c.territories[a.territoryIndex].id,
          territoryCode: c.territories[a.territoryIndex].code,
          routeId: s.route.id,
          routeCode: s.route.code,
          sequence: sequence + 1,
          outletAssignmentId: rowId("outlet_assignments", String(s.index)),
          territoryOwnershipId: rowId(
            "territory_ownerships",
            String(a.territoryIndex),
          ),
          employeeAssignmentId: rowId("employee_assignments", a.id),
          orgUnitId: a.org_unit_id,
          activityKind: "outlet_visit",
          approvedAssigneeProfileId: a.id,
        };
        const slot = d.add("coverage_plan_slots", key, {
          slot_key: `SMP-${key}`,
          plan_id: plan.id,
          assignee_profile_id: a.id,
          service_date: date,
          kind: "outlet_visit",
          outlet_id: s.id,
          route_id: s.route.id,
          required_objectives: ["sell"],
          intents: ["sell"],
          sequence: sequence + 1,
          expected_duration_minutes: a.positionCode === "KAS" ? 45 : 10,
          approved_snapshot: snapshot,
          content_revision: 1,
          updated_by: ACTOR,
        });
        const planned = d.add("planned_visits", key, {
          generation_key: `sample:${key}`,
          plan_id: plan.id,
          plan_version: 1,
          plan_slot_id: slot.id,
          assignee_profile_id: a.id,
          outlet_id: s.id,
          service_date: date,
          status: "planned",
          approved_snapshot: snapshot,
          required_objectives: ["sell"],
          intents: ["sell"],
          expected_duration_minutes: slot.expected_duration_minutes,
          generated_at: plan.effective_from,
        });
        const isOpen = today && todayMode === "in_call" && sequence === done;
        if (sequence >= done && !isOpen) continue;
        const startMinute = today
          ? 7 * 60 +
            sequence *
              (todayMode === "done" ? 250 / a.dailyCalls : 280 / a.dailyCalls)
          : 8 * 60 + sequence * ((8 * 60) / a.dailyCalls);
        const checkIn = at(date, isOpen ? 11 * 60 + 55 : startMinute);
        const sampledDuration =
          (a.positionCode === "KAS" ? 32 + d.rng() * 15 : 5 + d.rng() * 7) *
          60_000;
        const duration = Math.round(
          today
            ? Math.min(
                sampledDuration,
                ((todayMode === "done" ? 250 : 280) / a.dailyCalls - 1) *
                  60_000,
              )
            : sampledDuration,
        );
        const checkOut = isOpen
          ? null
          : Math.min(
              checkIn + duration,
              at(date, today ? 11 * 60 + 50 : 17 * 60),
            );
        if (!isOpen) completedCounter++;
        const productive =
          !isOpen &&
          Math.floor(completedCounter * 0.7) >
            Math.floor((completedCounter - 1) * 0.7);
        if (productive) productiveCounter++;
        const v = d.add(
          "visit_executions",
          key,
          {
            organization_id: org,
            client_visit_id: `sample:${key}`,
            planned_visit_id: planned.id,
            plan_id: plan.id,
            slot_id: slot.id,
            plan_version: 1,
            assignee_profile_id: a.id,
            outlet_id: s.id,
            org_unit_id: a.org_unit_id,
            route_id: s.route.id,
            customer_id: s.customer.id,
            service_date: date,
            source: "planned",
            intents: ["sell"],
            state: isOpen ? "in-progress" : "completed",
            outcome: isOpen ? null : "completed",
            productivity: isOpen
              ? "pending"
              : productive
                ? "verified"
                : "nonproductive",
            rule_version: "sample-objective-v1",
            last_server_time: new Date(checkOut ?? checkIn).toISOString(),
            checked_in_at: new Date(checkIn).toISOString(),
            checked_out_at:
              checkOut === null ? null : new Date(checkOut).toISOString(),
            started_at: new Date(checkIn).toISOString(),
            ended_at:
              checkOut === null ? null : new Date(checkOut).toISOString(),
            completed_at:
              checkOut === null ? null : new Date(checkOut).toISOString(),
            call_duration_ms: checkOut === null ? null : checkOut - checkIn,
            missing_activities: [],
          },
          checkIn,
        );
        f.lastVisitId = v.id;
        if (!isOpen) {
          f.productive += productive ? 1 : 0;
          f.first ??= v.started_at;
          f.last = v.ended_at;
          f.duration += (checkOut ?? checkIn) - checkIn;
        }
        for (const event of isOpen ? ["check_in"] : ["check_in", "check_out"]) {
          const issue = completedCounter % 137 === 0;
          const time = event === "check_in" ? checkIn : (checkOut ?? checkIn);
          d.add(
            "visit_location_evidence",
            `${key}-${event}`,
            {
              organization_id: org,
              org_unit_id: a.org_unit_id,
              visit_id: v.id,
              event,
              latitude: s.lat + (issue ? 0.003 : 0.00001),
              longitude: s.lng,
              provider: "fused",
              accuracy_meters: 12,
              mock_signal: false,
              integrity_signal: "sample",
              pin_id: s.pin.id,
              pin_version: "sample-v1",
              policy_version: "sample-v1",
              radius_meters: 75,
              distance_meters: issue ? 335 : 2,
              result: issue ? "outside_radius" : "within_radius",
              review_status: issue ? "pending_review" : "verified",
              device_time: new Date(time).toISOString(),
              server_time: new Date(time + 10_000).toISOString(),
            },
            time,
          );
          d.add(
            "execution_events",
            `${key}-${event}`,
            {
              organization_id: org,
              org_unit_id: a.org_unit_id,
              entity_type: "visit",
              entity_id: v.id,
              kind: event,
              actor_subject: a.auth_subject,
              actor_role: "sales",
              actor_org_unit_id: a.org_unit_id,
              source: "system",
              operation_key: `sample:${key}-${event}`,
              occurred_at: new Date(time).toISOString(),
              server_at: new Date(time + 10_000).toISOString(),
              summary_reason_code: "sample",
              schema_version: 1,
            },
            time,
          );
        }
        if (checkOut === null) continue;
        const sells = productive && !s.dormant && productiveCounter % 6 !== 0;
        if (productive && !sells) v.reason_code = "no_sales_due_to_inventory";
        const activity = d.add(
          "visit_activities",
          key,
          {
            organization_id: org,
            org_unit_id: a.org_unit_id,
            visit_id: v.id,
            assignee_profile_id: a.id,
            outlet_id: s.id,
            activity_kind: sells
              ? "order_intent"
              : productive
                ? "merchandising"
                : "note",
            activity: sells
              ? {
                  kind: "order_intent",
                  clientOrderId: `sample:${key}`,
                  source: "sample",
                  lines: [],
                }
              : productive
                ? {
                    kind: "merchandising",
                    source: "sample",
                    displayFixed: true,
                    noSalesDueToInventory: true,
                    note: "Sample display and price-tag check; no sales due to sufficient store stock",
                  }
                : {
                    kind: "note",
                    source: "sample",
                    text: "Sample: buyer unavailable, no qualifying activity",
                  },
            device_time: new Date(checkOut - 60_000).toISOString(),
            server_time: new Date(checkOut).toISOString(),
          },
          checkOut,
        );
        if (sells) {
          orderCounter++;
          const status =
            orderCounter % 43 === 0
              ? "rejected"
              : orderCounter % 5 === 0
                ? "approved"
                : "posted";
          const order = d.add(
            "orders",
            key,
            {
              organization_id: org,
              client_request_id: `sample:${key}`,
              order_number: `SMP-SO-${orderCounter}`,
              order_type: "field",
              org_unit_id: a.org_unit_id,
              salesperson_profile_id: a.id,
              created_by_subject: a.auth_subject,
              outlet_id: s.id,
              territory_id: c.territories[a.territoryIndex].id,
              channel_key: s.channel,
              service_date: date,
              customer_code: s.customer.code,
              salesperson_subject: a.auth_subject,
              status,
              subtotal: 0,
              total: 0,
              source_location_id: null,
              request_payload_hash: "sample",
            },
            checkOut,
          );
          const lineCount = 2 + Math.floor(d.rng() * 5);
          let total = 0;
          const orderLines = [];
          const payday = [14, 15, 16, 29, 30, 31].includes(
            Number(date.slice(8)),
          )
            ? 1.4
            : 1;
          const seasonal =
            1 +
            0.1 * Math.sin(dayIndex / 7) +
            (Number(month.slice(5)) >= 9 ? 0.05 : 0);
          const firstProduct = Math.floor(d.rng() * c.products.length);
          for (let li = 0; li < lineCount; li++) {
            const p = c.products[(firstProduct + li * 7) % c.products.length];
            const quantity = Math.max(
              1,
              Math.round(
                (2 +
                  d.rng() *
                    (s.channel === "kas"
                      ? 60
                      : s.channel === "supermarket"
                        ? 35
                        : 8)) *
                  payday *
                  seasonal *
                  (a.index === 0 ? 1.3 : 1),
              ),
            );
            const price = Math.round(
              p.piecePriceMinor *
                c.factors[
                  ["gt", "pmot", "supermarket", "kas"].indexOf(s.channel)
                ],
            );
            total += quantity * price;
            d.add(
              "order_lines",
              `${key}-${li}`,
              {
                order_id: order.id,
                product_code: p.code,
                description: p.name,
                quantity,
                unit_price: price / 100,
                line_total: (quantity * price) / 100,
              },
              checkOut,
            );
            orderLines.push({ p: p.index, qty: quantity, from: 0, to: null });
          }
          order.total = order.subtotal = total / 100;
          activity.activity.lines = orderLines.map((l) => ({
            productId: c.products[l.p].id,
            uom: "PC",
            quantity: l.qty,
          }));
          const creditExposure =
            (invoices.get(s.customer.id) ?? [])
              .filter((i) => i.issuedAt <= checkOut)
              .reduce((sum, i) => sum + i.remainingMinor, 0) +
            d
              .rows("orders")
              .filter(
                (o) =>
                  o.id !== order.id &&
                  o.customer_code === s.customer.code &&
                  o.status === "approved" &&
                  Date.parse(o.created_at) <= checkOut,
              )
              .reduce((sum, o) => sum + Math.round(Number(o.total) * 100), 0);
          const pricing = d.add(
            "field_order_pricings",
            key,
            {
              organization_id: org,
              org_unit_id: a.org_unit_id,
              visit_id: v.id,
              activity_id: activity.id,
              outlet_id: s.id,
              customer_id: s.customer.id,
              client_order_id: `sample:${key}`,
              price_list_id:
                c.lists[["gt", "pmot", "supermarket", "kas"].indexOf(s.channel)]
                  .id,
              price_list_source: "sample",
              currency: "PHP",
              priced_at: new Date(checkOut).toISOString(),
              total_minor: total,
              unpriced_lines: 0,
              credit_status: s.customer.credit_limit
                ? creditExposure + total <= s.customer.credit_limit * 100
                  ? "within"
                  : "over"
                : "no_limit",
              credit_limit_minor: s.customer.credit_limit * 100,
              credit_open_orders_minor: creditExposure,
              server_time: new Date(checkOut).toISOString(),
            },
            checkOut,
          );
          orderLines.forEach((l, ordinal) => {
            const price = Math.round(
              c.products[l.p].piecePriceMinor *
                c.factors[
                  ["gt", "pmot", "supermarket", "kas"].indexOf(s.channel)
                ],
            );
            d.add(
              "field_order_pricing_lines",
              `${key}-${ordinal}`,
              {
                field_order_pricing_id: pricing.id,
                ordinal,
                product_id: c.products[l.p].id,
                uom: "PC",
                quantity: l.qty,
                unit_price_minor: price,
                line_total_minor: price * l.qty,
              },
              checkOut,
            );
          });
          if (status !== "rejected") {
            f.sales += total;
            f.orders++;
            addSum(agentSales, `${month}-${a.index}`, total);
            addSum(channelSales, `${month}-${s.channel}`, total);
            addSum(monthlySales, month, total);
          }
          if (status === "posted")
            order.inventory_movement_id = stock.movement({
              key: `order-${order.id}`,
              kind: "inventory_issue",
              sourceId: order.id,
              time: checkOut,
              lines: orderLines,
            });
          if (today && status !== "rejected")
            todayOrders.push({
              order,
              pricing,
              total,
              f,
              month,
              channel: s.channel,
              agentIndex: a.index,
            });
          if (s.customer.credit_limit && status === "posted") {
            const account = invoices.get(s.customer.id) ?? [];
            account.push({
              orderId: order.id,
              amountMinor: total,
              remainingMinor: total,
              invoiceDate: date,
              issuedAt: checkOut,
              dueDate: plusDays(date, 30),
            });
            invoices.set(s.customer.id, account);
          }
          if (status === "posted" && orderCounter % 97 === 0) {
            const p = c.products[orderLines[0].p],
              qty = Math.min(orderLines[0].qty, 2);
            const price = Math.round(
                p.piecePriceMinor *
                  c.factors[
                    ["gt", "pmot", "supermarket", "kas"].indexOf(s.channel)
                  ],
              ),
              amount = qty * price;
            const ret = d.add(
              "orders",
              `return-${key}`,
              {
                organization_id: org,
                client_request_id: `sample:return-${key}`,
                order_number: `SMP-BO-${orderCounter}`,
                order_type: "return",
                org_unit_id: a.org_unit_id,
                salesperson_profile_id: a.id,
                created_by_subject: a.auth_subject,
                outlet_id: s.id,
                territory_id: c.territories[a.territoryIndex].id,
                channel_key: s.channel,
                service_date: date,
                original_order_id: order.id,
                customer_code: s.customer.code,
                salesperson_subject: a.auth_subject,
                status: "returned",
                subtotal: -amount / 100,
                total: -amount / 100,
                source_location_id: null,
              },
              checkOut + 1000,
            );
            d.add(
              "order_lines",
              `return-${key}`,
              {
                order_id: ret.id,
                product_code: p.code,
                description: `Sample BO pickup: ${p.name}`,
                quantity: -qty,
                unit_price: price / 100,
                line_total: -amount / 100,
              },
              checkOut + 1000,
            );
            ret.inventory_movement_id = stock.movement({
              key: `return-${ret.id}`,
              kind: "pos_return",
              sourceId: ret.id,
              time: checkOut + 1000,
              lines: [{ p: p.index, qty, from: null, to: 0 }],
            });
            f.sales -= amount;
            f.returnOrders++;
            addSum(agentSales, `${month}-${a.index}`, -amount);
            addSum(channelSales, `${month}-${s.channel}`, -amount);
            addSum(monthlySales, month, -amount);
            const invoice = invoices
              .get(s.customer.id)
              ?.find((i) => i.orderId === order.id);
            if (invoice) {
              invoice.remainingMinor -= amount;
              invoice.amountMinor -= amount;
            }
            d.event(
              "field_return",
              `bo-${ret.id}`,
              {
                visitId: v.id,
                orderId: ret.id,
                originalOrderId: order.id,
                amountMinor: amount,
                reason: "sample-good-stock-pullout",
                disposition: "saleable",
              },
              checkOut + 1000,
            );
          }
        }
        const account = (invoices.get(s.customer.id) ?? [])
          .filter((invoice) => invoice.issuedAt <= checkOut)
          .sort(
            (a, b) =>
              a.issuedAt - b.issuedAt || a.orderId.localeCompare(b.orderId),
          );
        const exposure = account.reduce((sum, i) => sum + i.remainingMinor, 0);
        if (
          productive &&
          exposure > 0 &&
          s.index % 7 !== 0 &&
          (productiveCounter % 3 === 0 || weekday(date) === 6)
        ) {
          const amount = Math.min(
            exposure,
            Math.round(exposure * (0.08 + d.rng() * 0.14)),
          );
          if (amount > 0) {
            let left = amount;
            const allocations = [];
            for (const invoice of account) {
              const paid = Math.min(left, invoice.remainingMinor);
              if (paid) {
                invoice.remainingMinor -= paid;
                left -= paid;
                allocations.push({
                  orderId: invoice.orderId,
                  amountMinor: paid,
                });
              }
            }
            const col = d.add(
              "field_collections",
              key,
              {
                organization_id: org,
                org_unit_id: a.org_unit_id,
                customer_id: s.customer.id,
                outlet_id: s.id,
                visit_id: v.id,
                assignee_profile_id: a.id,
                amount_minor: amount,
                currency: "PHP",
                method: "cash",
                reference: `SMP-OR-${key}`,
                status: "recorded",
                device_time: new Date(checkOut).toISOString(),
                server_time: new Date(checkOut).toISOString(),
              },
              checkOut,
            );
            d.event(
              "collection_allocation",
              `collection-${col.id}`,
              { collectionId: col.id, customerId: s.customer.id, allocations },
              checkOut,
            );
            f.collections++;
            f.collectionMinor += amount;
          }
        }
      }
      if (today) {
        const s = eligible[(dayIndex * 7) % eligible.length];
        const recorded = at(
          date,
          todayMode === "idle" ? 10 * 60 : 11 * 60 + 59,
        );
        for (let pi = 0; pi < 8; pi++) {
          const time =
            todayMode === "idle"
              ? recorded - (7 - pi) * 60_000
              : recorded - (7 - pi) * 20 * 60_000;
          d.add(
            "location_pings",
            `${a.index}-${pi}`,
            {
              organization_id: org,
              kind: "field",
              profile_id: a.id,
              client_ping_id: `sample:${a.index}-${pi}`,
              org_unit_id: a.org_unit_id,
              service_date: date,
              latitude: s.lat + pi * 0.0001,
              longitude: s.lng,
              accuracy_meters: 12,
              battery_percent: 85 - pi * 3,
              mock_location: false,
              provider: "fused",
              trigger: "moving",
              recorded_at: new Date(time).toISOString(),
              received_at: new Date(time).toISOString(),
              sample: true,
            },
            time,
          );
        }
        d.add(
          "live_locations",
          a.id,
          {
            organization_id: org,
            kind: "field",
            subject_key: a.id,
            profile_id: a.id,
            org_unit_id: a.org_unit_id,
            visit_id: f.lastVisitId,
            service_date: date,
            latitude: s.lat + 0.0007,
            longitude: s.lng,
            accuracy_meters: 12,
            battery_percent: 64,
            mock_location: false,
            provider: "fused",
            trigger: todayMode === "done" ? "stop" : "still",
            recorded_at: new Date(recorded).toISOString(),
            received_at: new Date(recorded).toISOString(),
            tracking_ended: todayMode === "done",
            sample: true,
          },
          recorded,
        );
      }
    }
  }
  // Exactly two today approvals; suppress stock/AR consequences before they are built.
  // Pick approved (not posted) rows so pending orders have never issued stock.
  for (const item of todayOrders
    .filter((x) => x.order.status === "approved")
    .slice(0, 2)) {
    item.order.status = "pending_approval";
    const workflow = d.add(
      "workflow_instances",
      item.order.id,
      {
        entity_type: "order",
        entity_id: item.order.id,
        workflow_type: "order_approval",
        status: "pending",
        current_step: 1,
        requested_by: item.order.salesperson_subject,
      },
      item.order.created_at,
    );
    d.add(
      "approvals",
      item.order.id,
      { workflow_id: workflow.id, decision: "pending" },
      item.order.created_at,
    );
  }
  for (const plan of plans.values()) {
    const slots = d
      .rows("coverage_plan_slots")
      .filter((s) => s.plan_id === plan.id);
    plan.content_hash = planDigest(d, plan);
    plan.approval_signature = `${plan.id}:1:${plan.approved_by}:${Date.parse(plan.approved_at)}:${plan.content_hash}`;
    d.add(
      "coverage_audit_events",
      plan.id,
      {
        plan_id: plan.id,
        assignee_profile_id: plan.assignee_profile_id,
        org_unit_id: plan.org_unit_id,
        local_month: plan.local_month,
        actor_subject: plan.approved_by,
        action: "approved",
        reason: "Sample signed MCP",
        affected_entity: "coverage_plans",
        plan_version: 1,
        approval_signature_ref: plan.approval_signature,
        after: {
          source: "sample",
          signatureFormat: "sample-sql-v1",
          slots: slots.length,
        },
      },
      plan.approved_at,
    );
  }
  // Future month's submitted plan does not overlap any effective approved assignment.
  const month = nextMonth(d.anchorDate.slice(0, 7)),
    a = c.agents[0];
  d.add(
    "coverage_plans",
    "pending",
    {
      organization_id: org,
      assignee_profile_id: a.id,
      local_month: month,
      version: 1,
      cycle_type: "monthly",
      org_unit_id: a.org_unit_id,
      requested_from: new Date(at(`${month}-01`)).toISOString(),
      requested_to: new Date(at(`${nextMonth(month)}-01`)).toISOString(),
      effective_from: new Date(at(`${month}-01`)).toISOString(),
      effective_to: new Date(at(`${nextMonth(month)}-01`)).toISOString(),
      status: "submitted",
      prepared_by: a.auth_subject,
      prepared_at: d.noon,
      submitted_by: a.auth_subject,
      submitted_at: d.noon,
      content_revision: 1,
      created_by: a.auth_subject,
      updated_by: a.auth_subject,
    },
    d.noon,
  );
  const pending = d
    .rows("coverage_plans")
    .find((p) => p.status === "submitted");
  if (!pending) throw new Error("Sample submitted MCP is missing");
  let serviceDate = `${month}-01`;
  if (weekday(serviceDate) === 0) serviceDate = plusDays(serviceDate, 1);
  for (const [sequence, s] of c.stores
    .filter((s) => s.territoryIndex === 0)
    .slice(0, a.dailyCalls)
    .entries()) {
    d.add(
      "coverage_plan_outlets",
      `pending-${s.id}`,
      {
        plan_id: pending.id,
        outlet_id: s.id,
        route_id: s.route.id,
        territory_id: c.territories[0].id,
        frequency: "custom",
        preferred_weekdays: [],
        custom_local_dates: [serviceDate],
        sequence: sequence + 1,
        priority: 1,
        expected_duration_minutes: 10,
        required_objectives: ["sell"],
        content_revision: 1,
        updated_by: a.auth_subject,
      },
      d.noon,
    );
    d.add(
      "coverage_plan_slots",
      `pending-${s.id}`,
      {
        slot_key: `sample:pending-${s.id}`,
        plan_id: pending.id,
        assignee_profile_id: a.id,
        service_date: serviceDate,
        kind: "outlet_visit",
        outlet_id: s.id,
        route_id: s.route.id,
        required_objectives: ["sell"],
        intents: ["sell"],
        sequence: sequence + 1,
        expected_duration_minutes: 10,
        content_revision: 1,
        updated_by: a.auth_subject,
      },
      d.noon,
    );
  }
  pending.content_hash = planDigest(d, pending);
  return {
    dates,
    months,
    plans,
    invoices,
    monthlySales,
    agentSales,
    channelSales,
    dayFacts,
    completed: completedCounter,
    productive: productiveCounter,
  };
}
/** @typedef {ReturnType<typeof execution>} Execution */
