import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
} from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { canonicalJson, sha256Hex } from "../src/core/util.js";
import { postMovement } from "../src/domains/inventory/posting.js";
import { explainStock } from "../src/domains/van/facts.js";
import {
  requestCorrection,
  decideCorrection,
  unloadBasis,
  effectiveCash,
  reviseSettlement,
} from "../src/domains/van/corrections.js";
import { decideSettlement } from "../src/domains/van/settlement.js";
test("F-116 F-117 independent remainder and cash corrections preserve original evidence and create a signable new version", async () => {
  const h = await startHarness();
  try {
    const people = profileStore(h),
      unit = crypto.randomUUID(),
      truck = crypto.randomUUID(),
      depot = crypto.randomUUID(),
      vehicle = crypto.randomUUID(),
      tripId = crypto.randomUUID(),
      sku = crypto.randomUUID();
    h.setHooks({ unitInScope: async () => true });
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE','national','active',now()-interval '1 day')`;
    const seller = await boundDevice(h, people, {
      role: "super_admin",
      orgUnitId: unit,
      app: "van-android",
    });
    const records = [{ uid: seller.userId, p: seller.profile }];
    for (const name of ["requester", "approver"]) {
      const uid = await createUser(
        h,
        `correction-${name}@example.test`,
        "test-only-correction-password",
      );
      records.push({
        uid,
        p: people.set(uid, {
          role: "super_admin",
          orgUnitId: unit,
          name: `SAMPLE ${name}`,
        }),
      });
    }
    for (const { uid, p } of records) {
      await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${uid},${uid},${p.name},${`sample-${uid}@example.test`},'super_admin','active',${unit})`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},'super_admin',now()-interval '1 day','SAMPLE','SAMPLE')`;
    }
    const actors = await Promise.all(records.map((r) => actorFor(h.db, r.uid)));
    const [driver, requester, approver] = actors;
    if (!driver || !requester || !approver)
      throw Error("SAMPLE actors missing");
    for (const [id, code, type] of [
      [truck, "SAMPLE-TRUCK", "truck"],
      [depot, "SAMPLE-DEPOT", "warehouse"],
    ])
      await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${id},'sunpride',${unit},'SAMPLE',${code},${code},${type},true,true,true,true,false)`;
    await h.db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by) values(${vehicle},'sunpride',${unit},'SAMPLE','SAMPLE',${truck},${depot},'active','SAMPLE')`;
    await h.db`insert into van_trips(id,organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,started_device_id,created_by) values(${tripId},'sunpride',${unit},'SAMPLE-CORRECTION',${vehicle},${truck},${depot},current_date,${driver.profileId},${driver.subject},'closing',${seller.deviceId},'SAMPLE')`;
    const [trip] = await h.db`select * from van_trips where id=${tripId}`;
    await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,active,quantity_scale,tracking_mode) values(${sku},'sunpride','SAMPLE-CORRECTION','SAMPLE item','SAMPLE','EA',1,true,1,'none')`;
    const product = {
      productId: sku,
      code: "SAMPLE-CORRECTION",
      name: "SAMPLE item",
      uomCode: "EA",
      quantityScale: "1",
      caseBase: "0",
      pieceBase: "1",
    };
    const open = {
      organizationId: "sunpride",
      kind: "opening_balance",
      sourceType: "SAMPLE",
      sourceId: tripId,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: Date.now(),
      actor: { profileId: requester.profileId, userId: requester.userId },
      authorizedLocations: [truck, depot],
      lines: [
        {
          productId: sku,
          fromLocationId: null,
          toLocationId: truck,
          quantityBase: 10,
          uom: "EA",
          stockStatus: "available",
          unitCostMinor: 100,
        },
      ],
    };
    await tx(h.db, (db) => postMovement(db, open));
    await explainStock(h.db, trip, tripId, "load", [
      { productId: sku, delta: 10n, facts: product },
    ]);
    await tx(h.db, (db) =>
      postMovement(db, {
        ...open,
        kind: "van_unload",
        idempotencyKey: crypto.randomUUID(),
        lines: [
          {
            productId: sku,
            fromLocationId: truck,
            toLocationId: depot,
            quantityBase: 8,
            uom: "EA",
            stockStatus: "available",
          },
        ],
      }),
    );
    const observationId = crypto.randomUUID();
    await explainStock(h.db, trip, observationId, "unload", [
      { productId: sku, delta: -8n, facts: product },
    ]);
    const line = {
      productId: sku,
      status: "available",
      quantityBase: "10",
      partition: "unsold",
      product,
    };
    await h.db`insert into van_trip_observations(id,trip_id,client_op_id,kind,captured_at,recorded_by,device_id,facts) values(${observationId},${trip.id},${crypto.randomUUID()},'unload',now(),${driver.profileId},${seller.deviceId},${{ lines: [line], empties: [] }})`;
    await h.db`insert into van_observation_decisions(observation_id,decision,facts,actor_profile_id) values(${observationId},'received',${{ lines: [{ ...line, receivedBase: "8" }], empties: [], discrepancy: true }},${requester.profileId})`;
    const pending = await tx(h.db, (db) =>
      requestCorrection(db, requester, {
        tripId: trip.id,
        kind: "unload_remainder",
        reason: "SAMPLE two units physically found",
      }),
    );
    await expect(
      tx(h.db, (db) =>
        decideCorrection(db, requester, {
          changeId: pending.changeId,
          decision: "approved",
          reason: "SAMPLE",
        }),
      ),
    ).rejects.toThrow("different person");
    await tx(h.db, (db) =>
      decideCorrection(db, approver, {
        changeId: pending.changeId,
        decision: "approved",
        reason: "SAMPLE received remaining two",
      }),
    );
    expect((await unloadBasis(h.db, trip.id)).lines[0].quantityBase).toBe("0");
    expect(
      String(
        (
          await h.db`select physical_base from inventory_balances where location_id=${truck} and product_id=${sku}`
        )[0].physical_base,
      ),
    ).toBe("0");
    const [count] =
      await h.db`insert into van_cash_counts(id,trip_id,expected_centavos,declared_centavos,variance_centavos,facts) values(${crypto.randomUUID()},${trip.id},100,100,0,'{}') returning id`;
    await h.db`insert into van_cash_remittances(id,trip_id,count_id,amount_centavos,received_by,received_by_name,reference) values(${crypto.randomUUID()},${trip.id},${count.id},100,${requester.profileId},'SAMPLE requester','SAMPLE old receipt')`;
    const cash = await tx(h.db, (db) =>
      requestCorrection(db, requester, {
        tripId: trip.id,
        kind: "cash_recount",
        newDeclaredMinor: "120",
        newReceivedMinor: "120",
        reference: "SAMPLE verified extra handover",
        reason: "SAMPLE recount evidence",
      }),
    );
    await tx(h.db, (db) =>
      decideCorrection(db, approver, {
        changeId: cash.changeId,
        decision: "approved",
        reason: "SAMPLE independently recounted",
      }),
    );
    expect((await effectiveCash(h.db, trip.id)).declaredMinor).toBe("120");
    expect(
      String(
        (
          await h.db`select declared_centavos from van_cash_counts where id=${count.id}`
        )[0].declared_centavos,
      ),
    ).toBe("100");
    await h.db`insert into van_policy_versions(org_unit_id,kind,effective_from,source_ref,facts,created_by) values(${unit},'variance','2026-01-01','SAMPLE',${{ toleranceBasisPoints: 50, escalateAfterHours: 24 }},${requester.profileId})`;
    const old = {
      cash: {
        expectedCentavos: "100",
        declaredCentavos: "100",
        varianceCentavos: "0",
      },
      salesCentavos: "10000",
      varianceCentavos: "0",
      toleranceBasisPoints: 50,
      unloadId: observationId,
      stock: [],
      closing: [],
      documents: [],
      payments: [],
    };
    const oldHash = sha256Hex(canonicalJson(old)),
      oldId = crypto.randomUUID();
    await h.db`insert into van_settlements(id,trip_id,version,content_hash,facts,submitted_by,captured_at) values(${oldId},${trip.id},1,${oldHash},${old},${driver.profileId},now())`;
    await h.db`insert into van_settlement_decisions(settlement_id,decision,note,actor_profile_id) values(${oldId},'rejected','SAMPLE correction needed',${requester.profileId})`;
    const revised = await tx(h.db, (db) =>
      reviseSettlement(db, requester, {
        tripId: trip.id,
        contentHash: oldHash,
        reason: "SAMPLE corrections reviewed",
      }),
    );
    const [version] =
      await h.db`select * from van_settlements where id=${revised.settlementId}`;
    expect(version.facts.cash.declaredCentavos).toBe("120");
    expect(
      (await h.db`select facts from van_settlements where id=${oldId}`)[0]
        .facts,
    ).toEqual(old);
    await tx(h.db, (db) =>
      decideSettlement(db, approver, {
        tripId: trip.id,
        settlementId: version.id,
        contentHash: version.content_hash,
        decision: "approved",
        note: "SAMPLE independent sign-off",
      }),
    );
    expect(
      (await h.db`select status from van_trips where id=${trip.id}`)[0].status,
    ).toBe("closed");
  } finally {
    await h.close();
  }
}, 120000);
