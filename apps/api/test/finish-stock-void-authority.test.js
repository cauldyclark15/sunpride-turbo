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
import { execute } from "../src/domains/inventory/commands.js";
import {
  issueApproval,
  consumeApproval,
} from "../src/domains/van/approvals.js";
test("F-124 stock approval and handheld void code use the current fiscal matrix; an old code cannot bypass replacement", async () => {
  const h = await startHarness();
  try {
    const people = profileStore(h),
      unit = crypto.randomUUID(),
      truck = crypto.randomUUID(),
      sku = crypto.randomUUID();
    h.setHooks({ unitInScope: async () => true });
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE','national','active',now()-interval '1 day')`;
    const seller = await boundDevice(h, people, {
        orgUnitId: unit,
        role: "super_admin",
        app: "van-android",
      }),
      bossId = await createUser(
        h,
        "stock-admin@example.test",
        "test-only-stock-password",
      ),
      boss = people.set(bossId, {
        role: "super_admin",
        orgUnitId: unit,
        name: "SAMPLE reviewer",
      });
    for (const { uid, p } of [
      { uid: seller.userId, p: seller.profile },
      { uid: bossId, p: boss },
    ]) {
      await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${uid},${uid},${p.name},${`SAMPLE-${uid}@example.test`},${p.role},'active',${unit})`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','SAMPLE','SAMPLE')`;
    }
    const requester = await actorFor(h.db, seller.userId),
      reviewer = await actorFor(h.db, bossId);
    if (!requester || !reviewer) throw Error("SAMPLE actors missing");
    for (const kind of ["stock", "void"])
      await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${unit},${kind},'super_admin','*',0,1000000,0,${["super_admin"]},true,'2026-01-01',true)`;
    await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${truck},'sunpride',${unit},'SAMPLE','SAMPLE','SAMPLE truck','truck',true,true,true,true,false)`;
    await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,active,quantity_scale,tracking_mode) values(${sku},'sunpride','SAMPLE-CONTROL','SAMPLE item','SAMPLE','EA',3,true,1,'none')`;
    const base = {
      organizationId: "sunpride",
      kind: "opening_balance",
      sourceType: "SAMPLE",
      sourceId: sku,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: Date.now(),
      actor: { profileId: requester.profileId, userId: requester.userId },
      authorizedLocations: [truck],
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
    await tx(h.db, (db) => postMovement(db, base));
    const ctx = {
      db: h.db,
      actor: requester,
      env: h.env,
      now: Date.now(),
      publish: async () => {},
      enqueue: async () => {},
    };
    const adjustment = await execute(
      {
        ...ctx,
        body: {
          idempotencyKey: crypto.randomUUID(),
          reasonCode: "SAMPLE verified shortage",
          lines: [
            {
              productId: sku,
              locationId: truck,
              stockStatus: "available",
              varianceBase: -2,
            },
          ],
        },
      },
      "adjustments/request",
    );
    await expect(
      execute(
        {
          ...ctx,
          body: {
            idempotencyKey: crypto.randomUUID(),
            adjustmentId: adjustment.id,
            decision: "approved",
          },
        },
        "adjustments/decide",
      ),
    ).rejects.toMatchObject({ status: 403 });
    await execute(
      {
        ...ctx,
        actor: reviewer,
        body: {
          idempotencyKey: crypto.randomUUID(),
          adjustmentId: adjustment.id,
          decision: "approved",
        },
      },
      "adjustments/decide",
    );
    expect(
      String(
        (
          await h.db`select physical_base from inventory_balances where product_id=${sku} and location_id=${truck}`
        )[0].physical_base,
      ),
    ).toBe("8");
    const [authority] =
      await h.db`select r.*,e.kind as event from fiscal_override_requests r join fiscal_override_events e on e.request_id=r.id and e.kind='consumed' where r.kind='stock'`;
    expect(String(authority.amount_centavos)).toBe("200");
    expect(authority.facts.sourceId).toBe(adjustment.id);
    const vehicle = crypto.randomUUID(),
      tripId = crypto.randomUUID(),
      saleId = crypto.randomUUID();
    await h.db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by) values(${vehicle},'sunpride',${unit},'SAMPLE','SAMPLE',${truck},${truck},'active','SAMPLE')`;
    await h.db`insert into van_trips(id,organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by) values(${tripId},'sunpride',${unit},'SAMPLE-CONTROL',${vehicle},${truck},${truck},current_date,${requester.profileId},${requester.subject},'active','SAMPLE')`;
    const [trip] = await h.db`select * from van_trips where id=${tripId}`;
    const [outlet] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride','SAMPLE-CONTROL','SAMPLE buyer','active',${unit},'general_trade',${requester.subject}) returning *`;
    const receiptNumber = "SAMPLE-CONTROL-ABCD1234-0001",
      line = {
        productId: sku,
        code: "SAMPLE-CONTROL",
        name: "SAMPLE item",
        uomCode: "EA",
        quantityScale: "1",
        quantityBase: "1",
        unitPriceMinor: "300",
        grossMinor: "300",
        discountMinor: "0",
        totalMinor: "300",
      };
    await h.db`insert into van_sales(id,trip_id,receipt_number,outlet_id,total_centavos,discount_centavos,receipt,captured_request) values(${saleId},${tripId},${receiptNumber},${outlet.id},300,0,${{ lines: [line], totalMinor: "300" }},'{}')`;
    await tx(h.db, (db) =>
      postMovement(db, {
        ...base,
        kind: "pos_sale",
        sourceType: "van_sale",
        sourceId: saleId,
        idempotencyKey: crypto.randomUUID(),
        lines: [
          {
            productId: sku,
            fromLocationId: truck,
            toLocationId: null,
            quantityBase: 1,
            uom: "EA",
            stockStatus: "available",
          },
        ],
      }),
    );
    const facts = {
      receiptNumber,
      totalMinor: "300",
      reasonCode: "customer_cancelled",
    };
    const issued = await tx(h.db, (db) =>
      issueApproval(db, reviewer, h.env, "void", { ...facts, tripId }),
    );
    expect(issued.code).toMatch(/^\d{8}$/);
    await h.db`update fiscal_authority_rules set effective_to=now()-interval '1 second' where kind='void'`;
    const operationId = crypto.randomUUID();
    await expect(
      tx(h.db, (db) =>
        consumeApproval(
          db,
          h.env,
          trip,
          "void",
          facts,
          { method: "supervisor_code", code: issued.code },
          operationId,
        ),
      ),
    ).rejects.toThrow("policy is missing");
    expect(
      (
        await h.db`select consumed_by from van_approval_codes where trip_id=${tripId}`
      )[0].consumed_by,
    ).toBeNull();
    await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${unit},'void','super_admin','*',0,1000000,0,${["super_admin"]},true,now(),true)`;
    const renewed = await tx(h.db, (db) =>
      issueApproval(db, reviewer, h.env, "void", { ...facts, tripId }),
    );
    await tx(h.db, (db) =>
      consumeApproval(
        db,
        h.env,
        trip,
        "void",
        facts,
        { method: "supervisor_code", code: renewed.code },
        operationId,
      ),
    );
    const [used] =
      await h.db`select e.operation_id from van_approval_codes c join fiscal_override_events e on e.request_id=c.fiscal_request_id and e.kind='consumed' where c.trip_id=${tripId}`;
    expect(used.operation_id).toBe(operationId);
  } finally {
    await h.close();
  }
}, 120000);
