import { test, expect } from "bun:test";
import { createDb, tx } from "../src/client.js";

const lane = process.env.SP_LANE ?? "core";
if (!/^[a-z0-9_]+$/.test(lane)) throw new Error("Invalid SP_LANE");
const url = (
  await Bun.file(`${process.env.HOME}/.sunpride-keys/pg-lane-${lane}-url`).text()
).trim();

/** @template T @param {Promise<T>} p @param {number} ms */
const within = (p, ms) =>
  Promise.race([p, Bun.sleep(ms).then(() => "hung")]);

test("64 concurrent plain pool queries beside transactions never land in one (Bun 1.3 pool desync)", async () => {
  const db = createDb(url, { max: 10 });
  /** @type {Record<string, number>} */ const bad = {};
  let ok = 0;
  try {
    for (let r = 0; r < 5; r++)
      await within(
        Promise.all(
          Array.from({ length: 64 }, async (_, i) => {
            try {
              await db`select ${i}::int as i, now() as t`;
              await tx(db, async (t) => {
                await t`set transaction isolation level repeatable read read only`;
                await t`set local jit=off`;
                for (let k = 0; k < 5; k++)
                  await t`select count(*)::int as n from pg_class where ${k}::int >= 0`;
              });
              ok++;
            } catch (e) {
              const m = String(/** @type {any} */ (e).message).slice(0, 80);
              bad[m] = (bad[m] ?? 0) + 1;
            }
          }),
        ),
        30_000,
      );
    expect(bad).toEqual({});
    expect(ok).toBe(320);
    expect(await within(db`select 1 as x`.then((r) => r[0].x), 5_000)).toBe(1);
  } finally {
    await within(db.close(), 5_000);
  }
}, 60_000);

test("transactions roll back without unhandled rejections, honour options and savepoints, and refuse escaped queries", async () => {
  const db = createDb(url, { max: 2 });
  /** @type {any[]} */ const unhandled = [];
  const onUnhandled = (/** @type {any} */ e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    await expect(
      tx(db, async (t) => {
        await t`select 1`;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const opts = await db.begin(
      "isolation level repeatable read read only",
      async (/** @type {any} */ t) =>
        (
          await t`select current_setting('transaction_isolation') l, current_setting('transaction_read_only') ro`
        )[0],
    );
    expect(opts).toEqual({ l: "repeatable read", ro: "on" });
    const nested = await tx(db, async (t) => {
      const inner = await tx(t, async (s) => (await s`select 5 as v`)[0].v);
      await expect(
        /** @type {any} */ (t).savepoint(async (/** @type {any} */ s) => {
          await s`select 1`;
          throw new Error("inner");
        }),
      ).rejects.toThrow("inner");
      return { inner, after: (await t`select 7 as v`)[0].v };
    });
    expect(nested).toEqual({ inner: 5, after: 7 });
    /** @type {any} */ let escaped;
    await tx(db, async (t) => {
      escaped = t;
    });
    expect(() => escaped`select 1`).toThrow("Transaction is closed");
    // Pool queries keep Bun's Query surface: fragments, values(), catch().
    expect(
      await db`select 1 as a where true ${db`and ${2}::int = 2`}`.values(),
    ).toEqual([[1]]);
    expect(await db`select no_such_column`.catch(() => "caught")).toBe(
      "caught",
    );
    await Bun.sleep(50);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await db.close();
  }
});
