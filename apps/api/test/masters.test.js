import { afterAll, beforeAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  createUser,
  deviceKey,
  registerDevice,
  nativeSignIn,
  bind,
  signedPost,
} from "./harness.js";
import { install as org } from "../src/domains/org/index.js";
import {
  install as masters,
  readMslFramework,
} from "../src/domains/masters/index.js";
import {
  polygon,
  containedRing,
  contains,
} from "../src/domains/masters/geometry.js";
import { potentialClass } from "../src/domains/masters/definitions.js";
import { validateCensusJpeg } from "../src/domains/masters/photo.js";
import { SAMPLE_IMAGE } from "../src/domains/masters/catalogue.js";
import { currentOutletTaxonomy } from "../src/domains/masters/taxonomy.js";
import { encode as encodeJpeg } from "jpeg-js";
import {
  canonicalOutletId,
  nameSimilarity,
} from "../src/domains/masters/outlets.js";
import { seedDemo } from "../../../packages/db/seed/index.js";
import {
  seedSpecMasters,
  sampleCatalogueIngredients,
} from "../../../packages/db/seed/spec-masters.js";
import { rowId, todayManila, plusDays } from "../../../packages/db/seed/store.js";

/** @type {import('./harness.js').Harness} */ let h;
let cookie = "";
/** @type {any} */ let actor;
/** @param {string} path @param {any} [body] @param {string} [key] @param {string} [asCookie] */
async function call(path, body, key = crypto.randomUUID(), asCookie = cookie) {
  const r = await h.fetch(`/api/v1/masters/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      cookie: asCookie,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: /** @type {any} */ (await r.json()) };
}
/** @param {string} kind */
async function rows(kind) {
  const r = await call(`definitions?kind=${kind}`);
  expect(r.status).toBe(200);
  return /** @type {any[]} */ (r.body.rows);
}
/** @param {string} code @param {any} [data] */
const channel = (code, data = {}) => ({
  kind: "channel",
  code,
  label: "Test channel",
  data,
  status: "active",
  reason: "F-013 fixture",
  baseVersion: 0,
});
beforeAll(async () => {
  h = await startHarness({ installers: [org, masters] });
  // F-020 F-013/F-022: generate the future fixture through its writer, never
  // mutate the now-immutable audit log to simulate a future manifest.
  await seedDemo(h.db, { days: 3, anchorDate: plusDays(todayManila(), 1) });
  const [futureManifest] = await h.db`select created_at from audit_logs where id=${rowId("audit_logs", "manifest")}`;
  expect(new Date(futureManifest.created_at).getTime()).toBeGreaterThan(Date.now());
  await tx(h.db, seedSpecMasters);
  const password = (
    await Bun.file(`${process.env.HOME}/.sunpride-keys/v2-test-password`).text()
  ).trim();
  const r = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@sunpride.test", password }),
  });
  expect(r.status).toBe(200);
  cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  const me = await h.fetch("/api/me", { headers: { cookie } });
  const m = /** @type {any} */ (await me.json());
  actor = {
    userId: m.user.id,
    profileId: m.profile.id,
    role: "admin",
    orgUnitId: m.profile.orgUnitId,
  };
}, 120000);
afterAll(async () => {
  await h?.close();
});

test("F-616 invented ingredient families match beef, chicken and fruit examples without product claims", () => {
  expect(sampleCatalogueIngredients("Sample Beef Burger")).toContain("beef");
  expect(sampleCatalogueIngredients("Sample Beef Burger")).not.toContain(
    "pork",
  );
  expect(sampleCatalogueIngredients("Sample Chicken Hotdog")).toContain(
    "chicken",
  );
  expect(sampleCatalogueIngredients("Sample Calamansi Drink")).toContain(
    "fruit juice",
  );
  expect(sampleCatalogueIngredients("Unknown sample food")).toContain(
    "not an ingredient declaration",
  );
});
test("F-013/F-017 marked seed is idempotent, maps legacy outlet keys and publishes 20 class/channel profiles", async () => {
  const before =
    await h.db`select id,version,data from master_versions order by id`;
  const result = await tx(h.db, seedSpecMasters);
  expect(result).toEqual({
    channels: 5,
    subchannels: 9,
    mslProfiles: 20,
    branches: 3,
  });
  expect(
    await h.db`select id,version,data from master_versions order by id`,
  ).toEqual(before);
  expect((await rows("channel")).every((r) => r.sample)).toBe(true);
  expect((await rows("subchannel")).length).toBe(9);
  // F-009/F-010 sample masters must be usable in the real map/editor, not only
  // in source-write tests. Bun SQL integer arrays must become ordinary JSON arrays.
  const beats = await rows("beat");
  expect(beats.length).toBeGreaterThan(0);
  expect(
    beats.every(
      (r) => Array.isArray(r.data.weekdays) && r.data.weekdays.length > 0,
    ),
  ).toBe(true);
  const geographies = await rows("geography");
  for (const g of geographies) {
    if (g.data.parentId) {
      const parent = geographies.find((r) => r.id === g.data.parentId);
      expect(
        g.data.polygon.coordinates[0].every(
          (/** @type {[number,number]} */ p) =>
            contains(p, parent.data.polygon.coordinates[0]),
        ),
      ).toBe(true);
    }
    if (g.data.type !== "territory") continue;
    const pins =
      await h.db`select p.longitude,p.latitude from outlet_pins p join outlet_assignments a on a.outlet_id=p.outlet_id where a.territory_id=${g.data.territoryId} and a.effective_to is null and a.deleted_at is null and p.status='verified' and p.effective_to is null and p.deleted_at is null`;
    expect(pins.length).toBeGreaterThan(0);
    expect(
      pins.every((/** @type {any} */ p) =>
        contains(
          [Number(p.longitude), Number(p.latitude)],
          g.data.polygon.coordinates[0],
        ),
      ),
    ).toBe(true);
  }
  const [unmapped] =
    await h.db`select count(*)::int n from outlets where code like 'SMP-%' and channel_id is null`;
  expect(unmapped.n).toBe(0);
  const framework = await call("msl-framework");
  expect(framework.status).toBe(200);
  expect(framework.body.rows.length).toBe(20);
  expect(
    framework.body.rows.every(
      (/** @type {any} */ r) =>
        r.data.productIds.length > 0 && r.versionId && r.effectiveFrom,
    ),
  ).toBe(true);
});
test("F-013 master writes validate capability before returning receipts and reject unknown fields", async () => {
  expect(
    (await call("definitions/save", channel("NOAUTH"), undefined, "")).status,
  ).toBe(401);
  expect(
    (await call("definitions/save", channel("BAD", { arbitrary: true })))
      .status,
  ).toBe(422);
  const key = crypto.randomUUID(),
    input = channel("REPLAY");
  const a = await call("definitions/save", input, key),
    b = await call("definitions/save", input, key);
  expect(a.status).toBe(200);
  expect(b.body).toEqual(a.body);
  expect(
    (await call("definitions/save", { ...input, label: "Changed" }, key))
      .status,
  ).toBe(409);
  expect((await call("definitions/save", input)).status).toBe(409);
});
test("F-009 boundary validation rejects self intersections, bad closure, holes and concave-parent bridges", () => {
  for (const ring of [
    [
      [0, 0],
      [2, 2],
      [0, 2],
      [2, 0],
      [0, 0],
    ],
    [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 1],
    ],
    [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 0],
    ],
  ])
    expect(() => polygon({ type: "Polygon", coordinates: [ring] })).toThrow();
  expect(() =>
    polygon({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 0],
        ],
        [
          [0.1, 0.1],
          [0.2, 0.1],
          [0.1, 0.2],
          [0.1, 0.1],
        ],
      ],
    }),
  ).toThrow();
  const parent = polygon({
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [3, 4],
        [3, 1],
        [1, 1],
        [1, 4],
        [0, 4],
        [0, 0],
      ],
    ],
  }).coordinates[0];
  expect(
    containedRing(
      [
        [0.5, 2],
        [3.5, 2],
        [3.5, 3],
        [0.5, 3],
        [0.5, 2],
      ],
      parent,
    ),
  ).toBe(false);
});
test("F-009 parent tiers, containment, immutable revisions and stale editors are enforced", async () => {
  const geos = await rows("geography"),
    area = geos.find((r) => r.data.type === "area"),
    territory = geos.find((r) => r.data.type === "territory");
  const input = {
    kind: "geography",
    code: "ZONE-NEW",
    label: "A zone",
    orgUnitId: territory.orgUnitId,
    baseVersion: 0,
    status: "active",
    reason: "F-009 fixture",
    data: { type: "zone", parentId: area.id, polygon: territory.data.polygon },
  };
  expect((await call("definitions/save", input)).status).toBe(422);
  input.data.parentId = territory.id;
  input.data.polygon = {
    type: "Polygon",
    coordinates: [
      [
        [1, 1],
        [2, 1],
        [2, 2],
        [1, 1],
      ],
    ],
  };
  expect((await call("definitions/save", input)).status).toBe(422);
  input.data.polygon = territory.data.polygon;
  const saved = await call("definitions/save", input);
  expect(saved.status).toBe(200);
  const revised = await call("definitions/save", {
    ...input,
    label: "Renamed zone",
    baseVersion: 1,
  });
  expect(revised.status).toBe(200);
  const history = await call(`history/${saved.body.id}`);
  expect(history.body.rows.length).toBe(2);
  expect(history.body.rows[1].label).toBe("A zone");
  let refused = false;
  try {
    await h.db`update master_versions set label='tampered' where id=${saved.body.versionId}`;
  } catch {
    refused = true;
  }
  expect(refused).toBe(true);
  expect(
    (await call("definitions/save", { ...input, baseVersion: 1 })).status,
  ).toBe(409);
});
test("F-010 beats include durable weekday cycle, rep, endpoints, expected stops and distance; invalid double assignments fail", async () => {
  const beat = (await rows("beat"))[0];
  expect(beat).toBeDefined();
  expect(beat.data.weekdays.length).toBeGreaterThan(0);
  expect(beat.data.expectedOutlets).toBe(25);
  expect(beat.data.distanceMeters).toBe(24000);
  const input = {
    ...beat,
    baseVersion: beat.version,
    label: "Changed itinerary",
    reason: "F-010 test",
    effectiveFrom: null,
    data: { ...beat.data, cycleWeeks: 2 },
  };
  expect(
    (
      await call("definitions/save", {
        ...input,
        data: { ...input.data, weekdays: [1, 1] },
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call("definitions/save", {
        ...input,
        data: { ...input.data, vanId: crypto.randomUUID() },
      })
    ).status,
  ).toBe(422);
  const revised = await call("definitions/save", input);
  expect(revised.status).toBe(200);
  expect(revised.body.version).toBe(2);
  expect(revised.body.data.cycleWeeks).toBe(2);
});
test("F-014 potential scoring is independent of actual sales, retains policy version and explains overrides", async () => {
  const inputs = {
    transactionsPerDay: 100,
    averageBasketCentavos: 10000,
    tradingDaysPerMonth: 30,
    captureRatePct: 50,
  };
  const preview = await call("class-preview", { inputs });
  expect(preview.status).toBe(200);
  expect(preview.body.potentialCentavos).toBe(15000000);
  expect(preview.body.derivedClass).toBe("C");
  const outletId = rowId("outlets", "0");
  const [outlet] = await h.db`select id from outlets order by code limit 1`;
  const saved = await call("outlets/classify", {
    outletId: outlet.id,
    policyVersionId: preview.body.policyVersionId,
    inputs,
    overrideClass: "B",
    reason: "Estimated new freezer capacity",
  });
  expect(saved.status).toBe(200);
  expect(saved.body.assignedClass).toBe("B");
  const history = await call(`outlets/${outlet.id}/history`);
  expect(history.body.decisions[0].inputs).toEqual(inputs);
  expect(history.body.decisions[0].reason).toBe(
    "Estimated new freezer capacity",
  );
  expect(
    (
      await call("outlets/classify", {
        outletId: outlet.id,
        policyVersionId: crypto.randomUUID(),
        inputs,
        reason: "stale",
      })
    ).status,
  ).toBe(422);
  expect(() =>
    potentialClass({ ...inputs, transactionsPerDay: -1 }, { bands: [] }),
  ).toThrow();
});
test("F-017 one profile per exact criteria, valid product set and matching sub-channel; invalid edits leave prior content intact", async () => {
  const profile = (await rows("msl"))[0],
    sub = (await rows("subchannel")).find(
      (r) => r.data.channelId !== profile.data.channelId,
    );
  expect(
    (
      await call("definitions/save", {
        ...profile,
        code: "MSL-DUP",
        baseVersion: 0,
        reason: "F-017 duplicate",
        effectiveFrom: null,
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call("definitions/save", {
        ...profile,
        baseVersion: 1,
        reason: "F-017 invalid",
        effectiveFrom: null,
        data: { ...profile.data, subchannelId: sub.id },
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call("definitions/save", {
        ...profile,
        baseVersion: 1,
        reason: "F-017 invalid",
        effectiveFrom: null,
        data: { ...profile.data, productIds: [crypto.randomUUID()] },
      })
    ).status,
  ).toBe(422);
  expect((await rows("msl")).find((r) => r.id === profile.id).version).toBe(1);
});
test("F-305 chain → banner → branch preserves outlet and effective SAP accounting mapping", async () => {
  const chain = (await rows("chain"))[0],
    banner = (await rows("banner"))[0],
    branch = (await rows("branch"))[0];
  expect(banner.data.chainId).toBe(chain.id);
  expect(branch.data.bannerId).toBe(banner.id);
  const [link] =
    await h.db`select 1 from outlet_customer_links where outlet_id=${branch.data.outletId} and customer_id=${branch.data.sapCustomerId}`;
  expect(link).toBeDefined();
  expect(
    (
      await call("definitions/save", {
        ...branch,
        baseVersion: 1,
        reason: "F-305 invalid mapping",
        effectiveFrom: null,
        data: { ...branch.data, sapCustomerId: crypto.randomUUID() },
      })
    ).status,
  ).toBe(422);
});
test("F-012 candidates combine contact/name/proximity and audited merge preserves every original reference", async () => {
  const [source] =
    await h.db`select * from outlets where status='active' order by code limit 1`;
  const [pin] =
    await h.db`select * from outlet_pins where outlet_id=${source.id} and status='verified' limit 1`;
  const [other] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,address,created_by) values('sunpride','TEST-DUP',${source.name},'active',${source.custodian_org_unit_id},${source.address},'test') returning id`;
  await h.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at) values(${other.id},${pin.latitude + 0.0001},${pin.longitude},75,'test','verified',now()-interval '1 minute','test',now())`;
  await h.db`insert into outlet_contacts(outlet_id,ordinal,name,phone) values(${source.id},100,'Owner','0917 123 4567'),(${other.id},0,'Owner','09171234567')`;
  const candidates = await call(`outlets/${source.id}/duplicates`);
  expect(candidates.status).toBe(200);
  expect(
    candidates.body.candidates.some(
      (/** @type {any} */ r) =>
        r.id === other.id && r.sameContact && r.distanceMeters < 50,
    ),
  ).toBe(true);
  const before =
    await h.db`select id from planned_visits where outlet_id=${source.id} order by id`;
  const result = await call("outlets/merge", {
    sourceOutletId: source.id,
    survivorOutletId: other.id,
    reason: "F-012 same physical store",
  });
  expect(result.status).toBe(200);
  expect(await canonicalOutletId(h.db, source.id)).toBe(other.id);
  expect(
    await h.db`select id from planned_visits where outlet_id=${source.id} order by id`,
  ).toEqual(before);
  expect(
    (
      await call("outlets/merge", {
        sourceOutletId: other.id,
        survivorOutletId: source.id,
        reason: "cycle",
      })
    ).status,
  ).toBe(422);
  expect(nameSimilarity("Café Maria Store", "Cafe Maria store")).toBe(1);
});
test("F-011 JPEG validation decodes a real image and rejects header-only or over-budget evidence", async () => {
  const bytes = new Uint8Array(await Bun.file(SAMPLE_IMAGE).arrayBuffer());
  expect(validateCensusJpeg(bytes)).toEqual({ width: 480, height: 480 });
  expect(() =>
    validateCensusJpeg(new Uint8Array([255, 216, 255, 217])),
  ).toThrow();
  expect(() => validateCensusJpeg(new Uint8Array(160 * 1024 + 1))).toThrow();
});
test("F-011 signed census capture enforces under-50m GPS, offline replay and separate reviewed outlet creation", async () => {
  const password = "census-test-only-password",
    email = `census-${crypto.randomUUID()}@example.com`;
  const userId = await createUser(h, email, password),
    unitId = rowId("org_units", "territory-0");
  const [profile] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${userId},${userId},'Census rep',${email},'sales','active',${unitId}) returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${profile.id},${unitId},'sales',${new Date(0)},${userId},'F-011 valid active field assignment')`;
  const key = await deviceKey(),
    deviceId = await registerDevice(h, {
      profileId: profile.id,
      orgUnitId: unitId,
      key,
    });
  const { body: tokens } = await nativeSignIn(
    h,
    email,
    password,
    "field-android",
    { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
  );
  expect((await bind(h, tokens.accessToken, deviceId, key)).res.status).toBe(
    200,
  );
  const who = { access: tokens.accessToken, deviceId, key };
  const conf = await h.fetch("/api/v1/masters/census-config", {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  expect(conf.status).toBe(200);
  const config = /** @type {any} */ (await conf.json());
  expect(config.batches.length).toBe(1);
  const sub = config.subchannels[0],
    channelId = sub.data.channelId;
  const at = Date.now(),
    captureId = crypto.randomUUID();
  const payload = {
    captureId,
    batchId: config.batches[0].id,
    name: "Sample census store",
    address: "Invented test address",
    ownerName: "Sample owner",
    ownerPhone: "09171234567",
    channelId,
    subchannelId: sub.id,
    estimatedClass: "C",
    deviceTime: at,
    location: {
      latitude: 10.32,
      longitude: 123.9,
      accuracyMeters: 12,
      fixTime: at,
      mockSignal: false,
      provider: "gps",
    },
    photoJpegBase64: Buffer.from(
      await Bun.file(SAMPLE_IMAGE).arrayBuffer(),
    ).toString("base64"),
  };
  const op = {
    clientOpId: captureId,
    opType: "census.capture",
    clientTime: at,
    dependsOn: [],
    payload,
  };
  const push = async (/** @type {any} */ operation) =>
    signedPost(h, who, "/api/sync/push", {
      version: 2,
      app: "field-android",
      deviceId,
      scopeId: unitId,
      operations: [operation],
    });
  for (const accuracy of [50, 51]) {
    const invalid = await push({
      ...op,
      clientOpId: crypto.randomUUID(),
      payload: {
        ...payload,
        captureId: crypto.randomUUID(),
        location: { ...payload.location, accuracyMeters: accuracy },
      },
    });
    expect(invalid.body.results[0].status).toBe("rejected");
  }
  const sent = await push(op);
  expect(sent.res.status).toBe(200);
  expect(sent.body.results[0].status).toBe("applied");
  expect((await push(op)).body.results[0].status).toBe("duplicate");
  const [saved] =
    await h.db`select * from census_captures where id=${captureId}`;
  expect(saved.accuracy_meters).toBe(12);
  expect(saved.location_provider).toBe("gps");
  expect(new Date(saved.location_recorded_at).getTime()).toBe(at);
  expect(saved.device_id).toBe(deviceId);
  expect(saved.estimated_class).toBe("C");
  const photo = await h.fetch(`/api/v1/masters/census/${captureId}/photo`, {
    headers: { cookie },
  });
  expect(photo.status).toBe(200);
  expect(photo.headers.get("cache-control")).toContain("no-store");
  const queue = await call("census-queue");
  expect(queue.status).toBe(200);
  expect(
    queue.body.rows.some((/** @type {any} */ r) => r.id === captureId),
  ).toBe(true);
  const review = await call("census/review", {
    captureId,
    decision: "accept",
    code: "CENSUS-TEST-001",
    reason: "Verified synthetic fixture",
  });
  expect(review.status).toBe(200);
  const [outlet] =
    await h.db`select * from outlets where id=${review.body.outletId}`;
  expect(outlet.channel_id).toBe(channelId);
  // F-014: a survey estimate is evidence, not an approved potential assessment.
  expect(outlet.classification).toBeNull();
  const [pin] =
    await h.db`select * from outlet_pins where outlet_id=${outlet.id}`;
  expect(pin.status).toBe("verified");
  expect(
    (
      await call("census/review", {
        captureId,
        decision: "reject",
        reason: "Already reviewed",
      })
    ).status,
  ).toBe(422);
});

test("F-009/F-305 current organizational scope filters historical masters and forbids cross-scope writes", async () => {
  const [p] =
    await h.db`select * from profiles where id=${rowId("profiles", "agent")}`;
  const user = await h.db`select email from users where id=${p.user_id}`;
  const password = (
    await Bun.file(`${process.env.HOME}/.sunpride-keys/v2-test-password`).text()
  ).trim();
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user[0].email, password }),
  });
  const agentCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const geos = await call(
    "definitions?kind=geography",
    undefined,
    undefined,
    agentCookie,
  );
  expect(geos.status).toBe(200);
  expect(
    geos.body.rows.every(
      (/** @type {any} */ r) => r.orgUnitId === p.org_unit_id,
    ),
  ).toBe(true);
  expect(
    (
      await call(
        "definitions/save",
        channel("AGENT-WRITE"),
        undefined,
        agentCookie,
      )
    ).status,
  ).toBe(403);
  const options = await call("options");
  expect(options.status).toBe(200);
  expect(options.body.products.length).toBeGreaterThan(0);
});

test("F-616 marked catalogue content and exact pack hierarchy include a real bounded image", async () => {
  const response = await call("catalogue");
  expect(response.status).toBe(200);
  const p = response.body.rows.find((/** @type {any} */ p) => p.catalogue);
  expect(p.catalogue.source).toBe("sample");
  expect(p.catalogue.sample).toBe(true);
  for (const key of [
    "description",
    "ingredients",
    "allergens",
    "storage",
    "caseSpecifications",
  ])
    expect(p.catalogue[key].length).toBeGreaterThan(0);
  expect(p.catalogue.packHierarchy.length).toBeGreaterThan(0);
  expect(
    p.catalogue.packHierarchy.every(
      (/** @type {any} */ u) =>
        u.numerator === null || (u.numerator > 0 && u.denominator > 0),
    ),
  ).toBe(true);
  const image = await h.fetch(p.catalogue.image.path, { headers: { cookie } });
  expect(image.status).toBe(200);
  const bytes = new Uint8Array(await image.arrayBuffer());
  expect(bytes.length).toBe(p.catalogue.image.bytes);
  expect(bytes.length).toBeLessThan(524288);
  expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(
    p.catalogue.image.sha256,
  );
  expect(JSON.stringify(p.catalogue)).not.toContain("unitPrice");
});
test("F-616 uploaded product images bind to owner and product and remain frozen across later revisions", async () => {
  const setup = await call("catalogue"),
    [p, other] = setup.body.rows.filter((/** @type {any} */ p) => p.catalogue),
    c = p.catalogue;
  const photoA = encodeJpeg(
    { width: 32, height: 32, data: new Uint8Array(32 * 32 * 4).fill(128) },
    75,
  ).data;
  const photoB = encodeJpeg(
    { width: 32, height: 32, data: new Uint8Array(32 * 32 * 4).fill(64) },
    75,
  ).data;
  expect(
    (
      await call("catalogue/image", {
        productId: p.id,
        jpegBase64: Buffer.from([255, 216, 255, 217]).toString("base64"),
      })
    ).status,
  ).toBe(422);
  const uploadA = await call("catalogue/image", {
    productId: p.id,
    jpegBase64: photoA.toString("base64"),
  });
  expect(uploadA.status).toBe(200);
  const payload = {
    productId: p.id,
    baseRevision: c.revision,
    description: c.description,
    ingredients: c.ingredients,
    allergens: c.allergens,
    storage: c.storage,
    caseSpecifications: c.caseSpecifications,
    shelfLifeDays: c.shelfLifeDays,
    reason: "F-616 reviewed product image",
    imageFileId: uploadA.body.id,
  };
  expect(
    (
      await call("catalogue/save", {
        ...payload,
        productId: other.id,
        baseRevision: other.catalogue.revision,
      })
    ).status,
  ).toBe(422);
  const first = await call("catalogue/save", payload);
  expect(first.status).toBe(200);
  const pathA = `/api/v1/masters/catalogue-images/${first.body.id}`;
  const readA = await h.fetch(pathA, { headers: { cookie } });
  expect(readA.status).toBe(200);
  expect(new Uint8Array(await readA.arrayBuffer())).toEqual(
    new Uint8Array(photoA),
  );
  const uploadB = await call("catalogue/image", {
    productId: p.id,
    jpegBase64: photoB.toString("base64"),
  });
  expect(uploadB.status).toBe(200);
  const second = await call("catalogue/save", {
    ...payload,
    baseRevision: first.body.revision,
    imageFileId: uploadB.body.id,
  });
  expect(second.status).toBe(200);
  const old = await h.fetch(pathA, { headers: { cookie } }),
    latest = await h.fetch(
      `/api/v1/masters/catalogue-images/${second.body.id}`,
      { headers: { cookie } },
    );
  expect(new Uint8Array(await old.arrayBuffer())).toEqual(
    new Uint8Array(photoA),
  );
  expect(new Uint8Array(await latest.arrayBuffer())).toEqual(
    new Uint8Array(photoB),
  );
  expect(new Bun.CryptoHasher("sha256").update(photoA).digest("hex")).not.toBe(
    new Bun.CryptoHasher("sha256").update(photoB).digest("hex"),
  );
});
test("F-013 reviewed legacy cutover includes unmarked client rows, detects drift and never guesses unknown keys", async () => {
  const channels = await rows("channel"),
    subs = await rows("subchannel");
  const gt = channels.find((c) => c.code === "GT"),
    mt = channels.find((c) => c.code === "MT");
  const gtSub = subs.find((s) => s.data.channelId === gt.id),
    mtSub = subs.find((s) => s.data.channelId === mt.id);
  const unit = rowId("org_units", "territory-0");
  const [known] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,enrolment_status,created_by) values('sunpride','LEGACY-KNOWN','Retained legacy store','active',${unit},'gt','approved',${actor.userId}) returning id`;
  const [unknown] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,enrolment_status,created_by) values('sunpride','LEGACY-UNKNOWN','Retained unknown store','active',${unit},'original-unknown-key','approved',${actor.userId}) returning id`;
  const [partial] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,channel_id,enrolment_status,created_by) values('sunpride','LEGACY-PARTIAL','Already reviewed channel','active',${unit},'gt',${mt.id},'approved',${actor.userId}) returning id`;
  const [customer] =
    await h.db`insert into customers(code,name,channel,territory,credit_limit,active) values('LEGACY-CUSTOMER','Retained legacy customer','gt','Retained source territory',1250.50,true) returning id`;
  const [unknownCustomer] =
    await h.db`insert into customers(code,name,channel,territory,credit_limit,active) values('LEGACY-UNKNOWN-CUSTOMER','Retained unknown customer','original-customer-key','Retained source territory',750.25,true) returning id`;
  const [explicitCustomer] =
    await h.db`insert into customers(code,name,channel,channel_id,territory,credit_limit,active) values('EXPLICIT-CUSTOMER','Governed customer source','external-source-category',${mt.id},'Retained source territory',100.00,true) returning channel_id`;
  expect(explicitCustomer.channel_id).toBe(mt.id);
  await h.db`update outlets set channel_id=null,subchannel_id=null where id=${known.id}`;
  await h.db`update customers set channel_id=null where id=${customer.id}`;
  const [marked] =
    await h.db`select count(*)::int n from sample_data_rows where row_id in(${known.id},${customer.id})`;
  expect(marked.n).toBe(0);
  const preview = await call("taxonomy-migration");
  expect(preview.status).toBe(200);
  expect(preview.body.readyOutlets).toBeGreaterThan(0);
  expect(preview.body.readyCustomers).toBeGreaterThan(0);
  expect(
    preview.body.unknown.some((/** @type {any} */ r) => r.id === unknown.id),
  ).toBe(true);
  expect(
    preview.body.unknown.some((/** @type {any} */ r) => r.id === partial.id),
  ).toBe(true);
  await h.db`update outlets set channel='changed-source-key' where id=${known.id}`;
  expect(
    (
      await call("taxonomy-migration/apply", {
        previewHash: preview.body.previewHash,
        reason: "Reviewed known source keys",
      })
    ).status,
  ).toBe(422);
  const [unwritten] =
    await h.db`select channel_id from customers where id=${customer.id}`;
  expect(unwritten.channel_id).toBeNull();
  await h.db`update outlets set channel='gt' where id=${known.id}`;
  await h.db`update outlets set channel_id=null,subchannel_id=null where id=${known.id}`;
  const fresh = await call("taxonomy-migration"),
    key = crypto.randomUUID(),
    payload = {
      previewHash: fresh.body.previewHash,
      reason: "F-013 reviewed client cutover",
    };
  const applied = await call("taxonomy-migration/apply", payload, key);
  expect(applied.status).toBe(200);
  expect(applied.body.outlets).toBeGreaterThan(0);
  expect(applied.body.customers).toBeGreaterThan(0);
  expect((await call("taxonomy-migration/apply", payload, key)).body).toEqual(
    applied.body,
  );
  const [store] =
    await h.db`select channel,channel_id,subchannel_id from outlets where id=${known.id}`;
  expect(store.channel).toBe("gt");
  expect(store.channel_id).toBe(gt.id);
  expect(store.subchannel_id).not.toBeNull();
  const [account] =
    await h.db`select channel,channel_id,territory,credit_limit::text credit from customers where id=${customer.id}`;
  expect(account.channel).toBe("gt");
  expect(account.channel_id).toBe(gt.id);
  expect(account.territory).toBe("Retained source territory");
  expect(account.credit).toBe("1250.50");
  const [kept] =
    await h.db`select channel_id,subchannel_id from outlets where id=${partial.id}`;
  expect(kept.channel_id).toBe(mt.id);
  expect(kept.subchannel_id).toBeNull();
  expect(
    (
      await call("taxonomy-migration/assign", {
        kind: "outlet",
        id: partial.id,
        channelId: gt.id,
        subchannelId: gtSub.id,
        reason: "Cannot overwrite a prior decision",
      })
    ).status,
  ).toBe(422);
  for (const p of [
    {
      kind: "outlet",
      id: unknown.id,
      channelId: gt.id,
      subchannelId: gtSub.id,
    },
    {
      kind: "outlet",
      id: partial.id,
      channelId: mt.id,
      subchannelId: mtSub.id,
    },
    { kind: "customer", id: unknownCustomer.id, channelId: gt.id },
  ])
    expect(
      (
        await call("taxonomy-migration/assign", {
          ...p,
          reason: "F-013 reviewed unknown source",
        })
      ).status,
    ).toBe(200);
  const [original] =
    await h.db`select channel,channel_id from outlets where id=${unknown.id}`;
  expect(original.channel).toBe("original-unknown-key");
  expect(original.channel_id).toBe(gt.id);
  const [untouched] =
    await h.db`select credit_limit::text credit,channel from customers where id=${unknownCustomer.id}`;
  expect(untouched.credit).toBe("750.25");
  expect(untouched.channel).toBe("original-customer-key");
  const resolved = await currentOutletTaxonomy(
    { db: h.db, actor, now: Date.now() },
    unknown.id,
  );
  expect(resolved.status).toBe("resolved");
  expect(resolved.channelId).toBe(gt.id);
});

test("F-616 catalogue revisions are prospective, append-only, receipt-safe and cannot overwrite SAP", async () => {
  const setup = await call("catalogue"),
    p = setup.body.rows.find((/** @type {any} */ p) => p.catalogue),
    c = p.catalogue;
  const at = Date.now() + 86400000,
    key = crypto.randomUUID(),
    payload = {
      productId: p.id,
      baseRevision: c.revision,
      description: "SAMPLE updated description",
      ingredients: c.ingredients,
      allergens: c.allergens,
      storage: c.storage,
      caseSpecifications: c.caseSpecifications,
      shelfLifeDays: 180,
      effectiveFrom: at,
      reason: "F-616 reviewed sample content",
    };
  const result = await call("catalogue/save", payload, key);
  expect(result.status).toBe(200);
  expect(result.body.revision).toBe(c.revision + 1);
  expect((await call("catalogue/save", payload, key)).body).toEqual(
    result.body,
  );
  const current = await call("catalogue");
  expect(
    current.body.rows.find((/** @type {any} */ r) => r.id === p.id).catalogue
      .revision,
  ).toBe(c.revision);
  expect(
    (
      await call(
        "catalogue/save",
        { ...payload, description: "Another description" },
        key,
      )
    ).status,
  ).toBe(409);
  expect((await call("catalogue/save", payload)).status).toBe(422);
  await expect(
    (async () => {
      await h.db`update product_catalogue_versions set ingredients='Altered history' where id=${c.versionId}`;
    })(),
  ).rejects.toThrow();
  await h.db`update product_catalogue_versions set effective_to=${new Date(at + 86400000)} where id=${result.body.id}`;
  await h.db`insert into product_catalogue_versions(product_id,revision,source,source_reference,description,ingredients,allergens,storage,shelf_life_days,case_specifications,effective_from) values(${p.id},${result.body.revision + 1},'sap','F-616-MOCK-SAP','SAP description','SAP ingredients','SAP allergens','SAP storage',180,'SAP case specs',${new Date(at + 86400000)})`;
  expect(
    (
      await call("catalogue/save", {
        ...payload,
        baseRevision: result.body.revision + 1,
      })
    ).status,
  ).toBe(422);
});
