import { afterAll, beforeAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness } from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { install as org } from "../src/domains/org/index.js";
import { postMovement } from "../src/domains/inventory/posting.js";
import { openRecall } from "../src/domains/retail/recall.js";
import { frozenQuantityScale } from "../src/domains/presell/source-units.js";
/** @type {any} */ let h;
/** @type {any} */ let c;
const sku = crypto.randomUUID(),
  lot = crypto.randomUUID(),
  depot = crypto.randomUUID();
beforeAll(async () => {
  h = await startHarness({ installers: [org] });
  const unit = await ensureRoot(h.db);
  const [u] =
    await h.db`insert into users(email,password_hash) values('sample-recall@example.com','fixture-not-a-login') returning id`;
  const [person] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${u.id},${u.id},'Sample recall controller','sample-recall@example.com','super_admin','active',${unit}) returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${person.id},${unit},'super_admin',now()-interval '1 day',${u.id},'Sample fixture')`;
  c = {
    db: h.db,
    actor: await actorFor(h.db, u.id),
    now: Date.now(),
    change: async () => 1,
    publish: () => {},
  };
  const [pc] =
    await h.db`insert into units_of_measure(organization_id,code,name,dimension,decimal_places,active) values('sunpride','PC','Sample piece','count',0,true) returning id`;
  await h.db`insert into products(id,code,name,category,uom,unit_price,active,organization_id,base_uom_id,quantity_scale,tracking_mode,allocation_policy) values(${sku},'SAMPLE-RECALL','Sample SKU','Sample','PC',0,true,'sunpride',${pc.id},1,'lot','fefo')`;
  await h.db`insert into product_inventory_policies(organization_id,product_id,base_uom_id,quantity_scale,quantity_precision,tracking_mode,allocation_policy,allow_mixed_lots_per_line,allow_negative_stock,quality_release_required,expiry_date_required,manufacture_date_required,minimum_remaining_shelf_life_days,costing_method,version,active) values('sunpride',${sku},${pc.id},1,0,'lot','fefo',true,false,false,false,false,0,'weighted_average',1,true)`;
  await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${depot},'sunpride',${unit},'SAMPLE','SAMPLE-RECALL','Sample depot','warehouse',true,true,true,true,false)`;
  await h.db`insert into inventory_lots(id,organization_id,product_id,lot_number,normalized_lot_number,source_type,received_at,quality_status) values(${lot},'sunpride',${sku},'SAMPLE-0584','SAMPLE-0584','sample',now(),'released')`;
}, 60000);
afterAll(async () => {
  await h?.close();
});
/** @param {string} kind @param {any} line */
const movement = (kind, line) =>
  tx(h.db, (db) =>
    postMovement(db, {
      organizationId: "sunpride",
      kind,
      sourceType: "sample",
      sourceId: lot,
      idempotencyKey: crypto.randomUUID(),
      occurredAt: c.now,
      actor: c.actor,
      lines: [
        {
          productId: sku,
          lotId: lot,
          quantityBase: 2,
          uom: "base",
          fromLocationId: null,
          toLocationId: depot,
          ...line,
        },
      ],
    }),
  );
test("F-614 recall moves available stock through the one ledger, blocks release/sale and accepts returns only into hold", async () => {
  await movement("goods_receipt", {});
  const recall = await tx(h.db, (db) =>
    openRecall({ ...c, db, body: { lotId: lot, reason: "Sample recall" } }),
  );
  expect(recall.stockHold.heldLocations).toBe(1);
  const [b] =
    await h.db`select * from inventory_balances where product_id=${sku}`;
  expect(
    [b.physical_base, b.available_base, b.quality_hold_base].map(Number),
  ).toEqual([2, 0, 2]);
  await h.db`update inventory_lots set quality_status='released' where id=${lot}`;
  await expect(
    movement("inventory_issue", { fromLocationId: depot, toLocationId: null }),
  ).rejects.toThrow("held");
  await expect(
    movement("status_change", {
      fromLocationId: depot,
      toLocationId: depot,
      fromStockStatus: "quality_hold",
      toStockStatus: "available",
    }),
  ).rejects.toThrow("recall");
  await movement("pos_return", { quantityBase: 1 });
  const [after] =
    await h.db`select * from inventory_balances where product_id=${sku}`;
  expect(
    [after.physical_base, after.available_base, after.quality_hold_base].map(
      Number,
    ),
  ).toEqual([3, 0, 3]);
});
test("F-614 new delivery units come only from the order's frozen pricing; retained unknown scales stay unknown", () => {
  const line = { product_id: sku, uom: "CS", quantity_base: 120, quantity: 1 };
  expect(
    frozenQuantityScale(
      {
        pricing_snapshot: {
          lines: [
            {
              productId: sku,
              uom: "CS",
              quantityBase: 120,
              quantity: 1,
              quantityScale: 10,
            },
          ],
        },
      },
      line,
    ),
  ).toBe(10);
  expect(frozenQuantityScale({}, line)).toBeNull();
});
