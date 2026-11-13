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
import { install as reports } from "../src/domains/fieldreports/index.js";
import { manilaDate } from "../src/domains/visits/shared.js";

test("F-223 signed native draft chain completes canonical coaching and carries actions; office edits and withdrawn trainee deny before replay", async () => {
  const h = await startHarness({ installers: [org, reports] });
  try {
    const root = crypto.randomUUID(),
      unit = crypto.randomUUID(),
      foreign = crypto.randomUUID(),
      position = crypto.randomUUID();
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${root},'sunpride','SUNPRIDE','SAMPLE company','national','active','2020-01-01'),(${unit},'sunpride','SAMPLE-A','SAMPLE team','region','active','2020-01-01'),(${foreign},'sunpride','SAMPLE-B','SAMPLE other team','region','active','2020-01-01')`;
    await h.db`update org_units set parent_id=${root} where id in (${unit},${foreign})`;
    await h.db`insert into positions(id,organization_id,code,label,category,active) values(${position},'sunpride','SAMPLE-COACH','SAMPLE coach','field',true)`;
    await h.db`insert into position_standards(organization_id,position_id,effective_from,productive_call_rule,selling_weekdays,source_ref,work_with_weekly_min) values('sunpride',${position},'2020-01-01','any_listed_activity',array[1,2,3,4,5,6],'SAMPLE',1)`;
    const password = "test-only-coaching-password",
      trainerUser = await createUser(h, "sample-coach@example.test", password),
      traineeUser = await createUser(
        h,
        "sample-trainee@example.test",
        password,
      );
    const people = [];
    for (const [uid, role, name] of [
      [trainerUser, "manager", "SAMPLE coach"],
      [traineeUser, "sales", "SAMPLE trainee"],
    ]) {
      const [p] =
        await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,position_id) values(${uid},${uid},${name},${uid + "@example.test"},${role},'active',${unit},${position}) returning id`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,position_id,effective_from,actor_subject,reason) values(${p.id},${unit},${role},${position},'2020-01-01','SAMPLE','SAMPLE')`;
      people.push(p.id);
    }
    const [trainer, trainee] = people,
      key = await deviceKey(),
      deviceId = await registerDevice(h, {
        profileId: trainer,
        orgUnitId: unit,
        key,
      });
    const login = await nativeSignIn(
      h,
      "sample-coach@example.test",
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
    const who = { access, deviceId, key },
      day = manilaDate(Date.now());
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
            projection: "field.jointcall",
            params: { serviceDate: day },
          },
        ],
        limit: 128,
      });
      if (r.res.status !== 200) throw Error(JSON.stringify(r.body));
      return r.body;
    }
    const initial = await pull();
    expect(
      initial.bundles[0].data.trainees.map((/** @type {any} */ x) => x.id),
    ).toEqual([trainee]);
    /** @param {any} payload @param {string[]} [deps] */
    async function push(payload, deps = []) {
      const op = {
        clientOpId: crypto.randomUUID(),
        opType: "jointcall.capture",
        clientTime: Date.now(),
        dependsOn: deps,
        payload,
      };
      const body = {
        version: 2,
        app: "field-android",
        deviceId,
        scopeId: me.scope.id,
        operations: [op],
      };
      const r = await signedPost(h, who, "/api/sync/push", body);
      if (r.res.status !== 200) throw Error(JSON.stringify(r.body));
      return { op, body, result: r.body.results[0] };
    }
    const a = {
      serviceDate: day,
      traineeProfileId: trainee,
      objective: "training",
      mode: "booking",
      observations: [],
      reviews: [],
      complete: false,
    };
    const first = await push(a);
    expect(first.result.status).toBe("applied");
    const sessionId = first.result.ack.entityId;
    const second = await push(
      {
        ...a,
        sessionId,
        previousRequestId: first.op.clientOpId,
        observations: [
          { area: "bcp", item: "Prepare call", rating: "met" },
          {
            area: "psf",
            item: "Explain benefit",
            rating: "partial",
            remark: "Practise one concrete benefit",
          },
        ],
        trainingLog: {
          topics: "Call preparation",
          tradeDevelopment: "Review shelf order",
          discussedWithTrainee: true,
        },
        actions: [
          { agreement: "Prepare the next call", owner: "trainee", dueOn: day },
        ],
        complete: true,
      },
      [first.op.clientOpId],
    );
    expect(second.result.status).toBe("applied");
    const [stored] =
      await h.db`select status,training_log_topics from work_with_sessions where id=${sessionId}`;
    expect(stored.status).toBe("completed");
    expect(stored.training_log_topics).toBe("Call preparation");
    const follow = await pull();
    expect(follow.bundles[0].data.trainees[0].carried[0].agreement).toBe(
      "Prepare the next call",
    );
    // FLD-159: reopen a saved draft from the office copy (expectedRevision, as the phone does) and finish it with
    // a required part missing: the refusal names it (was the generic invalid_request), then a full finish lands.
    const saved = await push(a);
    expect(saved.result.status).toBe("applied");
    const reopened = (await pull()).bundles[0].data.sessions.find(
      (/** @type {any} */ x) => x.session.id === saved.result.ack.entityId,
    );
    const partial = {
      ...a,
      sessionId: saved.result.ack.entityId,
      expectedRevision: reopened.revision,
      observations: [{ area: "bcp", item: "Prepare call", rating: "met" }],
      trainingLog: {
        topics: "Call preparation",
        tradeDevelopment: "Review shelf order",
        discussedWithTrainee: false,
      },
      complete: true,
    };
    const refused = await push(partial);
    expect(refused.result.status).toBe("rejected");
    expect(refused.result.code).toBe("work_with_incomplete");
    const finished = await push({
      ...partial,
      observations: [
        ...partial.observations,
        { area: "psf", item: "Explain benefit", rating: "met" },
      ],
      trainingLog: { ...partial.trainingLog, discussedWithTrainee: true },
      reviews: reopened.jointCall.carried.map((/** @type {any} */ x) => ({
        actionId: x.id,
        outcome: "done",
        note: "Prepared",
      })),
    });
    expect(finished.result.status).toBe("applied");
    const [done] =
      await h.db`select status from work_with_sessions where id=${saved.result.ack.entityId}`;
    expect(done.status).toBe("completed");
    const draft = await push(a);
    expect(draft.result.status).toBe("applied");
    await h.db`update work_with_sessions set training_log_topics='Office edit' where id=${draft.result.ack.entityId}`;
    const stale = await push(
      {
        ...a,
        sessionId: draft.result.ack.entityId,
        previousRequestId: draft.op.clientOpId,
      },
      [draft.op.clientOpId],
    );
    expect(stale.result.code).toBe("idempotency_conflict");
    if (process.env.SP_NATIVE_JOINT_WIRE)
      await Bun.write(
        process.env.SP_NATIVE_JOINT_WIRE,
        JSON.stringify({
          me,
          response: follow,
          captured: second.op,
          ack: second.result.ack,
        }),
      );
    await h.db`update profiles set org_unit_id=${foreign} where id=${trainee}`;
    await h.db`update employee_assignments set org_unit_id=${foreign} where profile_id=${trainee}`;
    const replay = await signedPost(h, who, "/api/sync/push", second.body);
    expect(replay.res.status).toBe(200);
    expect(replay.body.results[0].code).toBe("out_of_scope");
  } finally {
    await h.close();
  }
});
