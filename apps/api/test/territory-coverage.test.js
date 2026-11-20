import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";
import { install } from "../src/domains/org/index.js";
import { loadPhGeography } from "../../../packages/db/src/ph-geography.js";
import { outletOwnerUnit } from "../src/domains/org/scope.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let root;
/** @type {any} */ let cookie;
/** @type {any} */ let cebu;
/** @type {any} */ let mandaue;
/** @type {any} */ let lapu;
/** @type {any} */ let guadalupe;
/** @type {any} */ let cityTerritory;
/** @type {any} */ let barangayTerritory;
/** @type {any} */ let groupTerritory;
/** @type {any} */ let group;
/** @type {any[]} */ let stores = [];
/** @param {string} path @param {any} [body] @param {string} [who] */
async function call(path, body, who = cookie) {
  const res = await h.fetch(`/api/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: { cookie: who, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} code @param {any} [fields] */
async function territory(code, fields = {}) {
  const r = await call("territories/create", {
    code,
    name: `SAMPLE ${code}`,
    orgUnitId: root,
    effectiveFrom: Date.now(),
    reason: "SP-0222 synthetic fixture",
    ...fields,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
/** @param {string} id @param {number} [at] */
async function assignment(id, at) {
  const date = at === undefined ? null : new Date(at);
  const rows =
    await h.db`select * from outlet_assignments where outlet_id=${id} and deleted_at is null and effective_from<=coalesce(${date}::timestamptz,clock_timestamp()) and (effective_to is null or effective_to>coalesce(${date}::timestamptz,clock_timestamp()))`;
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0];
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  await loadPhGeography(h.db);
  await h.db`insert into users(email,password_hash) values('boss@example.com',${await Bun.password.hash("test-only-password")})`;
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "boss@example.com",
      password: "test-only-password",
    }),
  });
  cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const me = await h.fetch("/api/me", { headers: { cookie } });
  root = /** @type {any} */ (await me.json()).profile.orgUnitId;
  await h.db`update org_units set effective_from=now()-interval '1 day' where id=${root}`;
  [cebu] =
    await h.db`select * from ph_municipalities where name='City of Cebu'`;
  [mandaue] =
    await h.db`select * from ph_municipalities where name='City of Mandaue'`;
  [lapu] =
    await h.db`select * from ph_municipalities where name='City of Lapu-Lapu'`;
  [guadalupe] =
    await h.db`select * from ph_barangays where municipality_code=${cebu.code} and name='Guadalupe'`;
  for (const [index, place] of [cebu, mandaue, lapu, cebu, null].entries()) {
    const [store] =
      await h.db`insert into outlets(organization_id,code,name,custodian_org_unit_id,status,created_by) values('sunpride',${`SAMPLE-${index}`},${`SAMPLE store ${index}`},${root},'active','test') returning *`;
    if (place)
      await h.db`insert into customer_profiles(outlet_id,municipality_code,barangay_code,updated_by) values(${store.id},${place.code},${index === 0 ? guadalupe.code : null},'test')`;
    stores.push(store);
  }
}, 30000);
afterAll(async () => {
  if (h) await h.close();
});

test("legacy territories default to Location without coverage; manual assignments remain manual", async () => {
  const legacy = await territory("LEGACY");
  const r = await call(`territories/detail?territoryId=${legacy}`);
  expect(r.body.territory.territoryType).toBe("location");
  expect(r.body.coverage).toEqual([]);
  const [row] =
    await h.db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason) values(${stores[4].id},${legacy},now()-interval '1 second','test','Existing manual') returning *`;
  expect(row.assignment_source).toBe("manual");
});
test("upgrade gives eight existing territories Location with no places and preserves manual assignments", async () => {
  const sql = await Bun.file(
    new URL(
      "../../../packages/db/migrations/0835_territory_coverage.sql",
      import.meta.url,
    ),
  ).text();
  const typeSql = sql.match(
    /alter table territories add column territory_type[\s\S]*?;/,
  )?.[0];
  const sourceSql = sql.match(
    /alter table outlet_assignments add column assignment_source[\s\S]*?;/,
  )?.[0];
  if (!typeSql || !sourceSql) throw new Error("Migration statements missing");
  let checked = false;
  try {
    await h.db.begin(async (t) => {
      for (let n = 1; n <= 8; n++)
        await t`insert into territories(organization_id,code,name,status,effective_from,created_by) values('sunpride',${`UPGRADE-${n}`},'Existing territory','active',now()-interval '1 day','test')`;
      const before =
        await t`select id,outlet_id,territory_id,effective_from,effective_to from outlet_assignments order by id`;
      await t`alter table territories drop column territory_type`;
      await t`alter table outlet_assignments drop column assignment_source`;
      await t.unsafe(typeSql);
      await t.unsafe(sourceSql);
      const rows =
        await t`select territory_type from territories where code like 'UPGRADE-%'`;
      expect(rows).toHaveLength(8);
      expect(
        rows.every((/** @type {any} */ r) => r.territory_type === "location"),
      ).toBe(true);
      expect(
        await t`select id,outlet_id,territory_id,effective_from,effective_to from outlet_assignments order by id`,
      ).toEqual(before);
      expect(
        (
          await t`select id from outlet_assignments where assignment_source<>'manual'`
        ).length,
      ).toBe(0);
      expect(
        (
          await t`select c.id from territory_coverage c join territories t on t.id=c.territory_id where t.code like 'UPGRADE-%'`
        ).length,
      ).toBe(0);
      checked = true;
      throw new Error("Rollback upgrade fixture");
    });
  } catch (error) {
    if (/** @type {Error} */ (error).message !== "Rollback upgrade fixture")
      throw error;
  }
  expect(checked).toBe(true);
});

test("Location covers Cebu, Mandaue and Lapu-Lapu; persisted rosters and owner agree", async () => {
  cityTerritory = await territory("CEBU-CITIES", {
    territoryType: "location",
    municipalityCodes: [cebu.code, mandaue.code, lapu.code],
    barangayCodes: [],
    customerGroupIds: [],
  });
  const r = await call(`territories/detail?territoryId=${cityTerritory}`);
  expect(r.body.coverage.map((/** @type {any} */ x) => x.name).sort()).toEqual(
    [cebu.name, mandaue.name, lapu.name].sort(),
  );
  for (const s of stores.slice(0, 4)) {
    expect((await assignment(s.id)).territory_id).toBe(cityTerritory);
    expect(await outletOwnerUnit(h.db, s.id, Date.now())).toBe(root);
  }
  expect(
    (await call(`outlets/list?territoryId=${cityTerritory}`)).body.page,
  ).toHaveLength(4);
  expect(
    (
      await call(
        `outlets/assignments/territory-roster?territoryId=${cityTerritory}`,
      )
    ).body,
  ).toHaveLength(4);
});
test("a barangay exception wins over the whole city, and removing it returns stores to city coverage", async () => {
  barangayTerritory = await territory("GUADALUPE", {
    territoryType: "location",
    barangayCodes: [guadalupe.code],
  });
  expect((await assignment(stores[0].id)).territory_id).toBe(barangayTerritory);
  expect((await assignment(stores[3].id)).territory_id).toBe(cityTerritory);
  const r = await call("territories/edit", {
    territoryId: barangayTerritory,
    name: "SAMPLE GUADALUPE",
    territoryType: "location",
    barangayCodes: [],
    reason: "Remove exception",
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect((await assignment(stores[0].id)).territory_id).toBe(cityTerritory);
});
test("duplicate places and groups refuse in plain words naming the other territory, atomically and concurrently", async () => {
  const r = await call("territories/create", {
    code: "CONFLICT",
    name: "SAMPLE conflict",
    orgUnitId: root,
    effectiveFrom: Date.now(),
    reason: "Duplicate",
    territoryType: "location",
    municipalityCodes: [cebu.code],
  });
  expect(r.status).toBe(422);
  expect(r.body.error.message).toContain("SAMPLE CEBU-CITIES");
  expect(
    (await h.db`select id from territories where code='CONFLICT'`).length,
  ).toBe(0);
  const [place] =
    await h.db`select code from ph_municipalities where name='City of Talisay' order by code limit 1`;
  const results = await Promise.all(
    [1, 2].map((n) =>
      call("territories/create", {
        code: `RACE${n}`,
        name: `SAMPLE Race ${n}`,
        orgUnitId: root,
        effectiveFrom: Date.now(),
        reason: "Race",
        territoryType: "location",
        municipalityCodes: [place.code],
      }),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
});
test("Customer groups link stores across cities; group coverage wins over location and unlink falls back", async () => {
  const g = await call("customer-groups/save", {
    code: "GAISANO",
    name: "SAMPLE Gaisano",
    reason: "Group",
  });
  expect(g.status).toBe(200);
  group = g.body;
  const link = await call("customer-groups/link-stores", {
    customerGroupId: group,
    outletIds: [stores[0].id, stores[2].id],
    reason: "North and south",
  });
  expect(link.status).toBe(200);
  groupTerritory = await territory("KEY-ACCOUNT", {
    territoryType: "customer_group",
    customerGroupIds: [group],
    channel: "Food Service",
  });
  expect((await assignment(stores[0].id)).territory_id).toBe(groupTerritory);
  expect((await assignment(stores[2].id)).territory_id).toBe(groupTerritory);
  expect(
    (await call(`outlets/list?customerGroupId=${group}`)).body.page,
  ).toHaveLength(2);
  const dup = await call("territories/edit", {
    territoryId: barangayTerritory,
    name: "SAMPLE GUADALUPE",
    territoryType: "customer_group",
    customerGroupIds: [group],
    reason: "Duplicate group",
  });
  expect(dup.status).toBe(422);
  expect(dup.body.error.message).toContain("SAMPLE KEY-ACCOUNT");
  expect(
    (
      await call("customer-groups/link-stores", {
        outletIds: [stores[2].id],
        reason: "Unlink",
      })
    ).status,
  ).toBe(200);
  expect((await assignment(stores[2].id)).territory_id).toBe(cityTerritory);
});
test("manual assignment wins before and after place/group changes; future override starts only at its effective time", async () => {
  const at = Date.now() + 1000;
  const r = await call("outlets/assignments/assign", {
    outletId: stores[0].id,
    territoryId: cityTerritory,
    effectiveFrom: at,
    reason: "Manual override",
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect((await assignment(stores[0].id, at - 1)).territory_id).toBe(
    groupTerritory,
  );
  expect((await assignment(stores[0].id, at + 1)).assignment_source).toBe(
    "manual",
  );
  await h.db`update customer_profiles set municipality_code=${lapu.code},barangay_code=null where outlet_id=${stores[0].id}`;
  expect((await assignment(stores[0].id, at + 1)).territory_id).toBe(
    cityTerritory,
  );
  expect((await assignment(stores[0].id, at - 1)).territory_id).toBe(
    groupTerritory,
  );
});
test("new/changed customer geography automatically updates membership; repeat refresh makes no assignment churn", async () => {
  await h.db`update customer_profiles set municipality_code=null,barangay_code=null where outlet_id=${stores[1].id}`;
  expect(await assignment(stores[1].id)).toBeUndefined();
  await h.db`update customer_profiles set municipality_code=${cebu.code} where outlet_id=${stores[1].id}`;
  expect((await assignment(stores[1].id)).territory_id).toBe(cityTerritory);
  const before =
    await h.db`select id from outlet_assignments where outlet_id=${stores[1].id}`;
  await h.db`select refresh_all_territory_coverage()`;
  expect(
    await h.db`select id from outlet_assignments where outlet_id=${stores[1].id}`,
  ).toEqual(before);
  const [s] =
    await h.db`insert into outlets(organization_id,code,name,custodian_org_unit_id,status,created_by) values('sunpride','SAMPLE-NEW','SAMPLE New',${root},'active','test') returning id`;
  await h.db`insert into customer_profiles(outlet_id,municipality_code,updated_by) values(${s.id},${mandaue.code},'test')`;
  expect((await assignment(s.id)).territory_id).toBe(cityTerritory);
});
test("future and bounded territories activate/end on their dates and automatically fall back", async () => {
  const from = Date.now() + 60000,
    to = from + 60000;
  const t = await territory("BOUNDED", {
    territoryType: "location",
    barangayCodes: [guadalupe.code],
    effectiveFrom: from,
    effectiveTo: to,
  });
  await h.db`update customer_profiles set barangay_code=${guadalupe.code},municipality_code=${cebu.code} where outlet_id=${stores[3].id}`;
  expect((await assignment(stores[3].id, from - 1)).territory_id).toBe(
    cityTerritory,
  );
  expect((await assignment(stores[3].id, from)).territory_id).toBe(t);
  expect((await assignment(stores[3].id, to)).territory_id).toBe(cityTerritory);
});
test("Setup health includes stores without both place and group, even with a manual territory", async () => {
  const r = await call("org/setup-health");
  const item = r.body.items.find(
    (/** @type {any} */ i) => i.key === "coverage",
  );
  const missing = await call(
    "outlets/list?missingCoverage=true&status=active&limit=100",
  );
  expect(item.count).toBe(missing.body.page.length);
  expect(missing.body.page.map((/** @type {any} */ s) => s.id)).toContain(
    stores[4].id,
  );
  expect(item.href).toContain("missingCoverage=true");
});
test("invalid type, mixed selections, missing geography and duplicate choices refuse without partial writes", async () => {
  for (const fields of [
    { territoryType: "other" },
    { territoryType: "location", customerGroupIds: [group] },
    { territoryType: "customer_group", municipalityCodes: [cebu.code] },
    { territoryType: "location", municipalityCodes: ["0000000000"] },
    { territoryType: "location", municipalityCodes: [cebu.code, cebu.code] },
  ]) {
    const r = await call("territories/edit", {
      territoryId: barangayTerritory,
      name: "SHOULD NOT SAVE",
      reason: "Invalid",
      ...fields,
    });
    expect(r.status).toBe(422);
  }
  expect(
    (await call(`territories/detail?territoryId=${barangayTerritory}`)).body
      .territory.name,
  ).toBe("SAMPLE GUADALUPE");
});
test("search pages the loaded Philippine list and customer groups beyond the first page", async () => {
  const city = await call("territories/places?q=Cebu&kind=municipality");
  expect(city.body.options.map((/** @type {any} */ r) => r.code)).toContain(
    cebu.code,
  );
  const barangay = await call("territories/places?q=Guadalupe&kind=barangay");
  expect(barangay.body.options.map((/** @type {any} */ r) => r.code)).toContain(
    guadalupe.code,
  );
  const first = await call("territories/places?q=San&kind=barangay");
  expect(first.body.hasMore).toBe(true);
  const second = await call("territories/places?q=San&kind=barangay&offset=50");
  expect(second.body.options.length).toBeGreaterThan(0);
  expect(second.body.options[0].code).not.toBe(first.body.options[0].code);
  await call("customer-groups/save", {
    code: "SM",
    name: "SAMPLE SM",
    reason: "Second group",
  });
  const a = await call("customer-groups/list?limit=1");
  expect(a.body.isDone).toBe(false);
  const b = await call(`customer-groups/list?limit=1&cursor=${a.body.next}`);
  expect(b.body.page[0].id).not.toBe(a.body.page[0].id);
});
test("national-only coverage/group changes and ordinary scope/salesperson rules stay enforced", async () => {
  const [unit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from) values('sunpride','REGION','SAMPLE region','REGION',${root},'active',now()-interval '1 day') returning id`;
  await h.db`insert into org_unit_parent_edges(unit_id,parent_id,effective_from,actor_subject,reason) values(${unit.id},${root},now()-interval '1 day','test','Fixture')`;
  const [u] =
    await h.db`insert into users(email,password_hash) values('regional@example.com',${await Bun.password.hash("test-only-password")}) returning id`;
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,effective_from) values(${u.id},${u.id},'Regional','regional@example.com','admin','active',${unit.id},now()-interval '1 day') returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit.id},'admin',now()-interval '1 day','test','Fixture')`;
  const res = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "regional@example.com",
      password: "test-only-password",
    }),
  });
  const regional = res.headers.get("set-cookie")?.split(";")[0];
  expect(
    (
      await call(
        "customer-groups/save",
        { code: "NO", name: "No", reason: "No" },
        regional,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        "customer-groups/link-stores",
        { customerGroupId: group, outletIds: [stores[4].id], reason: "No" },
        regional,
      )
    ).status,
  ).toBe(403);
  const places =
    await h.db`select m.code from ph_municipalities m where not exists(select 1 from territory_coverage c where c.municipality_code=m.code) and not exists(select 1 from customer_profiles p where p.municipality_code=m.code) order by code limit 2`;
  const [foreign] =
    await h.db`insert into outlets(organization_id,code,name,custodian_org_unit_id,status,created_by) values('sunpride','FOREIGN-COVERAGE','SAMPLE Foreign coverage',${root},'active','test') returning id`;
  await h.db`insert into customer_profiles(outlet_id,municipality_code,updated_by) values(${foreign.id},${places[0].code},'test')`;
  expect(
    (
      await call(
        "territories/create",
        {
          code: "NO",
          name: "No",
          orgUnitId: unit.id,
          effectiveFrom: Date.now(),
          territoryType: "location",
          municipalityCodes: [places[0].code],
          reason: "No",
        },
        regional,
      )
    ).status,
  ).toBe(403);
  const own = await call(
    "territories/create",
    {
      code: "REGIONAL",
      name: "SAMPLE Regional coverage",
      orgUnitId: unit.id,
      effectiveFrom: Date.now(),
      territoryType: "location",
      municipalityCodes: [places[1].code],
      reason: "Own branch",
    },
    regional,
  );
  expect(own.status, JSON.stringify(own.body)).toBe(200);
  expect(
    (
      await call(
        `territories/detail?territoryId=${own.body}`,
        undefined,
        regional,
      )
    ).body.coverage,
  ).toHaveLength(1);
  expect(
    (
      await call(
        `territories/detail?territoryId=${cityTerritory}`,
        undefined,
        regional,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call("territories/assignSalesperson", {
        territoryId: cityTerritory,
        profileId: p.id,
        effectiveFrom: Date.now() + 1000,
        reason: "wrong hierarchy",
      })
    ).status,
  ).toBe(200); // root owns child hierarchy, unchanged
  const [audit] =
    await h.db`select action from audit_logs where action='customer-groups.link-stores' limit 1`;
  expect(audit.action).toBe("customer-groups.link-stores");
});
