import { test, expect } from "bun:test";
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
  installCollections,
  latestAr,
} from "../src/domains/coverage/collections.js";
import { installCollectorCapture } from "../src/domains/coverage/collector-native.js";
import { ingestMaster } from "../src/domains/integration/replicas.js";
import { sha256Hex } from "../src/core/util.js";
import { roleHas } from "../src/core/capabilities.js";
import { manilaDate } from "../src/domains/visits/shared.js";

test("F-613 signed own collector agenda captures canonical promises, post-dated custody and bank evidence without planner/AR authority; withdrawn route denies replay", async () => {
  const h = await startHarness({
    installers: [
      org,
      (/** @type {any} */ r, /** @type {any} */ p) => {
        installCollections(r);
        installCollectorCapture(r, p);
      },
    ],
  });
  try {
    const unit = crypto.randomUUID();
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE company','national','active','2020-01-01')`;
    const password = "test-only-collector-password",
      people = [];
    for (const [name, role] of [
      ["collector", "sales"],
      ["manager", "manager"],
    ]) {
      const uid = await createUser(h, name + "@example.test", password);
      const [p] =
        await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${uid},${uid},${"SAMPLE " + name},${name + "@example.test"},${role},'active',${unit}) returning id`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${role},'2020-01-01','SAMPLE','SAMPLE')`;
      people.push({ uid, id: p.id });
    }
    const collector = people[0],
      manager = people[1],
      day = manilaDate(Date.now()),
      tomorrow = manilaDate(Date.now() + 86400000);
    const token = "sps_sample_collection_manager";
    await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${manager.uid},${sha256Hex(token)},'web',now()+interval '1 day')`;
    const cookie = "sp_session=" + token;
    /** @param {string} path @param {any} [body] */
    async function office(path, body) {
      const res = await h.fetch("/api/v1/money/collections" + path, {
        method: body ? "POST" : "GET",
        headers: { cookie, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: await res.json() };
    }
    for (let i = 0; i < 3; i++) {
      const code = "SAMPLE-C" + i;
      const [customer] =
        await h.db`insert into customers(code,name,channel,territory,credit_limit,active) values(${code},${"SAMPLE account " + i},'general_trade','SAMPLE',0,true) returning id`;
      const [o] =
        await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride',${"SAMPLE-O" + i},${"SAMPLE store " + i},'active',${unit},'general_trade','SAMPLE') returning id`;
      await h.db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values(${o.id},${customer.id},'SAMPLE','2020-01-01','SAMPLE','SAMPLE')`;
    }
    const ar = {
      schemaVersion: 1,
      organizationId: "sunpride",
      kind: "ar",
      key: "SAMPLE-INV-1",
      version: 1,
      source: "sample",
      effectiveFrom: Date.now() - 60000,
      effectiveTo: null,
      deleted: false,
      data: {
        customerCode: "SAMPLE-C0",
        documentNumber: "SAMPLE invoice 1",
        dueAt: Date.now() - 86400000,
        amountCentavos: 10000,
        currency: "PHP",
      },
    };
    await ingestMaster(h.db, ar);
    expect(
      (
        await office("/route", {
          routeDate: day,
          collectorProfileId: collector.id,
          stops: [
            { customerCode: "SAMPLE-C0", reason: "overdue_balance" },
            { customerCode: "SAMPLE-C1", reason: "manual" },
          ],
        })
      ).status,
    ).toBe(200);
    const key = await deviceKey(),
      deviceId = await registerDevice(h, {
        profileId: collector.id,
        orgUnitId: unit,
        key,
      });
    const login = await nativeSignIn(
      h,
      "collector@example.test",
      password,
      "field-android",
      { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
    );
    expect(login.res.status).toBe(200);
    const access = login.body.accessToken;
    expect((await bind(h, access, deviceId, key)).body.bindingStatus).toBe(
      "bound",
    );
    const me = await (
      await h.fetch("/api/me", {
        headers: {
          authorization: "Bearer " + access,
          "x-app": "field-android",
          "x-device-key-id": key.keyId,
        },
      })
    ).json();
    const who = { access, deviceId, key };
    async function pull() {
      const r = await signedPost(h, who, "/api/sync/pull", {
        version: 2,
        app: "field-android",
        deviceId,
        since: null,
        pageCursor: null,
        scopes: [
          {
            scopeId: me.scope.id,
            projection: "field.collections",
            params: { serviceDate: day },
          },
        ],
        limit: 128,
      });
      if (r.res.status !== 200) throw Error(JSON.stringify(r.body));
      return r.body;
    }
    const response = await pull(),
      agenda = response.bundles[0].data;
    expect(agenda.stops.map((/** @type {any} */ s) => s.customerCode)).toEqual([
      "SAMPLE-C0",
      "SAMPLE-C1",
    ]);
    expect(agenda.stops[1].ar).toBe(null);
    expect(roleHas("sales", "collections.plan")).toBe(false);
    expect(roleHas("sales", "collections.capture")).toBe(true);
    /** @type {any[]} */ const requests = [];
    /** @param {any} payload */
    async function push(payload) {
      const op = {
          clientOpId: crypto.randomUUID(),
          opType: "collections.capture",
          clientTime: Date.now(),
          dependsOn: [],
          payload: { serviceDate: day, deviceTime: Date.now(), ...payload },
        },
        body = {
          version: 2,
          app: "field-android",
          deviceId,
          scopeId: me.scope.id,
          operations: [op],
        };
      const r = await signedPost(h, who, "/api/sync/push", body);
      if (r.res.status !== 200) throw Error(JSON.stringify(r.body));
      requests.push(op);
      return { result: r.body.results[0], body };
    }
    const promise = await push({
      action: "promise",
      customerCode: "SAMPLE-C0",
      amountMinor: 1000,
      promisedOn: tomorrow,
      openItemRef: "SAMPLE-INV-1",
      sourceHash: agenda.stops[0].ar.sourceHash,
      note: "SAMPLE customer agreed to pay tomorrow",
    });
    expect(promise.result.status).toBe("applied");
    const jpeg = Buffer.from(
        await Bun.file(
          new URL("./fixtures/sample-return.jpg", import.meta.url),
        ).arrayBuffer(),
      ),
      photo = {
        mimeType: "image/jpeg",
        bytesBase64: jpeg.toString("base64"),
        sha256: sha256Hex(jpeg),
      };
    const pickup = await push({
      action: "cheque.receive",
      customerCode: "SAMPLE-C0",
      amountMinor: 1000,
      chequeDate: tomorrow,
      bank: "SAMPLE bank",
      chequeNumber: "SAMPLE-PDC",
      note: "SAMPLE physical post-dated cheque received",
      photo,
    });
    expect(pickup.result.status).toBe("applied");
    const earlyDeposit = await office("/cheque/event", {
      chequeId: pickup.result.ack.entityId,
      kind: "deposited",
    });
    expect(earlyDeposit.status).toBe(400);
    expect(earlyDeposit.body.error.message).toContain("post-dated cheque");
    const todayCheque = await office("/cheque", {
      customerCode: "SAMPLE-C0",
      amountMinor: 1000,
      chequeDate: day,
      bank: "SAMPLE bank",
      chequeNumber: "SAMPLE-TODAY",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(todayCheque.status).toBe(200);
    expect(
      (
        await office("/cheque/event", {
          chequeId: todayCheque.body.id,
          kind: "deposited",
        })
      ).status,
    ).toBe(200);
    const bounced = await push({
      action: "cheque.bounced",
      customerCode: "SAMPLE-C0",
      chequeId: todayCheque.body.id,
      note: "SAMPLE bank returned insufficient-funds notice",
      photo,
    });
    expect(bounced.result.status).toBe("applied");
    expect(
      (
        await push({
          action: "cheque.cleared",
          customerCode: "SAMPLE-C0",
          chequeId: todayCheque.body.id,
          note: "not permitted",
        })
      ).result.code,
    ).toBe("invalid_request");
    const reordered = await push({
      action: "route.order",
      customerCodes: ["SAMPLE-C1", "SAMPLE-C0"],
    });
    expect(reordered.result.status).toBe("applied");
    expect(
      (
        await h.db`select customer_code from collection_route_stops where collector_profile_id=${collector.id} order by sequence`
      ).map((/** @type {any} */ r) => r.customer_code),
    ).toEqual(["SAMPLE-C1", "SAMPLE-C0"]);
    const evidence = await office("/evidence?chequeId=" + todayCheque.body.id);
    expect(evidence.status).toBe(200);
    expect(evidence.body.items[0].photo.bytesBase64).toBe(photo.bytesBase64);
    expect(evidence.body.items[0].photo.width).toBeGreaterThanOrEqual(32);
    const stored =
      await h.db`select ar_source from collection_promises where id=${promise.result.ack.entityId}`;
    expect(stored[0].ar_source.kind).toBe("sap_replicas");
    expect((await office("")).body.summary.arMinor).toBe(null);
    if (process.env.SP_NATIVE_COLLECTOR_WIRE)
      await Bun.write(
        process.env.SP_NATIVE_COLLECTOR_WIRE,
        JSON.stringify({ me, response, requests, evidence: evidence.body }),
      );
    await ingestMaster(h.db, { ...ar, version: 2, deleted: true });
    expect((await latestAr(h.db, ["SAMPLE-C0"], day)).has("SAMPLE-C0")).toBe(
      false,
    );
    await h.db`delete from collection_route_stops where collector_profile_id=${collector.id} and customer_code='SAMPLE-C0'`;
    const replay = await signedPost(h, who, "/api/sync/push", promise.body);
    expect(replay.res.status).toBe(200);
    expect(replay.body.results[0].code).toBe("out_of_scope");
    expect(
      (await h.db`select count(*)::int n from collection_promises`)[0].n,
    ).toBe(1);
    expect(
      (await h.db`select count(*)::int n from collection_capture_evidence`)[0]
        .n,
    ).toBe(3);
  } finally {
    await h.close();
  }
});
