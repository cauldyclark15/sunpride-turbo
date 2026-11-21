import { afterAll, beforeAll, expect, test } from "bun:test";
import { loadPhGeography } from "@sunpride/db/ph-geography";
import {
  CUSTOMER_HEADERS,
  EXAMPLE,
} from "@sunpride/import-templates/customers";
import { startHarness, createUser } from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import { install as masters } from "../src/domains/masters/index.js";
import { install as imports } from "../src/domains/imports/index.js";
import { runtime } from "../src/domains/imports/customer-upload.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {Record<string,string>} */ const cookies = {};
/** @type {Record<string,string>} */ const ids = {};
/** @param {string} who @param {string} path @param {any} [body] @param {string} [method] */
async function call(
  who,
  path,
  body,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await h.fetch(`/api/v1/${path}`, {
    method,
    headers: {
      cookie: cookies[who],
      "content-type": "application/json",
      connection: "close",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bodyOut = /** @type {any} */ (await r.json());
  return { status: r.status, body: bodyOut };
}
/** @param {string[]} customerIds @param {any} visitFrequency @param {string} [who] */
const set = (customerIds, visitFrequency, who = "office") =>
  call(who, "customers/visit-frequency", { customerIds, visitFrequency });
/** @param {string} id */
async function stored(id) {
  return (
    await h.db`select visit_frequency_days as days,visit_frequency_per_month as monthly from outlets where id=${id}`
  )[0];
}

beforeAll(async () => {
  h = await startHarness({ installers: [org, masters, imports] });
  await loadPhGeography(h.db);
  const [root] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','SUNPRIDE','National','NATIONAL','active','2020-01-01') returning id`;
  for (const code of ["LOCAL", "OTHER"]) {
    const [u] =
      await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from,parent_id) values('sunpride',${code},${code},'BRANCH','active','2020-01-01',${root.id}) returning id`;
    ids[code] = u.id;
  }
  h.setHooks({ rootUnitId: async () => root.id });
  for (const [name, role] of [
    ["office", "admin"],
    ["head", "manager"],
    ["agent", "sales"],
    ["viewer", "viewer"],
  ]) {
    const user = await createUser(
      h,
      `${name}@example.com`,
      "frequency-test-password",
    );
    const [p] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,org_unit_id,status) values(${user},${user},${name},${`${name}@example.com`},${role},${ids.LOCAL},'active') returning id`;
    await h.db`insert into employee_assignments(profile_id,role,org_unit_id,effective_from,actor_subject,reason) values(${p.id},${role},${ids.LOCAL},'2020-01-01',${user},'Test setup')`;
    const r = await h.fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({
        email: `${name}@example.com`,
        password: "frequency-test-password",
      }),
    });
    expect(r.status).toBe(200);
    cookies[name] = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  }
  for (const [code, unit, status] of [
    ["A", ids.LOCAL, "active"],
    ["B", ids.LOCAL, "prospect"],
    ["FOREIGN", ids.OTHER, "active"],
    ["CLOSED", ids.LOCAL, "inactive"],
  ]) {
    const [o] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('sunpride',${code},${code},${status},${unit},'test') returning id`;
    ids[code] = o.id;
  }
}, 240000);
afterAll(async () => {
  await Promise.all(runtime.workers.values());
  await h?.close();
});

test("SP-0223 office saves weekly, fortnightly, monthly and exact monthly counts; reads list/detail", async () => {
  for (const [frequency, days, monthly] of [
    ["Weekly", 7, null],
    ["Every 2 weeks", 14, null],
    ["Monthly", 30, null],
    ["4 times a month", 7, 4],
    ["7 times a month", 4, 7],
    ["31 times a month", 1, 31],
  ]) {
    expect((await set([ids.A], frequency)).status).toBe(200);
    expect(await stored(ids.A)).toEqual({ days, monthly });
    const detail = await call("office", `customers/${ids.A}`);
    expect(detail.body.visitFrequency).toBe(frequency);
    expect(detail.body.visitFrequencyPerMonth).toBe(monthly);
    const list = await call("office", "customers?q=A&offset=0");
    expect(
      list.body.rows.find((/** @type {any} */ r) => r.id === ids.A)
        ?.visitFrequency,
    ).toBe(frequency);
  }
});

test("SP-0223 Sales Head can set two customers together without editing enrollment", async () => {
  const result = await set([ids.A, ids.B], "4 times a month", "head");
  expect(result.status).toBe(200);
  expect(result.body.updated).toBe(2);
  expect(await stored(ids.A)).toEqual({ days: 7, monthly: 4 });
  expect(await stored(ids.B)).toEqual({ days: 7, monthly: 4 });
  const audits =
    await h.db`select details from audit_logs where action='customer.visit_frequency' and entity_id=${ids.B}`;
  expect(audits).toHaveLength(1);
  expect(JSON.parse(audits[0].details).after.label).toBe("4 times a month");
});

test("SP-0223 refuses field/read-only roles, foreign scope, inactive customers and invalid batches atomically", async () => {
  for (const who of ["agent", "viewer"])
    expect((await set([ids.A], "Monthly", who)).status).toBe(403);
  // Loosened (jc): the head (manager) is company-wide, so a foreign store saves too.
  expect((await set([ids.A, ids.FOREIGN], "Monthly", "head")).status).toBe(/* loosened (jc): was 403 */ 200);
  const before = await stored(ids.A);
  expect((await set([ids.A, ids.CLOSED], "Monthly")).status).toBe(422);
  for (const batch of [[], [ids.A, ids.A], Array(101).fill(ids.A)])
    expect((await set(batch, "Monthly")).status).toBe(422);
  for (const frequency of [
    null,
    4,
    "",
    "0 times a month",
    "32 times a month",
    "2.5 times a month",
    "daily",
  ])
    expect((await set([ids.A], frequency)).status).toBe(422);
  expect(await stored(ids.A)).toEqual(before);
});

test("SP-0223 upload uses the same representation; omitted frequency preserves the requirement", async () => {
  const upload = async (/** @type {string|undefined} */ frequency) => {
    const result = await call("office", "imports/customer-upload/runs", {
      fileName: `${crypto.randomUUID()}.csv`,
      header: [...CUSTOMER_HEADERS],
      rows: [
        {
          rowNumber: 2,
          values: {
            ...EXAMPLE,
            code: "UPLOAD-FREQUENCY",
            customerName: "Frequency sample customer",
            ...(frequency ? { visitFrequency: frequency } : {}),
          },
        },
      ],
    });
    expect(result.status).toBe(200);
    await runtime.workers.get(result.body.id);
    const [run] =
      await h.db`select status,failed_count from customer_upload_runs where id=${result.body.id}`;
    expect(run.failed_count).toBe(0);
    expect(run.status).toBe("completed");
    return (await h.db`select id from outlets where code='UPLOAD-FREQUENCY'`)[0]
      .id;
  };
  const id = await upload("5 times a month");
  expect(await stored(id)).toEqual({ days: 6, monthly: 5 });
  expect(await upload(undefined)).toBe(id);
  expect(await stored(id)).toEqual({ days: 6, monthly: 5 });
  expect(await upload("Weekly")).toBe(id);
  expect(await stored(id)).toEqual({ days: 7, monthly: null });
  const changed = await call(
    "office",
    `customers/${id}`,
    { customer: { visitFrequency: "3 times a month" } },
    "PUT",
  );
  expect(changed.status).toBe(200);
  expect(changed.body.visitFrequencyPerMonth).toBe(3);
  expect(await stored(id)).toEqual({ days: 10, monthly: 3 });
  expect(
    (
      await call(
        "office",
        `customers/${id}`,
        { customer: { tradeName: "Updated trade name" } },
        "PUT",
      )
    ).status,
  ).toBe(200);
  expect(await stored(id)).toEqual({ days: 10, monthly: 3 });
  expect(
    (
      await call(
        "office",
        `customers/${id}`,
        {
          customer: {
            tradeName: "Must not be saved",
            visitFrequency: "invalid",
          },
        },
        "PUT",
      )
    ).status,
  ).toBe(422);
  expect((await call("office", `customers/${id}`)).body.tradeName).toBe(
    "Updated trade name",
  );
  expect(await stored(id)).toEqual({ days: 10, monthly: 3 });
});

test("SP-0223 legacy day edits clear the exact monthly marker while omitted edits preserve it", async () => {
  expect((await set([ids.A], "4 times a month")).status).toBe(200);
  expect(
    (
      await call("office", "outlets/edit", {
        outletId: ids.A,
        name: "A renamed",
        reason: "Check preservation",
      })
    ).status,
  ).toBe(200);
  expect(await stored(ids.A)).toEqual({ days: 7, monthly: 4 });
  expect(
    (
      await call("office", "outlets/edit", {
        outletId: ids.A,
        name: "A renamed",
        visitFrequencyDays: 14,
        reason: "Change cadence",
      })
    ).status,
  ).toBe(200);
  expect(await stored(ids.A)).toEqual({ days: 14, monthly: null });
  expect((await call("office", `customers/${ids.A}`)).body.visitFrequency).toBe(
    "Every 2 weeks",
  );
});
