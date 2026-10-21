import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
} from "./harness.js";
import { startMock } from "../../sap-mock/src/server.js";
import { install } from "../src/domains/integration/index.js";
import { configureSap } from "../src/domains/integration/transport.js";
import { actorFor } from "../src/core/context.js";
import { decideOverride } from "../src/domains/fiscal/authority.js";
import { bindCreditDecision } from "../src/domains/integration/credit.js";

test("F-404 independent Fiscal decision reaches real mock SAP and authorizes only the exact once-reserved document", async () => {
  const h = await startHarness({ installers: [install] }),
    mock = startMock({
      path: h.filesDir + "/exception.sqlite",
      port: 0,
      seed: false,
    });
  try {
    h.env.SAP_MODE = "mock";
    h.env.SAP_ORIGIN = mock.origin;
    configureSap(h.db, h.env);
    mock.db.run("insert into credit_accounts values(?,?,?)", [
      "SAMPLE-CREDIT",
      1000,
      900,
    ]);
    const people = profileStore(h),
      unit = crypto.randomUUID(),
      source = crypto.randomUUID();
    h.setHooks({ unitInScope: async () => true });
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE','national','active','2020-01-01')`;
    const seller = await boundDevice(h, people, {
        orgUnitId: unit,
        role: "super_admin",
        app: "van-android",
      }),
      reviewerId = await createUser(
        h,
        "sample-credit-reviewer@example.test",
        "test-only-credit-password",
      ),
      reviewer = people.set(reviewerId, {
        role: "super_admin",
        orgUnitId: unit,
        name: "SAMPLE credit reviewer",
      });
    for (const { uid, p } of [
      { uid: seller.userId, p: seller.profile },
      { uid: reviewerId, p: reviewer },
    ]) {
      await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${uid},${uid},${p.name},${"SAMPLE-" + uid + "@example.test"},${p.role},'active',${unit})`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},'2020-01-01','SAMPLE','SAMPLE')`;
    }
    await h.db`insert into customers(code,name,credit_limit,active,channel,territory) values('SAMPLE-CREDIT','SAMPLE account',10,true,'general_trade','SAMPLE')`;
    // Even an amount inside this self limit must have another person's credit-exception decision.
    const [rule] =
      await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${unit},'credit','super_admin','*',0,1000000,1000000,${["super_admin"]},false,'2020-01-01',true) returning id`;
    const requester = await actorFor(h.db, seller.userId),
      approver = await actorFor(h.db, reviewerId);
    const q = {
      customerCode: "SAMPLE-CREDIT",
      amountCentavos: 2000,
      sourceType: "van_sale",
      sourceId: source,
      ownerProfileId: seller.profile.id,
      env: h.env,
    };
    await expect(tx(h.db, (db) => bindCreditDecision(db, q))).rejects.toThrow(
      "SAP refused",
    );
    /** @param {string} path @param {any} body */
    const post = async (path, body) => {
      const res = await h.fetch(path, {
        method: "POST",
        headers: {
          authorization: "Bearer " + seller.access,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      expect(res.status).toBe(200);
      return result;
    };
    const requestBody = {
      customerCode: q.customerCode,
      amountCentavos: q.amountCentavos,
      sourceType: q.sourceType,
      sourceId: q.sourceId,
      idempotencyKey: crypto.randomUUID(),
      reason: "SAMPLE exact invoice exception",
    };
    const pending = await post("/api/v1/credit/request-override", requestBody);
    expect(pending.phase).toBe("awaiting_finance");
    const [fiscal] =
      await h.db`select * from fiscal_override_requests where id::text=${pending.fiscalRequestId}`;
    expect(fiscal.requires_second).toBe(true);
    expect(
      (await post("/api/v1/credit/exception/status", { id: pending.id })).phase,
    ).toBe("awaiting_finance");
    await expect(
      tx(h.db, (db) =>
        decideOverride(db, requester, {
          id: fiscal.id,
          decision: "approved",
          reason: "SAMPLE self",
        }),
      ),
    ).rejects.toThrow("second person");
    await tx(h.db, (db) =>
      decideOverride(db, approver, {
        id: fiscal.id,
        decision: "approved",
        reason: "SAMPLE independent exposure review",
      }),
    );
    const approved = await post("/api/v1/credit/exception/status", {
      id: pending.id,
    });
    expect(approved).toMatchObject({
      phase: "approved",
      status: "approved",
      source: "sample",
      amountCentavos: 2000,
      sourceId: source,
    });
    expect(approved.reference.startsWith("SAMPLE-CREDIT-")).toBe(true);
    const decision = await tx(h.db, (db) =>
      bindCreditDecision(db, { ...q, exceptionId: pending.id }),
    );
    expect(
      await tx(h.db, (db) =>
        bindCreditDecision(db, { ...q, exceptionId: pending.id }),
      ),
    ).toBe(decision);
    // A future alias-aware consumer still cannot spend the same provider approval twice.
    await expect(
      tx(h.db, (db) =>
        bindCreditDecision(db, {
          ...q,
          sourceId: crypto.randomUUID(),
          exceptionSourceId: source,
          exceptionId: pending.id,
        }),
      ),
    ).rejects.toThrow("SAP refused");
    expect(
      mock.db
        .query(
          "select credit_limit,exposure from credit_accounts where customer=?",
        )
        .get("SAMPLE-CREDIT"),
    ).toEqual({ credit_limit: 1000, exposure: 2900 });
    const refused = await post("/api/v1/credit/request-override", {
      customerCode: "SAMPLE-CREDIT",
      amountCentavos: 200000,
      sourceType: "van_sale",
      sourceId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      reason: "SAMPLE outside provider allowance",
    });
    await tx(h.db, (db) =>
      decideOverride(db, approver, {
        id: refused.fiscalRequestId,
        decision: "approved",
        reason: "SAMPLE independent review",
      }),
    );
    expect(
      await post("/api/v1/credit/exception/status", { id: refused.id }),
    ).toMatchObject({
      status: "rejected",
      phase: "rejected",
      source: "sample",
      reference: null,
    });
    await h.db`update fiscal_authority_rules set effective_to=now() where id=${rule.id}`;
    await expect(
      tx(h.db, (db) =>
        bindCreditDecision(db, { ...q, exceptionId: pending.id }),
      ),
    ).rejects.toThrow();
    if (process.env.SP_NATIVE_SAP_CREDIT_WIRE)
      await Bun.write(
        process.env.SP_NATIVE_SAP_CREDIT_WIRE,
        JSON.stringify({ approved }),
      );
  } finally {
    mock.stop();
    await h.close();
  }
}, 30000);
