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
import { SAMPLE_IMAGE } from "../src/domains/masters/catalogue.js";
import { outletOwnerUnit, subtree } from "../src/domains/org/scope.js";
import { scopeOf } from "../src/core/scope.js";
import { actorFor } from "../src/core/context.js";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { seedSpecMasters } from "../../../packages/db/seed/spec-masters.js";
import {
  rowId,
  todayManila,
  plusDays,
} from "../../../packages/db/seed/store.js";

/** Field "Edit store": a change request linked to an existing store, reviewed by the office.
 * @type {import('./harness.js').Harness} */ let h;
const cookies = /** @type {Record<string,string>} */ ({});
let photo = "";
const UNIT = () => rowId("org_units", "territory-0");
/** @type {string[]} */ let storeIds = [];

/** @param {string} key @param {string} email @param {string} password */
async function signInAs(key, email, password) {
  const r = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(r.status).toBe(200);
  cookies[key] = r.headers.get("set-cookie")?.split(";")[0] ?? "";
}
/** @param {string} key @param {string} path @param {any} [body] @param {string} [requestKey] */
async function as(key, path, body, requestKey = crypto.randomUUID()) {
  const r = await h.fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      cookie: cookies[key],
      "content-type": "application/json",
      "idempotency-key": requestKey,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return {
    status: r.status,
    body: /** @type {any} */ (text ? JSON.parse(text) : null),
  };
}
/** A person on a bound field phone. @param {string} role */
async function fieldPerson(role = "sales") {
  const password = "store-edit-test-only-password",
    email = `se-${crypto.randomUUID()}@example.com`;
  const userId = await createUser(h, email, password),
    unitId = UNIT();
  const [profile] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${userId},${userId},'Edit rep',${email},${role},'active',${unitId}) returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${profile.id},${unitId},${role},${new Date(0)},${userId},'store edit test assignment')`;
  const app = "field-android";
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
    email,
    password,
    profileId: profile.id,
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
/** @param {string} targetOutletId @param {any} [over] */
function change(targetOutletId, over = {}) {
  return {
    kind: "change",
    targetOutletId,
    captureId: crypto.randomUUID(),
    name: "Renamed Sari-Sari",
    address: "Purok 9, Lahug, Cebu City",
    ownerName: "New Owner",
    ownerPhone: "0917 555 0199",
    deviceTime: Date.now(),
    ...over,
  };
}
const outletCount = async () =>
  Number((await h.db`select count(*)::int n from outlets`)[0].n);

beforeAll(async () => {
  h = await startHarness({ installers: [org, masters] });
  await seedDemo(h.db, { days: 3, anchorDate: plusDays(todayManila(), 1) });
  await tx(h.db, seedSpecMasters);
  const password = (
    await Bun.file(`${process.env.HOME}/.sunpride-keys/v2-test-password`).text()
  ).trim();
  for (const role of ["manager", "viewer", "admin"])
    await signInAs(role, `${role}@sunpride.test`, password);
  photo = Buffer.from(await Bun.file(SAMPLE_IMAGE).arrayBuffer()).toString(
    "base64",
  );
  setPlacesFetch(async () => Response.json({ status: "ZERO_RESULTS" }));
  // Stores owned inside the field unit (so the rep may propose and the manager may review).
  const units = new Set(await subtree(h.db, UNIT()));
  for (const o of await h.db`select id from outlets where status='active' and deleted_at is null order by code limit 400`) {
    const unit = await outletOwnerUnit(h.db, o.id, Date.now());
    if (unit && units.has(unit)) storeIds.push(o.id);
    if (storeIds.length >= 6) break;
  }
  expect(storeIds.length).toBeGreaterThanOrEqual(5);
}, 180000);
afterAll(async () => {
  setPlacesFetch(null);
  await h?.close();
});

test("store edit: approve updates the existing store, adds no store, moves the pin", async () => {
  const rep = await fieldPerson();
  const id = storeIds[0];
  const before = await outletCount();
  const at = Date.now();
  const p = change(id, {
    photoJpegBase64: photo,
    landmark: "Beside the chapel",
    deviceTime: at,
    location: {
      latitude: 10.3311,
      longitude: 123.8991,
      accuracyMeters: 9,
      fixTime: at,
      mockSignal: false,
      provider: "gps",
    },
  });
  const ack = await rep.push(p);
  expect(ack.status).toBe("applied");
  const queue = await as("manager", "/api/v1/masters/census-queue");
  const row = queue.body.rows.find(
    (/** @type {any} */ r) => r.id === p.captureId,
  );
  expect(row.kind).toBe("change");
  expect(row.target.id).toBe(id);
  const fields = row.changes.map((/** @type {any} */ c) => c.field);
  expect(fields).toEqual(
    expect.arrayContaining([
      "name",
      "address",
      "ownerName",
      "ownerPhone",
      "landmark",
      "location",
      "photo",
    ]),
  );
  const name = row.changes.find((/** @type {any} */ c) => c.field === "name");
  const [old] = await h.db`select name from outlets where id=${id}`;
  expect(name).toMatchObject({ old: old.name, new: "Renamed Sari-Sari" });
  // Coverage counts never include a change.
  const batch = queue.body.batches.find(
    (/** @type {any} */ b) => b.pending > 0,
  );
  expect(batch).toBeTruthy();

  const dup = await as("manager", "/api/v1/masters/census/review", {
    captureId: p.captureId,
    decision: "duplicate",
    outletId: id,
    reason: "x",
  });
  expect(dup.status).toBe(422);
  // WEB-173: the customer page reads the customer record, so it holds the old contact before approval.
  await h.db`insert into customer_profiles(outlet_id,mobile_no,updated_by) values(${id},'09000000000','fixture') on conflict (outlet_id) do update set mobile_no='09000000000'`;
  await h.db`insert into customer_ship_tos(outlet_id,ordinal,ship_to_party,contact_person,mobile_no,updated_by) values(${id},0,'Old party','Old contact','09000000000','fixture') on conflict (outlet_id,ordinal) where deleted_at is null do update set contact_person='Old contact',mobile_no='09000000000'`;
  const ok = await as("manager", "/api/v1/masters/census/review", {
    captureId: p.captureId,
    decision: "accept",
    reason: "Checked with the owner",
  });
  expect(ok.status).toBe(200);
  expect(ok.body).toMatchObject({
    kind: "change",
    outletId: id,
    decision: "accept",
  });
  expect(await outletCount()).toBe(before);
  const [after] =
    await h.db`select name,address,directions from outlets where id=${id}`;
  expect(after).toEqual({
    name: "Renamed Sari-Sari",
    address: "Purok 9, Lahug, Cebu City",
    directions: "Beside the chapel",
  });
  const [contact] =
    await h.db`select name,phone from outlet_contacts where outlet_id=${id} and ordinal=0`;
  expect(contact).toEqual({ name: "New Owner", phone: "0917 555 0199" });
  const [profileRow] = await h.db`select mobile_no from customer_profiles where outlet_id=${id}`;
  expect(profileRow.mobile_no).toBe("09175550199");
  const [shipTo] = await h.db`select contact_person,mobile_no from customer_ship_tos where outlet_id=${id} and deleted_at is null and ordinal=0`;
  expect(shipTo).toEqual({ contact_person: "New Owner", mobile_no: "09175550199" });
  const pins =
    await h.db`select latitude from outlet_pins where outlet_id=${id} and status='verified' and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now())`;
  expect(pins.map((/** @type {any} */ x) => x.latitude)).toEqual([10.3311]);
  const [photoRow] =
    await h.db`select f.purpose from outlet_photos p join files f on f.id=p.file_id where p.outlet_id=${id} and p.ordinal=0`;
  expect(photoRow.purpose).toBe("census-storefront");
  const again = await as("manager", "/api/v1/masters/census-queue");
  expect(
    again.body.rows.some((/** @type {any} */ r) => r.id === p.captureId),
  ).toBe(false);
});

test("store edit: reject leaves the store untouched", async () => {
  const rep = await fieldPerson();
  const id = storeIds[1];
  const [store] =
    await h.db`select name,address,directions,updated_at from outlets where id=${id}`;
  const contacts =
    await h.db`select name,phone from outlet_contacts where outlet_id=${id} order by ordinal`;
  const p = change(id, { name: "Should Not Apply" });
  expect((await rep.push(p)).status).toBe("applied");
  const noReason = await as("manager", "/api/v1/masters/census/review", {
    captureId: p.captureId,
    decision: "reject",
    reason: "",
  });
  expect(noReason.status).toBe(422);
  const r = await as("manager", "/api/v1/masters/census/review", {
    captureId: p.captureId,
    decision: "reject",
    reason: "Owner did not confirm",
  });
  expect(r.status).toBe(200);
  expect(r.body.outletId).toBeNull();
  expect(
    (
      await h.db`select name,address,directions,updated_at from outlets where id=${id}`
    )[0],
  ).toEqual(store);
  expect(
    await h.db`select name,phone from outlet_contacts where outlet_id=${id} order by ordinal`,
  ).toEqual(contacts);
  const [review] =
    await h.db`select decision,reason from census_reviews where capture_id=${p.captureId}`;
  expect(review).toEqual({
    decision: "reject",
    reason: "Owner did not confirm",
  });
});

test("store edit: the person who proposed a change cannot approve it", async () => {
  const boss = await fieldPerson("manager");
  await signInAs("boss", boss.email, boss.password);
  const p = change(storeIds[2], { name: "Own Approval Try" });
  expect((await boss.push(p)).status).toBe("applied");
  const own = await as("boss", "/api/v1/masters/census/review", {
    captureId: p.captureId,
    decision: "accept",
    reason: "Looks fine",
  });
  expect(own.status).toBe(422);
  expect(JSON.stringify(own.body)).toContain("Another person");
  const [store] = await h.db`select name from outlets where id=${storeIds[2]}`;
  expect(store.name).not.toBe("Own Approval Try");
});

test("store edit: people without the Add store right are refused", async () => {
  const viewer = await fieldPerson("viewer");
  const ack = await viewer.push(change(storeIds[3]));
  expect(ack.status).not.toBe("applied");
  expect(
    Number(
      (
        await h.db`select count(*)::int n from census_captures where target_outlet_id=${storeIds[3]}`
      )[0].n,
    ),
  ).toBe(0);
  // The viewer may not review either.
  const queue = await as("viewer", "/api/v1/masters/census-queue");
  expect(queue.status).toBe(403);
});

test("store edit: retry is idempotent, a changed retry is refused, nothing-changed is refused", async () => {
  const rep = await fieldPerson();
  const p = change(storeIds[4], { name: "Retry Store" });
  const op = crypto.randomUUID();
  expect((await rep.push(p, op)).status).toBe("applied");
  expect((await rep.push(p, op)).status).toBe("duplicate"); // same op replayed
  expect((await rep.push(p)).status).toBe("applied"); // same capture id, new op id
  expect(
    Number(
      (
        await h.db`select count(*)::int n from census_captures where id=${p.captureId}`
      )[0].n,
    ),
  ).toBe(1);
  const conflict = await rep.push({ ...p, name: "Different" });
  expect(conflict.status).not.toBe("applied");
  // Same review sent twice with one request key: one review, one answer.
  const key = crypto.randomUUID();
  const body = { captureId: p.captureId, decision: "accept", reason: "ok" };
  const a = await as("manager", "/api/v1/masters/census/review", body, key);
  const b = await as("manager", "/api/v1/masters/census/review", body, key);
  expect(a.status).toBe(200);
  expect(b.body).toEqual(a.body);
  // The store now matches the proposal: sending it again changes nothing.
  const [s] =
    await h.db`select o.name,o.address,c.name owner,c.phone from outlets o join outlet_contacts c on c.outlet_id=o.id and c.ordinal=0 where o.id=${storeIds[4]}`;
  const same = await rep.push(
    change(storeIds[4], {
      name: s.name,
      address: s.address,
      ownerName: s.owner,
      ownerPhone: s.phone,
    }),
  );
  expect(same.status).not.toBe("applied");
});

test("store edit: the phone learns the office's decision on its own changes", async () => {
  const rep = await fieldPerson();
  await signInAs("rep", rep.email, rep.password);
  const empty = await as("rep", "/api/v1/masters/census/my-changes");
  expect(empty.status).toBe(200);
  expect(empty.body.items).toEqual([]);
  const yes = change(storeIds[4], { name: "Accepted Rename" });
  const no = change(storeIds[5] ?? storeIds[4], { name: "Rejected Rename" });
  expect((await rep.push(yes)).status).toBe("applied");
  expect((await rep.push(no)).status).toBe("applied");
  // Still waiting: not listed.
  expect(
    (await as("rep", "/api/v1/masters/census/my-changes")).body.items,
  ).toEqual([]);
  expect(
    (
      await as("manager", "/api/v1/masters/census/review", {
        captureId: yes.captureId,
        decision: "accept",
        reason: "Checked",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await as("manager", "/api/v1/masters/census/review", {
        captureId: no.captureId,
        decision: "reject",
        reason: "Wrong store name",
      })
    ).status,
  ).toBe(200);
  const mine = await as("rep", "/api/v1/masters/census/my-changes");
  expect(mine.status).toBe(200);
  const byId = Object.fromEntries(
    mine.body.items.map((/** @type {any} */ i) => [i.captureId, i]),
  );
  expect(byId[yes.captureId]).toMatchObject({
    targetOutletId: yes.targetOutletId,
    decision: "accepted",
    reason: null,
  });
  expect(byId[no.captureId]).toMatchObject({
    targetOutletId: no.targetOutletId,
    decision: "rejected",
    reason: "Wrong store name",
  });
  expect(typeof byId[no.captureId].decidedAt).toBe("number");
  // Another rep never sees someone else's decisions; people without Add store are refused.
  const other = await fieldPerson();
  await signInAs("other", other.email, other.password);
  expect(
    (await as("other", "/api/v1/masters/census/my-changes")).body.items,
  ).toEqual([]);
  expect((await as("viewer", "/api/v1/masters/census/my-changes")).status).toBe(
    403,
  );
});

test("store edit: an office move that is put back keeps the phone's scope, so its queued change still reaches the office (WEB-173)", async () => {
  const rep = await fieldPerson();
  const [{ user_id: userId }] =
    await h.db`select user_id from profiles where id=${rep.profileId}`;
  const fp = async () =>
    (await scopeOf(h.db, /** @type {any} */ (await actorFor(h.db, userId))))
      .fingerprint;
  const before = await fp();
  const inside = new Set(await subtree(h.db, UNIT()));
  const [other] =
    await h.db`select id from org_units where deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now()) and not (id::text = any(${h.db.array([...inside], "TEXT")})) order by code limit 1`;
  const assign = (/** @type {any} */ b) =>
    as("admin", "/api/v1/people/assign", { profileId: rep.profileId, ...b });
  const moved = await assign({
    orgUnitId: other.id,
    role: "manager",
    reason: "QA move",
  });
  expect(moved.status).toBe(200);
  expect(await fp()).not.toBe(before); // a real move changes the phone's scope
  await Bun.sleep(5);
  const back = await assign({
    orgUnitId: UNIT(),
    role: "sales",
    reason: "Put back",
  });
  expect(back.status).toBe(200);
  // Same person, unit, role and reach: the phone keeps its partition (no held work).
  expect(await fp()).toBe(before);
  const p = change(storeIds[5], { name: "Moved And Back Store" });
  expect((await rep.push(p)).status).toBe("applied");
  const queue = await as("manager", "/api/v1/masters/census-queue");
  expect(
    queue.body.rows.some((/** @type {any} */ r) => r.id === p.captureId),
  ).toBe(true);
});
