import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { tx } from "@sunpride/db/client";

mock.module("../src/domains/org/audit.js", () => ({
  writeAudit: async (/** @type {any} */ t, /** @type {any} */ e) => {
    await t`insert into audit_logs (subject,action,entity_type,entity_id,details) values (${e.subject},${e.action},${e.entityType},${e.entityId},${e.details ?? null})`;
  },
}));
const { setup } = await import("./value-fixture.js");
const { postMovement } = await import("../src/domains/inventory/posting.js");
const { stockLock, postingLocks } = await import(
  "../src/domains/inventory/common.js"
);

/** @type {Awaited<ReturnType<typeof setup>>} */ let f;
/** @type {any} */ let admin;
let depot = "",
  truck = "",
  truck2 = "";
beforeAll(async () => {
  f = await setup();
  admin = await f.person("admin");
  depot = await f.location("Lock depot", "warehouse");
  truck = await f.location("Lock truck", "truck");
  truck2 = await f.location("Lock truck 2", "truck");
}, 30000);
afterAll(async () => {
  await f?.h.close();
});
/** @param {any[]} movementLines @param {any} [extra] */
const input = (movementLines, extra = {}) => ({
  kind: "goods_receipt",
  sourceType: "test",
  sourceId: "lock-test",
  idempotencyKey: crypto.randomUUID(),
  occurredAt: Date.now(),
  actor: admin,
  organizationId: "sunpride",
  lines: movementLines,
  ...extra,
});
/** @param {string} productId @param {string|null} from @param {string|null} to @param {number} qty */
const line = (productId, from, to, qty) => ({
  productId,
  fromLocationId: from,
  toLocationId: to,
  quantityBase: qty,
  uom: "PC",
});
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** An in-flight posting: it holds its row locks but has not reached core/sync.js recordChange,
 * which takes one GLOBAL change-log lock until commit (outside this lane; reported as an ask).
 * @param {any} t @param {any[]} movementLines */
const postHalfway = (t, movementLines) =>
  postingLocks(t, "sunpride", crypto.randomUUID(), movementLines);
/** Resolves "done" if the promise settles before ms, else "waiting".
 * @param {Promise<any>} p @param {number} ms */
const settled = (p, ms) =>
  Promise.race([p.then(() => "done"), sleep(ms).then(() => "waiting")]);

describe("per-product posting locks", () => {
  it("two postings on different products do not wait for each other; the same product does", async () => {
    const p1 = await f.product(),
      p2 = await f.product();
    /** @type {() => void} */ let release = () => {};
    const gate = new Promise((r) => (release = () => r(undefined)));
    /** @type {() => void} */ let locked = () => {};
    const holding = new Promise((r) => (locked = () => r(undefined)));
    const holder = tx(f.h.db, async (t) => {
      await postHalfway(t, [line(p1.id, null, depot, 10)]);
      locked();
      await gate;
    });
    await holding;
    // different product: completes while the first transaction is still open
    const other = tx(f.h.db, (t) =>
      postMovement(t, input([line(p2.id, null, depot, 5)])),
    );
    expect(await settled(other, 4000)).toBe("done");
    // same product + location: must queue behind the first transaction
    const same = tx(f.h.db, (t) =>
      postMovement(t, input([line(p1.id, null, depot, 1)])),
    );
    expect(await settled(same, 400)).toBe("waiting");
    release();
    await holder;
    await same;
    const [b] =
      await f.h.db`select physical_base from inventory_balances where product_id=${p1.id} and location_id=${depot}`;
    expect(Number(b.physical_base)).toBe(1);
  });

  it("the same product at a DIFFERENT location does not wait either", async () => {
    const p = await f.product();
    /** @type {() => void} */ let release = () => {};
    const gate = new Promise((r) => (release = () => r(undefined)));
    /** @type {() => void} */ let locked = () => {};
    const holding = new Promise((r) => (locked = () => r(undefined)));
    const holder = tx(f.h.db, async (t) => {
      await postHalfway(t, [line(p.id, null, truck, 10)]);
      locked();
      await gate;
    });
    await holding;
    const other = tx(f.h.db, (t) =>
      postMovement(t, input([line(p.id, null, truck2, 7)])),
    );
    expect(await settled(other, 4000)).toBe("done");
    release();
    await holder;
  });

  it("a whole-org holder (stockLock) still excludes postings", async () => {
    const p = await f.product();
    /** @type {() => void} */ let release = () => {};
    const gate = new Promise((r) => (release = () => r(undefined)));
    /** @type {() => void} */ let locked = () => {};
    const holding = new Promise((r) => (locked = () => r(undefined)));
    const holder = tx(f.h.db, async (t) => {
      await stockLock(t, "sunpride");
      locked();
      await gate;
    });
    await holding;
    const blocked = tx(f.h.db, (t) =>
      postMovement(t, input([line(p.id, null, depot, 3)])),
    );
    expect(await settled(blocked, 400)).toBe("waiting");
    release();
    await holder;
    expect(await settled(blocked, 4000)).toBe("done");
  });

  it("locks are taken in one sorted order: opposite-order multi-product postings never deadlock", async () => {
    const products = await Promise.all([f.product(), f.product(), f.product()]);
    await tx(f.h.db, (t) =>
      postMovement(
        t,
        input(products.map((p) => line(p.id, null, depot, 1000))),
      ),
    );
    const forward = products.map((p) => line(p.id, depot, truck, 1));
    const backward = [...forward].reverse();
    const jobs = [];
    for (let i = 0; i < 24; i++)
      jobs.push(
        tx(f.h.db, (t) =>
          postMovement(
            t,
            input(i % 2 ? forward : backward, { kind: "inventory_issue" }),
          ),
        ),
      );
    const results = await Promise.allSettled(jobs);
    const failures = results.filter((r) => r.status === "rejected");
    expect(failures.map((r) => String(/** @type {any} */ (r).reason))).toEqual(
      [],
    );
    const [b] =
      await f.h.db`select physical_base from inventory_balances where product_id=${products[0].id} and location_id=${depot}`;
    expect(Number(b.physical_base)).toBe(1000 - 24);
  });

  it("holds one advisory lock per product+location touched (plus org and idempotency key)", async () => {
    const [p1, p2] = [await f.product(), await f.product()];
    const names = await tx(f.h.db, async (t) => {
      await postMovement(
        t,
        input([line(p1.id, null, depot, 4), line(p2.id, null, depot, 4)]),
      );
      const rows =
        await t`select mode,count(*)::int as n from pg_locks where locktype='advisory' and pid=pg_backend_pid() group by mode`;
      return Object.fromEntries(rows.map((/** @type {any} */ r) => [r.mode, r.n]));
    });
    // org (shared) + 2 pairs + idempotency key + the change-log lock
    expect(names.ShareLock).toBe(1);
    expect(names.ExclusiveLock).toBeGreaterThanOrEqual(3);
  });

  it("a replay of the same key while the first is in flight returns the first result", async () => {
    const p = await f.product();
    const data = input([line(p.id, null, depot, 9)]);
    const [a, b] = await Promise.all([
      tx(f.h.db, (t) => postMovement(t, data)),
      tx(f.h.db, (t) => postMovement(t, data)),
    ]);
    expect(a.movementId).toBe(b.movementId);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
  });
});

describe("batched SQL in the writer", () => {
  it("a 100-line movement issues a bounded number of statements and keeps the ledger exact", async () => {
    /** @type {any[]} */ const products = [];
    for (let i = 0; i < 100; i++) products.push(await f.product());
    let statements = 0;
    const result = await tx(f.h.db, async (t) => {
      const counted = new Proxy(t, {
        apply(target, thisArg, args) {
          statements++;
          return Reflect.apply(target, thisArg, args);
        },
      });
      return postMovement(
        counted,
        input(products.map((p) => line(p.id, null, depot, 12))),
      );
    });
    // before: roughly 15 statements PER line; now: preloads + 4 set-based writes + the audit/outbox tail
    expect(statements).toBeLessThan(60);
    const [c] =
      await f.h.db`select count(*)::int as n,sum(quantity_delta_base)::int as q from inventory_ledger_entries where movement_id=${result.movementId}`;
    expect(c).toEqual({ n: 100, q: 1200 });
    const [bad] =
      await f.h.db`select count(*)::int as n from inventory_balances b where b.product_id in ${f.h.db(products.map((p) => p.id))} and (b.physical_base<>12 or b.available_stock_base<>12 or b.version<>1)`;
    expect(bad.n).toBe(0);
  });
});
