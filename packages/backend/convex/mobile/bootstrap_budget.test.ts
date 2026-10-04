import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { manilaDate } from "../coverage/validation";
import { fixture } from "./bootstrap.test";
import {
  MAX_BOOTSTRAP_PAGE_BYTES,
  MAX_BOOTSTRAP_PAGES,
  MAX_WORKING_SET_PRODUCTS,
  MAX_WORKING_SET_VISITS,
} from "./budget";
import { dayProjection, HORIZON_DAYS } from "./projection";

/** Convex allows 4,096 index ranges (db.get + db.query calls) per transaction. */
const CONVEX_INDEX_RANGE_LIMIT = 4096;

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Territory = {
  label: string;
  callsPerDay: number;
  linesPerSheet: number;
  catalogSize: number;
  /** Header/pricing text length (the Annex C limit is 200 characters). */
  textLength: number;
};

/** Deterministic pseudo-random words, so gzip ratios are not flattered by repeated filler. */
let seed = 0x5eed;
const word = () => {
  let out = "";
  const length = 3 + (seed % 7);
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    out += "abcdefghijklmnopqrstuvwxyz"[(seed >>> 16) % 26];
  }
  return out;
};
const text = (prefix: string, length: number) => {
  let out = prefix;
  while (out.length < length) out += ` ${word()}`;
  return out.slice(0, Math.max(length, 1));
};

/**
 * One salesperson's horizon: `callsPerDay` distinct outlets on each of HORIZON_DAYS days, each
 * with a verified pin, a linked customer and an Annex C sheet drawn from a shared catalog.
 */
async function seedTerritory(f: Fixture, spec: Territory) {
  await f.t.run(async (ctx) => {
    const uom = await ctx.db.insert("unitsOfMeasure", {
      organizationId: "sunpride",
      code: "CS",
      name: "Case",
      dimension: "count",
      decimalPlaces: 0,
      active: true,
      createdAt: f.now,
      updatedAt: f.now,
    });
    const products: Id<"products">[] = [];
    for (let p = 0; p < spec.catalogSize; p++) {
      const id = await ctx.db.insert("products", {
        code: `SUNP-${String(p).padStart(5, "0")}`,
        name: `SUNPRIDE CORNED BEEF ${150 + p}G X 48 CANS`,
        category: "canned",
        uom: "CS",
        unitPrice: 0,
        active: true,
        updatedAt: f.now,
      });
      await ctx.db.insert("productBarcodes", {
        organizationId: "sunpride",
        productId: id,
        barcode: `48000${String(p).padStart(8, "0")}`,
        uomId: uom,
        active: true,
        source: "fixture",
        createdAt: f.now,
        updatedAt: f.now,
      });
      products.push(id);
    }
    let n = 0;
    for (let d = 0; d < HORIZON_DAYS; d++) {
      const serviceDate = manilaDate(f.now + d * 86_400_000);
      for (let c = 0; c < spec.callsPerDay; c++, n++) {
        const code = `OUT-${String(n).padStart(5, "0")}`;
        const outlet = await ctx.db.insert("outlets", {
          organizationId: "sunpride",
          code,
          name: text(`Sari-sari store ${n}`, 60),
          address: text(`Purok ${n}, Barangay Lahug, Cebu City`, 90),
          status: "active",
          custodianOrgUnitId: f.ids.unit,
          createdAt: f.now,
          updatedAt: f.now,
          createdBy: f.actor.subject,
        });
        await ctx.db.insert("outletPins", {
          outletId: outlet,
          latitude: 10.33 + n / 10_000,
          longitude: 123.9 + n / 10_000,
          radiusMeters: 75,
          source: "fixture",
          status: "verified",
          effectiveFrom: f.now - 50_000,
          proposedBy: f.actor.subject,
          proposedAt: f.now - 50_000,
          createdAt: f.now - 50_000,
        });
        const customer = await ctx.db.insert("customers", {
          code: `C${String(n).padStart(6, "0")}`,
          name: code,
          channel: "local",
          territory: "T",
          creditLimit: 0,
          active: true,
          updatedAt: f.now,
        });
        await ctx.db.insert("callSheetAccounts", {
          organizationId: "sunpride",
          outletId: outlet,
          revision: 1,
          header: {
            accountName: text(`Account ${n}`, spec.textLength),
            address: text("Address", spec.textLength),
            buyerName: text("Buyer", spec.textLength),
            contactNumber: "0917 000 0000",
            accountInCharge: text("AIC", spec.textLength),
            receivingInCharge: text("Receiving", spec.textLength),
            distributorName: text("Distributor", spec.textLength),
            distributorSchedule: "Every Monday",
            foc: text("FOC", spec.textLength),
            pricing: text("Pricing", spec.textLength),
          },
          lines: Array.from({ length: spec.linesPerSheet }, (_, l) => ({
            productId:
              products[(n * spec.linesPerSheet + l) % products.length]!,
            pricing: text(`₱${189 + l}.00/CS`, Math.min(spec.textLength, 40)),
          })),
          updatedAt: f.now,
          updatedBy: "fixture",
        });
        const snapshot = {
          ...f.ids.snapshot,
          outletId: outlet,
          outletCode: code,
          outletName: text(`Sari-sari store ${n}`, 60),
          customerId: customer,
        };
        await ctx.db.insert("plannedVisits", {
          generationKey: `budget-${n}`,
          planId: f.ids.plan,
          planVersion: 1,
          planSlotId: f.ids.slot,
          assigneeProfileId: f.ids.person,
          outletId: outlet,
          serviceDate,
          status: "planned",
          approvedSnapshot: snapshot,
          requiredObjectives: [],
          intents: ["sell", "merchandise"],
          expectedDurationMinutes: 30,
          generatedAt: f.now,
        });
      }
    }
  });
}

/** Index ranges (db.get + db.query calls) one day projection spends. */
async function indexRanges(f: Fixture) {
  return await f.t.run(async (ctx) => {
    let ranges = 0;
    const db = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (prop === "get" || prop === "query") ranges++;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const now = Date.now();
    await dayProjection(
      { ...ctx, db } as unknown as QueryCtx,
      f.actor,
      manilaDate(now),
      now,
    );
    return ranges;
  });
}

/** Pages a phone downloads, as JSON bytes on the wire (the gateway sends JSON.stringify). */
async function download(f: Fixture) {
  const started = performance.now();
  const pages = [];
  let cursor: string | undefined;
  do {
    const page = await f.caller.query(internal.mobile.bootstrap.snapshot, {
      actor: f.actor,
      ...(cursor ? { pageCursor: cursor } : {}),
    });
    pages.push(page);
    cursor = page.nextPageCursor ?? undefined;
  } while (cursor);
  const elapsedMs = performance.now() - started;
  const bytes = pages.map((p) => Buffer.byteLength(JSON.stringify(p)));
  const gzip = pages.map((p) => gzipSync(JSON.stringify(p)).length);
  return { pages, bytes, gzip, elapsedMs };
}

const REPRESENTATIVE: Territory[] = [
  // Client call answer 1: KAS/Booking 5 calls a day; large supermarket call sheets.
  {
    label: "KAS",
    callsPerDay: 5,
    linesPerSheet: 60,
    catalogSize: 120,
    textLength: 60,
  },
  // Route Sales / PMOT: 30 calls a day, sari-sari sheets.
  {
    label: "Route sales",
    callsPerDay: 30,
    linesPerSheet: 25,
    catalogSize: 150,
    textLength: 40,
  },
  // Stress: 30 calls a day, every sheet full (100 lines) with maximum-length text.
  {
    label: "Route sales, full sheets",
    callsPerDay: 30,
    linesPerSheet: 100,
    catalogSize: 300,
    textLength: 200,
  },
];

describe("QSR-013 mobile bootstrap size and duration", () => {
  for (const spec of REPRESENTATIVE) {
    it(`${spec.label}: every page within budget, nothing dropped or repeated`, async () => {
      const f = await fixture();
      await seedTerritory(f, spec);
      const { pages, bytes, gzip, elapsedMs } = await download(f);
      const visits = pages.flatMap((p) => p.plannedVisits);
      // fixture() already holds one planned visit today (no call sheet).
      expect(visits).toHaveLength(spec.callsPerDay * HORIZON_DAYS + 1);
      expect(new Set(visits.map((v) => v.id)).size).toBe(visits.length);
      const sheets = pages.flatMap((p) => p.callSheets);
      expect(sheets).toHaveLength(spec.callsPerDay * HORIZON_DAYS);
      expect(new Set(sheets.map((s) => s.outletId)).size).toBe(sheets.length);
      for (const page of pages) {
        const onPage = new Set(page.plannedVisits.map((v) => v.outletId));
        expect(page.callSheets.every((s) => onPage.has(s.outletId))).toBe(true);
      }
      expect(pages.length).toBeLessThanOrEqual(MAX_BOOTSTRAP_PAGES);
      expect(Math.max(...bytes)).toBeLessThanOrEqual(MAX_BOOTSTRAP_PAGE_BYTES);
      expect(pages.at(-1)!.syncCursor).toBeTruthy();
      const ranges = await indexRanges(f);
      expect(ranges).toBeLessThan(CONVEX_INDEX_RANGE_LIMIT / 2);
      const total = bytes.reduce((a, b) => a + b, 0);
      const zipped = gzip.reduce((a, b) => a + b, 0);
      // Measurements for docs/qa/MOBILE_BOOTSTRAP_BUDGET.md (convex-test, in memory).
      console.info(
        `[QSR-013] ${spec.label}: visits=${visits.length} pages=${pages.length} ` +
          `json=${total}B maxPage=${Math.max(...bytes)}B gzip=${zipped}B ` +
          `ranges=${ranges} convexTestMs=${Math.round(elapsedMs)}`,
      );
      // Generous: convex-test runs in-process; production time is measured on DEV.
      expect(elapsedMs).toBeLessThan(20_000);
    }, 120_000);
  }

  it("a maximum working set stays inside the Convex transaction range limit", async () => {
    const f = await fixture();
    // fixture() holds one visit; fill to the cap with distinct outlets whose sheets together
    // read exactly MAX_WORKING_SET_PRODUCTS distinct products.
    const perDay = Math.floor((MAX_WORKING_SET_VISITS - 1) / HORIZON_DAYS);
    const outlets = perDay * HORIZON_DAYS;
    await seedTerritory(f, {
      label: "bound",
      callsPerDay: perDay,
      linesPerSheet: Math.ceil(MAX_WORKING_SET_PRODUCTS / outlets),
      catalogSize: MAX_WORKING_SET_PRODUCTS,
      textLength: 20,
    });
    const ranges = await indexRanges(f);
    console.info(`[QSR-013] bound: ranges=${ranges}`);
    expect(ranges).toBeLessThan(CONVEX_INDEX_RANGE_LIMIT);
    // IOS-011: a page also reads each newly shipped account summary (customer, links, orders:
    // three ranges) for at most 100 page entries.
    expect(ranges + 3 * 100).toBeLessThan(CONVEX_INDEX_RANGE_LIMIT);
    const { pages, bytes } = await download(f);
    expect(pages.flatMap((p) => p.plannedVisits)).toHaveLength(outlets + 1);
    expect(pages.length).toBeLessThanOrEqual(MAX_BOOTSTRAP_PAGES);
    expect(Math.max(...bytes)).toBeLessThanOrEqual(MAX_BOOTSTRAP_PAGE_BYTES);
  }, 180_000);

  it("refuses a working set over the visit cap instead of truncating it", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (let i = 0; i < MAX_WORKING_SET_VISITS; i++)
        await ctx.db.insert("plannedVisits", {
          generationKey: `over-${i}`,
          planId: f.ids.plan,
          planVersion: 1,
          planSlotId: f.ids.slot,
          assigneeProfileId: f.ids.person,
          outletId: f.ids.outlet,
          serviceDate: manilaDate(f.now + (i % HORIZON_DAYS) * 86_400_000),
          status: "planned",
          approvedSnapshot: f.ids.snapshot,
          requiredObjectives: [],
          intents: [],
          expectedDurationMinutes: 15,
          generatedAt: f.now,
        });
    });
    await expect(
      f.caller.query(internal.mobile.bootstrap.snapshot, { actor: f.actor }),
    ).rejects.toThrow("working_set_too_large");
    // A delta pull recomputes the same projection, so it fails the same way.
    await expect(indexRanges(f)).rejects.toThrow("working_set_too_large");
  });

  it("refuses call sheets that would read more distinct products than the cap", async () => {
    const f = await fixture();
    // 7 outlets x 100 distinct lines = 700 products > 600.
    await seedTerritory(f, {
      label: "products",
      callsPerDay: 3,
      linesPerSheet: 100,
      catalogSize: 700,
      textLength: 20,
    });
    await expect(
      f.caller.query(internal.mobile.bootstrap.snapshot, { actor: f.actor }),
    ).rejects.toThrow("working_set_too_large");
  }, 120_000);

  it("ships a repeated outlet's call sheet once per snapshot, on its first page", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const product = await ctx.db.insert("products", {
        code: "SUNP-1",
        name: "Product",
        category: "canned",
        uom: "CS",
        unitPrice: 0,
        active: true,
        updatedAt: f.now,
      });
      await ctx.db.insert("callSheetAccounts", {
        organizationId: "sunpride",
        outletId: f.ids.outlet,
        revision: 1,
        header: { accountName: "Signed outlet" },
        lines: [{ productId: product }],
        updatedAt: f.now,
        updatedBy: "fixture",
      });
      for (let d = 1; d < HORIZON_DAYS; d++)
        await ctx.db.insert("plannedVisits", {
          generationKey: `repeat-${d}`,
          planId: f.ids.plan,
          planVersion: 1,
          planSlotId: f.ids.slot,
          assigneeProfileId: f.ids.person,
          outletId: f.ids.outlet,
          serviceDate: manilaDate(f.now + d * 86_400_000),
          status: "planned",
          approvedSnapshot: f.ids.snapshot,
          requiredObjectives: [],
          intents: ["sell"],
          expectedDurationMinutes: 30,
          generatedAt: f.now,
        });
    });
    const sheetsPerPage: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await f.caller.query(internal.mobile.bootstrap.snapshot, {
        actor: f.actor,
        limit: 1,
        ...(cursor ? { pageCursor: cursor } : {}),
      });
      sheetsPerPage.push(page.callSheets.length);
      cursor = page.nextPageCursor ?? undefined;
    } while (cursor);
    expect(sheetsPerPage).toEqual([1, 0, 0]);
  });
});
