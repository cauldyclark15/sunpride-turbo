import { test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { startHarness, profileStore, boundDevice } from "./harness.js";
import { startMock } from "../../sap-mock/src/server.js";
import { install } from "../src/domains/integration/index.js";
import { configureSap } from "../src/domains/integration/transport.js";
import { creditView } from "../src/domains/integration/credit-view.js";
test("F-112 current exposure is not projected exposure; native snapshot expires without losing last-known facts", async () => {
  const h = await startHarness({ installers: [install] });
  const mock = startMock({
    path: h.filesDir + "/credit-view.sqlite",
    port: 0,
    seed: false,
  });
  try {
    h.env.SAP_MODE = "mock";
    h.env.SAP_ORIGIN = mock.origin;
    configureSap(h.db, h.env);
    mock.db.run(
      "insert into credit_accounts(customer,credit_limit,exposure) values(?,?,?)",
      ["SAMPLE-ACCOUNT", 10000, 1000],
    );
    const people = profileStore(h),
      unit = crypto.randomUUID();
    h.setHooks({ unitInScope: async () => true });
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE','national','active',now()-interval '1 day')`;
    const user = await boundDevice(h, people, {
      role: "super_admin",
      orgUnitId: unit,
      app: "van-android",
    });
    const [outlet] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('sunpride','SAMPLE-CREDIT','SAMPLE buyer','active',${unit},${user.userId}) returning *`;
    const [terms] =
      await h.db`insert into outlet_credit_terms(organization_id,outlet_id,terms_days,credit_limit_minor,currency,effective_from,source_ref,actor_subject) values('sunpride',${outlet.id},30,5000,'PHP','2026-01-01','SAMPLE',${user.userId}) returning *`;
    const res = await h.fetch("/api/v1/credit/check", {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.access}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        customerCode: "SAMPLE-ACCOUNT",
        outletId: outlet.id,
        amountCentavos: 2000,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exposure).toBe(1000);
    expect(body.projectedExposure).toBe(3000);
    expect(body.creditSnapshot.availableMinor).toBe("5000");
    const at = body.checkedAt;
    const stale = creditView(body, terms, "SAMPLE-ACCOUNT", body.expiresAt + 1);
    expect(stale.availableMinor).toBeNull();
    expect(stale.exposureMinor).toBe("1000");
    expect(stale.freshness).toBe("stale");
    const unknown = creditView(null, terms, "SAMPLE-ACCOUNT", at);
    expect(unknown.availableMinor).toBeNull();
    if (process.env.SP_NATIVE_CREDIT_WIRE)
      await writeFile(
        process.env.SP_NATIVE_CREDIT_WIRE,
        JSON.stringify({
          at,
          outletId: outlet.id,
          frames: { fresh: body.creditSnapshot, stale, unknown },
        }),
        { mode: 0o600 },
      );
  } finally {
    mock.stop();
    await h.close();
  }
}, 120000);
