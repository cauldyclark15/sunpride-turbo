import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { startHarness, profileStore } from "./harness.js";
import { sha256Hex } from "../src/core/util.js";
import {
  NOT_SET_UP_MESSAGE,
  PLAIN_BY_CODE,
  PLAIN_FALLBACK,
  plainMessage,
} from "../src/core/plain-errors.js";
import { ApiError, errorBody } from "../src/core/errors.js";

mock.module("../src/domains/org/audit.js", () => ({
  writeAudit: async () => {},
}));
mock.module("../src/domains/orders/pricing.js", () => ({
  resolvePrice: async () => ({
    unitPriceCentavos: 1250,
    priceListId: null,
    source: "test",
  }),
  creditCheck: async () => ({ status: "unknown", limit: null, exposure: null }),
}));
mock.module("../src/domains/analytics/refresh.js", () => ({
  enqueueRefresh: async () => {},
}));
mock.module("../src/domains/org/scope.js", () => ({
  scopeFilterForActor: async (
    /** @type {any} */ _db,
    /** @type {any} */ actor,
  ) => ({ unitIds: actor.role === "super_admin" ? null : [actor.orgUnitId] }),
  outletOwnerUnit: async () => null,
}));
const inventory = await import("../src/domains/inventory/index.js");
const van = await import("../src/domains/van/index.js");
const storepos = await import("../src/domains/storepos/index.js");

describe("catalogue", () => {
  test("the SPEC 8.4 sentences become plain words", () => {
    const e = (/** @type {string} */ code, /** @type {string} */ message) =>
      plainMessage({ code, message });
    expect(
      e("stale_snapshot", "The product roster changed. Start a new count."),
    ).toBe(
      "Stock moved on this line while you counted. It will be rechecked automatically.",
    );
    expect(
      e(
        "invalid_request",
        "This movement needs more than 50 lots; split the document",
      ),
    ).toBe("Too many batches on one line. Split this line in two.");
    expect(e("invalid_request", "Unit conversion needs setup")).toBe(
      "Case size not set for this product. Enter pieces.",
    );
    expect(
      e("invalid_transition", "Download the register's current configuration"),
    ).toBe("Settings changed in the office. Tap Sync.");
    expect(e("device_revoked", "Device removed")).toBe(NOT_SET_UP_MESSAGE);
    expect(NOT_SET_UP_MESSAGE).toBe(
      "This handheld is not set up for you. Ask your supervisor to hand it over.",
    );
  });

  test("specific, already-plain sentences are kept; blank or generic ones get a default", () => {
    expect(
      plainMessage({
        code: "invalid_transition",
        message: "Start the trip before selling",
      }),
    ).toBe("Start the trip before selling");
    expect(
      plainMessage({ code: "forbidden", message: "Insufficient permission" }),
    ).toBe(PLAIN_FALLBACK.forbidden);
    expect(plainMessage({ code: "not_found", message: "not_found" })).toBe(
      PLAIN_FALLBACK.not_found,
    );
  });

  test("no message in the catalogue shows a machine code or a centavo word", () => {
    for (const text of [
      ...Object.values(PLAIN_BY_CODE),
      ...Object.values(PLAIN_FALLBACK),
    ]) {
      expect(text).not.toMatch(/[a-z]+_[a-z]+/);
      expect(text).not.toMatch(/centavo/i);
      expect(text.length).toBeLessThan(110);
    }
  });

  test("other routes keep their own words; the code is never changed", () => {
    const err = new ApiError("forbidden", 403, "Insufficient permission");
    expect(errorBody(err, false, 0, "/api/v1/van/x").error).toMatchObject({
      code: "forbidden",
      message: PLAIN_FALLBACK.forbidden,
    });
    expect(errorBody(err, false, 0, "/api/v1/orders/x").error).toMatchObject({
      code: "forbidden",
      message: "Insufficient permission",
    });
    expect(errorBody(err, true, 0, "/api/v1/van/x")).toMatchObject({
      error: { code: "forbidden" },
    });
  });
});

describe("one route per domain", () => {
  /** @type {any} */ let h;
  let cookie = "";
  beforeAll(async () => {
    h = await startHarness({
      installers: [inventory.install, van.install, storepos.install],
    });
    const profiles = profileStore(h);
    const unit = crypto.randomUUID();
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','T','Team','national','active',now()-interval '1 day')`;
    const [u] =
      await h.db`insert into users (email,password_hash) values (${`${crypto.randomUUID()}@test.invalid`},'fixture-not-a-login') returning id`;
    const p = profiles.set(u.id, { role: "sales", orgUnitId: unit });
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${u.id},${u.id},'Seller','s@example.com','sales','active',${unit})`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},'sales',now()-interval '1 day','fixture','fixture')`;
    const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
    await h.db`insert into sessions (user_id,token_hash,app,expires_at) values (${u.id},${sha256Hex(token)},'web',now()+interval '1 day')`;
    cookie = `sp_session=${token}`;
  }, 30000);
  afterAll(async () => {
    await h?.close();
  });
  /** @param {string} path @param {any} body */
  async function post(path, body) {
    const res = await h.fetch(path, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: /** @type {any} */ (await res.json()) };
  }

  for (const [
    domain,
    path,
    body,
  ] of /** @type {Array<[string,string,any]>} */ ([
    [
      "inventory",
      "/api/v1/inventory/adjustments/request",
      { idempotencyKey: crypto.randomUUID() },
    ],
    ["van", "/api/v1/van/loads/approve", { tripId: crypto.randomUUID() }],
    [
      "store POS",
      "/api/v1/storepos/shifts/decide",
      { requestKey: crypto.randomUUID() },
    ],
  ]))
    test(`${domain}: the body keeps the machine code and carries a plain message`, async () => {
      const r = await post(path, body);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("forbidden");
      expect(r.body.error.message).toBe(PLAIN_FALLBACK.forbidden);
      expect(JSON.stringify(r.body)).not.toContain("Insufficient permission");
    });
});
