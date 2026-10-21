import { test, expect } from "bun:test";
import {
  startHarness,
  createUser,
  deviceKey,
  registerDevice,
  nativeSignIn,
  bind,
  signedPost,
} from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as visits } from "../src/domains/visits/index.js";
import { install as callflow } from "../src/domains/callflow/index.js";
import { install as availability } from "../src/domains/availability/index.js";
import { install as distributors } from "../src/domains/distributors/index.js";
import { roleHas } from "../src/core/capabilities.js";
import { manilaDate } from "../src/domains/visits/shared.js";

test("F-407 real signed distributor PJP/MSL/stock/order-intent call uses shared writers with no employee capability and reauthorizes before replay", async () => {
  const h = await startHarness({
    installers: [org, visits, callflow, availability, distributors],
  });
  try {
    const root = crypto.randomUUID(),
      unit = crypto.randomUUID(),
      party = crypto.randomUUID(),
      outlet = crypto.randomUUID(),
      territory = crypto.randomUUID(),
      sku = crypto.randomUUID();
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${root},'sunpride','SUNPRIDE','SAMPLE company','national','active','2020-01-01'),(${unit},'sunpride','SAMPLE-DEVICE','SAMPLE partner device partition','region','active','2020-01-01')`;
    await h.db`update org_units set parent_id=${root} where id=${unit}`;
    const email = "sample-dsr@example.test",
      password = "test-only-distributor-field-password",
      uid = await createUser(h, email, password);
    const [p] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${uid},${uid},'SAMPLE DSR',${email},'distributor','active',${unit}) returning id`;
    await h.db`insert into distributors(id,code,name,org_unit_id,device_org_unit_id,status,sap_customer_code,source,effective_from) values(${party},'SAMPLE-D','SAMPLE Distributor',${root},${unit},'accredited','SAMPLE-D','sample','2020-01-01')`;
    await h.db`insert into distributor_users(distributor_id,profile_id,grants,effective_from) values(${party},${p.id},ARRAY['dsr']::text[],'2020-01-01')`;
    await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,quantity_scale,active) values(${sku},'sunpride','SAMPLE-SKU','SAMPLE item','SAMPLE','EA',10,1,true)`;
    const [m] =
      await h.db`insert into distributor_master_versions(distributor_id,source,source_key,version,payload_hash,payload,effective_from) values(${party},'sample','SAMPLE',1,'SAMPLE',${{ products: [{ productId: sku, uom: "EA", unitsPerUom: 1, priceCentavos: 1000, availableBase: 10 }], schemes: [], terms: {} }},'2020-01-01') returning id`;
    await h.db`insert into distributor_policies(distributor_id,version,settings,effective_from) values(${party},1,${{ creditMaxAgeSeconds: 3600 }},'2020-01-01')`;
    await h.db`insert into territories(id,organization_id,code,name,channel,status,effective_from,created_by) values(${territory},'sunpride','SAMPLE-T','SAMPLE territory','general_trade','active','2020-01-01','SAMPLE')`;
    await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${territory},${root},'2020-01-01','SAMPLE','SAMPLE')`;
    await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,classification,created_by) values(${outlet},'sunpride','SAMPLE-O','SAMPLE shared store','active',${root},'general_trade','SAMPLE','SAMPLE')`;
    await h.db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason) values(${outlet},${territory},'2020-01-01','SAMPLE','SAMPLE')`;
    await h.db`insert into distributor_outlets(distributor_id,outlet_id,territory_id,master_version_id,effective_from) values(${party},${outlet},${territory},${m.id},'2020-01-01')`;
    await h.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,status,effective_from,proposed_by,verified_by,source,proposed_at) values(${outlet},10,123,100,'verified','2020-01-01','SAMPLE','SAMPLE-reviewer','SAMPLE','2020-01-01')`;
    const steps = [
      "check_in",
      "stock_check",
      "availability",
      "order_build",
      "check_out",
    ].map((adapter) => ({
      key: adapter,
      adapter,
      label: adapter,
      required: true,
      condition: "always",
    }));
    await h.db`insert into call_flow_definitions(channel_profile,version,label,steps,effective_from,published_by,source) values('distributor_rep',1,'SAMPLE DSR',${{ values: steps }}::jsonb->'values','2020-01-01','SAMPLE','sample')`;
    await h.db`insert into call_flow_policies(channel_profile,outlet_class,version,radius_meters,max_accuracy_meters,max_fix_age_ms,min_dwell_ms,effective_from,published_by) values('distributor_rep','*',1,100,50,60000,0,'2020-01-01','SAMPLE')`;
    await h.db`insert into no_order_reasons(code,label,version,effective_from,published_by) values('no_demand','SAMPLE no demand',1,'2020-01-01','SAMPLE')`;
    await h.db`insert into availability_releases(kind,policy_key,version,label,status,effective_from,payload,source_ref,actor_subject,published_at) values('msl','SAMPLE-DSR',1,'SAMPLE MSL','published','2020-01-01',${{ outletIds: [outlet], priority: 1, lines: [{ productId: sku, minimumBase: 1 }] }},'SAMPLE','SAMPLE','2020-01-01')`;
    const key = await deviceKey(),
      deviceId = await registerDevice(h, {
        profileId: p.id,
        orgUnitId: unit,
        key,
      }),
      login = await nativeSignIn(h, email, password, "field-android", {
        keyId: key.keyId,
        publicKeySpki: key.publicKeySpki,
      });
    expect(login.res.status).toBe(200);
    const access = login.body.accessToken;
    expect((await bind(h, access, deviceId, key)).body.bindingStatus).toBe(
      "bound",
    );
    const who = { access, deviceId, key };
    const me = await (
      await h.fetch("/api/me", {
        headers: { authorization: "Bearer " + access },
      })
    ).json();
    expect(roleHas("distributor", "visit.record")).toBe(false);
    const pull = await signedPost(h, who, "/api/sync/pull", {
      version: 2,
      app: "field-android",
      deviceId,
      since: null,
      pageCursor: null,
      scopes: [
        {
          scopeId: me.scope.id,
          projection: "distributor.bundle",
          params: { distributorId: party },
        },
      ],
      limit: 128,
    });
    if (pull.res.status !== 200) throw Error(JSON.stringify(pull.body));
    const data = pull.body.bundles[0].data;
    expect(data.agenda.length).toBeGreaterThan(0);
    expect(data.availability[outlet].lines).toHaveLength(1);
    if (process.env.SP_NATIVE_DSR_WIRE)
      await Bun.write(
        process.env.SP_NATIVE_DSR_WIRE,
        JSON.stringify({ me, response: pull.body }),
      );
    const clientVisitId = crypto.randomUUID();
    /** @param {string} type @param {any} payload @param {string[]} [deps] */
    async function push(type, payload, deps = []) {
      const op = {
        clientOpId: crypto.randomUUID(),
        opType: type,
        clientTime: Date.now(),
        dependsOn: deps,
        payload: { distributorId: party, deviceTime: Date.now(), ...payload },
      };
      const result = await signedPost(h, who, "/api/sync/push", {
        version: 2,
        app: "field-android",
        deviceId,
        scopeId: me.scope.id,
        operations: [op],
      });
      if (
        result.res.status !== 200 ||
        result.body.results[0].status !== "applied"
      )
        throw Error(JSON.stringify(result.body));
      return { op, result: result.body.results[0] };
    }
    const started = await push("dsr.visit.checkIn", {
        clientVisitId,
        outletId: outlet,
        serviceDate: manilaDate(Date.now()),
        intents: [],
        flowDefinitionId:
          data.configuration.configurations[outlet].definition.id,
        unplannedReason: "SAMPLE partner beat",
        location: {
          latitude: 10,
          longitude: 123,
          accuracyMeters: 1,
          provider: "gps",
          mockSignal: false,
          fixTime: Date.now(),
        },
      }),
      visitId = started.result.ack.entityId;
    const stock = await push(
      "dsr.visit.activity",
      {
        visitId,
        activity: {
          kind: "inventory_check",
          productId: sku,
          icoFinding: "present",
          observedQuantity: 2,
        },
      },
      [started.op.clientOpId],
    );
    const checked = await push(
      "dsr.availability.record",
      {
        visitId,
        checkId: crypto.randomUUID(),
        snapshotId: data.availability[outlet].snapshotId,
        callKey: clientVisitId,
        complete: true,
        lines: [
          { productId: sku, state: "present", method: "tap", shelfBase: 2 },
        ],
      },
      [stock.op.clientOpId],
    );
    const ordered = await push(
      "dsr.visit.activity",
      {
        visitId,
        activity: {
          kind: "order_intent",
          clientOrderId: crypto.randomUUID(),
          lines: [{ productId: sku, uom: "EA", quantity: 1 }],
        },
      },
      [checked.op.clientOpId],
    );
    await push(
      "dsr.visit.checkOut",
      {
        visitId,
        outcome: "completed",
        location: {
          latitude: 10,
          longitude: 123,
          accuracyMeters: 1,
          provider: "gps",
          mockSignal: false,
          fixTime: Date.now(),
        },
      },
      [ordered.op.clientOpId],
    );
    const [call] =
      await h.db`select state from call_executions where client_call_id=${clientVisitId}`;
    expect(call.state).toBe("closed");
    const [count] = await h.db`select count(*)::int as n from orders`;
    expect(count.n).toBe(0);
    await h.db`update distributor_users set grants=ARRAY[]::text[] where distributor_id=${party}`;
    const replay = await signedPost(h, who, "/api/sync/push", {
      version: 2,
      app: "field-android",
      deviceId,
      scopeId: me.scope.id,
      operations: [started.op],
    });
    expect(replay.res.status).toBe(403);
  } finally {
    await h.close();
  }
}, 30000);
