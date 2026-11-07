import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, profileStore } from "./harness.js";
import { sha256Hex } from "../src/core/util.js";
import { capabilitiesFor } from "../src/core/capabilities.js";
import { install } from "../src/domains/inventory/index.js";
import {
  listReasonCodes,
  requireReason,
  ensureDefaultReasonCodes,
} from "../src/domains/inventory/reasons.js";
import {
  toleranceFor,
  withinTolerance,
} from "../src/domains/inventory/tolerances.js";
import { nextDocNumber, DOC_TYPES } from "../src/core/docnum.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {ReturnType<typeof profileStore>} */ let profiles;
/** @type {any} */ let admin;
/** @type {any} */ let viewer;
/** @type {any} */ let ops;

/** @param {string} role */
async function person(role) {
  const [u] =
    await h.db`insert into users (email,password_hash) values (${`${crypto.randomUUID()}@test.invalid`},'fixture-not-a-login') returning id`;
  const profile = profiles.set(u.id, { role });
  const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
  await h.db`insert into sessions (user_id,token_hash,app,expires_at) values (${u.id},${sha256Hex(token)},'web',now()+interval '1 day')`;
  return {
    userId: u.id,
    profileId: profile.id,
    role,
    capabilities: new Set(capabilitiesFor(role)),
    cookie: `sp_session=${token}`,
  };
}
/** @param {any} who @param {string} path @param {any} [body] */
async function call(who, path, body) {
  const res = await h.fetch(`/api/v1/inventory/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: who.cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}

beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  profiles = profileStore(h);
  [admin, viewer, ops] = await Promise.all([
    person("admin"),
    person("viewer"),
    person("operations"),
  ]);
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe("reason codes", () => {
  it("ships the ten SPEC 3.4 defaults", async () => {
    const all = await listReasonCodes(h.db, "sunpride");
    expect(all.map((r) => r.code).sort()).toEqual([
      "COUNT-ERR",
      "CUST-RETURN",
      "DMG-HANDLING",
      "DMG-TRANSIT",
      "EXP",
      "FOUND",
      "RECALL",
      "SAMPLE",
      "SHORT-PICK",
      "SHORT-TRANSIT",
    ]);
    const dmg = all.find((r) => r.code === "DMG-HANDLING");
    expect(dmg).toMatchObject({
      direction: "out",
      category: "damage",
      requiresPhoto: true,
      active: true,
      approvalThresholdCentavos: null,
    });
  });
  it("filters by direction (both counts for either) and category", async () => {
    const ins = await listReasonCodes(h.db, "sunpride", { direction: "in" });
    expect(ins.map((r) => r.code).sort()).toEqual([
      "COUNT-ERR",
      "CUST-RETURN",
      "FOUND",
      "SHORT-PICK",
    ]);
    const dmg = await listReasonCodes(h.db, "sunpride", { category: "damage" });
    expect(dmg.map((r) => r.code).sort()).toEqual([
      "DMG-HANDLING",
      "DMG-TRANSIT",
    ]);
  });
  it("requireReason refuses unknown, wrong direction, missing note or photo, then accepts", async () => {
    const bad = async (/** @type {string} */ code, /** @type {any} */ o) => {
      const e = await requireReason(h.db, "sunpride", code, o).catch((x) => x);
      expect(e.code).toBe("reason_code_invalid");
      return e.message;
    };
    await bad("NOPE", { direction: "out" });
    expect(await bad("FOUND", { direction: "out", note: "x" })).toMatch(
      /can't be used/,
    );
    expect(await bad("FOUND", { direction: "in" })).toMatch(/note/);
    expect(
      await bad("DMG-HANDLING", { direction: "out", photoCount: 0 }),
    ).toMatch(/photo/);
    const ok = await requireReason(h.db, "sunpride", "DMG-HANDLING", {
      direction: "out",
      photoCount: 1,
    });
    expect(ok.code).toBe("DMG-HANDLING");
    expect(
      (await requireReason(h.db, "sunpride", "SHORT-PICK", { direction: "in" }))
        .direction,
    ).toBe("both");
  });
  it("IP-REFUND: reasons only a customer refund uses are hidden from stock pickers and refused for stock changes, but a refund can list them", async () => {
    const refundOnly = ["RF-CHANGED-MIND", "RF-DAMAGED", "RF-EXPIRED", "RF-QUALITY", "RF-WRONG-ITEM"];
    const picker = (await listReasonCodes(h.db, "sunpride", { direction: "in" })).map((r) => r.code);
    for (const code of refundOnly) expect(picker).not.toContain(code);
    const asked = (await listReasonCodes(h.db, "sunpride", { refund: true })).map((r) => r.code);
    for (const code of refundOnly) expect(asked).toContain(code);
    const e = await requireReason(h.db, "sunpride", "RF-DAMAGED", { direction: "in", note: "x" }).catch((x) => x);
    expect(e.code).toBe("reason_code_invalid");
  });
  it("lazily seeds a new organization once and never overwrites edits", async () => {
    expect((await listReasonCodes(h.db, "acme")).length).toBe(10);
    await h.db`update inventory_reason_codes set label='Edited' where organization_id='acme' and code='EXP'`;
    await ensureDefaultReasonCodes(h.db, "acme");
    expect(
      (await listReasonCodes(h.db, "acme")).find((r) => r.code === "EXP")
        ?.label,
    ).toBe("Edited");
  });
  it("routes: anyone can read, only admin can save; inactive codes drop out and are refused", async () => {
    const list = await call(viewer, "reason-codes?direction=out");
    expect(list.status).toBe(200);
    expect(list.body.some((/** @type {any} */ r) => r.code === "EXP")).toBe(
      true,
    );
    expect(list.body.some((/** @type {any} */ r) => r.code === "FOUND")).toBe(
      false,
    );
    const payload = {
      code: "wrong-lot",
      label: "Wrong lot scanned",
      category: "shrink",
      direction: "both",
      requiresNote: true,
      requiresPhoto: false,
      approvalThresholdCentavos: 100000,
    };
    expect((await call(ops, "reason-codes/save", payload)).status).toBe(403);
    const saved = await call(admin, "reason-codes/save", payload);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      code: "WRONG-LOT",
      requiresNote: true,
      approvalThresholdCentavos: 100000,
      active: true,
    });
    expect(
      (
        await call(admin, "reason-codes/save", {
          ...payload,
          category: "bogus",
        })
      ).status,
    ).toBe(422);
    await call(admin, "reason-codes/save", { ...payload, active: false });
    const after = await call(viewer, "reason-codes");
    expect(
      after.body.some((/** @type {any} */ r) => r.code === "WRONG-LOT"),
    ).toBe(false);
    const withInactive = await call(viewer, "reason-codes?all=1");
    expect(
      withInactive.body.some(
        (/** @type {any} */ r) => r.code === "WRONG-LOT" && !r.active,
      ),
    ).toBe(true);
    const e = await requireReason(h.db, "sunpride", "WRONG-LOT", {
      note: "x",
    }).catch((x) => x);
    expect(e.code).toBe("reason_code_invalid");
  });
});

describe("tolerances", () => {
  it("ships SPEC 3.5 defaults labelled as defaults", async () => {
    expect(await toleranceFor(h.db, "sunpride", "load_out_difference")).toEqual(
      { maxCentavos: 50000, maxQtyBase: null, maxCases: 1, isDefault: true },
    );
    expect(
      await toleranceFor(h.db, "sunpride", "count_variance"),
    ).toMatchObject({ maxCentavos: 50000, maxQtyBase: 2 });
    expect(
      (await toleranceFor(h.db, "sunpride", "cash_variance")).maxCentavos,
    ).toBe(5000);
    expect(
      (await toleranceFor(h.db, "sunpride", "truck_damage")).maxCentavos,
    ).toBe(100000);
    await expect(toleranceFor(h.db, "sunpride", "made_up")).rejects.toThrow();
  });
  it("withinTolerance checks every measure given, by size", () => {
    const t = {
      maxCentavos: 50000,
      maxQtyBase: 2,
      maxCases: 1,
      isDefault: true,
    };
    expect(withinTolerance(t, { centavos: 50000, qtyBase: 2, cases: 1 })).toBe(
      true,
    );
    expect(withinTolerance(t, { centavos: -50000, qtyBase: -2 })).toBe(true);
    expect(withinTolerance(t, { centavos: 50001 })).toBe(false);
    expect(withinTolerance(t, { qtyBase: 3 })).toBe(false);
    expect(withinTolerance(t, { cases: 2 })).toBe(false);
    expect(withinTolerance(t, {})).toBe(true);
    expect(
      withinTolerance({ ...t, maxCentavos: null }, { centavos: 9e9 }),
    ).toBe(true);
    expect(withinTolerance({ ...t, maxCentavos: 0 }, { centavos: 1 })).toBe(
      false,
    );
  });
  it("routes: save is admin only, effective-dated, history kept", async () => {
    const list = await call(viewer, "tolerances");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(6);
    expect(list.body.every((/** @type {any} */ r) => r.isDefault)).toBe(true);
    expect(
      (
        await call(ops, "tolerances", {
          event: "cash_variance",
          maxCentavos: 100,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(admin, "tolerances", { event: "cash_variance" })).status,
    ).toBe(422);
    expect(
      (
        await call(admin, "tolerances", {
          event: "cash_variance",
          maxCentavos: -1,
        })
      ).status,
    ).toBe(422);
    expect(
      (await call(admin, "tolerances", { event: "nope", maxCentavos: 1 }))
        .status,
    ).toBe(422);
    const before = Date.now();
    const saved = await call(admin, "tolerances", {
      event: "cash_variance",
      maxCentavos: 10000,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      event: "cash_variance",
      maxCentavos: 10000,
      isDefault: false,
    });
    expect(
      (await toleranceFor(h.db, "sunpride", "cash_variance")).maxCentavos,
    ).toBe(10000);
    // before the change it was the default
    expect(
      (await toleranceFor(h.db, "sunpride", "cash_variance", before - 86400000))
        .isDefault,
    ).toBe(true);
    const [{ n }] =
      await h.db`select count(*)::int n from approval_tolerances where event='cash_variance'`;
    expect(n).toBe(2);
    // a future-dated limit is not in force yet
    const future = Date.now() + 7 * 86400000;
    await call(admin, "tolerances", {
      event: "cash_variance",
      maxCentavos: 20000,
      effectiveFrom: future,
    });
    expect(
      (await toleranceFor(h.db, "sunpride", "cash_variance")).maxCentavos,
    ).toBe(10000);
    expect(
      (await toleranceFor(h.db, "sunpride", "cash_variance", future + 1000))
        .maxCentavos,
    ).toBe(20000);
  });
});

describe("document numbers", () => {
  const at = Date.parse("2026-11-06T10:00:00+08:00");
  it("formats TYPE-LOC-YYMMDD-NNNN and counts per type, location and day", async () => {
    expect(
      await nextDocNumber(h.db, "sunpride", {
        type: "TRF",
        locationCode: "CEB",
        at,
      }),
    ).toBe("TRF-CEB-261106-0001");
    expect(
      await nextDocNumber(h.db, "sunpride", {
        type: "TRF",
        locationCode: "ceb",
        at,
      }),
    ).toBe("TRF-CEB-261106-0002");
    expect(
      await nextDocNumber(h.db, "sunpride", {
        type: "LOAD",
        locationCode: "CEB",
        at,
      }),
    ).toBe("LOAD-CEB-261106-0001");
    expect(
      await nextDocNumber(h.db, "sunpride", {
        type: "TRF",
        locationCode: "MNL",
        at,
      }),
    ).toBe("TRF-MNL-261106-0001");
    expect(
      await nextDocNumber(h.db, "sunpride", {
        type: "TRF",
        locationCode: "CEB",
        at: at + 86400000,
      }),
    ).toBe("TRF-CEB-261107-0001");
    expect(
      await nextDocNumber(h.db, "other", {
        type: "TRF",
        locationCode: "CEB",
        at,
      }),
    ).toBe("TRF-CEB-261106-0001");
  });
  it("uses the Manila business date (16:30 UTC is already tomorrow in Manila)", async () => {
    const lateUtc = Date.parse("2026-12-31T16:30:00Z");
    expect(
      await nextDocNumber(h.db, "sunpride", {
        type: "CNT",
        locationCode: "CEB",
        at: lateUtc,
      }),
    ).toBe("CNT-CEB-270101-0001");
    const earlyUtc = Date.parse("2026-12-31T15:59:00Z");
    expect(
      await nextDocNumber(h.db, "sunpride", {
        type: "CNT",
        locationCode: "CEB",
        at: earlyUtc,
      }),
    ).toBe("CNT-CEB-261231-0001");
  });
  it("issues every type; refuses unknown types and bad locations", async () => {
    for (const type of DOC_TYPES)
      expect(
        await nextDocNumber(h.db, "sunpride", {
          type,
          locationCode: "REG01",
          at,
        }),
      ).toBe(`${type}-REG01-261106-0001`);
    await expect(
      nextDocNumber(h.db, "sunpride", { type: "XXX", locationCode: "CEB", at }),
    ).rejects.toThrow();
    await expect(
      nextDocNumber(h.db, "sunpride", {
        type: "TRF",
        locationCode: "bad loc!",
        at,
      }),
    ).rejects.toThrow();
  });
  it("20 parallel calls give 20 distinct consecutive numbers", async () => {
    const out = await Promise.all(
      Array.from({ length: 20 }, () =>
        nextDocNumber(h.db, "sunpride", {
          type: "RCV",
          locationCode: "PAR",
          at,
        }),
      ),
    );
    expect(new Set(out).size).toBe(20);
    expect(out.map((s) => Number(s.slice(-4))).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });
  it("20 parallel calls, each inside its own transaction, stay consecutive", async () => {
    const out = await Promise.all(
      Array.from({ length: 20 }, () =>
        tx(h.db, (t) =>
          nextDocNumber(t, "sunpride", {
            type: "ADJ",
            locationCode: "PAR",
            at,
          }),
        ),
      ),
    );
    expect(new Set(out).size).toBe(20);
    expect(out.map((s) => Number(s.slice(-4))).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });
  it("a rolled-back document gives its number back (no gap)", async () => {
    await tx(h.db, async (t) => {
      await nextDocNumber(t, "sunpride", {
        type: "DSP",
        locationCode: "CEB",
        at,
      });
      throw new Error("abort");
    }).catch(() => {});
    expect(
      await nextDocNumber(h.db, "sunpride", {
        type: "DSP",
        locationCode: "CEB",
        at,
      }),
    ).toBe("DSP-CEB-261106-0001");
  });
});

describe("IP-INT2 ask 3: till cash reasons are rows of the reason table", () => {
  it("the old store-till codes are seeded as cash rows and stay out of stock pickers", async () => {
    const drops = await listReasonCodes(h.db, "sunpride", { cashKind: "drop" });
    expect(drops.map((r) => r.code).sort()).toEqual(["end_of_day", "safe_drop", "till_limit"]);
    expect(drops.every((r) => r.category === "cash")).toBe(true);
    const stock = await listReasonCodes(h.db, "sunpride");
    expect(stock.some((r) => r.category === "cash")).toBe(false);
    const asked = await call(viewer, "reason-codes?category=cash");
    expect(asked.body.length).toBe(15);
    expect((await call(viewer, "reason-codes?kind=no_sale")).body.map((/** @type {any} */ r) => r.code).sort()).toEqual(["change_request", "drawer_check", "other"]);
    // a brand new organization gets them from the shipped defaults too
    expect((await listReasonCodes(h.db, "acme-cash", { category: "cash" })).length).toBe(15);
  });
  it("a cash reason only works for its own movement; stock reasons never work for cash; a note is asked for where needed", async () => {
    const ok = await requireReason(h.db, "sunpride", "till_limit", { cashKind: "drop", direction: "out" });
    expect(ok.code).toBe("till_limit");
    await expect(requireReason(h.db, "sunpride", "till_limit", { cashKind: "paid_out" })).rejects.toThrow("Choose a reason");
    await expect(requireReason(h.db, "sunpride", "EXP", { cashKind: "drop" })).rejects.toThrow("Choose a reason");
    await expect(requireReason(h.db, "sunpride", "till_limit", { direction: "out" })).rejects.toThrow("Choose a reason");
    await expect(requireReason(h.db, "sunpride", "other", { cashKind: "paid_out" })).rejects.toThrow("needs one");
    expect((await requireReason(h.db, "sunpride", "other", { cashKind: "paid_out", note: "Ice" })).code).toBe("other");
  });
  it("an admin can retire or edit a till reason through the same save route; a cash reason needs its movements", async () => {
    const bad = await call(admin, "reason-codes/save", { code: "NEW-CASH", label: "New cash reason", category: "cash", direction: "out" });
    expect(bad.status).toBe(422);
    const good = await call(admin, "reason-codes/save", { code: "NEW-CASH", label: "New cash reason", category: "cash", direction: "out", cashKinds: ["drop"] });
    expect(good.status).toBe(200);
    const edit = await call(admin, "reason-codes/save", { code: "till_limit", label: "Drawer is full", category: "cash", direction: "out", cashKinds: ["drop"] });
    expect(edit.body.code).toBe("till_limit");
    expect(edit.body.label).toBe("Drawer is full");
  });
});
