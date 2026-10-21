import { test, expect } from "bun:test";
import { startHarness, createUser, profileStore } from "./harness.js";
import { installModels } from "../src/domains/analytics/model-workflows.js";
import { canonicalModelSuggestion } from "../src/domains/analytics/order-model.js";
import { sha256Hex } from "../src/core/util.js";

test("F-610 persisted version training, independent approval, replay, correction and live-rule retention fence", async () => {
  const h = await startHarness({ installers: [installModels] });
  try {
    const profiles = profileStore(h);
    const [unit] =
      await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','SAMPLE-MODELS','Sample models','region','active','2020-01-01') returning id`;
    h.setHooks({ rootUnitId: async () => unit.id });
    async function person() {
      const email = crypto.randomUUID() + "@example.com",
        user = await createUser(h, email, "Sample fixture password only"),
        p = profiles.set(user, { role: "super_admin", orgUnitId: unit.id });
      await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user},${user},'Sample reviewer',${email},'super_admin','active',${unit.id})`;
      const token = "sps_" + crypto.randomUUID().replaceAll("-", "");
      await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${user},${sha256Hex(token)},'web',now()+interval '1 day')`;
      return "sp_session=" + token;
    }
    const author = await person(),
      reviewer = await person();
    const [outlet] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride','SAMPLE-MODEL','Sample model store','active',${unit.id},'GT','sample') returning id`;
    const [product] =
      await h.db`insert into products(code,name,category,uom,unit_price,active,organization_id,quantity_scale) values('SAMPLE-MODEL','Sample model SKU','Food','PC',1,true,'sunpride',1) returning id`;
    /** @param {string} cookie @param {string} action @param {any} body */
    async function post(cookie, action, body) {
      const r = await h.fetch("/api/v1/analytics/models/" + action, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    }
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const result = await post(author, "dataset", {
        purpose: "order_backtest",
        outletId: outlet.id,
        productId: product.id,
        observedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
        retainUntil: new Date(Date.now() + 86400000).toISOString(),
        sourceReference: "SAMPLE-PURCHASE-" + i,
        consentReference: "SAMPLE TEST ONLY",
        sourceType: "sample",
        split: i < 10 ? "train" : "temporal_holdout",
        annotations: {
          historyDailyBase: i + 1,
          offtakeDailyBase: 2 * (i + 1),
          seasonSin: 0,
          seasonCos: 1,
          promotionUpliftPct: 0,
          stockBase: 0,
          coverDays: 7,
          nextOrderBase: 3 * (i + 1),
        },
      });
      expect(result.status).toBe(200);
      ids.push(result.body.id);
    }
    const trained = await post(author, "train", {
      purpose: "suggested_order",
      datasetIds: ids,
    });
    expect(trained.status).toBe(200);
    expect(
      (await post(author, "approve", { modelId: trained.body.id })).status,
    ).toBe(422);
    expect(
      (await post(reviewer, "approve", { modelId: trained.body.id })).status,
    ).toBe(200);
    const request = {
      modelId: trained.body.id,
      datasetId: ids[11],
      idempotencyKey: crypto.randomUUID(),
    };
    const prediction = await post(author, "predict", request);
    expect(prediction.status).toBe(200);
    expect(prediction.body.result.quantityBase).toBeGreaterThan(30);
    expect((await post(author, "predict", request)).body.id).toBe(
      prediction.body.id,
    );
    expect(
      (
        await post(reviewer, "review", {
          runId: prediction.body.id,
          decision: "corrected",
          correction: { quantityBase: 36 },
          reason: "Reviewed sample ground truth",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.db`select decision,correction from analytics_model_reviews where run_id=${prediction.body.id}`
      )[0],
    ).toMatchObject({
      decision: "corrected",
      correction: { quantityBase: 36 },
    });
    const listResponse = await h.fetch("/api/v1/analytics/models", {
      headers: { cookie: author },
    });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json();
    expect(
      list.runs.find((/** @type {any} */ r) => r.id === prediction.body.id)
        .reviews[0].correction,
    ).toEqual({ quantityBase: 36 });
    const input = {
      owner: unit.id,
      outletId: outlet.id,
      productId: product.id,
      sample: true,
      day: "2026-01-13",
      historyDailyBase: 12,
      offtake: { quantityBase: 24, days: 1 },
      stockBase: 0,
      upliftPct: 0,
      coverDays: 7,
    };
    const rule = {
      quantityBase: 84,
      status: "suggest",
      reasons: ["Existing rule"],
    };
    expect(
      (await canonicalModelSuggestion({ db: h.db }, input, rule)).quantityBase,
    ).toBeLessThan(40);
    await h.db`update analytics_ai_dataset_items set retain_until=now()-interval '1 second' where id=${ids[0]}`;
    expect(await canonicalModelSuggestion({ db: h.db }, input, rule)).toEqual(
      rule,
    );
    expect(
      (
        await post(author, "predict", {
          ...request,
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(422);
  } finally {
    await h.close();
  }
});
