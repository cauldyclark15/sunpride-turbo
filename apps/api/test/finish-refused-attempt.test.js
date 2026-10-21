import { test, expect } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  signedPost,
} from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { install } from "../src/domains/integrity/index.js";
import { detect, readQueue } from "../src/domains/integrity/detectors.js";

test("F-221 uploaded on-phone mock refusal is counted once without a visit or impossible travel", async () => {
  const h = await startHarness({ installers: [install] });
  try {
    const people = profileStore(h),
      unit = crypto.randomUUID();
    h.setHooks({ unitInScope: async () => true });
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SAMPLE','SAMPLE','national','active',now()-interval '1 day')`;
    const phone = await boundDevice(h, people, {
      app: "field-android",
      role: "super_admin",
      orgUnitId: unit,
    });
    const p = phone.profile;
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${phone.userId},${phone.userId},${p.name},${phone.email},${p.role},'active',${unit})`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','SAMPLE','SAMPLE')`;
    const [outlet] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('sunpride','SAMPLE','SAMPLE store','active',${unit},${phone.userId}) returning id`;
    const at = Date.now();
    const op = {
      opType: "integrity.checkInRefused",
      clientOpId: crypto.randomUUID(),
      clientTime: at,
      dependsOn: [],
      payload: { outletId: outlet.id, deviceTime: at, mockSignal: true },
    };
    const send = () =>
      signedPost(h, phone, "/api/sync/push", {
        version: 2,
        app: "field-android",
        deviceId: phone.deviceId,
        scopeId: unit,
        operations: [op],
      });
    const first = await send();
    expect(first.body.results[0]).toMatchObject({ status: "applied" });
    const replay = await send();
    expect(replay.body.results[0]).toMatchObject({ status: "duplicate" });
    const observations =
      await h.db`select * from integrity_observations where device_id=${phone.deviceId}`;
    expect(observations).toHaveLength(1);
    expect(observations[0].kind).toBe("refused_check_in");
    expect(await h.db`select * from visits`).toHaveLength(0);
    await detect(h.db);
    const queue = await readQueue({
      db: h.db,
      actor: await actorFor(h.db, phone.userId),
      url: new URL("http://localhost/integrity"),
    });
    expect(queue.mockRate.attempts).toBe(1);
    expect(queue.mockRate.incidents).toBe(1);
    expect(queue.items.map((/** @type {any} */ r) => r.rule)).toEqual([
      "mock_location",
    ]);
  } finally {
    await h.close();
  }
});
