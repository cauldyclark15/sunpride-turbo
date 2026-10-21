import { test, expect } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
} from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { install } from "../src/domains/coverage/index.js";
import {
  previewCascade,
  submitCascade,
  decideCascade,
  METRICS,
} from "../src/domains/coverage/target-cascade.js";
import { targetProgress } from "../src/domains/coverage/target-progress.js";
import { manilaDate, midnight } from "../src/domains/fieldsync/model.js";
import { monthEnd } from "../src/domains/analytics/measures.js";

test("F-615 publish six own-person measures, canonical base units and scoped actuals through the signed native projection", async () => {
  const h = await startHarness({ installers: [install] });
  try {
    const db = h.db,
      people = profileStore(h),
      unit = crypto.randomUUID(),
      foreign = crypto.randomUUID(),
      location = crypto.randomUUID(),
      sku = crypto.randomUUID(),
      outlet = crypto.randomUUID(),
      territory = crypto.randomUUID(),
      visit = crypto.randomUUID();
    h.setHooks({ unitInScope: async () => true });
    await db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE target team','national','active','2020-01-01'),(${foreign},'sunpride','SAMPLE-OTHER','SAMPLE other scope','national','active','2020-01-01')`;
    const seller = await boundDevice(h, people, {
      orgUnitId: unit,
      role: "sales",
    });
    const makerId = await createUser(
        h,
        "sample-target-maker@example.test",
        "test-only-target-password",
      ),
      reviewerId = await createUser(
        h,
        "sample-target-reviewer@example.test",
        "test-only-target-password",
      );
    const maker = people.set(makerId, {
        role: "super_admin",
        orgUnitId: unit,
        name: "SAMPLE maker",
      }),
      reviewer = people.set(reviewerId, {
        role: "super_admin",
        orgUnitId: unit,
        name: "SAMPLE reviewer",
      });
    for (const { uid, p } of [
      { uid: seller.userId, p: seller.profile },
      { uid: makerId, p: maker },
      { uid: reviewerId, p: reviewer },
    ]) {
      await db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id,channel_scope) values(${p.id},${uid},${uid},${p.name},${"SAMPLE-" + uid + "@example.test"},${p.role},'active',${unit},'general_trade')`;
      await db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},'2020-01-01','SAMPLE','SAMPLE')`;
    }
    await db`insert into territories(id,organization_id,code,name,channel,status,effective_from,created_by) values(${territory},'sunpride','SAMPLE-T','SAMPLE territory','general_trade','active','2020-01-01','SAMPLE')`;
    await db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${territory},${unit},'2020-01-01','SAMPLE','SAMPLE')`;
    await db`insert into territory_salespeople(territory_id,profile_id,kind,effective_from,actor_subject,reason) values(${territory},${seller.profile.id},'primary','2020-01-01','SAMPLE','SAMPLE')`;
    const [customer] =
      await db`insert into customers(code,name,channel,territory,credit_limit,active) values('SAMPLE-TARGET','SAMPLE account','general_trade','SAMPLE-T',100000,true) returning id`;
    await db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values(${outlet},'sunpride','SAMPLE-STORE','SAMPLE store','active',${unit},'general_trade','SAMPLE')`;
    await db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values(${outlet},${customer.id},'SAMPLE','2020-01-01','SAMPLE','SAMPLE')`;
    await db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason) values(${outlet},${territory},'2020-01-01','SAMPLE','SAMPLE')`;
    await db`insert into products(id,organization_id,code,name,category,uom,unit_price,active,quantity_scale,tracking_mode) values(${sku},'sunpride','SAMPLE-SKU','SAMPLE item','SAMPLE','EA',100,true,1000,'none')`;
    await db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${location},'sunpride',${foreign},'SAMPLE','SAMPLE-FOREIGN','SAMPLE foreign warehouse','warehouse',true,true,true,true,false)`;
    const day = manilaDate(Date.now()),
      month = day.slice(0, 7),
      previousMonth = new Date(
        Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 2, 1),
      )
        .toISOString()
        .slice(0, 7),
      prior =
        previousMonth +
        "-" +
        String(
          Math.min(+day.slice(8), +monthEnd(previousMonth).slice(8)),
        ).padStart(2, "0");
    for (const d of [
      {
        date: prior,
        key: "prior",
        qty: 1,
        base: 12000,
        total: 100,
        status: "approved",
        location: null,
      },
      {
        date: day,
        key: "current",
        qty: 2,
        base: 24000,
        total: 200,
        status: "approved",
        location: null,
      },
      {
        date: day,
        key: "foreign",
        qty: 99,
        base: 99000,
        total: 9900,
        status: "approved",
        location,
      },
      {
        date: day,
        key: "pending",
        qty: 99,
        base: 99000,
        total: 9900,
        status: "pending_approval",
        location: null,
      },
    ]) {
      const [order] =
        await db`insert into orders(organization_id,client_request_id,order_number,customer_code,salesperson_subject,status,subtotal,total,created_at,source_location_id) values('sunpride',${"SAMPLE-" + d.key},${"SAMPLE-" + d.key},'SAMPLE-TARGET',${seller.userId},${d.status},${d.total},${d.total},${new Date(midnight(d.date) + 3600000)},${d.location}) returning id`;
      await db`insert into order_lines(order_id,product_code,description,quantity,uom,quantity_base,unit_price,line_total) values(${order.id},'SAMPLE-SKU','SAMPLE item',${d.qty},'CASE',${d.base},100,${d.total})`;
    }
    const makeActor = await actorFor(db, makerId),
      reviewActor = await actorFor(db, reviewerId),
      reader = await actorFor(db, seller.userId);
    const context = {
      db,
      env: h.env,
      now: Date.now(),
      url: new URL("http://internal/targets"),
      publish: async () => {},
      enqueue: async () => {},
    };
    /** @type {Record<string,number>} */
    const goals = {
      sales_value: 150000,
      volume: 600,
      coverage_stores: 18,
      distribution_points: 18,
      calls: 27,
      msl_compliance: 9000,
    };
    for (const metric of Object.keys(METRICS)) {
      const body = {
        month,
        metric,
        productCode: metric === "volume" ? "SAMPLE-SKU" : null,
        parentLevel: "territory",
        parentKey: territory,
        parentAmount: goals[metric],
        method: "equal",
      };
      const preview = await previewCascade({
        ...context,
        actor: makeActor,
        body,
      });
      expect(preview.reconciliation.ok).toBe(true);
      if (metric === "volume") {
        expect(preview.unit).toBe("EA");
        expect(
          preview.lines.find((l) => l.key === seller.profile.id)?.basis,
        ).toBe(12);
      }
      const submitted = await submitCascade({
        ...context,
        actor: makeActor,
        body: {
          ...body,
          lines: preview.lines,
          idempotencyKey: crypto.randomUUID(),
          sourceRef: "SAMPLE F-615 acceptance targets",
        },
      });
      expect(
        await decideCascade({
          ...context,
          actor: reviewActor,
          body: {
            cascadeId: submitted.id,
            contentHash: submitted.contentHash,
            decision: "approve",
          },
        }),
      ).toEqual({ status: "published" });
    }
    const withoutAudit = await targetProgress(
      { ...context, actor: reader },
      day,
    );
    expect(
      withoutAudit.rows.find((r) => r.metric === "msl_compliance")?.actual,
    ).toBeNull();
    await db`insert into visit_executions(id,organization_id,client_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,state,productivity,last_server_time,checked_in_at,checked_out_at,completed_at,unplanned_reason) values(${visit},'sunpride','SAMPLE-call',${seller.profile.id},${outlet},${unit},${day}::date,'unplanned','completed','nonproductive',now(),now()-interval '10 minutes',now(),now(),'SAMPLE approved off-plan call')`;
    await db`insert into availability_releases(kind,policy_key,version,label,status,effective_from,payload,source_ref,sample,actor_subject) values('rules','default',1,'SAMPLE shelf policy','published','2020-01-01',${{ coverDays: 8, freshnessDays: 7, universeFreshnessDays: 7 }},'SAMPLE',true,'SAMPLE')`;
    await db`insert into availability_universes(label,service_date,members,source_ref,sample,actor_subject) values('SAMPLE validated cohort',${day}::date,${[{ outletId: outlet, turnoverWeight: 1, validationRef: "SAMPLE" }]},'SAMPLE',true,'SAMPLE')`;
    const [snapshot] =
      await db`insert into availability_call_snapshots(outlet_id,profile_id,app,service_date,content_hash,body) values(${outlet},${seller.profile.id},'field-android',${day}::date,'SAMPLE',${{ required: [{ productId: sku }] }}) returning id`;
    await db`insert into availability_checks(id,snapshot_id,outlet_id,profile_id,org_unit_id,visit_id,call_key,service_date,device_time,complete,required_count,checked_count,present_count,lines,proposals,payload_hash,actor_subject) values(${crypto.randomUUID()},${snapshot.id},${outlet},${seller.profile.id},${unit},${visit},${visit},${day}::date,now(),true,1,1,1,${[{ productId: sku, state: "present" }]},${[]},'SAMPLE','SAMPLE')`;
    const meResponse = await h.fetch("/api/me", {
        headers: { authorization: "Bearer " + seller.access },
      }),
      me = await meResponse.json();
    expect(meResponse.status).toBe(200);
    const scope = me.scope;
    const pull = await signedPost(h, seller, "/api/sync/pull", {
      version: 2,
      app: "field-android",
      deviceId: seller.deviceId,
      since: null,
      pageCursor: null,
      scopes: [
        {
          scopeId: scope.id,
          projection: "targets.progress",
          params: { serviceDate: day },
        },
      ],
      limit: 128,
    });
    expect(pull.res.status).toBe(200);
    const actual = pull.body.bundles[0].data,
      byMetric = /** @type {Map<string,any>} */ (
        new Map(actual.rows.map((/** @type {any} */ r) => [r.metric, r]))
      );
    expect(actual.profileId).toBe(seller.profile.id);
    expect(actual.rows).toHaveLength(6);
    expect(byMetric.get("sales_value")).toMatchObject({
      actual: 20000,
      prior: 10000,
      target: 50000,
    });
    expect(byMetric.get("volume")).toMatchObject({
      actual: 24,
      prior: 12,
      target: 200,
      unit: "EA",
    });
    expect(byMetric.get("coverage_stores").actual).toBe(1);
    expect(byMetric.get("distribution_points").actual).toBe(1);
    expect(byMetric.get("calls").actual).toBe(1);
    expect(byMetric.get("msl_compliance")).toMatchObject({
      actual: 10000,
      target: 9000,
      status: "on_target",
    });
    expect(
      actual.rows.every(
        (/** @type {any} */ r) =>
          r.paceTarget !== null && r.nextAction.length > 0,
      ),
    ).toBe(true);
    if (process.env.SP_NATIVE_TARGET_WIRE)
      await Bun.write(
        process.env.SP_NATIVE_TARGET_WIRE,
        JSON.stringify(pull.body),
      );
  } finally {
    await h.close();
  }
}, 30000);
