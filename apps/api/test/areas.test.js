import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarness, profileStore } from "./harness.js";
import { loadPhGeography } from "@sunpride/db/ph-geography";
import {
  areaExplorer,
  aggregateAreas,
  locateArea,
} from "../src/domains/fieldsync/areas.js";
import { storePins } from "../src/domains/fieldsync/location.js";
import { mapFixture } from "./areas-fixture.js";
/** @type {any} */ let h;
/** @type {any} */ let f;
beforeAll(async () => {
  h = await startHarness({
    port: 5002,
    installers: [
      (/** @type {any} */ router) => {
        router.get("/api/v1/location/areas", areaExplorer);
        router.get("/api/v1/location/store-pins", storePins);
      },
    ],
  });
  await loadPhGeography(h.db);
  f = await mapFixture(h.db);
  const profiles = profileStore(h);
  for (const p of [f.admin, f.sales, f.viewer])
    profiles.byUser.set(p.user_id, {
      id: p.id,
      userId: p.user_id,
      name: p.name,
      role: p.role,
      status: "active",
      orgUnitId: p.org_unit_id,
    });
}, 30000);
afterAll(async () => {
  await h?.close();
});
/** @param {any} who @param {string} [query] */
async function read(who, query = "") {
  const r = await h.fetch(
    `/api/v1/location/areas?from=${f.date}&to=${f.date}${query}`,
    { headers: { cookie: who.cookie } },
  );
  return { status: r.status, body: await r.json() };
}
describe("map area projection", () => {
  test("real SQL aggregates current customers, completed visits and distinct people at all levels", async () => {
    const { status, body } = await read(f.admin);
    expect(status).toBe(200);
    expect(body.areas.all.customers).toBe(5);
    expect(body.areas.all.sales).toBe(600000);
    expect(body.areas.all.done).toBe(3);
    expect(body.areas.all.active).toBe(1);
    expect(body.areas["0700000000"].customers).toBe(3);
    expect(body.areas["0702200000"].done).toBe(3);
    expect(body.areas["0730600000"].customers).toBe(1);
    expect(body.unlocated.customers).toBe(1);
    expect(body.unlocated.sales).toBe(50000);
    expect(body.areas["0702200000"].active).toBe(1);
    expect(body.areas.all.planned).toBe(4);
    expect(body.areas["0702200000"].planned).toBe(3);
  });
  test("source-order access rejects a foreign warehouse even when customer and salesperson match", async () => {
    const { status, body } = await read(f.sales);
    expect(status).toBe(200);
    expect(body.areas.all.sales).toBe(110000); // Cebu 10+20+30k and unlocated 50k; not Manila 40k or foreign warehouse 90k.
    expect(body.areas.all.done).toBe(3);
    expect(body.areas["1300000000"]).toBeUndefined();
  });
  test("selected branch narrows every metric; unauthorised units and roles are refused", async () => {
    const scoped = await read(f.admin, `&orgUnitId=${f.foreign}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.areas.all.customers).toBe(1);
    expect(scoped.body.areas.all.done).toBe(0);
    expect((await read(f.sales, `&orgUnitId=${f.foreign}`)).status).toBe(403);
    expect((await read(f.viewer)).status).toBe(403);
  });
  test("unknown order amounts never become a false zero or partial sales total", async () => {
    await h.db`update orders set amount_known=false where order_number='MAP-SAMPLE-2'`;
    const { body } = await read(f.admin);
    expect(body.areas.all.sales).toBeNull();
    expect(body.areas.all.unknownSales).toBe(1);
    expect(body.areas["0731300000"].sales).toBeNull();
    await h.db`update orders set amount_known=true where order_number='MAP-SAMPLE-2'`;
  });
  test("city store pins honour the selected branch before paging", async () => {
    const get = async (/** @type {string} */ unit) => {
      const r = await h.fetch(`/api/v1/location/store-pins?orgUnitId=${unit}`, {
        headers: { cookie: f.admin.cookie },
      });
      expect(r.status).toBe(200);
      return r.json();
    };
    expect((await get(f.unit)).items.length).toBe(3);
    expect((await get(f.foreign)).items).toEqual([]);
    const denied = await h.fetch(
      `/api/v1/location/store-pins?orgUnitId=${f.foreign}`,
      { headers: { cookie: f.sales.cookie } },
    );
    expect(denied.status).toBe(403);
  });
  test("historical facts follow current store ownership after transfer", async () => {
    await h.db`update outlets set custodian_org_unit_id=${f.foreign} where id=${f.stores[0]}`;
    const { body } = await read(f.sales);
    expect(body.areas.all.done).toBe(2);
    expect(body.areas.all.sales).toBe(100000);
  });
  test("rejects malformed periods and unit identifiers", async () => {
    expect((await read(f.admin, "&orgUnitId=not-a-uuid")).status).toBe(400);
    const r = await h.fetch("/api/v1/location/areas?from=2026-02-30", {
      headers: { cookie: f.admin.cookie },
    });
    expect(r.status).toBe(400);
  });
});
test("geometry parents reconcile NCR, Isabela, SGA and Manila without guessing names", () => {
  expect(
    locateArea({
      city: "1381300000",
      province: "1374000000",
      region: "1300000000",
    }),
  ).toMatchObject({
    city: "1381300000",
    province: "1307400000",
    region: "1300000000",
  });
  expect(
    locateArea({
      city: "0990101000",
      province: "0990101000",
      region: "0900000000",
    }).province,
  ).toBe("0990100000");
  expect(
    locateArea({
      city: "1999901000",
      province: "1908800000",
      region: "1900000000",
    }).province,
  ).toBe("1999900000");
  expect(
    locateArea({
      city: "1380601000",
      province: "1339000000",
      region: "1300000000",
    }).province,
  ).toBe("1303900000");
  expect(
    locateArea({ city: null, province: "1374000000", region: "1300000000" })
      .province,
  ).toBe("1307400000");
  expect(
    locateArea({ city: "unknown", province: "unknown", region: "unknown" }),
  ).toMatchObject({ city: null, province: null, region: null });
});

test("distinct people are deduplicated when several city facts reach the same parent", () => {
  const a = aggregateAreas([
    {
      region: "R",
      province: "P",
      city: "A",
      people: ["one"],
      done: 2,
      sources: 2,
    },
    {
      region: "R",
      province: "P",
      city: "B",
      people: ["one", "two"],
      done: 1,
      sources: 1,
    },
  ]);
  expect(a.P.active).toBe(2);
  expect(a.all.done).toBe(3);
});
