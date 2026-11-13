import { test, expect, beforeAll, afterAll } from "bun:test";
import { startHarness } from "./harness.js";
import { analyticsFixture } from "./analytics-fixture.js";
import { sha256Hex } from "../src/core/util.js";
const { install: analytics } =
  await import("../src/domains/analytics/index.js");
const { installTargetCascade, allocate } =
  await import("../src/domains/coverage/target-cascade.js");

/** @type {any} */ let h;
/** @type {any} */ let f;
/** @type {Record<string,string>} */ const cookies = {};
/** @type {string} */ let month;
beforeAll(async () => {
  h = await startHarness({
    installers: [
      analytics,
      (/** @type {any} */ router, /** @type {any} */ platform) =>
        installTargetCascade(router, platform),
    ],
  });
  f = await analyticsFixture(h);
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${f.boss},${f.root},'super_admin','2020-01-01','fixture','fixture')`;
  /** @param {string} name @param {string} role @param {string} unit */
  async function person(name, role, unit) {
    const email = `${name}@example.com`;
    const [u] =
      await h.db`insert into users(email,password_hash) values(${email},'not-a-password-hash') returning id`;
    const [p] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${u.id},${u.id},${name},${email},${role},'active',${unit}) returning id`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${role},'2020-01-01','fixture','fixture')`;
    await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${u.id},${sha256Hex("sps_" + name)},'web',now()+interval '1 day')`;
    cookies[name] = "sp_session=sps_" + name;
  }
  await person("approver-root", "approver", f.root);
  await person("manager-a", "manager", f.a);
  // Next month: the prior three complete months include this month's fixture orders.
  const d = new Date(f.today + "T00:00:00Z");
  month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 7);
}, 120000);
afterAll(async () => {
  await h?.close();
});
/** @param {string} path @param {any} [body] @param {string} [cookie] */
async function call(path, body, cookie = f.cookie) {
  const r = await h.fetch(path, {
    method: body ? "POST" : "GET",
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: /** @type {any} */ (await r.json()) };
}

test("F-615 largest-remainder allocation reconciles exactly and splits evenly without a basis", () => {
  const a = allocate(100, [
    { key: "a", basis: 1 },
    { key: "b", basis: 1 },
    { key: "c", basis: 1 },
  ]);
  expect(a.reduce((x, y) => x + y, 0)).toBe(100);
  expect(a).toEqual([34, 33, 33]);
  expect(
    allocate(10, [
      { key: "a", basis: 0 },
      { key: "b", basis: 0 },
    ]),
  ).toEqual([5, 5]);
  const p = allocate(1_000_001, [
    { key: "x", basis: 7 },
    { key: "y", basis: 3 },
  ]);
  expect(p[0] + p[1]).toBe(1_000_001);
  expect(p[0]).toBeGreaterThan(p[1]);
});

test("F-615 sales value cascade: preview from prior actuals, reconciliation, idempotent submit, independent approval publishes one target book", async () => {
  const base = {
    month,
    metric: "sales_value",
    parentLevel: "company",
    parentKey: "company",
    parentAmount: 1_000_000_00,
  };
  const preview = await call("/api/v1/targets/cascade/preview", base);
  expect(preview.status).toBe(200);
  expect(preview.body.childLevel).toBe("channel");
  expect(preview.body.method).toBe("prior_actual");
  expect(
    preview.body.lines.map((/** @type {any} */ l) => l.key).sort(),
  ).toEqual(["GT", "KAS", "PMOT", "SM"]);
  expect(preview.body.reconciliation.ok).toBe(true);
  const sum = preview.body.lines.reduce(
    (/** @type {number} */ a, /** @type {any} */ l) => a + l.amount,
    0,
  );
  expect(sum).toBe(base.parentAmount);
  // A regional manager cannot cascade the company target.
  expect(
    (await call("/api/v1/targets/cascade/preview", base, cookies["manager-a"]))
      .status,
  ).toBe(403);
  const lines = preview.body.lines.map((/** @type {any} */ l) => ({
    key: l.key,
    amount: l.amount,
  }));
  const off = lines.map((/** @type {any} */ l, /** @type {number} */ i) =>
    i === 0 ? { ...l, amount: l.amount + 1 } : l,
  );
  const unreconciled = await call("/api/v1/targets/cascade/submit", {
    ...base,
    lines: off,
    sourceRef: "TEST plan",
    idempotencyKey: "u1",
  });
  expect(unreconciled.status).toBe(409);
  expect(unreconciled.body.error.message).toContain("difference -1");
  const missing = await call("/api/v1/targets/cascade/submit", {
    ...base,
    lines: lines.slice(1),
    sourceRef: "TEST plan",
    idempotencyKey: "u2",
  });
  expect(missing.status).toBe(409);
  // Manual edit that still reconciles: +1 on one child, -1 on another.
  const manual = lines.map((/** @type {any} */ l, /** @type {number} */ i) =>
    i === 0
      ? { ...l, amount: l.amount + 1 }
      : i === 1
        ? { ...l, amount: l.amount - 1 }
        : l,
  );
  const body = {
    ...base,
    lines: manual,
    sourceRef: "TEST plan",
    idempotencyKey: "s1",
  };
  const submitted = await call("/api/v1/targets/cascade/submit", body);
  expect(submitted.status).toBe(200);
  expect(submitted.body.version).toBe(1);
  expect((await call("/api/v1/targets/cascade/submit", body)).body.id).toBe(
    submitted.body.id,
  );
  expect(
    (
      await call("/api/v1/targets/cascade/submit", {
        ...body,
        sourceRef: "Changed",
      })
    ).status,
  ).toBe(409);
  const [{ method }] =
    await h.db`select method from target_cascades where id=${submitted.body.id}`;
  expect(method).toBe("manual");
  // WEB-037: the read says who may decide, so the regional manager is not
  // offered Approve/Send back the server would refuse.
  /** @param {string} [cookie] */
  const decidable = async (cookie) => {
    const r = await call(`/api/v1/targets/cascade?month=${month}`, undefined, cookie);
    return {
      wide: r.body.companyWide,
      can: r.body.cascades.find(
        (/** @type {any} */ k) => k.id === submitted.body.id,
      )?.canDecide,
    };
  };
  expect(await decidable(cookies["manager-a"])).toEqual({ wide: false, can: false });
  expect(await decidable(cookies["approver-root"])).toEqual({ wide: true, can: true });
  expect((await decidable()).can).toBe(false);
  // The preparer (super admin) cannot publish their own cascade.
  const decide = {
    cascadeId: submitted.body.id,
    decision: "approve",
    contentHash: submitted.body.contentHash,
  };
  expect((await call("/api/v1/targets/cascade/decide", decide)).status).toBe(
    403,
  );
  expect(
    (
      await call(
        "/api/v1/targets/cascade/decide",
        { ...decide, contentHash: "stale" },
        cookies["approver-root"],
      )
    ).status,
  ).toBe(409);
  const published = await call(
    "/api/v1/targets/cascade/decide",
    decide,
    cookies["approver-root"],
  );
  expect(published.status).toBe(200);
  expect(published.body.status).toBe("published");
  const book = await call(`/api/v1/targets?month=${month}&level=channel`);
  expect(book.status).toBe(200);
  const byKey = Object.fromEntries(
    book.body.rows.map((/** @type {any} */ r) => [r.key, r.amountCentavos]),
  );
  for (const l of manual) expect(byKey[l.key]).toBe(l.amount);
  expect(book.body.total).toBe(base.parentAmount);
  const company = await call(`/api/v1/targets?month=${month}&level=company`);
  expect(company.body.rows[0].amountCentavos).toBe(base.parentAmount);
  // A second published version supersedes the first.
  const v2 = await call("/api/v1/targets/cascade/submit", {
    ...base,
    parentAmount: 1_200_000_00,
    lines: (
      await call("/api/v1/targets/cascade/preview", {
        ...base,
        parentAmount: 1_200_000_00,
      })
    ).body.lines.map((/** @type {any} */ l) => ({
      key: l.key,
      amount: l.amount,
    })),
    sourceRef: "TEST revision",
    idempotencyKey: "s2",
  });
  expect(v2.body.version).toBe(2);
  expect(
    (
      await call(
        "/api/v1/targets/cascade/decide",
        {
          cascadeId: v2.body.id,
          decision: "approve",
          contentHash: v2.body.contentHash,
        },
        cookies["approver-root"],
      )
    ).status,
  ).toBe(200);
  const read = await call(`/api/v1/targets/cascade?month=${month}`);
  const sales = read.body.cascades.filter(
    (/** @type {any} */ k) => k.metric === "sales_value",
  );
  expect(sales.map((/** @type {any} */ k) => [k.version, k.status])).toEqual([
    [2, "published"],
    [1, "superseded"],
  ]);
  expect(
    (await call(`/api/v1/targets?month=${month}&level=company`)).body.rows[0]
      .amountCentavos,
  ).toBe(1_200_000_00);
  // Two waiting versions: publishing the newer one retires the older; it can no longer be approved.
  /** @param {number} amount @param {string} key */
  async function submit(amount, key) {
    const p = await call("/api/v1/targets/cascade/preview", {
      ...base,
      parentAmount: amount,
    });
    return (
      await call("/api/v1/targets/cascade/submit", {
        ...base,
        parentAmount: amount,
        lines: p.body.lines.map((/** @type {any} */ l) => ({
          key: l.key,
          amount: l.amount,
        })),
        sourceRef: "TEST stale",
        idempotencyKey: key,
      })
    ).body;
  }
  const older = await submit(1_300_000_00, "s3");
  const newer = await submit(1_400_000_00, "s4");
  expect(
    (
      await call(
        "/api/v1/targets/cascade/decide",
        {
          cascadeId: newer.id,
          decision: "approve",
          contentHash: newer.contentHash,
        },
        cookies["approver-root"],
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await call(
        "/api/v1/targets/cascade/decide",
        {
          cascadeId: older.id,
          decision: "approve",
          contentHash: older.contentHash,
        },
        cookies["approver-root"],
      )
    ).status,
  ).toBe(409);
  expect(
    (await call(`/api/v1/targets?month=${month}&level=company`)).body.rows[0]
      .amountCentavos,
  ).toBe(1_400_000_00);
});

test("F-615 non-sales bundle: MSL rate carries to every child, volume names a product, territory cascades reach agents, rejection keeps the book", async () => {
  const territory = (
    await h.db`select id::text from territories where code='T0'`
  )[0].id;
  const msl = await call("/api/v1/targets/cascade/preview", {
    month,
    metric: "msl_compliance",
    parentLevel: "territory",
    parentKey: territory,
    parentAmount: 8500,
  });
  expect(msl.status).toBe(200);
  expect(msl.body.method).toBe("same_rate");
  expect(msl.body.childLevel).toBe("agent");
  expect(
    msl.body.lines.every((/** @type {any} */ l) => l.amount === 8500),
  ).toBe(true);
  expect(
    (
      await call("/api/v1/targets/cascade/preview", {
        month,
        metric: "msl_compliance",
        parentLevel: "territory",
        parentKey: territory,
        parentAmount: 10001,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("/api/v1/targets/cascade/preview", {
        month,
        metric: "volume",
        parentLevel: "territory",
        parentKey: territory,
        parentAmount: 100,
      })
    ).status,
  ).toBe(422);
  // Team A's manager may cascade its own territory's call target.
  const calls = await call(
    "/api/v1/targets/cascade/preview",
    {
      month,
      metric: "calls",
      parentLevel: "territory",
      parentKey: territory,
      parentAmount: 301,
    },
    cookies["manager-a"],
  );
  expect(calls.status).toBe(200);
  expect(calls.body.method).toBe("equal");
  const submitted = await call(
    "/api/v1/targets/cascade/submit",
    {
      month,
      metric: "calls",
      parentLevel: "territory",
      parentKey: territory,
      parentAmount: 301,
      lines: calls.body.lines.map((/** @type {any} */ l) => ({
        key: l.key,
        amount: l.amount,
      })),
      sourceRef: "TEST calls",
      idempotencyKey: "c1",
    },
    cookies["manager-a"],
  );
  expect(submitted.status).toBe(200);
  expect(
    (
      await call("/api/v1/targets/cascade/decide", {
        cascadeId: submitted.body.id,
        decision: "reject",
        contentHash: submitted.body.contentHash,
      })
    ).status,
  ).toBe(422);
  const rejected = await call("/api/v1/targets/cascade/decide", {
    cascadeId: submitted.body.id,
    decision: "reject",
    reason: "TEST: hold calls flat",
    contentHash: submitted.body.contentHash,
  });
  expect(rejected.body.status).toBe("rejected");
  const [{ n }] =
    await h.db`select count(*)::int n from sales_targets where month=${month} and metric='calls'`;
  expect(n).toBe(0);
  // Superseding a version its approver once prepared is not self-approval of that old version.
  const callIdentity = {
    month,
    metric: "calls",
    parentLevel: "territory",
    parentKey: territory,
  };
  /** @param {number} amount @param {string} key @param {string} cookie */
  async function submitCalls(amount, key, cookie) {
    const p = await call(
      "/api/v1/targets/cascade/preview",
      { ...callIdentity, parentAmount: amount },
      cookie,
    );
    return (
      await call(
        "/api/v1/targets/cascade/submit",
        {
          ...callIdentity,
          parentAmount: amount,
          lines: p.body.lines.map((/** @type {any} */ l) => ({
            key: l.key,
            amount: l.amount,
          })),
          sourceRef: "TEST calls",
          idempotencyKey: key,
        },
        cookie,
      )
    ).body;
  }
  const byManager = await submitCalls(320, "c2", cookies["manager-a"]);
  expect(
    (
      await call("/api/v1/targets/cascade/decide", {
        cascadeId: byManager.id,
        decision: "approve",
        contentHash: byManager.contentHash,
      })
    ).status,
  ).toBe(200);
  const byBoss = await submitCalls(340, "c3", f.cookie);
  const swap = await call(
    "/api/v1/targets/cascade/decide",
    {
      cascadeId: byBoss.id,
      decision: "approve",
      contentHash: byBoss.contentHash,
    },
    cookies["manager-a"],
  );
  expect(swap.status).toBe(200);
  const states =
    await h.db`select version,status from target_cascades where metric='calls' and parent_key=${territory} order by version`;
  expect(states.map((/** @type {any} */ r) => [r.version, r.status])).toEqual([
    [1, "rejected"],
    [2, "superseded"],
    [3, "published"],
  ]);
});
test("WEB-037 the prior-actual basis reads the sales view once, fenced, before filtering by child and scope", async () => {
  const { basisFor } =
    await import("../src/domains/coverage/target-cascade.js");
  /** @type {string[]} */ const texts = [];
  /** @param {any} strings @param {any[]} values */
  const db = (strings, ...values) => {
    if (!Array.isArray(strings) || !("raw" in strings))
      return { list: strings };
    texts.push(
      strings.reduce(
        (
          /** @type {string} */ out,
          /** @type {string} */ s,
          /** @type {number} */ i,
        ) => out + s + (i < values.length ? (values[i]?.unsafe ?? "?") : ""),
        "",
      ),
    );
    return Promise.resolve([]);
  };
  db.unsafe = (/** @type {string} */ s) => ({ unsafe: s });
  for (const metric of ["sales_value", "volume", "coverage_stores"])
    await basisFor(
      db,
      metric,
      metric === "volume" ? "SKU" : null,
      "channel",
      ["gt"],
      "2026-11",
      {
        ids: ["u1"],
        cross: true,
      },
    );
  expect(texts).toHaveLength(3);
  for (const sql of texts) {
    const fence = sql.indexOf("as materialized (");
    const close = sql.indexOf(")\n", fence);
    expect(fence).toBeGreaterThan(-1);
    const inner = sql.slice(fence, close);
    expect(inner).toContain("from analytics_sales_facts f where f.approved");
    // Child keys and unit scope stay outside the fence, so they cannot reshape the view's joins.
    expect(inner).not.toContain("agent_unit_id");
    expect(inner).not.toContain("f.channel in");
    expect(sql.slice(close)).toContain("f.agent_unit_id in");
  }
});
