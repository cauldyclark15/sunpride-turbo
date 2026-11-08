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
import { install as masters } from "../src/domains/masters/index.js";
import { setPlacesFetch } from "../src/domains/masters/places.js";
import { runDueJobs } from "../src/core/jobs.js";
import { SAMPLE_IMAGE } from "../src/domains/masters/catalogue.js";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { seedSpecMasters } from "../../../packages/db/seed/spec-masters.js";
import {
  rowId,
  todayManila,
  plusDays,
} from "../../../packages/db/seed/store.js";

const FAKE_KEY = "test-only-fake-google-key";
/** @type {import('./harness.js').Harness} */ let h;
const cookies = /** @type {Record<string,string>} */ ({});
/** @type {string[]} */ let calls = [];
/** @type {(url: URL) => any} */ let google = () => ({
  status: "ZERO_RESULTS",
});
let photo = "";
/** @type {any} */ let config;

function stub() {
  calls = [];
  setPlacesFetch(async (/** @type {string} */ raw) => {
    const url = new URL(raw);
    calls.push(raw);
    const answer = google(url);
    if (answer instanceof Error) throw answer;
    if (answer?.httpStatus)
      return new Response("upstream says no " + raw, {
        status: answer.httpStatus,
      });
    return Response.json(answer);
  });
}
/** @param {string} role */
async function signIn(role) {
  const password = (
    await Bun.file(`${process.env.HOME}/.sunpride-keys/v2-test-password`).text()
  ).trim();
  const r = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${role}@sunpride.test`, password }),
  });
  expect(r.status).toBe(200);
  cookies[role] = r.headers.get("set-cookie")?.split(";")[0] ?? "";
}
/** @param {string} role @param {string} path @param {any} [body] */
async function as(role, path, body) {
  const r = await h.fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      cookie: cookies[role],
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return {
    status: r.status,
    text,
    body: /** @type {any} */ (text ? JSON.parse(text) : null),
  };
}
/** Field rep on a bound phone of the given app. @param {string} app */
async function fieldRep(app, unit = rowId("org_units", "territory-0")) {
  const password = "census-test-only-password",
    email = `cg-${crypto.randomUUID()}@example.com`;
  const userId = await createUser(h, email, password),
    unitId = unit;
  const [profile] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${userId},${userId},'Gathering rep',${email},'sales','active',${unitId}) returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${profile.id},${unitId},'sales',${new Date(0)},${userId},'SP-0162 active field assignment')`;
  const key = await deviceKey(),
    deviceId = await registerDevice(h, {
      profileId: profile.id,
      orgUnitId: unitId,
      key,
      app,
    });
  const { body: tokens } = await nativeSignIn(h, email, password, app, {
    keyId: key.keyId,
    publicKeySpki: key.publicKeySpki,
  });
  expect((await bind(h, tokens.accessToken, deviceId, key)).res.status).toBe(
    200,
  );
  const who = { access: tokens.accessToken, deviceId, key };
  return {
    who,
    unitId,
    profileId: profile.id,
    /** @param {string} path */
    get: async (path) => {
      const r = await h.fetch(path, {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      return { status: r.status, body: /** @type {any} */ (await r.json()) };
    },
    /** @param {any} payload @param {string} [clientOpId] */
    push: async (payload, clientOpId = crypto.randomUUID()) =>
      (
        await signedPost(h, who, "/api/sync/push", {
          version: 2,
          app,
          deviceId,
          scopeId: unitId,
          operations: [
            {
              clientOpId,
              opType: "census.capture",
              clientTime: payload.deviceTime,
              dependsOn: [],
              payload,
            },
          ],
        })
      ).body.results[0],
  };
}
/** @param {any} [over] */
function capture(over = {}) {
  const at = Date.now();
  const sub = config.subchannels[0];
  return {
    captureId: crypto.randomUUID(),
    name: "Aling Nena Sari-Sari Store",
    address: "Purok 3, Lahug, Cebu City",
    ownerName: "Nena Cruz",
    ownerPhone: "0917 555 0101",
    channelId: sub.data.channelId,
    subchannelId: sub.id,
    estimatedClass: "C",
    deviceTime: at,
    location: {
      latitude: 10.3301,
      longitude: 123.8981,
      accuracyMeters: 12,
      fixTime: at,
      mockSignal: false,
      provider: "gps",
    },
    photoJpegBase64: photo,
    ...over,
  };
}

beforeAll(async () => {
  h = await startHarness({
    installers: [org, masters],
    env: { GOOGLE_MAPS_SERVER_KEY: FAKE_KEY },
  });
  await seedDemo(h.db, { days: 3, anchorDate: plusDays(todayManila(), 1) });
  await tx(h.db, seedSpecMasters);
  for (const role of ["admin", "manager", "viewer"]) await signIn(role);
  photo = Buffer.from(await Bun.file(SAMPLE_IMAGE).arrayBuffer()).toString(
    "base64",
  );
  stub();
}, 180000);
afterAll(async () => {
  setPlacesFetch(null);
  await h?.close();
});

test("SP-0162 places proxy maps Google answers, biases to the fix and never leaks the key", async () => {
  google = (url) => {
    if (url.pathname.endsWith("/place/autocomplete/json"))
      return {
        status: "OK",
        predictions: Array.from({ length: 7 }, (_, i) => ({
          place_id: `ChIJ-${i}`,
          description: `SM Seaside ${i}, Cebu City`,
          structured_formatting: {
            main_text: `SM Seaside ${i}`,
            secondary_text: "Cebu City",
          },
        })),
      };
    if (url.pathname.endsWith("/place/details/json"))
      return {
        status: "OK",
        result: {
          place_id: url.searchParams.get("place_id"),
          formatted_address: "SRP, Cebu City, Cebu, Philippines",
          geometry: { location: { lat: 10.2817, lng: 123.8807 } },
          address_components: [
            { long_name: "12", types: ["street_number"] },
            { long_name: "Cebu South Coastal Rd", types: ["route"] },
            {
              long_name: "Mambaling",
              types: ["sublocality_level_1", "sublocality"],
            },
            { long_name: "Cebu City", types: ["locality"] },
            { long_name: "Cebu", types: ["administrative_area_level_2"] },
            {
              long_name: "Central Visayas",
              types: ["administrative_area_level_1"],
            },
          ],
        },
      };
    return {
      status: "OK",
      results: [
        { types: ["plus_code"], formatted_address: "8VJ9+2X Cebu City" },
        {
          types: ["street_address"],
          formatted_address: "Gorordo Ave, Lahug, Cebu City",
          address_components: [
            { long_name: "Gorordo Avenue", types: ["route"] },
            { long_name: "Lahug", types: ["neighborhood"] },
            { long_name: "Cebu City", types: ["administrative_area_level_3"] },
            { long_name: "6000", types: ["postal_code"] },
          ],
        },
      ],
    };
  };
  stub();
  const session = crypto.randomUUID();
  const auto = await as(
    "manager",
    `/api/v1/places/autocomplete?input=SM%20Sea&session=${session}&lat=10.3&lng=123.9`,
  );
  expect(auto.status).toBe(200);
  expect(auto.body.predictions.length).toBe(5);
  expect(auto.body.predictions[0]).toEqual({
    placeId: "ChIJ-0",
    primary: "SM Seaside 0",
    secondary: "Cebu City",
    description: "SM Seaside 0, Cebu City",
  });
  const sent = new URL(calls[0]);
  expect(sent.searchParams.get("components")).toBe("country:ph");
  expect(sent.searchParams.get("sessiontoken")).toBe(session);
  expect(sent.searchParams.get("location")).toBe("10.3,123.9");
  expect(sent.searchParams.get("radius")).toBe("20000");
  expect(sent.searchParams.get("language")).toBe("en");
  expect(auto.text).not.toContain(FAKE_KEY);

  const d1 = await as(
    "manager",
    `/api/v1/places/details?placeId=ChIJ-det&session=${session}`,
  );
  expect(d1.status).toBe(200);
  expect(d1.body).toEqual({
    placeId: "ChIJ-det",
    formattedAddress: "SRP, Cebu City, Cebu, Philippines",
    latitude: 10.2817,
    longitude: 123.8807,
    components: {
      street: "12 Cebu South Coastal Rd",
      barangay: "Mambaling",
      city: "Cebu City",
      province: "Cebu",
      region: "Central Visayas",
      postalCode: null,
    },
  });
  expect(new URL(calls[1]).searchParams.get("fields")).toBe(
    "formatted_address,geometry,address_component,place_id",
  );
  const before = calls.length;
  expect(
    (await as("manager", `/api/v1/places/details?placeId=ChIJ-det`)).status,
  ).toBe(200);
  expect(calls.length).toBe(before); // 24 h cache

  const rev = await as("manager", `/api/v1/places/reverse?lat=10.33&lng=123.9`);
  expect(rev.status).toBe(200);
  expect(rev.body).toEqual({
    formattedAddress: "Gorordo Ave, Lahug, Cebu City",
    components: {
      street: "Gorordo Avenue",
      barangay: "Lahug",
      city: "Cebu City",
      province: null,
      region: null,
      postalCode: "6000",
    },
  });
  expect(new URL(calls.at(-1) ?? "").searchParams.get("latlng")).toBe(
    "10.33,123.9",
  );
});

test("SP-0162 places proxy errors are plain codes with no Google URL, key or body", async () => {
  expect(
    (await as("viewer", "/api/v1/places/reverse?lat=10&lng=123")).status,
  ).toBe(403);
  expect((await h.fetch("/api/v1/places/reverse?lat=10&lng=123")).status).toBe(
    401,
  );
  expect(
    (
      await as(
        "manager",
        "/api/v1/places/autocomplete?input=ab&session=" + crypto.randomUUID(),
      )
    ).status,
  ).toBe(400);
  google = () => ({ httpStatus: 500 });
  stub();
  const bad = await as("manager", "/api/v1/places/reverse?lat=10.1&lng=123.1");
  expect(bad.status).toBe(502);
  expect(bad.body.error.code).toBe("places_unavailable");
  expect(bad.body.error.message).toBe(
    "Address search is not available right now.",
  );
  expect(bad.text).not.toContain(FAKE_KEY);
  expect(bad.text).not.toContain("googleapis");
  expect(bad.text).not.toContain("upstream");
  google = () => ({ status: "REQUEST_DENIED", error_message: "secret detail" });
  stub();
  const denied = await as(
    "manager",
    "/api/v1/places/reverse?lat=10.2&lng=123.2",
  );
  expect(denied.status).toBe(502);
  expect(denied.text).not.toContain("secret detail");
  google = () => new DOMException("The operation timed out.", "TimeoutError");
  stub();
  expect(
    (await as("manager", "/api/v1/places/reverse?lat=10.3&lng=123.3")).status,
  ).toBe(502);
  google = () => ({ status: "ZERO_RESULTS", results: [] });
  stub();
  const none = await as("manager", "/api/v1/places/reverse?lat=10.4&lng=123.4");
  expect(none.status).toBe(404);
  expect(none.body.error.code).toBe("not_found");
  const key = h.env.GOOGLE_MAPS_SERVER_KEY;
  delete h.env.GOOGLE_MAPS_SERVER_KEY;
  const off = await as("manager", "/api/v1/places/reverse?lat=10.5&lng=123.5");
  expect(off.status).toBe(503);
  expect(off.body.error.message).toBe("Address search is not set up.");
  h.env.GOOGLE_MAPS_SERVER_KEY = key;
});

test("SP-0162 places proxy limits each person to 60 requests a minute", async () => {
  google = () => ({ status: "OK", predictions: [] });
  stub();
  await h.db`delete from rate_limits where bucket_key like 'places:%'`;
  const statuses = [];
  for (let i = 0; i < 61; i++)
    statuses.push(
      (
        await as(
          "admin",
          `/api/v1/places/autocomplete?input=store${i}&session=${crypto.randomUUID()}`,
        )
      ).status,
    );
  expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
  expect(statuses[60]).toBe(429);
  const other = await as(
    "manager",
    `/api/v1/places/autocomplete?input=other&session=${crypto.randomUUID()}`,
  );
  expect(other.status).toBe(200);
});

test("SP-0162 census capture: optional batch uses the ongoing unit batch, field-ios accepted, candidates stored", async () => {
  const android = await fieldRep("field-android");
  const conf = await android.get("/api/v1/masters/census-config");
  expect(conf.status).toBe(200);
  config = conf.body;
  expect(config.addressSearch).toBe(true);
  expect(config.defaultBatch).toBeNull();
  const first = capture();
  const r1 = await android.push(first);
  expect(r1.status).toBe("applied");
  const [batch] =
    await h.db`select * from census_batches where org_unit_id=${android.unitId} and is_default`;
  expect(batch.name).toBe("Ongoing store gathering");
  expect(batch.code).toMatch(/^ONGOING-/);
  expect(batch.expected_outlets).toBe(1000);
  const after = await android.get("/api/v1/masters/census-config");
  expect(after.body.defaultBatch).toEqual({
    id: batch.id,
    name: "Ongoing store gathering",
  });
  const [saved] =
    await h.db`select * from census_captures where id=${first.captureId}`;
  expect(saved.batch_id).toBe(batch.id);
  expect(saved.location_source).toBe("gps");
  expect(saved.duplicate_flag).toBe(false);

  // Same phone next door from an iPhone: flagged, candidate stored with reasons.
  const ios = await fieldRep("field-ios");
  const second = capture({
    name: "Nena Store",
    landmark: "beside the chapel",
    addressComponents: { barangay: "Lahug", city: "Cebu City" },
    formattedAddress: "Lahug, Cebu City",
    location: { ...capture().location, latitude: 10.3302 },
  });
  const r2 = await ios.push(second);
  expect(r2.status).toBe("applied");
  const [s2] =
    await h.db`select * from census_captures where id=${second.captureId}`;
  expect(s2.app).toBe("field-ios");
  expect(s2.landmark).toBe("beside the chapel");
  expect(s2.address_components).toEqual({
    barangay: "Lahug",
    city: "Cebu City",
  });
  expect(s2.duplicate_flag).toBe(true);
  expect(s2.duplicate_candidates[0].id).toBe(first.captureId);
  expect(s2.duplicate_candidates[0].kind).toBe("capture");
  expect(s2.duplicate_candidates[0].reasons).toEqual(["phone", "nearby"]);

  // Acknowledged "different store": candidates kept, flag cleared.
  const third = capture({
    name: "JM Trading",
    ownerPhone: "0918 000 1111",
    acknowledgedDuplicateIds: [first.captureId, second.captureId],
    location: { ...capture().location, latitude: 10.3303 },
  });
  expect((await ios.push(third)).status).toBe("applied");
  const [s3] =
    await h.db`select * from census_captures where id=${third.captureId}`;
  expect(s3.duplicate_candidates.length).toBe(2);
  expect(s3.duplicate_flag).toBe(false);
  expect(s3.acknowledged_duplicate_ids).toEqual([
    first.captureId,
    second.captureId,
  ]);

  // Duplicate check endpoint is scoped and follows the same rules.
  const check = await as("manager", "/api/v1/masters/census/duplicate-check", {
    name: "Aling Nena",
    phone: "+63 917 555 0101",
    latitude: 10.3301,
    longitude: 123.8981,
  });
  expect(check.status).toBe(200);
  expect(check.body.truncated).toBe(false);
  expect(check.body.candidates[0]).toMatchObject({
    kind: "capture",
    id: first.captureId,
    code: null,
    reasons: ["phone", "nearby", "name"],
    distanceMeters: 0,
    score: 90 + 80 + 30,
  });
  const native = await h.fetch("/api/v1/masters/census/duplicate-check", {
    method: "POST",
    headers: {
      authorization: `Bearer ${android.who.access}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Aling Nena",
      excludeCaptureId: first.captureId,
    }),
  });
  expect(native.status).toBe(200);
  const nb = /** @type {any} */ (await native.json());
  expect(
    nb.candidates.some((/** @type {any} */ c) => c.id === first.captureId),
  ).toBe(false);
  expect(
    (
      await as("viewer", "/api/v1/masters/census/duplicate-check", {
        name: "x",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await as("manager", "/api/v1/masters/census/duplicate-check", {
        name: "",
      })
    ).status,
  ).toBe(400);
});

test("SP-0162 address-search capture: no Google in sync; job verifies within 50 m, flags a mismatch, retries while Google is down", async () => {
  const rep = await fieldRep("field-android");
  const placeAt = { lat: 10.3157, lng: 123.8854 };
  const real = (/** @type {URL} */ url) =>
    url.searchParams.get("place_id") === "ChIJ-real"
      ? {
          status: "OK",
          result: {
            place_id: "ChIJ-real",
            formatted_address: "Colon St, Cebu City",
            geometry: { location: placeAt },
            address_components: [],
          },
        }
      : { status: "NOT_FOUND" };
  const base = {
    locationSource: "places",
    placeId: "ChIJ-real",
    formattedAddress: "Colon St, Cebu City",
    addressComponents: { street: "Colon St", city: "Cebu City" },
    location: { latitude: 10.31571, longitude: 123.88541 },
  };
  /** @param {string} id */
  const row = async (id) =>
    (
      await h.db`select c.*,pc.place_latitude,pc.place_longitude,case when pc.capture_id is null then 'pending' else pc.status end location_status from census_captures c left join census_place_checks pc on pc.capture_id=c.id where c.id=${id}`
    )[0];
  const due = async () => {
    await h.db`update jobs set run_at=now() where kind='census.resolvePlace' and status='pending'`;
    return runDueJobs(h.db, { limit: 50 });
  };
  // Google down during sync: the op is still a plain accepted result (never retryable),
  // stored as pending with the phone's point; no Google call happens inside the op.
  google = () => ({ httpStatus: 503 });
  stub();
  const later = capture(base);
  const opId = crypto.randomUUID();
  const r = await rep.push(later, opId);
  expect(r.status).toBe("applied");
  expect(r.retryable ?? false).toBe(false);
  expect(calls.length).toBe(0);
  let saved = await row(later.captureId);
  expect(saved.location_status).toBe("pending");
  expect(saved.latitude).toBe(10.31571);
  expect(saved.accuracy_meters).toBeNull();
  const [job] =
    await h.db`select * from jobs where kind='census.resolvePlace' and coalesce_key=${later.captureId}`;
  expect(job.status).toBe("pending");
  // Job while Google is still down: retried with backoff, capture stays pending.
  await due();
  const [retry] =
    await h.db`select status,attempts,run_at,last_error from jobs where id=${job.id}`;
  expect(retry.status).toBe("pending");
  expect(Number(retry.attempts)).toBe(1);
  expect(new Date(retry.run_at).getTime()).toBeGreaterThan(Date.now());
  expect(String(retry.last_error)).not.toContain(FAKE_KEY);
  expect((await row(later.captureId)).location_status).toBe("pending");
  // Review: approve is refused while the address is being checked.
  const blocked = await as("manager", "/api/v1/masters/census/review", {
    captureId: later.captureId,
    decision: "accept",
    reason: "x",
  });
  expect(blocked.status).toBe(422);
  expect(blocked.body.error?.code ?? blocked.body.code).toBe(
    "location_pending",
  );
  // Google back: verified with the server coordinates; phone point kept.
  google = real;
  stub();
  await due();
  saved = await row(later.captureId);
  expect(saved.location_status).toBe("verified");
  expect(saved.place_latitude).toBe(placeAt.lat);
  expect(saved.place_longitude).toBe(placeAt.lng);
  expect(saved.latitude).toBe(10.31571); // the capture stays append-only evidence
  expect(saved.formatted_address).toBe("Colon St, Cebu City");
  expect(saved.address_components).toEqual({
    street: "Colon St",
    city: "Cebu City",
  });
  // Same op again: duplicate from the receipt. Same capture under a new op id: idempotent.
  expect((await rep.push(later, opId)).status).toBe("duplicate");
  calls = [];
  expect((await rep.push(later)).status).toBe("applied");
  expect(calls.length).toBe(0);
  expect((await rep.push({ ...later, landmark: "changed" })).code).toBe(
    "idempotency_conflict",
  );

  // Client point 300 m away from Google's: mismatch, both points kept.
  const far = capture({
    ...base,
    name: "Far Pin Store",
    ownerPhone: "0917 333 4444",
    location: { latitude: 10.3184, longitude: 123.8854 },
  });
  expect((await rep.push(far)).status).toBe("applied");
  const unknown = capture({
    ...base,
    name: "Gone Place Store",
    ownerPhone: "0917 333 5555",
    placeId: "ChIJ-gone",
  });
  expect((await rep.push(unknown)).status).toBe("applied");
  await due();
  const sFar = await row(far.captureId);
  expect(sFar.location_status).toBe("mismatch");
  expect(sFar.latitude).toBe(10.3184);
  expect(sFar.place_latitude).toBe(placeAt.lat);
  const sGone = await row(unknown.captureId);
  expect(sGone.location_status).toBe("mismatch");
  expect(sGone.place_latitude).toBeNull();
  // Queue exposes the status and both points for the warning.
  const q = await as("manager", "/api/v1/masters/census-queue");
  const listed = q.body.rows.find(
    (/** @type {any} */ x) => x.id === far.captureId,
  );
  expect(listed).toMatchObject({
    location_status: "mismatch",
    device_latitude: 10.3184,
    place_latitude: placeAt.lat,
  });
  // Mismatch: approve needs an explicit pin choice.
  const noChoice = await as("manager", "/api/v1/masters/census/review", {
    captureId: far.captureId,
    decision: "accept",
    reason: "x",
  });
  expect(noChoice.status).toBe(422);
  expect(noChoice.body.error?.code ?? noChoice.body.code).toBe(
    "location_mismatch",
  );
  expect(
    (
      await as("manager", "/api/v1/masters/census/review", {
        captureId: unknown.captureId,
        decision: "accept",
        pinChoice: "place",
        reason: "x",
      })
    ).status,
  ).toBe(422); // no Google point to choose
  const chosen = await as("manager", "/api/v1/masters/census/review", {
    captureId: far.captureId,
    decision: "accept",
    pinChoice: "device",
    reason: "Agent's pin is right; confirmed with the owner",
  });
  expect(chosen.status).toBe(200);
  const [pin] =
    await h.db`select * from outlet_pins where outlet_id=${chosen.body.outletId}`;
  expect(pin.latitude).toBe(10.3184);
  // Missing place id is a plain invalid request; GPS rules unchanged.
  expect((await rep.push(capture({ ...base, placeId: undefined }))).code).toBe(
    "invalid_request",
  );
  expect(
    (
      await rep.push(
        capture({ location: { ...capture().location, accuracyMeters: 50 } }),
      )
    ).code,
  ).toBe("invalid_request");
  // A second capture at the same place is a "place" duplicate.
  await h.db`delete from rate_limits where bucket_key like 'dupcheck:%'`;
  const check = await as("manager", "/api/v1/masters/census/duplicate-check", {
    name: "Something else",
    placeId: "ChIJ-real",
  });
  expect(check.body.candidates[0]).toMatchObject({
    id: later.captureId,
    reasons: ["place"],
  });
});

test("SP-0162 Google down: a places capture and a visit-style op in one push both get final acks", async () => {
  // Phones treat any retryable result as a whole-batch failure; census.capture must never
  // return one. Two ops in one batch, Google down: both final, nothing retryable.
  const rep = await fieldRep("field-android");
  google = () => new Error("network down");
  stub();
  const a = capture({
    locationSource: "places",
    placeId: "ChIJ-down",
    location: { latitude: 10.2, longitude: 123.9 },
    name: "Batch Store A",
    ownerPhone: "0917 777 0001",
  });
  const b = capture({ name: "Batch Store B", ownerPhone: "0917 777 0002" });
  const res = await signedPost(h, rep.who, "/api/sync/push", {
    version: 2,
    app: "field-android",
    deviceId: rep.who.deviceId,
    scopeId: rep.unitId,
    operations: [a, b].map((p) => ({
      clientOpId: crypto.randomUUID(),
      opType: "census.capture",
      clientTime: p.deviceTime,
      dependsOn: [],
      payload: p,
    })),
  });
  expect(res.res.status).toBe(200);
  expect(
    res.body.results.map((/** @type {any} */ x) => [
      x.status,
      Boolean(x.retryable),
    ]),
  ).toEqual([
    ["applied", false],
    ["applied", false],
  ]);
});

test("SP-0162 B1: candidates use the batch unit at capture time and the reader's scope at read time", async () => {
  const region = rowId("org_units", "visayas"),
    t0 = rowId("org_units", "territory-0"),
    t1 = rowId("org_units", "territory-1");
  // A sibling-unit outlet with the same phone, right next door.
  const sub = config.subchannels[0];
  const [sibling] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,address,created_by) values('sunpride',${"SIB" + Date.now()},'Sibling Unit Store','active',${t1},'Sibling St','test') returning id`;
  await h.db`insert into outlet_contacts(outlet_id,ordinal,name,phone) values(${sibling.id},0,'Sib','0917 888 1212')`;
  await h.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at,verified_by,verified_at) values(${sibling.id},10.401,123.901,50,'test','verified',${new Date(0)},'a',now(),'b',now())`;
  // (a) Wide (region) agent captures into a territory-0 batch: sibling not in the snapshot.
  const wide = await fieldRep("field-android", region);
  const [t0batch] =
    await h.db`insert into census_batches(code,name,org_unit_id,expected_outlets,effective_from) values(${"T0-" + Date.now()},'T0 sweep',${t0},10,${new Date(0)}) returning id`;
  const cap = capture({
    batchId: t0batch.id,
    name: "Sibling Unit Store",
    ownerPhone: "0917 888 1212",
    location: { ...capture().location, latitude: 10.401, longitude: 123.901 },
    channelId: sub.data.channelId,
  });
  expect((await wide.push(cap)).status).toBe("applied");
  const [stored] =
    await h.db`select duplicate_candidates from census_captures where id=${cap.captureId}`;
  expect(
    stored.duplicate_candidates.some(
      (/** @type {any} */ c) => c.id === sibling.id,
    ),
  ).toBe(false);
  // (b) An older snapshot that did hold the sibling: a territory-0 reviewer never sees it,
  // a region reviewer still does.
  await h.db`alter table census_captures disable trigger census_captures_immutable`;
  await h.db`update census_captures set duplicate_candidates=${[
    {
      kind: "outlet",
      id: sibling.id,
      name: "Sibling Unit Store",
      code: "X",
      address: "",
      latitude: 10.401,
      longitude: 123.901,
      distanceMeters: 0,
      reasons: ["phone"],
      score: 90,
    },
  ]} where id=${cap.captureId}`;
  await h.db`alter table census_captures enable trigger census_captures_immutable`;
  await signIn("supervisor");
  const narrow = await as("supervisor", "/api/v1/masters/census-queue");
  expect(narrow.status).toBe(200);
  const nRow = narrow.body.rows.find(
    (/** @type {any} */ r) => r.id === cap.captureId,
  );
  expect(nRow).toBeTruthy();
  expect(nRow.duplicate_candidates).toEqual([]);
  expect(narrow.text).not.toContain("Sibling St");
  const wideQ = await as("manager", "/api/v1/masters/census-queue");
  const wRow = wideQ.body.rows.find(
    (/** @type {any} */ r) => r.id === cap.captureId,
  );
  expect(wRow.duplicate_candidates.map((/** @type {any} */ c) => c.id)).toEqual(
    [sibling.id],
  );
});

test("SP-0162 SF4: the ongoing batch survives a code collision with an office round", async () => {
  const t2 = rowId("org_units", "territory-2");
  const [unit] = await h.db`select code from org_units where id=${t2}`;
  await h.db`delete from census_batches where org_unit_id=${t2} and is_default`;
  await h.db`insert into census_batches(code,name,org_unit_id,expected_outlets,effective_from) values(${`ONGOING-${unit.code}`},'Office round that took the code',${t2},10,${new Date(0)}) on conflict do nothing`;
  const rep = await fieldRep("field-android", t2);
  const c1 = capture({ name: "Collision Store", ownerPhone: "0917 222 0001" });
  expect((await rep.push(c1)).status).toBe("applied");
  const defaults =
    await h.db`select code from census_batches where org_unit_id=${t2} and is_default`;
  expect(defaults.length).toBe(1);
  expect(defaults[0].code).not.toBe(`ONGOING-${unit.code}`);
  expect(defaults[0].code.startsWith(`ONGOING-${unit.code}`)).toBe(true);
  // Next capture reuses it (lookup by flag, not code).
  expect(
    (
      await rep.push(
        capture({ name: "Collision Two", ownerPhone: "0917 222 0002" }),
      )
    ).status,
  ).toBe("applied");
  expect(
    (
      await h.db`select 1 from census_batches where org_unit_id=${t2} and is_default`
    ).length,
  ).toBe(1);
});

test("SP-0162 SF3: duplicate check is limited to 60 a minute per person", async () => {
  await h.db`delete from rate_limits where bucket_key like 'dupcheck:%'`;
  const statuses = [];
  for (let i = 0; i < 61; i++)
    statuses.push(
      (
        await as("manager", "/api/v1/masters/census/duplicate-check", {
          name: `Rate ${i}`,
        })
      ).status,
    );
  expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
  expect(statuses[60]).toBe(429);
  expect(
    (await as("admin", "/api/v1/masters/census/duplicate-check", { name: "x" }))
      .status,
  ).toBe(200);
  await h.db`delete from rate_limits where bucket_key like 'dupcheck:%'`;
});

test("SP-0162 nit: places endpoints answer 401 before validating input", async () => {
  for (const path of [
    "/api/v1/places/autocomplete?input=a",
    "/api/v1/places/details",
    "/api/v1/places/reverse?lat=x",
  ])
    expect((await h.fetch(path)).status).toBe(401);
});

test("SP-0162 review: approve with blank code uses the customer code allocator and keeps the place", async () => {
  const [row] =
    await h.db`select c.id,c.place_id,pc.place_latitude from census_captures c join census_place_checks pc on pc.capture_id=c.id left join census_reviews r on r.capture_id=c.id where pc.status='verified' and r.id is null limit 1`;
  const queue = await as("manager", "/api/v1/masters/census-queue");
  expect(queue.status).toBe(200);
  const listed = queue.body.rows.find(
    (/** @type {any} */ r) => r.id === row.id,
  );
  expect(listed.location_source).toBe("places");
  expect(listed.channel).toBeTruthy();
  const review = await as("manager", "/api/v1/masters/census/review", {
    captureId: row.id,
    decision: "accept",
    code: "",
    reason: "Checked photo and address",
  });
  expect(review.status).toBe(200);
  expect(review.body.code).toMatch(/^SP\d{6}$/);
  const [outlet] =
    await h.db`select * from outlets where id=${review.body.outletId}`;
  expect(outlet.code).toBe(review.body.code);
  expect(outlet.place_id).toBe(row.place_id);
  const [pin] =
    await h.db`select latitude from outlet_pins where outlet_id=${outlet.id}`;
  expect(pin.latitude).toBe(row.place_latitude); // Google's checked point
  // Accepted capture is now an outlet candidate (with its verified pin), not a capture.
  const check = await as("manager", "/api/v1/masters/census/duplicate-check", {
    name: "x",
    placeId: row.place_id,
  });
  expect(check.body.candidates[0]).toMatchObject({
    kind: "outlet",
    id: outlet.id,
    code: outlet.code,
  });
});

test("SP-0162 office Add store uses the outlet writer, proposes the office pin for a second person, and coverage counts it once verified", async () => {
  const setup = await as("admin", "/api/v1/masters/store-setup");
  expect(setup.status).toBe(200);
  expect(setup.body.addressSearch).toBe(true);
  const sub = setup.body.subchannels[0];
  const before = await as("admin", "/api/v1/masters/store-locations");
  expect(before.status).toBe(200);
  const add = await as("admin", "/api/v1/masters/stores/office-add", {
    name: "Office Added Store",
    address: "Mango Ave, Cebu City",
    ownerName: "Office Owner",
    ownerPhone: "0917 000 2222",
    channelId: sub.data.channelId,
    subchannelId: sub.id,
    orgUnitId: rowId("org_units", "territory-0"),
    latitude: 10.31,
    longitude: 123.89,
    placeId: "ChIJ-office",
    landmark: "near the church",
  });
  expect(add.status).toBe(200);
  expect(add.body.code).toMatch(/^SP\d{6}$/);
  const [outlet] =
    await h.db`select * from outlets where id=${add.body.outletId}`;
  expect(outlet.place_id).toBe("ChIJ-office");
  expect(outlet.directions).toBe("near the church");
  expect(outlet.channel_id).toBe(sub.data.channelId);
  const [contact] =
    await h.db`select * from outlet_contacts where outlet_id=${outlet.id}`;
  expect(contact.phone).toBe("0917 000 2222");
  const [pin] =
    await h.db`select * from outlet_pins where outlet_id=${outlet.id}`;
  // SF1: the office pin is only proposed; a different person confirms it.
  expect(pin.status).toBe("pending");
  expect(pin.source).toBe("office");
  expect(pin.id).toBe(add.body.pinId);
  expect(outlet.enrolment_status).toBeNull();
  const pending = await as(
    "admin",
    "/api/v1/masters/store-locations?q=Office%20Added",
  );
  expect(pending.body.total).toBe(before.body.total + 1);
  expect(pending.body.located).toBe(before.body.located);
  const queue = await as(
    "manager",
    "/api/v1/outlets/pins/queue?q=Office%20Added",
  );
  expect(queue.status).toBe(200);
  expect(JSON.stringify(queue.body)).toContain(pin.id);
  const self = await as("admin", "/api/v1/outlets/pins/decide", {
    pinId: pin.id,
    decision: "verified",
    reason: "mine",
  });
  expect(self.status).toBe(422);
  expect(self.text).toContain("self_verify");
  const ok = await as("manager", "/api/v1/outlets/pins/decide", {
    pinId: pin.id,
    decision: "verified",
    reason: "Pin checked on the map",
  });
  expect(ok.status).toBe(200);
  const afterAdd = await as(
    "admin",
    "/api/v1/masters/store-locations?q=Office%20Added",
  );
  expect(afterAdd.body.total).toBe(before.body.total + 1);
  expect(afterAdd.body.located).toBe(before.body.located + 1);
  expect(afterAdd.body.rows[0]).toMatchObject({
    name: "Office Added Store",
    located: true,
  });
  const missing = await as(
    "admin",
    "/api/v1/masters/store-locations?missing=1&limit=200",
  );
  expect(
    missing.body.rows.every((/** @type {any} */ r) => r.located === false),
  ).toBe(true);
  // Manager cannot add from the office (outlet.manage), and missing location is refused.
  expect(
    (await as("manager", "/api/v1/masters/stores/office-add", { name: "x" }))
      .status,
  ).toBe(403);
  const noPin = await as("admin", "/api/v1/masters/stores/office-add", {
    name: "No pin",
    address: "x",
    ownerName: "y",
    ownerPhone: "09170000000",
    channelId: sub.data.channelId,
    subchannelId: sub.id,
  });
  expect(noPin.status).toBe(422);
});
