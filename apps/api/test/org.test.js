import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarness, deviceKey } from "./harness.js";
import { install } from "../src/domains/org/index.js";
import { identityHooks } from "../src/domains/org/identity.js";
import {
  scopeFilterForActor,
  outletOwnerUnit,
  topology,
} from "../src/domains/org/scope.js";
import { capabilitiesFor } from "../src/core/capabilities.js";
import { actorFor } from "../src/core/context.js";
import { convertQuantity } from "../src/domains/org/catalog.js";
import { writeAudit } from "../src/domains/org/audit.js";
import { runDueJobs } from "../src/core/jobs.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { canSubscribe } from "../src/core/hooks.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let boss;
/** @type {any} */ let manager;
/** @type {any} */ let sales;
/** @type {any} */ let admin;
/** @type {any} */ let other;
/** @type {any} */ let regionA;
/** @type {any} */ let regionB;
/** @type {any} */ let root;
/** @type {any} */ let territory;
/** @type {any} */ let route;
/** @type {any} */ let outlet;
const password = "test-only-correct-horse";
/** @param {string} name @param {string} role @param {string|null} unit */
async function person(name, role, unit) {
  const email = `${name}-${crypto.randomUUID()}@example.com`;
  const [user] =
    await h.db`insert into users(email,password_hash) values(${email},${await Bun.password.hash(password)}) returning id`;
  const [profile] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,effective_from) values(${user.id},${user.id},${name},${email},${role},'active',${unit},now()-interval '1 day') returning *`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${profile.id},${unit},${role},now()-interval '1 day','system:test','fixture')`;
  const res = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return {
    userId: user.id,
    profileId: profile.id,
    email,
    cookie: res.headers.get("set-cookie")?.split(";")[0],
    role,
    orgUnitId: unit,
    subject: user.id,
    capabilities: new Set(capabilitiesFor(role)),
    name,
    scopeEpoch: null,
  };
}
/** @param {string} path @param {any} [who] @param {any} [body] @param {string} [key] */
async function call(path, who = boss, body, key) {
  const res = await h.fetch(`/api/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      cookie: who?.cookie ?? "",
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} label @param {string} parent */
async function unit(label, parent) {
  const [u] =
    await h.db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from) values('sunpride',${label},${label},'REGION',${parent},'active',now()-interval '1 day') returning *`;
  await h.db`insert into org_unit_parent_edges(unit_id,parent_id,effective_from,actor_subject,reason) values(${u.id},${parent},now()-interval '1 day','system:test','fixture')`;
  return u;
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  const [user] =
    await h.db`insert into users(email,password_hash) values('boss@example.com',${await Bun.password.hash(password)}) returning id`;
  const signin = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "boss@example.com", password }),
  });
  boss = {
    cookie: signin.headers.get("set-cookie")?.split(";")[0],
    userId: user.id,
  };
  const me = await h.fetch("/api/me", { headers: { cookie: boss.cookie } });
  const body = /** @type {any} */ (await me.json());
  expect(body.profile.role).toBe("super_admin");
  root = body.profile.orgUnitId;
  boss.profileId = body.profile.id;
  // Fixtures can predate first login, but root must cover their interval.
  await h.db`update org_units set effective_from=now()-interval '2 days' where id=${root}`;
  regionA = await unit("REGION_A", root);
  regionB = await unit("REGION_B", root);
  manager = await person("Manager", "manager", regionA.id);
  sales = await person("Seller", "sales", regionA.id);
  admin = await person("Admin", "admin", regionA.id);
  other = await person("Other", "manager", regionB.id);
  const [t] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by) values('sunpride','CEBU','Cebu territory','active',now()-interval '1 day','system:test') returning *`;
  territory = t;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${t.id},${regionA.id},now()-interval '1 day','system:test','fixture')`;
  await h.db`insert into territory_salespeople(territory_id,profile_id,kind,effective_from,actor_subject,reason) values(${t.id},${sales.profileId},'primary',now()-interval '1 day','system:test','fixture')`;
  const [r] =
    await h.db`insert into routes(organization_id,code,name,status,effective_from,created_by) values('sunpride','MON','Monday route','active',now()-interval '1 day','system:test') returning *`;
  route = r;
  await h.db`insert into route_territories(route_id,territory_id,effective_from,actor_subject,reason) values(${r.id},${t.id},now()-interval '1 day','system:test','fixture')`;
  const [o] =
    await h.db`insert into outlets(organization_id,code,name,custodian_org_unit_id,status,created_by) values('sunpride','STORE1','First store',${regionA.id},'active','system:test') returning *`;
  outlet = o;
}, 30000);
afterAll(async () => {
  if (h) await h.close();
});

describe("ORG identity hooks", () => {
  test("bootstrap provisions one super admin at root through a real /api/me", async () => {
    const hooks = identityHooks(h.env);
    const a = await hooks.loadProfile(h.db, boss.userId);
    const b = await hooks.loadProfile(h.db, boss.userId);
    expect(a?.role).toBe("super_admin");
    expect(a?.orgUnitId).toBe(root);
    expect(a?.id).toBe(b?.id);
    const [count] =
      await h.db`select count(*)::int as n from employee_assignments where profile_id=${a?.id}`;
    expect(count.n).toBe(1);
  });
  test("pending invitation provisions its role, position and unit and accepts exactly once", async () => {
    const email = `invite-${crypto.randomUUID()}@example.com`;
    await h.db`insert into access_invitations(email,name,role,status,invited_by,invited_at,org_unit_id) values(${email},'Invited agent','sales','pending','system:test',now(),${regionA.id})`;
    const [u] =
      await h.db`insert into users(email,password_hash) values(${email},'not-a-login-hash') returning id`;
    const hooks = identityHooks(h.env);
    expect(await hooks.isEmailInvited(h.db, email)).toBe(true);
    const profile = await hooks.loadProfile(h.db, u.id);
    expect(profile?.role).toBe("sales");
    expect(profile?.orgUnitId).toBe(regionA.id);
    const [row] =
      await h.db`select status,profile_id from access_invitations where email=${email}`;
    expect(row.status).toBe("accepted");
    expect(row.profile_id).toBe(profile?.id);
    expect(await hooks.isEmailInvited(h.db, email)).toBe(false);
  });
  test("SP-0168: a pre-provisioned profile links on first sign-in, accepts its invitation and fills reports' supervisor subject", async () => {
    const tag = crypto.randomUUID();
    const bossEmail = `lead-${tag}@example.com`;
    const repEmail = `rep-${tag}@example.com`;
    const [lead] =
      await h.db`insert into profiles(name,email,role,status,org_unit_id,effective_from) values('Lead',${bossEmail},'manager','active',${regionA.id},now()-interval '1 day') returning *`;
    const [rep] =
      await h.db`insert into profiles(name,email,role,status,org_unit_id,effective_from) values('Rep',${repEmail},'sales','active',${regionA.id},now()-interval '1 day') returning *`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${lead.id},${regionA.id},'manager',now()-interval '1 day','system:test','fixture')`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,supervisor_id,effective_from,actor_subject,reason) values(${rep.id},${regionA.id},'sales',${lead.id},now()-interval '1 day','system:test','fixture')`;
    await h.db`insert into access_invitations(email,name,role,status,invited_by,invited_at,org_unit_id) values(${bossEmail},'Lead','manager','pending','system:test',now(),${regionA.id})`;
    const [u] =
      await h.db`insert into users(email,password_hash) values(${bossEmail},'not-a-login-hash') returning id`;
    const hooks = identityHooks(h.env);
    expect(await hooks.isEmailInvited(h.db, bossEmail)).toBe(true);
    const profile = await hooks.loadProfile(h.db, u.id);
    expect(profile?.id).toBe(lead.id);
    const [inv] =
      await h.db`select status,profile_id from access_invitations where email=${bossEmail}`;
    expect(inv).toMatchObject({ status: "accepted", profile_id: lead.id });
    const [after] =
      await h.db`select supervisor_subject from profiles where id=${rep.id}`;
    expect(after.supervisor_subject).toBe(u.id);
  });
  test("uninvited identity returns null; revoked and disabled profiles never reactivate on read", async () => {
    const [u] =
      await h.db`insert into users(email,password_hash) values(${`unknown-${crypto.randomUUID()}@example.com`},'not-a-login-hash') returning id`;
    const hooks = identityHooks(h.env);
    expect(await hooks.loadProfile(h.db, u.id)).toBeNull();
    const inactive = await person("Disabled", "viewer", regionA.id);
    await h.db`update profiles set status='disabled' where id=${inactive.profileId}`;
    expect(await hooks.loadProfile(h.db, inactive.userId)).toBeNull();
    expect(await actorFor(h.db, inactive.userId)).toBeNull();
  });
});

describe("ORG scope and tree", () => {
  test("current subtree excludes sibling and scope remains current for historical tree", async () => {
    expect((await scopeFilterForActor(h.db, manager)).unitIds).toEqual([
      regionA.id,
    ]);
    const r = await call(`org/tree?asOf=${Date.now()}`, manager);
    expect(r.status).toBe(200);
    expect(r.body.map((/** @type {any} */ x) => x.id)).toEqual([regionA.id]);
    expect(
      (await scopeFilterForActor(h.db, { ...manager, role: "analyst" }))
        .unitIds,
    ).toBeNull();
  });
  test("org create enforces prospective dates, level and scope; name edit preserves code", async () => {
    const b = {
      parentId: regionA.id,
      typeCode: "AREA",
      code: "AREA1",
      name: "Area one",
      effectiveFrom: Date.now() + 60000,
      reason: "Grow coverage",
    };
    expect((await call("org/create", manager, b)).status).toBe(403);
    expect(
      (
        await call("org/create", boss, {
          ...b,
          effectiveFrom: Date.now() - 1000,
        })
      ).status,
    ).toBe(422);
    expect(
      (await call("org/create", boss, { ...b, typeCode: "NATIONAL" })).status,
    ).toBe(422);
    const created = await call("org/create", boss, b, "create-area");
    expect(created.status).toBe(200);
    expect((await call("org/create", boss, b, "create-area")).body).toBe(
      created.body,
    );
    expect(
      (await call("org/create", boss, { ...b, name: "Other" }, "create-area"))
        .status,
    ).toBe(409);
    const [u] =
      await h.db`select code,name from org_units where id=${created.body}`;
    expect(u.name).toBe("Area one");
    expect(u.code).toBe("AREA1");
    const before = await topology(h.db);
    const after = await topology(h.db, b.effectiveFrom);
    expect(before.some((x) => x.id === created.body)).toBe(false);
    expect(after.some((x) => x.id === created.body)).toBe(true);
    expect(
      (
        await call("org/edit", boss, {
          unitId: created.body,
          name: "Area renamed",
          reason: "Name corrected",
        })
      ).status,
    ).toBe(200);
  });
  test("reparent keeps historical edge and denies cycles and root retirement", async () => {
    const from = Date.now() + 120000;
    expect(
      (
        await call("org/reparent", boss, {
          unitId: regionA.id,
          parentId: regionA.id,
          effectiveFrom: from,
          reason: "bad",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("org/deactivate", boss, {
          unitId: root,
          effectiveTo: from,
          reason: "bad",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("org/deactivate", admin, {
          unitId: regionB.id,
          effectiveTo: from,
          reason: "bad",
        })
      ).status,
    ).toBe(403);
  });
});

describe("people, invitations and teams", () => {
  test("assignment appends history, denies supervisor cycle and admin escalation", async () => {
    const b = {
      profileId: sales.profileId,
      orgUnitId: regionA.id,
      role: "sales",
      employeeCode: "EMP1",
      reason: "Assigned",
    };
    expect(
      (
        await call("people/assign", admin, {
          ...b,
          supervisorId: sales.profileId,
        })
      ).status,
    ).toBe(422);
    expect(
      (await call("people/assign", admin, { ...b, role: "admin" })).status,
    ).toBe(403);
    expect((await call("people/assign", admin, b)).status).toBe(200);
    const [p] = await h.db`select * from profiles where id=${sales.profileId}`;
    expect(p.employee_code).toBe("EMP1");
    const rows = await call(
      `people/history?profileId=${sales.profileId}`,
      manager,
    );
    expect(rows.body.length).toBe(2);
    expect(
      (await call("people/assign", admin, { ...b, employeeCode: "EMP2" }))
        .status,
    ).toBe(422);
    expect(
      (await call(`people/history?profileId=${sales.profileId}`, other)).status,
    ).toBe(403);
  });
  test("IP-INT2 ask 6: the office keeps a staff phone number on the same assignment screen; bad numbers and non-admins are refused", async () => {
    const b = {
      profileId: sales.profileId,
      orgUnitId: regionA.id,
      role: "sales",
      reason: "Phone number",
    };
    expect((await call("people/assign", admin, { ...b, phone: "0917 123 4567" })).status).toBe(200);
    const [p] = await h.db`select phone from profiles where id=${sales.profileId}`;
    expect(p.phone).toBe("0917 123 4567");
    const detail = await call(`people/detail?profileId=${sales.profileId}`, admin);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).toContain("0917 123 4567");
    const bad = await call("people/assign", admin, { ...b, phone: "call me maybe" });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain("digits only");
    expect((await call("people/assign", manager, { ...b, phone: "0999 111 2222" })).status).toBe(403);
    // an assignment that does not mention the phone leaves it alone; blank clears it
    expect((await call("people/assign", admin, b)).status).toBe(200);
    expect((await h.db`select phone from profiles where id=${sales.profileId}`)[0].phone).toBe("0917 123 4567");
    expect((await call("people/assign", admin, { ...b, phone: "" })).status).toBe(200);
    expect((await h.db`select phone from profiles where id=${sales.profileId}`)[0].phone).toBeNull();
  });
  test("national invitation command accepts unit, but scoped admin cannot invite", async () => {
    const b = {
      email: "new-office-agent@example.com",
      role: "sales",
      name: "New agent",
      orgUnitId: regionA.id,
    };
    expect((await call("people/invite", admin, b)).status).toBe(403);
    const result = await call("people/invite", boss, b);
    expect(result.status).toBe(200);
    expect(
      (await call("people/revoke", boss, { invitationId: result.body })).status,
    ).toBe(200);
    const [r] =
      await h.db`select status from access_invitations where id=${result.body}`;
    expect(r.status).toBe("revoked");
  });
  test("team membership is effective dated, nonoverlapping and hierarchy limited", async () => {
    const from = Date.now() + 2000;
    const team = await call("org/teams/create", boss, {
      code: "TEAM1",
      name: "Cebu team",
      orgUnitId: regionA.id,
      effectiveFrom: from,
      reason: "Organize team",
    });
    expect(team.status).toBe(200);
    const b = {
      teamId: team.body,
      profileId: sales.profileId,
      effectiveFrom: from + 1000,
      reason: "Join",
    };
    expect((await call("org/teams/addMember", boss, b)).status).toBe(200);
    expect((await call("org/teams/addMember", boss, b)).status).toBe(422);
    expect(
      (
        await call("org/teams/addMember", boss, {
          ...b,
          profileId: other.profileId,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("org/teams/removeMember", boss, {
          teamId: team.body,
          profileId: sales.profileId,
          effectiveTo: from + 2000,
          reason: "Move team",
        })
      ).status,
    ).toBe(200);
    const detail = await call(
      `org/teams/detail?teamId=${team.body}&asOf=${from + 1500}`,
    );
    expect(detail.body.members.length).toBe(1);
  });
});

describe("territories, routes and outlet assignments", () => {
  test("creates prospective territory and route with bounded owner validation and deny", async () => {
    const from = Date.now() + 5000;
    const t = await call("territories/create", boss, {
      code: "NEW_T",
      name: "New territory",
      orgUnitId: regionA.id,
      effectiveFrom: from,
      reason: "Expansion",
    });
    expect(t.status).toBe(200);
    expect(
      (
        await call("territories/create", sales, {
          code: "BAD",
          name: "Bad",
          orgUnitId: regionA.id,
          effectiveFrom: from,
          reason: "Bad",
        })
      ).status,
    ).toBe(403);
    const r = await call("territories/routes/create", boss, {
      code: "NEW_R",
      name: "New route",
      territoryId: territory.id,
      effectiveFrom: from,
      weekdayTemplate: [1, 3],
      cycleDays: 7,
      reason: "Coverage",
    });
    expect(r.status).toBe(200);
    expect(
      (
        await call("territories/routes/create", boss, {
          code: "BAD_R",
          name: "Bad",
          territoryId: territory.id,
          effectiveFrom: from,
          weekdayTemplate: [0],
          reason: "Bad",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("territories/routes/assignSalesperson", boss, {
          routeId: route.id,
          profileId: sales.profileId,
          effectiveFrom: from,
          primary: true,
          reason: "Salesperson",
        })
      ).status,
    ).toBe(200);
  });
  test("outlet batch assignment rejects sequence collisions and foreign scope atomically", async () => {
    const from = Date.now() + 60000;
    const first = await call("outlets/assignments/assign", boss, {
      outletId: outlet.id,
      territoryId: territory.id,
      routeId: route.id,
      sequence: 1,
      effectiveFrom: from,
      reason: "Set stops",
    });
    expect(first.status).toBe(200);
    expect(await outletOwnerUnit(h.db, outlet.id, from + 1)).toBe(regionA.id);
    const [o2] =
      await h.db`insert into outlets(organization_id,code,name,custodian_org_unit_id,status,created_by) values('sunpride','STORE2','Second store',${regionA.id},'active','system:test') returning id`;
    expect(
      (
        await call("outlets/assignments/assign", boss, {
          outletId: o2.id,
          territoryId: territory.id,
          routeId: route.id,
          sequence: 1,
          effectiveFrom: from,
          reason: "Conflict",
        })
      ).status,
    ).toBe(422);
    const [foreign] =
      await h.db`insert into outlets(organization_id,code,name,custodian_org_unit_id,status,created_by) values('sunpride','FOREIGN','Foreign',${regionB.id},'active','system:test') returning id`;
    const batch = await call("outlets/assignments/batchAssign", admin, {
      assignments: [
        {
          outletId: o2.id,
          territoryId: territory.id,
          routeId: route.id,
          sequence: 2,
        },
        { outletId: foreign.id, territoryId: territory.id },
      ],
      effectiveFrom: from,
      reason: "Batch",
    });
    expect(batch.status).toBe(403);
    const [count] =
      await h.db`select count(*)::int as n from outlet_assignments where outlet_id=${o2.id}`;
    expect(count.n).toBe(0);
  });
  test("lists search and page before LIMIT with no hidden first-50 truncation", async () => {
    const r = await call("outlets/list?q=First&limit=1", manager);
    expect(r.status).toBe(200);
    expect(r.body.page.length).toBe(1);
    expect(r.body.page[0].name).toBe("First store");
    const a = await call("outlets/list?limit=1");
    expect(a.body.next).toBeTruthy();
    const b = await call(`outlets/list?limit=1&cursor=${a.body.next}`);
    expect(a.body.page[0].id).not.toBe(b.body.page[0].id);
    expect((await call("outlets/list?cursor=broken")).status).toBe(400);
    const scoped = await call("outlets/list?q=Foreign", manager);
    expect(scoped.body.page).toEqual([]);
  });
});

describe("pin verification, catalog and standards", () => {
  test("pin needs valid coordinates and a different verifier; history remains intact", async () => {
    const p = {
      outletId: outlet.id,
      latitude: 10.3,
      longitude: 123.9,
      radiusMeters: 75,
      source: "office",
      reason: "Store entrance",
      effectiveFrom: Date.now() + 1000,
    };
    expect(
      (await call("outlets/pins/propose", boss, { ...p, latitude: 100 }))
        .status,
    ).toBe(422);
    const pin = await call("outlets/pins/propose", boss, p);
    expect(pin.status).toBe(200);
    expect(
      (
        await call("outlets/pins/decide", boss, {
          pinId: pin.body,
          decision: "verified",
          reason: "Checked",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("outlets/pins/decide", other, {
          pinId: pin.body,
          decision: "verified",
          reason: "Checked",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("outlets/pins/decide", manager, {
          pinId: pin.body,
          decision: "verified",
          reason: "Checked",
        })
      ).status,
    ).toBe(200);
    const [audit] =
      await h.db`select details from audit_logs where entity_id=${pin.body} order by created_at desc limit 1`;
    expect(audit.details).not.toContain("10.3");
    const pinRows = await call(
      `outlets/pin-history?outletId=${outlet.id}`,
      manager,
    );
    expect(
      pinRows.body.some((/** @type {any} */ r) => r.status === "verified"),
    ).toBe(true);
  });
  test("catalog UOM conversion is exact, national-only and barcode uniqueness is enforced", async () => {
    const pcs = await call("catalog/saveUom", boss, {
      code: "PCS",
      name: "Pieces",
      dimension: "count",
      decimalPlaces: 0,
      reason: "Unit",
    });
    expect(pcs.status).toBe(200);
    const cases = await call("catalog/saveUom", boss, {
      code: "CASE",
      name: "Cases",
      dimension: "count",
      decimalPlaces: 0,
      reason: "Unit",
    });
    expect(cases.status).toBe(200);
    const product = await call("catalog/saveProduct", boss, {
      code: "SKU1",
      name: "Sample meat",
      category: "Sample",
      baseUomId: pcs.body,
      sellingUomIds: [pcs.body, cases.body],
      quantityScale: 1,
      reason: "Catalog",
    });
    expect(product.status).toBe(200);
    const conversion = await call("catalog/saveConversion", boss, {
      productId: product.body,
      fromUomId: cases.body,
      toUomId: pcs.body,
      numerator: 24,
      denominator: 1,
      effectiveFrom: Date.now() + 1000,
      reason: "Pack size",
    });
    expect(conversion.status).toBe(200);
    expect(
      convertQuantity(3n, {
        numerator: 24,
        denominator: 1,
        rounding_mode: "exact",
      }),
    ).toBe(72n);
    expect(() =>
      convertQuantity(1n, {
        numerator: 1,
        denominator: 24,
        rounding_mode: "exact",
      }),
    ).toThrow();
    expect(
      (
        await call("catalog/saveBarcode", boss, {
          productId: product.body,
          uomId: pcs.body,
          barcode: "000123",
          reason: "Scan",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("catalog/saveUom", admin, {
          code: "BAD",
          name: "Bad",
          dimension: "count",
          decimalPlaces: 0,
          reason: "Bad",
        })
      ).status,
    ).toBe(403);
    const listed = await call("catalog/products/list?q=Sample");
    expect(listed.body.page[0].name).toBe("Sample meat");
    expect(listed.body.page[0].priceStatus).toBe("Governed price required");
  });
  test("memo foundation is idempotent, preserves unresolved KAS percentage and denies sales writes", async () => {
    const a = await call("catalog/foundation", boss, {});
    expect(a.status).toBe(200);
    expect(a.body.positionsCreated).toBe(19);
    expect(a.body.standardsCreated).toBe(10);
    const b = await call("catalog/foundation", boss, {});
    expect(b.body.positionsCreated).toBe(0);
    expect(b.body.standardsCreated).toBe(0);
    const standards = await call("catalog/standards", sales);
    expect(standards.status).toBe(200);
    const kas = standards.body.positions.find(
      (/** @type {any} */ r) => r.code === "KAS",
    );
    expect(kas.standard.dailyCallsTarget).toBe(5);
    expect(kas.standard.notes).toContain("TO CONFIRM");
    expect((await call("catalog/foundation", sales, {})).status).toBe(403);
    await writeAudit(h.db, {
      subject: "system:test",
      action: "test.shared",
      entityType: "test",
      entityId: "shared",
      details: { reason: "seam" },
    });
    const [audit] =
      await h.db`select details from audit_logs where entity_id='shared'`;
    expect(JSON.parse(audit.details).reason).toBe("seam");
  });
});

describe("setup queues, enrollment and current-scope history", () => {
  test("setup health counts reconcile with scoped fix lists and retain unknown prior comparisons", async () => {
    const health = await call("org/setup-health");
    expect(health.status).toBe(200);
    expect(health.body.items).toHaveLength(5);
    const pending = await call("outlets/pins/queue");
    expect(pending.status).toBe(200);
    const unverified = await call("outlets/list?unverified=true&limit=100");
    expect(unverified.status).toBe(200);
    expect(
      health.body.items.find((/** @type {any} */ x) => x.key === "pins").count,
    ).toBe(
      unverified.body.page.filter(
        (/** @type {any} */ x) => x.status === "active",
      ).length,
    );
    for (const item of health.body.items) {
      expect(item.prior).toBeNull();
      expect(item.target).toBe(0);
      expect(item.href).not.toBe("");
    }
    expect((await call("org/setup-health", sales)).status).toBe(403);
    expect((await call("org/setup-health", admin)).status).toBe(200);
  });
  test("enrollment requires owned stored evidence, forbids self-approval and issues a code on independent review", async () => {
    const bytes = Buffer.from("small-fixture-image");
    const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const dir = join(h.filesDir, sha.slice(0, 2));
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, sha), bytes);
    const [file] =
      await h.db`insert into files(purpose,sha256,mime,size,path,status,created_by) values('new-store',${sha},'image/png',${bytes.length},${`${sha.slice(0, 2)}/${sha}`},'stored',${sales.userId}) returning id`;
    const b = {
      clientRequestId: "new-store-one",
      name: "Sample new store",
      address: "Cebu road",
      channel: "GT",
      contactName: "Store owner",
      latitude: 10.3,
      longitude: 123.9,
      territoryId: territory.id,
      photoStorageIds: [file.id],
    };
    expect(
      (
        await call("outlets/enrolment/propose", sales, {
          ...b,
          photoStorageIds: [],
        })
      ).status,
    ).toBe(422);
    const proposed = await call(
      "outlets/enrolment/propose",
      sales,
      b,
      "enroll-intent",
    );
    expect(proposed.status).toBe(200);
    expect(proposed.body.provisionalCode).toStartWith("PROV-");
    expect(
      (await call("outlets/enrolment/propose", sales, b, "enroll-intent")).body,
    ).toEqual(proposed.body);
    const ownManager = await person("Proposing manager", "manager", regionA.id);
    await h.db`update outlet_enrolments set proposed_by=${ownManager.subject},proposed_by_profile_id=${ownManager.profileId} where id=${proposed.body.enrolmentId}`;
    expect(
      (
        await call("outlets/enrolment/decide", ownManager, {
          enrolmentId: proposed.body.enrolmentId,
          decision: "approved",
          reason: "Self",
        })
      ).status,
    ).toBe(422);
    await h.db`update outlet_enrolments set proposed_by=${sales.subject},proposed_by_profile_id=${sales.profileId} where id=${proposed.body.enrolmentId}`;
    const queue = await call("outlets/enrolment/pending", manager);
    expect(queue.status).toBe(200);
    const queued = queue.body.page.find(
      (/** @type {any} */ r) => r.enrolment.id === proposed.body.enrolmentId,
    );
    expect(queued.proposerName).toBe("Seller");
    expect(queued.photoUrls).toHaveLength(1);
    const image = await h.fetch(queued.photoUrls[0], {
      headers: { cookie: manager.cookie },
    });
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
    const denied = await h.fetch(queued.photoUrls[0], {
      headers: { cookie: other.cookie },
    });
    expect(denied.status).toBe(403);
    const decision = await call("outlets/enrolment/decide", manager, {
      enrolmentId: proposed.body.enrolmentId,
      decision: "approved",
      reason: "Verified store",
    });
    expect(decision.status).toBe(200);
    expect(decision.body.code).toStartWith("SP");
    const [stored] =
      await h.db`select code,enrolment_status from outlets where id=${proposed.body.outletId}`;
    expect(stored.code).toBe(decision.body.code);
    expect(stored.enrolment_status).toBe("approved");
    const feed = await call("outlets/enrolment/notifications", manager);
    expect(feed.status).toBe(200);
    expect(
      feed.body.some((/** @type {any} */ r) => r.kind === "approved"),
    ).toBe(true);
  });
  test("rosters are as-of while authorization uses the current persisted outlet owner", async () => {
    const from = Date.now() - 10000;
    const [t] =
      await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by) values('sunpride','HISTORY_T','History territory','active',${new Date(from - 10000)},'system:test') returning id`;
    await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${t.id},${regionB.id},${new Date(from - 10000)},'system:test','fixture')`;
    const [store] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('sunpride','HISTORY_O','History store','active',${regionA.id},'system:test') returning id`;
    await h.db`insert into outlet_assignments(outlet_id,territory_id,effective_from,effective_to,actor_subject,reason) values(${store.id},${territory.id},${new Date(from)},${new Date(from + 1000)},'system:test','old owner')`;
    await h.db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason) values(${store.id},${t.id},${new Date(from + 1000)},'system:test','new owner')`;
    expect(
      (
        await call(
          `outlets/assignments/history?outletId=${store.id}&asOf=${from + 500}`,
          manager,
        )
      ).status,
    ).toBe(403);
    const historical = await call(
      `outlets/assignments/history?outletId=${store.id}&asOf=${from + 500}`,
      other,
    );
    expect(historical.status).toBe(200);
    expect(historical.body[0].territoryName).toBe("Cebu territory");
    const roster = await call(
      `outlets/assignments/territory-roster?territoryId=${territory.id}&asOf=${from + 500}`,
      manager,
    );
    expect(roster.status).toBe(200);
    expect(
      roster.body.some((/** @type {any} */ r) => r.outletId === store.id),
    ).toBe(false);
  });
  test("future reparenting changes scope at the edge instant and durable jobs materialize the projection", async () => {
    const [area] =
      await h.db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from) values('sunpride','MOVE_AREA','Moving area','AREA',${regionA.id},'active',now()-interval '1 day') returning id`;
    await h.db`insert into org_unit_parent_edges(unit_id,parent_id,effective_from,actor_subject,reason) values(${area.id},${regionA.id},now()-interval '1 day','system:test','fixture')`;
    const before = await identityHooks(h.env).loadProfile(h.db, manager.userId);
    const movingPerson = await person("Moving person", "viewer", regionA.id);
    const at = Date.now() + 1000;
    expect(
      (
        await call("org/reparent", boss, {
          unitId: area.id,
          parentId: regionB.id,
          effectiveFrom: at,
          reason: "Change owner",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("people/assign", boss, {
          profileId: movingPerson.profileId,
          role: "sales",
          orgUnitId: regionB.id,
          effectiveFrom: at,
          reason: "Transfer",
        })
      ).status,
    ).toBe(200);
    expect(
      (await identityHooks(h.env).loadProfile(h.db, movingPerson.userId))
        ?.orgUnitId,
    ).toBe(regionA.id);
    const [projectedBefore] =
      await h.db`select parent_id from org_units where id=${area.id}`;
    expect(projectedBefore.parent_id).toBe(regionA.id);
    await Bun.sleep(Math.max(0, at - Date.now() + 20));
    await runDueJobs(h.db, { limit: 100 });
    const [projectedAfter] =
      await h.db`select parent_id from org_units where id=${area.id}`;
    expect(projectedAfter.parent_id).toBe(regionB.id);
    const [projectedPerson] =
      await h.db`select role,org_unit_id from profiles where id=${movingPerson.profileId}`;
    expect(projectedPerson.role).toBe("sales");
    expect(projectedPerson.org_unit_id).toBe(regionB.id);
    const historical = await call(`org/tree?asOf=${at - 100}`, manager);
    expect(
      historical.body.some((/** @type {any} */ r) => r.id === area.id),
    ).toBe(false);
    const after = await identityHooks(h.env).loadProfile(h.db, manager.userId);
    expect(after?.scopeEpoch).not.toBe(before?.scopeEpoch);
  });
  test("admin registers a scoped P-256 phone without binding or leaking its key", async () => {
    const key = await deviceKey();
    const body = {
      profileId: sales.profileId,
      app: "van-android",
      inventoryTag: "V2-PROOF",
      publicKeySpki: key.publicKeySpki,
    };
    expect((await call("people/devices/register", sales, body)).status).toBe(
      403,
    );
    expect((await call("people/devices/register", other, body)).status).toBe(
      403,
    );
    expect(
      (
        await call("people/devices/register", admin, {
          ...body,
          publicKeySpki: "bad-key",
        })
      ).status,
    ).toBe(422);
    const created = await call(
      "people/devices/register",
      admin,
      body,
      "register-proof",
    );
    expect(created.status).toBe(200);
    expect(
      (await call("people/devices/register", admin, body, "register-proof"))
        .body,
    ).toEqual(created.body);
    const [stored] =
      await h.db`select * from registered_devices where id=${created.body.deviceId}`;
    expect(stored.profile_id).toBe(sales.profileId);
    expect(stored.key_id).toBe(key.keyId);
    expect(stored.bound_subject).toBeNull();
    expect(stored.credential_id).toBeNull();
    expect((await call("people/devices/register", admin, body)).status).toBe(
      422,
    );
    const [audit] =
      await h.db`select details from audit_logs where action='people.devices.register' order by created_at desc limit 1`;
    expect(JSON.stringify(audit.details)).not.toContain(key.publicKeySpki);
  });
  test("F-007 device administration has legal transitions, private-key fields stay out of lists and foreign scope is denied", async () => {
    // This transition fixture owns its person; the previous test already enrolled Seller's active phone.
    const owner = await person("Seller", "sales", regionA.id);
    const [d] =
      await h.db`insert into registered_devices(profile_id,app,platform,inventory_tag,public_key_spki,key_id,org_unit_id) values(${owner.profileId},'field-android','android','TEST-PHONE','test-only-public-key',${"a".repeat(64)},${regionA.id}) returning id`;
    expect(
      (
        await call("people/devices/suspend", other, {
          deviceId: d.id,
          reason: "lost",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("people/devices/suspend", admin, {
          deviceId: d.id,
          reason: "free text",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("people/devices/suspend", admin, {
          deviceId: d.id,
          reason: "lost",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("people/devices/reinstate", admin, {
          deviceId: d.id,
          reason: "found",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("people/devices/revoke", admin, {
          deviceId: d.id,
          reason: "replacement",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("people/devices/reinstate", admin, {
          deviceId: d.id,
          reason: "found",
        })
      ).status,
    ).toBe(422);
    const rows = await call("people/devices/list?q=TEST", admin);
    expect(rows.status).toBe(200);
    expect(rows.body.page[0].employeeName).toBe("Seller");
    expect(rows.body.page[0].keyId).toBeUndefined();
    expect(rows.body.page[0].publicKeySpki).toBeUndefined();
    const report = await call(`people/devices/report?deviceId=${d.id}`, admin);
    expect(report.status).toBe(200);
    expect(report.body.device.offlineLeaseExpiresAt).toBeNull();
    expect(report.body.acknowledged).toEqual([]);
    expect(await canSubscribe(manager, "org")).toBe(true);
    expect(await canSubscribe(sales, "people")).toBe(false);
    expect(await canSubscribe(sales, "outlets:foreign")).toBe(false);
  });
});

describe("all setup commands fail closed for a read-only actor", () => {
  /** @type {Awaited<ReturnType<typeof person>>|undefined} */ let reader;
  const endpoints = [
    ...["create", "edit", "reparent", "deactivate"].map((a) => `org/${a}`),
    ...["assign", "invite", "revoke"].map((a) => `people/${a}`),
    ...["create", "edit", "deactivate", "addMember", "removeMember"].map(
      (a) => `org/teams/${a}`,
    ),
    ...[
      "create",
      "edit",
      "deactivate",
      "assignSalesperson",
      "endSalespersonAssignment",
      "transferOwner",
    ].map((a) => `territories/${a}`),
    ...[
      "create",
      "edit",
      "deactivate",
      "assignSalesperson",
      "endSalespersonAssignment",
      "move",
      "duplicateTemplate",
    ].map((a) => `territories/routes/${a}`),
    ...["create", "edit", "deactivate", "changeCustomerLink"].map(
      (a) => `outlets/${a}`,
    ),
    ...["propose", "decide"].map((a) => `outlets/pins/${a}`),
    ...["assign", "batchAssign", "reorder"].map(
      (a) => `outlets/assignments/${a}`,
    ),
    ...["propose", "decide", "setCodeFormat"].map(
      (a) => `outlets/enrolment/${a}`,
    ),
    ...[
      "saveUom",
      "saveProduct",
      "saveCustomer",
      "saveBarcode",
      "saveConversion",
      "foundation",
      "set-standard",
    ].map((a) => `catalog/${a}`),
    ...["suspend", "revoke", "reinstate"].map((a) => `people/devices/${a}`),
  ];
  test.each(endpoints)("%s denies writes", async (path) => {
    reader ??= await person("Read only", "viewer", regionA.id);
    expect((await call(path, reader, {})).status).toBe(403);
  });
});

describe("catalog DTOs and national setup reconciliation", () => {
  test("product edits preserve omitted stock policies and customer money is integer centavos", async () => {
    const unit = await call("catalog/saveUom", boss, {
      code: "EDIT_PC",
      name: "Edit piece",
      dimension: "count",
      decimalPlaces: 0,
      reason: "Fixture",
    });
    expect(unit.status).toBe(200);
    const input = {
      name: "Sample tracked product",
      category: "Example",
      baseUomId: unit.body,
      trackingMode: "lot",
      allocationPolicy: "fefo",
      reason: "Fixture",
    };
    const product = await call("catalog/saveProduct", boss, {
      ...input,
      code: "EDIT_PRODUCT",
    });
    expect(product.status).toBe(200);
    expect(
      (
        await call("catalog/saveProduct", boss, {
          productId: product.body,
          name: "Renamed sample",
          category: "Example",
          baseUomId: unit.body,
          reason: "Rename only",
        })
      ).status,
    ).toBe(200);
    const detail = await call(
      `catalog/products/detail?productId=${product.body}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.product.trackingMode).toBe("lot");
    expect(detail.body.product.allocationPolicy).toBe("fefo");
    expect(detail.body.product.unitPrice).toBeUndefined();
    const customer = await call("catalog/saveCustomer", boss, {
      code: "DTO_CUSTOMER",
      name: "Sample account",
      channel: "GT",
      territory: "Cebu",
      creditLimitCentavos: 12345,
      reason: "Fixture",
    });
    expect(customer.status).toBe(200);
    const account = await call(
      `catalog/customers/detail?customerId=${customer.body}`,
    );
    expect(account.status).toBe(200);
    expect(account.body.creditLimitCentavos).toBe(12345);
    expect(account.body.creditLimit).toBeUndefined();
    expect(
      (
        await call(
          `catalog/customers/detail?customerId=${customer.body}`,
          manager,
        )
      ).status,
    ).toBe(403);
    expect(
      (await call("outlets/list?cursor=------------------------------------"))
        .status,
    ).toBe(400);
  });
  test("national administrators discover and repair expired assignments; regional readers cannot use stale projections", async () => {
    const national = await person("National administrator", "admin", root),
      expired = await person("Expired assignment", "viewer", regionA.id);
    await h.db`update employee_assignments set effective_to=now()-interval '1 hour' where profile_id=${expired.profileId}`;
    const regional = await call("people/list?q=Expired", manager);
    expect(regional.status).toBe(200);
    expect(regional.body.page).toEqual([]);
    const unassigned = await call(
      "people/list?unassigned=true&status=active",
      national,
    );
    expect((await call("org/permissions", national)).body.national).toBe(true);
    expect(unassigned.status).toBe(200);
    expect(unassigned.body.page.map((/** @type {any} */ p) => p.id)).toContain(
      expired.profileId,
    );
    expect(
      (await call(`people/detail?profileId=${expired.profileId}`, national))
        .status,
    ).toBe(200);
    const health = await call("org/setup-health", national);
    expect(health.status).toBe(200);
    expect(health.body.items[0].count).toBe(unassigned.body.page.length);
    expect(
      (await call("org/setup-health", admin)).body.items[0].count,
    ).toBeNull();
    expect((await call("org/permissions", national)).body.national).toBe(true);
    expect((await call("org/permissions", admin)).body.national).toBe(false);
    // SAP ownership hint for the office UI (Master data, Prices)
    const before = h.env.SAP_MODE;
    try {
      delete h.env.SAP_MODE;
      const off = (await call("org/permissions", national)).body;
      expect(off.sapOwnsMasters).toBe(false);
      expect(off.sapOwnsPrices).toBe(false);
      h.env.SAP_MODE = "mock";
      const on = (await call("org/permissions", national)).body;
      expect(on.sapOwnsMasters).toBe(true);
      expect(on.sapOwnsPrices).toBe(true);
    } finally {
      if (before === undefined) delete h.env.SAP_MODE;
      else h.env.SAP_MODE = before;
    }
  });
});
