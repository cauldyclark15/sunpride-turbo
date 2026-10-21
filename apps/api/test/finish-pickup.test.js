import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import jpeg from "jpeg-js";
import { startHarness, profileStore, createUser } from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { sha256Hex } from "../src/core/util.js";
import {
  capturePickup,
  pickupManifest,
  pickupQueue,
  reviewPickup,
} from "../src/domains/van/pickups.js";
test("F-113 unlinked evidence survives as custody, not stock or money; independent review links a historical SAP credit request", async () => {
  const h = await startHarness();
  try {
    const people = profileStore(h),
      unit = crypto.randomUUID(),
      truck = crypto.randomUUID(),
      vehicle = crypto.randomUUID(),
      tripId = crypto.randomUUID(),
      sku = crypto.randomUUID();
    h.setHooks({ unitInScope: async () => true });
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE','national','active',now()-interval '1 day')`;
    const actors = [];
    for (const n of ["seller", "reviewer"]) {
      const uid = await createUser(
        h,
        `pickup-${n}@example.test`,
        "test-only-pickup-password",
      );
      const p = people.set(uid, {
        role: "super_admin",
        orgUnitId: unit,
        name: `SAMPLE ${n}`,
      });
      await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${uid},${uid},${p.name},${`pickup-${n}@example.test`},'super_admin','active',${unit})`;
      actors.push(await actorFor(h.db, uid));
    }
    const [seller, reviewer] = actors;
    if (!seller || !reviewer) throw new Error("SAMPLE actors missing");
    await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${truck},'sunpride',${unit},'SAMPLE','SAMPLE-VAN','SAMPLE van','truck',true,true,true,true,false)`;
    await h.db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by) values(${vehicle},'sunpride',${unit},'SAMPLE','SAMPLE',${truck},${truck},'active','SAMPLE')`;
    await h.db`insert into van_trips(id,organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by) values(${tripId},'sunpride',${unit},'SAMPLE-PICKUP',${vehicle},${truck},${truck},current_date,${seller.profileId},${seller.subject},'active','SAMPLE')`;
    const [trip] = await h.db`select * from van_trips where id=${tripId}`;
    const [outlet] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('sunpride','SAMPLE-PICKUP','SAMPLE buyer','active',${unit},${seller.subject}) returning *`;
    await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,active,quantity_scale) values(${sku},'sunpride','SAMPLE-PICKUP','SAMPLE item','SAMPLE','EA',0,true,1)`;
    await h.db`insert into van_policy_versions(org_unit_id,kind,effective_from,source_ref,facts,created_by) values(${unit},'return_reasons','2026-01-01','SAMPLE',${{ items: [{ code: "quality_complaint", label: "SAMPLE quality" }] }},${seller.profileId})`;
    const photo = jpeg.encode(
      { data: Buffer.alloc(16, 255), width: 2, height: 2 },
      70,
    ).data;
    const p = {
      returnId: crypto.randomUUID(),
      returnNumber: "SAMPLE-PICKUP-001",
      customer: { outletId: outlet.id },
      customerName: "SAMPLE buyer",
      custodyOnly: true,
      deviceTime: Date.now(),
      photo: { base64: photo.toString("base64"), sha256: sha256Hex(photo) },
      customerAcknowledgement: {
        name: "SAMPLE customer",
        accepted: true,
        strokes: [
          [
            [1, 1],
            [100, 100],
          ],
        ],
      },
      lines: [
        {
          productId: sku,
          product: {
            name: "SAMPLE item",
            code: "SAMPLE-PICKUP",
            quantityScale: "1",
            uomCode: "EA",
          },
          uomCode: "EA",
          uomQuantity: "1",
          quantityBase: "1",
          reason: "quality_complaint",
          reasonLabel: "SAMPLE quality",
          lotNumber: "SAMPLE-BATCH",
          disposition: "bad_stock",
          stockEffect: "none",
        },
      ],
    };
    await tx(h.db, (db) => capturePickup(db, trip, seller, p));
    expect(await pickupManifest(h.db, trip.id)).toEqual([p.returnId]);
    expect(
      (await h.db`select count(*)::int as n from inventory_movements`)[0].n,
    ).toBe(0);
    expect((await h.db`select count(*)::int as n from van_payments`)[0].n).toBe(
      0,
    );
    await expect(
      tx(h.db, (db) =>
        reviewPickup(db, seller, {
          returnId: p.returnId,
          decision: "warehouse_received",
          reason: "SAMPLE received",
        }),
      ),
    ).rejects.toThrow("cannot approve your own");
    await tx(h.db, (db) =>
      reviewPickup(db, reviewer, {
        returnId: p.returnId,
        decision: "warehouse_received",
        reason: "SAMPLE bags counted",
      }),
    );
    const saleId = crypto.randomUUID();
    const receipt = {
      soldAt: Date.now(),
      lines: [
        {
          productId: sku,
          code: "SAMPLE-ORIGINAL",
          name: "SAMPLE original",
          uomCode: "EA",
          quantityScale: "1",
          quantityBase: "2",
          unitPriceMinor: "100",
          totalMinor: "200",
          taxCode: "SAMPLE",
          taxBasisPoints: 1200,
        },
      ],
    };
    await h.db`insert into van_sales(id,trip_id,outlet_id,receipt_number,customer_code,total_centavos,receipt,captured_request) values(${saleId},${trip.id},${outlet.id},'SAMPLE-OLD-SI','SAMPLE-ACCOUNT',200,${receipt},${{ sample: true }})`;
    await tx(h.db, (db) =>
      reviewPickup(db, reviewer, {
        returnId: p.returnId,
        decision: "credit_requested",
        invoiceNumber: "SAMPLE-OLD-SI",
        reason: "SAMPLE original matched",
      }),
    );
    expect(
      (await pickupQueue(h.db, reviewer, trip.id)).items[0].capture,
    ).toEqual(p);
    const [event] =
      await h.db`select payload from integration_events where event_id=${`credit_memo:van_return:${p.returnId}`}`;
    expect(event.payload.document.lines[0].productCode).toBe("SAMPLE-ORIGINAL");
  } finally {
    await h.close();
  }
}, 120000);
