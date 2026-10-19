import { requireCapability } from "../../core/capabilities.js";
import { recordChange } from "../../core/sync.js";
import { scopeFilterForActor } from "../org/scope.js";
import { outletContext, scoped } from "./access.js";
import { audit, command, createOrder, notify, transition } from "./service.js";
import {
  ORGANIZATION,
  choice,
  date,
  fail,
  manilaDate,
  quantityMilli,
  text,
  uuid,
} from "./validation.js";

const CODES = [
  "purchase_order",
  "merchandising",
  "inventory_retrieval",
  "suggested_order",
  "negotiation",
  "bad_order_pickup",
  "collection",
  "meeting",
];
/** @param {any} c @param {string} outletId @param {string} serviceDate */
async function candidates(c, outletId, serviceDate) {
  date(serviceDate);
  const store = await outletContext(c, outletId, "order.encode");
  const rows = !store.assignment
    ? []
    : await c.db`select distinct p.id as profile_id,p.name,t.kind,
    exists(select 1 from planned_visits v where v.outlet_id = ${outletId} and v.assignee_profile_id = p.id and v.service_date = ${serviceDate} and v.status = 'planned' and v.deleted_at is null) as in_plan
    from territory_salespeople t join profiles p on p.id = t.profile_id where t.territory_id = ${store.assignment.territory_id} and t.deleted_at is null
    and t.effective_from <= now() and (t.effective_to is null or t.effective_to > now()) and p.status = 'active' and p.deleted_at is null order by p.name`;
  return {
    store,
    outletName: store.outlet.name,
    outletCode: store.outlet.code,
    hasTerritory: !!store.assignment,
    salespeople: rows.map((/** @type {any} */ r) => ({
      profileId: r.profile_id,
      name: r.name,
      kind: r.kind,
      inPlan: r.in_plan,
    })),
  };
}
/** @param {any} c @param {any} r */
async function view(c, r) {
  const lines =
    await c.db`select * from outside_call_order_lines where outside_call_order_id = ${r.id} and deleted_at is null order by ordinal`;
  return {
    outletName: r.outlet_name,
    outletCode: r.outlet_code,
    salespersonName: r.salesperson_name,
    encodedByName: r.encoder_name,
    order: {
      _id: r.id,
      poNumber: r.po_number,
      serviceDate: new Date(r.service_date).toISOString().slice(0, 10),
      receivedVia: r.received_via,
      status: r.status,
      salespersonProfileId: r.salesperson_profile_id,
      encodedAt: new Date(r.encoded_at).getTime(),
      note: r.note,
      cancelReason: r.cancel_reason,
      lines: lines.map((/** @type {any} */ l) => ({
        productName: l.product_name,
        productCode: l.product_code,
        quantity: Number(l.quantity),
        uom: l.uom,
      })),
      activity: r.activity_recorded_at
        ? {
            contact: r.activity_contact,
            codes: r.activity_codes,
            note: r.activity_note,
            recordedAt: new Date(r.activity_recorded_at).getTime(),
          }
        : null,
    },
  };
}
/** @param {any} router */
export function installOutsideRoutes(router) {
  router.get(
    "/api/v1/orders/outside-calls/candidates",
    async (/** @type {any} */ c) => {
      const { store: _store, ...result } = await candidates(
        c,
        uuid(c.url.searchParams.get("outletId")),
        date(c.url.searchParams.get("serviceDate")),
      );
      return result;
    },
  );
  router.get(
    "/api/v1/orders/outside-calls/options",
    async (/** @type {any} */ c) => {
      await requireCapability(c, "order.encode");
      const { unitIds } = await scopeFilterForActor(c.db, c.actor);
      const stores =
        await c.db`select id,code,name,status from outlets where organization_id = ${ORGANIZATION} and status = 'active' and deleted_at is null order by code`;
      const outlets = [];
      for (const s of stores) {
        try {
          await outletContext(c, s.id, "order.encode");
          outlets.push({
            _id: s.id,
            code: s.code,
            name: s.name,
            status: s.status,
          });
        } catch (e) {
          if (!(e instanceof Error) || !("status" in e) || e.status !== 403)
            throw e;
        }
      }
      const products =
        await c.db`select id,code,name,uom,active from products where active and deleted_at is null and (organization_id is null or organization_id = ${ORGANIZATION}) order by code limit 2001`;
      if (outlets.length > 2000 || products.length > 2000)
        fail(
          "More than 2,000 choices; use the scoped master-data workspace to narrow setup",
        );
      void unitIds;
      return {
        outlets,
        products: products.map((/** @type {any} */ p) => ({
          _id: p.id,
          code: p.code,
          name: p.name,
          uom: p.uom,
          active: p.active,
        })),
      };
    },
  );
  router.get(
    "/api/v1/orders/outside-calls/list",
    async (/** @type {any} */ c) => {
      const actor = await requireCapability(c, "visit.read"),
        q = c.url.searchParams;
      const status = choice(
        q.get("status") ?? "awaiting_activity",
        ["awaiting_activity", "activity_recorded", "cancelled"],
        "Status",
      );
      const rows =
        await c.db`select o.*,s.name as outlet_name,s.code as outlet_code,p.name as salesperson_name,e.name as encoder_name
      from outside_call_orders o join outlets s on s.id = o.outlet_id join profiles p on p.id = o.salesperson_profile_id join profiles e on e.id = o.encoded_by_profile_id
      where o.organization_id = ${ORGANIZATION} and o.status = ${status} and o.deleted_at is null
      and (${actor.role === "sales"} = false or o.salesperson_profile_id = ${actor.profileId}) order by o.encoded_at desc,o.id desc`;
      const visible = [];
      for (const row of rows) {
        try {
          await outletContext(c, row.outlet_id, "visit.read");
          await scoped(c, "visit.read", row.org_unit_id);
          visible.push(row);
        } catch (e) {
          if (!(e instanceof Error) || !("status" in e) || e.status !== 403)
            throw e;
        }
      }
      const offset = Number(q.get("cursor") ?? 0);
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000)
        fail("Cursor is invalid");
      const page = visible.slice(offset, offset + 20);
      return {
        page: await Promise.all(page.map((r) => view(c, r))),
        isDone: offset + 20 >= visible.length,
        continueCursor: String(offset + 20),
        total: visible.length,
      };
    },
  );
  router.post(
    "/api/v1/orders/outside-calls/encode",
    async (/** @type {any} */ c) => {
      const b = c.body;
      const result = await command(
        c,
        "outside.encode",
        b,
        async (cc) => {
          await outletContext(cc, uuid(b.outletId), "order.encode");
        },
        async (cc) => {
          const info = await candidates(cc, b.outletId, date(b.serviceDate));
          if (
            b.serviceDate > manilaDate(c.now) ||
            b.serviceDate < manilaDate(c.now - 31 * 86400_000)
          )
            fail("PO date must be today or in the last 31 days");
          const person = info.salespeople.find(
            (/** @type {any} */ p) => p.profileId === b.salespersonProfileId,
          );
          if (!person) fail("Salesperson does not cover this store");
          if (person.inPlan)
            fail(
              "Store is in the plan that day; enter the PO at the visit",
              "mcp_order",
            );
          const po = text(b.poNumber, "PO number", 60),
            via = choice(
              b.receivedVia,
              ["email", "viber", "phone", "fax", "other"],
              "Arrival method",
            );
          if (b.note && (typeof b.note !== "string" || b.note.length > 500))
            fail("Note is too long");
          if (
            !Array.isArray(b.lines) ||
            !b.lines.length ||
            b.lines.length > 100
          )
            fail("Add 1–100 product lines");
          // Serialize duplicate PO checks for this store across office users.
          await cc.db`select id from outlets where id = ${b.outletId} for update`;
          const [dupe] =
            await cc.db`select id from outside_call_orders where outlet_id = ${b.outletId} and po_number = ${po} and status <> 'cancelled' and deleted_at is null`;
          if (dupe) fail("This PO is already encoded for the store");
          const [link] =
            await cc.db`select customer_id from outlet_customer_links where outlet_id = ${b.outletId} and deleted_at is null and effective_from <= now() and (effective_to is null or effective_to > now())`;
          const [row] =
            await cc.db`insert into outside_call_orders(organization_id,org_unit_id,outlet_id,territory_id,customer_id,salesperson_profile_id,service_date,po_number,received_via,note,status,client_request_id,encoded_by,encoded_by_profile_id,encoded_at)
        values(${ORGANIZATION},${info.store.unit},${b.outletId},${info.store.assignment.territory_id},${link?.customer_id ?? null},${b.salespersonProfileId},${b.serviceDate},${po},${via},${b.note ?? null},'awaiting_activity',${text(b.clientRequestId, "Request key", 160)},${cc.actor.subject},${cc.actor.profileId},${new Date(cc.now)}) returning *`;
          const seen = new Set();
          for (let i = 0; i < b.lines.length; i++) {
            const l = b.lines[i];
            quantityMilli(l.quantity);
            if (seen.has(l.productId)) fail("Each product may appear once");
            seen.add(l.productId);
            const [p] =
              await cc.db`select * from products where id = ${uuid(l.productId)} and active and deleted_at is null and (organization_id is null or organization_id = ${ORGANIZATION})`;
            if (!p) fail("Product not available");
            await cc.db`insert into outside_call_order_lines(outside_call_order_id,ordinal,product_id,product_code,product_name,quantity,uom) values(${row.id},${i},${p.id},${p.code},${p.name},${l.quantity},${p.uom})`;
          }
          let order = null;
          if (link) {
            const [customer] =
              await cc.db`select code from customers where id = ${link.customer_id}`;
            order = await createOrder(cc, {
              outletId: row.outlet_id,
              salespersonProfileId: row.salesperson_profile_id,
              serviceDate: b.serviceDate,
              lines: b.lines.map((/** @type {any} */ l) => ({
                productId: l.productId,
                quantity: l.quantity,
              })),
              customerCode: customer.code,
              outsideCallId: row.id,
              clientRequestId: `outside:${row.id}`,
              orderType: "outside_call",
            });
          }
          await audit(
            cc,
            "order.outside_call_encoded",
            row.id,
            null,
            "outsideCallOrder",
          );
          await recordChange(cc.db, {
            entity: "outside_call_order",
            entityId: row.id,
            scopeKey: `unit:${row.org_unit_id}`,
          });
          return {
            orderId: row.id,
            replayed: false,
            commercialOrderId: order?.id ?? null,
            rows: [
              { org_unit_id: row.org_unit_id, service_date: row.service_date },
            ],
          };
        },
      );
      await notify(c, result.rows);
      return {
        orderId: result.orderId,
        commercialOrderId: result.commercialOrderId,
        replayed: result.replayed,
      };
    },
  );
  for (const action of ["record-activity", "cancel"])
    router.post(
      `/api/v1/orders/outside-calls/${action}`,
      async (/** @type {any} */ c) => {
        const b = c.body;
        const result = await command(
          c,
          `outside.${action}`,
          b,
          async (cc) => {
            const [o] =
              await cc.db`select * from outside_call_orders where id = ${uuid(b.orderId)} and deleted_at is null for update`;
            if (!o) fail("PO not found");
            await outletContext(
              cc,
              o.outlet_id,
              action === "cancel" ? "order.encode" : "visit.record",
            );
            await scoped(
              cc,
              action === "cancel" ? "order.encode" : "visit.record",
              o.org_unit_id,
            );
            if (
              action !== "cancel" &&
              o.salesperson_profile_id !== cc.actor.profileId
            )
              fail("Only the credited salesperson records this activity");
          },
          async (cc) => {
            const [o] =
              await cc.db`select * from outside_call_orders where id = ${b.orderId} for update`;
            if (
              o.status === "cancelled" ||
              (action !== "cancel" && o.status !== "awaiting_activity")
            )
              fail("This PO has already been resolved");
            if (action === "cancel") {
              const reason = text(b.reason, "Cancellation reason");
              const [commercial] =
                await cc.db`select id from orders where outside_call_id = ${o.id}`;
              if (commercial)
                await transition(cc, commercial.id, "voided", reason);
              await cc.db`update outside_call_orders set status = 'cancelled',cancel_reason = ${reason},cancelled_at = now(),cancelled_by_profile_id = ${cc.actor.profileId} where id = ${o.id}`;
            } else {
              const contact = choice(
                b.contact,
                ["phone", "message", "in_person", "other"],
                "Contact method",
              );
              if (
                !Array.isArray(b.codes) ||
                b.codes.some((/** @type {any} */ x) => !CODES.includes(x))
              )
                fail("Activity is invalid");
              const codes = CODES.filter(
                (x) => x === "purchase_order" || b.codes.includes(x),
              );
              const note = b.note ? text(b.note, "Activity note", 500) : null;
              if (contact === "other" && !note)
                fail("Say how the store was reached");
              await cc.db`update outside_call_orders set status='activity_recorded',activity_contact=${contact},activity_codes=array(select jsonb_array_elements_text(${{ values: codes }}::jsonb -> 'values')),activity_note=${note},activity_recorded_at=now() where id=${o.id}`;
            }
            await audit(
              cc,
              `order.outside_call_${action}`,
              o.id,
              null,
              "outsideCallOrder",
            );
            await recordChange(cc.db, {
              entity: "outside_call_order",
              entityId: o.id,
              scopeKey: `unit:${o.org_unit_id}`,
            });
            return {
              ok: true,
              rows: [
                { org_unit_id: o.org_unit_id, service_date: o.service_date },
              ],
            };
          },
        );
        await notify(c, result.rows);
        return { ok: true };
      },
    );
}
