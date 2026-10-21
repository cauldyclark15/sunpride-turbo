import { test, expect } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  signedPost,
} from "./harness.js";
import { install } from "../src/domains/integration/index.js";
import { ingestMaster } from "../src/domains/integration/replicas.js";
import { sampleMaster } from "../../sap-mock/src/sample.js";
import { today } from "../src/domains/van/model.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

test("F-004 van master copy uses today's own truck/depot, not field MCP grants or national locations", async () => {
  const h = await startHarness({ installers: [install] });
  try {
    const people = profileStore(h),
      unit = crypto.randomUUID(),
      location = crypto.randomUUID(),
      other = crypto.randomUUID(),
      vehicle = crypto.randomUUID(),
      trip = crypto.randomUUID();
    h.setHooks({ unitInScope: async () => true });
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE','national','active',now()-interval '1 day')`;
    const phone = await boundDevice(h, people, {
      app: "van-android",
      orgUnitId: unit,
    });
    const p = phone.profile;
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${phone.userId},${phone.userId},${p.name},${phone.email},${p.role},'active',${unit})`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','SAMPLE','SAMPLE')`;
    for (const [id, code] of [
      [location, "SAMPLE-TRUCK"],
      [other, "SAMPLE-OTHER"],
    ]) {
      await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${id},'sunpride',${unit},'SAMPLE',${code},${code},'truck',true,true,true,true,false)`;
      await ingestMaster(
        h.db,
        sampleMaster("location", code, {
          locationCode: code,
          plant: "SAMPLE",
          storageLocation: "SAMPLE",
          status: "active",
        }),
      );
    }
    await h.db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by) values(${vehicle},'sunpride',${unit},'SAMPLE','SAMPLE',${location},${location},'active','SAMPLE')`;
    await h.db`insert into van_trips(id,organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,started_device_id,created_by) values(${trip},'sunpride',${unit},'SAMPLE',${vehicle},${location},${location},${today()},${p.id},${phone.userId},'active',${phone.deviceId},'SAMPLE')`;
    const request = {
      version: 2,
      app: "van-android",
      deviceId: phone.deviceId,
      since: null,
      pageCursor: null,
      scopes: [{ scopeId: unit, projection: "sap.masters", params: {} }],
      limit: 100,
    };
    const initial = await signedPost(h, phone, "/api/sync/pull", request);
    expect(initial.res.status, JSON.stringify(initial.body)).toBe(200);
    expect(
      initial.body.bundles[0].data.masters.map((/** @type {any} */ r) => r.key),
    ).toEqual(["SAMPLE-TRUCK"]);
    // This exact runtime packet is consumed by the native codec check; it contains no bearer/session.
    await writeFile(
      join(process.env.TMPDIR ?? "/tmp", "finish-a-sap-master-wire.json"),
      JSON.stringify(initial.body),
      { mode: 0o600 },
    );
    await ingestMaster(
      h.db,
      sampleMaster(
        "location",
        "SAMPLE-TRUCK",
        {
          locationCode: "SAMPLE-TRUCK",
          plant: "SAMPLE updated",
          storageLocation: "SAMPLE",
          status: "active",
        },
        2,
      ),
    );
    const delta = await signedPost(h, phone, "/api/sync/pull", {
      ...request,
      since: initial.body.nextCursor,
    });
    expect(delta.res.status).toBe(200);
    expect(delta.body.bundles[0].changes[0].value.version).toBe(2);
    await h.db`update van_trips set status='cancelled' where id=${trip}`;
    const denied = await signedPost(h, phone, "/api/sync/pull", {
      ...request,
      since: delta.body.nextCursor,
    });
    expect(denied.res.status).toBe(409);
  } finally {
    await h.close();
  }
});
