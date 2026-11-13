import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
} from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { postMovement } from "../src/domains/inventory/posting.js";
import { storeOperation } from "../src/domains/storepos/operations.js";

/** F-R04 one SKU/one shipped transfer: a leaf-store cashier receives from a root warehouse.
 * Tests the real domain and canonical posting boundary; authentication transport is covered separately. */
/** @param {((lineId: string) => any[]) | null} linesOf the phone's `lines` (null: receive everything shipped) */
async function receiveTransfer(linesOf) {
  const h = await startHarness();
  try {
    const people = profileStore(h),
      root = crypto.randomUUID(),
      unit = crypto.randomUUID(),
      base = crypto.randomUUID(),
      sku = crypto.randomUUID();
    const source = crypto.randomUUID(),
      transit = crypto.randomUUID(),
      location = crypto.randomUUID(),
      register = crypto.randomUUID(),
      mode = crypto.randomUUID(),
      policy = crypto.randomUUID(),
      shift = crypto.randomUUID(),
      transfer = crypto.randomUUID();
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from,parent_id) values(${root},'sunpride','SUNPRIDE','Root','national','active',now()-interval '1 day',null),(${unit},'sunpride','STORE','Store area','region','active',now()-interval '1 day',${root})`;
    const cashier = await boundDevice(h, people, {
      app: "van-android",
      orgUnitId: unit,
    });
    const userId = await createUser(
      h,
      "warehouse-fixture@example.com",
      "fixture password only",
    );
    const manager = {
      userId,
      email: "warehouse-fixture@example.com",
      profile: people.set(userId, {
        role: "super_admin",
        orgUnitId: root,
        name: "Warehouse fixture",
      }),
    };
    for (const who of [cashier, manager]) {
      const p = who.profile;
      await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${who.userId},${who.userId},${p.name},${who.email},${p.role},'active',${p.orgUnitId})`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${p.orgUnitId},${p.role},now()-interval '1 day','fixture','fixture')`;
    }
    const actor = await actorFor(h.db, cashier.userId),
      boss = await actorFor(h.db, userId);
    if (!actor || !boss) throw Error("Missing fixture identity");
    await h.db`insert into units_of_measure(id,organization_id,code,name,dimension,decimal_places,active) values(${base},'sunpride','PC','Piece','count',0,true)`;
    await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,active,base_uom_id,quantity_scale) values(${sku},'sunpride','STORE-TRANSFER','Sample SKU','Sample','PC',0,true,${base},1)`;
    for (const [id, owner, type, code] of [
      [source, root, "warehouse", "DEPOT"],
      [transit, root, "in_transit", "TRANSIT"],
      [location, unit, "store", "STORE"],
    ])
      await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${id},'sunpride',${owner},'CEBU',${code},${code},${type},true,true,true,true,false)`;
    await h.db`insert into store_registers(id,location_id,terminal_code,name,effective_from) values(${register},${location},'SAMPLE-LEAF','Sample leaf register',now()-interval '1 day')`;
    await h.db`insert into store_register_policies(id,register_id,tolerance_centavos,effective_from) values(${policy},${register},0,now()-interval '1 day')`;
    await h.db`insert into store_cashier_assignments(register_id,profile_id,effective_from) values(${register},${actor.profileId},now()-interval '1 day')`;
    await h.db`insert into pos_device_modes(id,device_id,register_id,mode,effective_from,actor_profile_id) values(${mode},${cashier.deviceId},${register},'store',now()-interval '1 day',${boss.profileId})`;
    await h.db`insert into store_shifts(id,register_id,mode_version_id,policy_id,device_id,cashier_id,service_date,opening_centavos,opened_at) values(${shift},${register},${mode},${policy},${cashier.deviceId},${actor.profileId},(now() at time zone 'Asia/Manila')::date,0,now()-interval '1 hour')`;
    const post = {
      organizationId: "sunpride",
      actor: { profileId: boss.profileId, userId: boss.userId },
      occurredAt: Date.now(),
    };
    await tx(h.db, (db) =>
      postMovement(db, {
        ...post,
        kind: "opening_balance",
        sourceType: "cutover",
        sourceId: source,
        idempotencyKey: "opening",
        lines: [
          {
            productId: sku,
            quantityBase: 1,
            fromLocationId: null,
            toLocationId: source,
            uom: "PC",
            unitCostMinor: 1000,
          },
        ],
      }),
    );
    const shipped = await tx(h.db, (db) =>
      postMovement(db, {
        ...post,
        kind: "transfer_ship",
        sourceType: "stock_transfer",
        sourceId: transfer,
        idempotencyKey: "shipping",
        lines: [
          {
            productId: sku,
            quantityBase: 1,
            fromLocationId: source,
            toLocationId: transit,
            fromStockStatus: "available",
            toStockStatus: "in_transit",
            uom: "PC",
            unitCostMinor: 1000,
          },
        ],
      }),
    );
    await h.db`insert into stock_transfers(id,organization_id,transfer_number,source_location_id,destination_location_id,in_transit_location_id,status,requested_by,approved_by,outbound_movement_id) values(${transfer},'sunpride','SAMPLE-TRANSFER',${source},${location},${transit},'shipped','fixture-requester',${boss.userId},${shipped.movementId})`;
    await h.db`insert into stock_transfer_lines(organization_id,transfer_id,product_id,requested_base,approved_base,shipped_base,received_base,rejected_base,short_base) values('sunpride',${transfer},${sku},1,1,1,0,0,0)`;
    const at = Date.now(),
      id = crypto.randomUUID();
    const [line] =
      await h.db`select id from stock_transfer_lines where transfer_id=${transfer}`;
    const payload = {
      registerId: register,
      modeVersionId: mode,
      shiftId: shift,
      transferId: transfer,
      deviceTime: at,
      ...(linesOf ? { lines: linesOf(line.id) } : {}),
    };
    const result = await tx(h.db, (db) =>
      storeOperation({
        db,
        actor,
        device: { id: cashier.deviceId },
        payload,
        op: { clientOpId: id, opType: "store.receive", clientTime: at },
        now: at,
      }),
    );
    if (!("movementId" in result))
      throw Error("Receiving must post through the stock authority");
    expect(result.entityId).toBe(transfer);
    const [stock] =
      await h.db`select available_base::text as n from inventory_balances where location_id=${location}`;
    expect(stock.n).toBe("1");
    const [t] =
      await h.db`select status,receipt_movement_id from stock_transfers where id=${transfer}`;
    expect(t.status).toBe("received");
    expect(t.receipt_movement_id).toBe(result.movementId);
  } finally {
    await h.close();
  }
}

test("F-R04 receiving an authorized transfer does not need access to the warehouse scope", () => receiveTransfer(null), 30000);

// POS-044: the phone's "Receive all shipped" lines, as the store wire names them (whole-number strings).
test("POS-044 store.receive reads receivedGoodBase sent as a whole-number string", () =>
  receiveTransfer((lineId) => [{ lineId, receivedGoodBase: "1", receivedDamagedBase: "0", receivedHoldBase: "0" }]), 30000);

// POS-044: phones in the field (up to 4c872cf3) send receivedBase as a number; it is read as received good.
test("POS-044 store.receive still reads the old phone's receivedBase number", () =>
  receiveTransfer((lineId) => [{ lineId, receivedBase: 1, rejectedBase: 0, shortBase: 0 }]), 30000);

test("POS-044 a wrong receive quantity is refused naming the field", async () => {
  const { transferReceiveLines } = await import(
    "../src/domains/storepos/operations.js"
  );
  /** @param {any} lines */
  const message = (lines) => {
    try {
      transferReceiveLines(lines);
      return "accepted";
    } catch (e) {
      return /** @type {any} */ (e).message;
    }
  };
  expect(message([{ lineId: "x", receivedGoodBase: "1.5" }])).toContain(
    "lines[0].receivedGoodBase",
  );
  expect(message([{ lineId: "x", receivedGoodBase: "-1" }])).toContain(
    "lines[0].receivedGoodBase",
  );
  expect(
    message([{ lineId: "x", receivedGoodBase: "1" }, { lineId: "y", receivedDamagedBase: 2.5 }]),
  ).toContain("lines[1].receivedDamagedBase");
  expect(message([{ lineId: "x", receivedBase: 1, shortBase: 1 }])).toContain(
    "lines[0].shortBase",
  );
  expect(transferReceiveLines([{ lineId: "x", receivedGoodBase: "12" }])).toEqual([
    { lineId: "x", receivedGoodBase: 12, receivedDamagedBase: 0, receivedHoldBase: 0 },
  ]);
});
