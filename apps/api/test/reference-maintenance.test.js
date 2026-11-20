import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as masters } from "../src/domains/masters/index.js";

/** @type {import('./harness.js').Harness} */ let h;
let cookie = "",
  root = "",
  profile = "",
  group = "",
  store = "";
const why = "SP-0230 synthetic realignment proof";
/** @param {string} path @param {any} [body] @param {string} [key] @param {string} [who] */
async function call(path, body, key = crypto.randomUUID(), who = cookie) {
  const res = await h.fetch(`/api/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      cookie: who,
      "content-type": "application/json",
      "idempotency-key": key,
      connection: "close",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} email */
async function login(email) {
  const res = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ email, password: "test-only-password" }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}
beforeAll(async () => {
  h = await startHarness({ installers: [org, masters], port: 5002 });
  await h.db`insert into users(email,password_hash) values('boss@example.com',${await Bun.password.hash("test-only-password")})`;
  cookie = await login("boss@example.com");
  const me = await h.fetch("/api/me", {
    headers: { cookie, connection: "close" },
  });
  const p = /** @type {any} */ (await me.json()).profile;
  root = p.orgUnitId;
  profile = p.id ?? p._id;
  await h.db`insert into ph_regions(code,name) values('0100000000','SAMPLE Region A'),('0200000000','SAMPLE Region B')`;
  await h.db`insert into ph_provinces(code,name,region_code,kind) values('0101000000','SAMPLE Province A','0100000000','province'),('0201000000','SAMPLE Province B','0200000000','province')`;
  await h.db`insert into ph_municipalities(code,name,province_code,region_code,kind) values('0101001000','SAMPLE Town A','0101000000','0100000000','municipality'),('0201001000','SAMPLE Town B','0201000000','0200000000','municipality')`;
  await h.db`insert into ph_barangays(code,name,municipality_code) values('0101001001','SAMPLE Barangay','0101001000')`;
  const [s] =
    await h.db`insert into outlets(organization_id,code,name,custodian_org_unit_id,status,created_by) values('sunpride','SAMPLE-230','SAMPLE Store',${root},'active','test') returning id`;
  store = s.id;
  await h.db`insert into customer_profiles(outlet_id,region_code,province_code,municipality_code,barangay_code,street1,updated_by) values(${store},'0100000000','0101000000','0101001000','0101001001','SAMPLE Street','test')`;
}, 30000);
afterAll(async () => {
  if (h) await h.close();
});

test("admin adds and renames a group, links stores, and sees before/after with their own reason", async () => {
  const create = { code: "SAMPLE-230", name: "SAMPLE Group", reason: why };
  const key = crypto.randomUUID();
  const result = await call("customer-groups/save", create, key);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  group = result.body;
  expect((await call("customer-groups/save", create, key)).body).toBe(group);
  expect(
    (
      await call("customer-groups/save", {
        customerGroupId: group,
        name: "SAMPLE Renamed group",
        reason: "Correct chain name",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call("customer-groups/link-stores", {
        customerGroupId: group,
        outletIds: [store],
        reason: "Assign chain stores",
      })
    ).status,
  ).toBe(200);
  const log = await call("masters/reference-log");
  expect(log.status).toBe(200);
  expect(log.body.rows).toHaveLength(3);
  expect(log.body.rows[0]).toMatchObject({
    kind: "group_store",
    reason: "Assign chain stores",
    before: null,
    after: { code: "SAMPLE-230", name: "SAMPLE Renamed group" },
  });
  expect(log.body.rows[1]).toMatchObject({
    kind: "customer_group",
    before: { name: "SAMPLE Group" },
    after: { name: "SAMPLE Renamed group" },
    reason: "Correct chain name",
  });
  expect(log.body.rows[1].actorName.length).toBeGreaterThan(0);
  expect(Number.isFinite(Date.parse(log.body.rows[1].createdAt))).toBe(true);
  expect(
    (await h.db`select customer_group_id from outlets where id=${store}`)[0]
      .customer_group_id,
  ).toBe(group);
});
test("requires an actual reason, refuses duplicate groups and logs no failed writes", async () => {
  const before = (
    await h.db`select count(*)::int n from field_master_changes`
  )[0].n;
  for (const data of [
    { customerGroupId: group, name: "SHOULD NOT SAVE", reason: "  " },
    { code: "OTHER", name: "SAMPLE Renamed group", reason: why },
  ])
    expect((await call("customer-groups/save", data)).status).toBe(422);
  expect(
    (await h.db`select name from customer_groups where id=${group}`)[0].name,
  ).toBe("SAMPLE Renamed group");
  expect(
    (await h.db`select count(*)::int n from field_master_changes`)[0].n,
  ).toBe(before);
});
test("maintains the actual customer distribution-channel list and preserves stable pricing keys", async () => {
  const created = await call("masters/reference/channel-save", {
    code: "099",
    name: "SAMPLE New channel",
    salesOrgCode: "1000",
    reason: why,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const rows = (await call("masters/channels")).body.rows;
  const channel = rows.find((/** @type {any} */ r) => r.id === created.body.id);
  expect(channel.code).toBe("099");
  await h.db`update customer_profiles set sales_org_code='1000',distribution_channel_code='099',distribution_channel_name='SAMPLE New channel' where outlet_id=${store}`;
  const saved = await call("masters/reference/channel-save", {
    id: channel.id,
    baseUpdatedAt: channel.updatedAt,
    name: "SAMPLE Channel renamed",
    reason: "Correct channel name",
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const canonical = await call(
    "customers/reference/distribution-channel?salesOrgCode=1000",
  );
  expect(
    canonical.body.options.find((/** @type {any} */ r) => r.code === "099")
      .name,
  ).toBe("SAMPLE Channel renamed");
  expect(
    (
      await h.db`select distribution_channel_name from customer_profiles where outlet_id=${store}`
    )[0].distribution_channel_name,
  ).toBe("SAMPLE Channel renamed");
  expect(
    (
      await call("masters/reference/channel-save", {
        id: channel.id,
        baseUpdatedAt: channel.updatedAt,
        name: "STALE",
        reason: why,
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call("masters/reference/channel-save", {
        code: "099",
        name: "Duplicate",
        salesOrgCode: "1000",
        reason: why,
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call("masters/reference/channel-save", {
        code: "88",
        name: "No org",
        salesOrgCode: "missing",
        reason: why,
      })
    ).status,
  ).toBe(422);
});
test("place rename/move updates dependent customer parents and automatic territory assignments with historical rows retained", async () => {
  const territories = [];
  for (const [n, city] of ["0101001000", "0201001000"].entries()) {
    const r = await call("territories/create", {
      code: `SAMPLE-T${n}`,
      name: `SAMPLE Territory ${n}`,
      orgUnitId: root,
      effectiveFrom: Date.now(),
      territoryType: "location",
      municipalityCodes: [city],
      reason: why,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    territories.push(r.body);
  }
  const oldAssignment = (
    await h.db`select id from outlet_assignments where outlet_id=${store} and effective_to is null`
  )[0];
  const places = await call("masters/places?kind=barangay&q=SAMPLE");
  const place = places.body.rows[0];
  const key = crypto.randomUUID();
  const body = {
    kind: "barangay",
    code: place.code,
    baseUpdatedAt: place.updatedAt,
    name: "SAMPLE Renamed barangay",
    parentCode: "0201001000",
    reason: why,
  };
  const saved = await call("masters/reference/place-save", body, key);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect((await call("masters/reference/place-save", body, key)).status).toBe(
    200,
  );
  const [p] =
    await h.db`select * from customer_profiles where outlet_id=${store}`;
  expect(p).toMatchObject({
    barangay_name: "SAMPLE Renamed barangay",
    municipality_code: "0201001000",
    province_code: "0201000000",
    region_code: "0200000000",
  });
  const [current] =
    await h.db`select * from outlet_assignments where outlet_id=${store} and effective_to is null`;
  expect(current.territory_id).toBe(territories[1]);
  expect(
    (
      await h.db`select effective_to from outlet_assignments where id=${oldAssignment.id}`
    )[0].effective_to,
  ).not.toBeNull();
  expect(
    (await h.db`select address from outlets where id=${store}`)[0].address,
  ).toContain("SAMPLE Renamed barangay");
  const log = (await call("masters/reference-log?kind=place")).body.rows;
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({
    before: { parentCode: "0101001000", name: "SAMPLE Barangay" },
    after: { parentCode: "0201001000", name: "SAMPLE Renamed barangay" },
    reason: why,
  });
  const territoryLog = (await call("masters/reference-log?kind=territory")).body
    .rows;
  expect(territoryLog).toHaveLength(2);
  expect(territoryLog[0].after.coverage[0].name).toBe("SAMPLE Town B");
  expect(
    (
      await call("masters/reference/place-save", {
        ...body,
        parentCode: "0000000000",
      })
    ).status,
  ).toBe(422);
});
test("province moves cascade municipality region and refuse stale place edits; official-code additions are validated", async () => {
  const province = (
    await call("masters/places?kind=province&q=SAMPLE Province B")
  ).body.rows[0];
  expect(
    (
      await call("masters/reference/place-save", {
        kind: "province",
        code: province.code,
        baseUpdatedAt: province.updatedAt,
        name: province.name,
        parentCode: "0100000000",
        reason: why,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.db`select region_code from ph_municipalities where code='0201001000'`
    )[0].region_code,
  ).toBe("0100000000");
  expect(
    (
      await h.db`select region_code from customer_profiles where outlet_id=${store}`
    )[0].region_code,
  ).toBe("0100000000");
  expect(
    (
      await call("masters/reference/place-save", {
        kind: "province",
        code: province.code,
        baseUpdatedAt: province.updatedAt,
        name: "STALE",
        parentCode: "0200000000",
        reason: why,
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call("masters/reference/place-save", {
        kind: "barangay",
        create: true,
        code: "invalid",
        name: "Invalid",
        parentCode: "0201001000",
        reason: why,
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call("masters/reference/place-save", {
        kind: "barangay",
        create: true,
        code: "0201001002",
        name: "SAMPLE New barangay",
        parentCode: "0201001000",
        reason: why,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call("geography/barangays?municipalityCode=0201001000")
    ).body.options.some((/** @type {any} */ p) => p.code === "0201001002"),
  ).toBe(true);
});
test("realignment refuses protected approved-plan stores without partial place, customer, assignment or history writes", async () => {
  const [assignment] =
    await h.db`select territory_id from outlet_assignments where outlet_id=${store} and effective_to is null`;
  const [plan] =
    await h.db`insert into coverage_plans(organization_id,assignee_profile_id,local_month,version,cycle_type,org_unit_id,requested_from,requested_to,effective_from,effective_to,status,prepared_by,prepared_at,content_revision,created_by,updated_by)
    values('sunpride',${profile},'2026-11',1,'monthly',${root},now(),now()+interval '30 days',now(),now()+interval '30 days','approved','test',now(),1,'test','test') returning id`;
  await h.db`insert into coverage_plan_outlets(plan_id,outlet_id,territory_id,frequency,priority,expected_duration_minutes,content_revision,updated_by) values(${plan.id},${store},${assignment.territory_id},'monthly',1,10,1,'test')`;
  const place = (
    await call("masters/places?kind=barangay&q=SAMPLE Renamed barangay")
  ).body.rows[0];
  const before = await h.db`select count(*)::int n from field_master_changes`;
  const result = await call("masters/reference/place-save", {
    kind: "barangay",
    code: place.code,
    baseUpdatedAt: place.updatedAt,
    name: "SHOULD NOT SAVE",
    parentCode: "0101001000",
    reason: why,
  });
  expect(result.status).toBe(422);
  expect(result.body.error.message).toContain("approved coverage plan");
  expect(
    (
      await h.db`select name,municipality_code from ph_barangays where code=${place.code}`
    )[0],
  ).toEqual({ name: place.name, municipality_code: place.parentCode });
  expect(
    (
      await h.db`select municipality_code from customer_profiles where outlet_id=${store}`
    )[0].municipality_code,
  ).toBe(place.parentCode);
  expect(await h.db`select count(*)::int n from field_master_changes`).toEqual(
    before,
  );
  const rename = await call("masters/reference/place-save", {
    kind: "barangay",
    code: place.code,
    baseUpdatedAt: place.updatedAt,
    name: "SAMPLE Label corrected during approved plan",
    parentCode: place.parentCode,
    reason: "Spelling correction only",
  });
  expect(rename.status, JSON.stringify(rename.body)).toBe(200);
  expect(
    (
      await h.db`select territory_id from outlet_assignments where outlet_id=${store} and effective_to is null`
    )[0].territory_id,
  ).toBe(assignment.territory_id);
  await h.db`update coverage_plans set status='superseded' where id=${plan.id}`;
});
test("reference history pages completely, snapshots actor names and is append-only", async () => {
  for (let n = 0; n < 26; n++)
    expect(
      (
        await call("customer-groups/save", {
          customerGroupId: group,
          name: `SAMPLE Group revision ${n}`,
          reason: `Reason ${n}`,
        })
      ).status,
    ).toBe(200);
  const a = (await call("masters/reference-log?kind=customer_group")).body;
  expect(a.rows).toHaveLength(25);
  expect(a.next).not.toBeNull();
  const b = (
    await call(
      `masters/reference-log?kind=customer_group&cursor=${encodeURIComponent(a.next)}`,
    )
  ).body;
  expect(b.rows).toHaveLength(3);
  expect(b.next).toBeNull();
  expect(new Set([...a.rows, ...b.rows].map((r) => r.id)).size).toBe(28);
  const name = a.rows[0].actorName;
  await h.db`update profiles set name='SAMPLE New actor name' where id=${profile}`;
  expect(
    (await call("masters/reference-log?kind=customer_group")).body.rows[0]
      .actorName,
  ).toBe(name);
  for (const sql of [
    "update field_master_changes set reason='tampered' where id=$1",
    "delete from field_master_changes where id=$1",
  ]) {
    let error;
    try {
      await h.db.unsafe(sql, [a.rows[0].id]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(String(error)).toContain("cannot be changed");
  }
});
test("history cursor retains every change at sub-millisecond boundaries and rejects malformed cursors", async () => {
  await h.db`insert into field_master_changes(kind,record_key,label,reason,actor_profile_id,actor_name,before_value,after_value,created_at)
    select 'group_store','cursor-fixture','SAMPLE precision fixture','Synthetic pagination boundary',${profile},'SAMPLE Admin',null,'{}'::jsonb,
    '2099-01-01T00:00:00Z'::timestamptz+n*interval '1 microsecond' from generate_series(1,26) n`;
  const a = (await call("masters/reference-log?kind=group_store")).body;
  expect(a.rows).toHaveLength(25);
  expect(a.next).toMatch(/\.\d{6}Z\|/);
  const b = (
    await call(
      `masters/reference-log?kind=group_store&cursor=${encodeURIComponent(a.next)}`,
    )
  ).body;
  expect(b.rows).toHaveLength(2);
  expect(new Set([...a.rows, ...b.rows].map((r) => r.id)).size).toBe(27);
  expect(b.next).toBeNull();
  expect(
    (
      await call(
        "masters/reference-log?cursor=1%7C00000000-0000-4000-8000-000000000000",
      )
    ).status,
  ).toBe(422);
});
test("non-admin and regional admins cannot write or read the national change log, including receipt replay", async () => {
  const [unit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from) values('sunpride','SAMPLE-REGION','SAMPLE Region','REGION',${root},'active',now()-interval '1 day') returning id`;
  await h.db`insert into org_unit_parent_edges(unit_id,parent_id,effective_from,actor_subject,reason) values(${unit.id},${root},now()-interval '1 day','test','fixture')`;
  for (const [role, unitId] of [
    ["admin", unit.id],
    ["operations", root],
    ["sales", root],
  ]) {
    const email = `${role}@example.com`;
    const [u] =
      await h.db`insert into users(email,password_hash) values(${email},${await Bun.password.hash("test-only-password")}) returning id`;
    const [p] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,effective_from) values(${u.id},${u.id},'SAMPLE Person',${email},${role},'active',${unitId},now()-interval '1 day') returning id`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unitId},${role},now()-interval '1 day','test','fixture')`;
    const who = await login(email);
    if (role === "admin") {
      // A real national admin can maintain masters, but moving their scope
      // afterwards must refuse even an exact previously successful receipt.
      await h.db`update profiles set org_unit_id=${root} where id=${p.id}`;
      await h.db`update employee_assignments set org_unit_id=${root} where profile_id=${p.id}`;
      const channelBody = {
        code: "REPLAY",
        name: "SAMPLE Admin channel",
        salesOrgCode: "1000",
        reason: why,
      };
      const groupBody = {
        code: "REPLAY",
        name: "SAMPLE Admin group",
        reason: why,
      };
      const channelKey = crypto.randomUUID(),
        groupKey = crypto.randomUUID();
      expect(
        (
          await call(
            "masters/reference/channel-save",
            channelBody,
            channelKey,
            who,
          )
        ).status,
      ).toBe(200);
      expect(
        (await call("customer-groups/save", groupBody, groupKey, who)).status,
      ).toBe(200);
      await h.db`update profiles set org_unit_id=${unitId} where id=${p.id}`;
      await h.db`update employee_assignments set org_unit_id=${unitId} where profile_id=${p.id}`;
      expect(
        (
          await call(
            "masters/reference/channel-save",
            channelBody,
            channelKey,
            who,
          )
        ).status,
      ).toBe(403);
      expect(
        (await call("customer-groups/save", groupBody, groupKey, who)).status,
      ).toBe(403);
    }
    for (const path of [
      "masters/reference-log",
      "masters/channels",
      "masters/places?kind=region",
    ])
      expect((await call(path, undefined, undefined, who)).status).toBe(403);
    expect(
      (
        await call(
          "masters/reference/channel-save",
          { code: "NO", name: "NO", salesOrgCode: "1000", reason: why },
          undefined,
          who,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "customer-groups/save",
          { code: "NO", name: "NO", reason: why },
          undefined,
          who,
        )
      ).status,
    ).toBe(403);
  }
});
