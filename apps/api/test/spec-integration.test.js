import { afterAll, beforeAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness, createUser } from "./harness.js";
import { domainInstallers } from "../src/domains/index.js";
import { startMock } from "../../sap-mock/src/server.js";
import { receiveEvent, runOutbox } from "../src/domains/integration/outbox.js";
import { posting } from "../src/domains/tpm/finance.js";
import {
  enqueueTpmPosting,
  distributorCredit,
  enqueueDistributorPosting,
  authorizeClaimant,
} from "../src/domains/integration/spec-adapters.js";
import { ensurePartnerDeviceScope } from "../src/domains/distributors/identity-seam.js";
import { distributorCallflowConfig } from "../src/domains/distributors/seams.js";
import { ensureCallflowSamples } from "../../../packages/db/seed/callflow.js";
import { bridgeClaim } from "../src/domains/distributors/claim-bridge.js";

/** @type {any} */ let h;
/** @type {any} */ let mock;
/** @type {any} */ let d;
/** @type {any} */ let c;
/** @type {any} */ let partner;
beforeAll(async () => {
  h = await startHarness({ installers: domainInstallers });
  mock = startMock({ path: h.filesDir + "/sap.sqlite", port: 0 });
  h.env.SAP_ORIGIN = mock.origin;
  const [unit] =
    await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','SUNPRIDE','Sample company','NATIONAL','active','2020-01-01') returning id`;
  [d] =
    await h.db`insert into distributors(code,name,org_unit_id,status,sap_customer_code,source) values('BRIDGE','Sample bridge',${unit.id},'accredited','MOCK-C1','sample') returning *`;
  await ensurePartnerDeviceScope({ db: h.db }, d);
  const user = await createUser(
    h,
    "bridge@test.invalid",
    "test-only bridge password",
  );
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${user},${user},'Sample partner','bridge@test.invalid','distributor','active',${d.device_org_unit_id}) returning id`;
  await h.db`insert into distributor_users(distributor_id,profile_id,grants) values(${d.id},${p.id},${h.db.array(["read", "claim", "dsr", "order"], "TEXT")})`;
  partner = {
    profileId: p.id,
    userId: user,
    subject: user,
    role: "distributor",
    orgUnitId: d.device_org_unit_id,
  };
  c = { db: h.db, env: h.env, actor: partner, now: Date.now() };
  await h.db`insert into distributor_master_versions(distributor_id,source,source_key,version,payload_hash,payload,effective_from) values(${d.id},'sample','bridge',1,'fixture',${{ credit: { limitCentavos: 1 }, terms: { deliveryLeadDays: 2 } }},'2020-01-01')`;
});
afterAll(async () => {
  mock?.stop();
  await h?.close();
});

test("F-404 integrated partner credit uses SAP, not its contradictory cached sample limit", async () => {
  const r = await distributorCredit(c, d, 1000);
  expect(r.status).toBe("within");
  expect(r.freshness).toBe("live");
  expect(r.limitCentavos).toBe(5000000);
  await fetch(mock.origin + "/control/fault", {
    method: "POST",
    body: JSON.stringify({ target: "check", mode: "fail", count: 1 }),
  });
  expect((await distributorCredit(c, d, 1000)).status).toBe("unknown");
});
test("F-403 partner reservations and outbox acknowledgement are real, replayable and atomic", async () => {
  const key = crypto.randomUUID();
  const req = await tx(h.db, (db) =>
    enqueueDistributorPosting({ ...c, db }, d, "primary_order", key, {
      totalCentavos: 1000,
      lines: [],
    }),
  );
  expect(req.status).toBe("pending");
  expect(req.acknowledgement).toBeNull();
  await runOutbox(h.db, { env: h.env });
  const [saved] =
    await h.db`select * from distributor_sap_requests where id=${req.id}`;
  expect(saved.status).toBe("acknowledged");
  expect(saved.acknowledgement.reference).toContain("SAMPLE-ORDER-");
  expect(
    (
      await tx(h.db, (db) =>
        enqueueDistributorPosting({ ...c, db }, d, "primary_order", key, {
          totalCentavos: 1000,
          lines: [],
        }),
      )
    ).id,
  ).toBe(req.id);
  const [count] =
    await h.db`select count(*)::int as n from sap_credit_decisions where consumed_by=${"distributor_request:" + req.id}`;
  expect(count.n).toBe(1);
});
test("F-504 actual TPM instruction reaches mock SAP and trusted ACK advances its source once", async () => {
  const p = await tx(h.db, (db) =>
    posting(
      { ...c, db },
      {
        sourceKey: "bridge-accrual",
        kind: "accrual",
        amountCentavos: 1000,
        currency: "PHP",
      },
    ),
  );
  await runOutbox(h.db, { env: h.env });
  await runOutbox(h.db, { env: h.env });
  const [saved] =
    await h.db`select * from tpm_posting_instructions where id=${p.id}`;
  expect(saved.status).toBe("acknowledged");
  expect(saved.sap_document).toContain("SAMPLE-ACCRUAL-");
  const receipts = await (
    await fetch(mock.origin + "/control/receipts")
  ).json();
  expect(
    receipts.rows.filter((/** @type {any} */ r) => r.effect === "tpm:" + p.id),
  ).toHaveLength(1);
  await expect(
    enqueueTpmPosting(
      h.db,
      {
        instructionId: p.id,
        kind: "accrual",
        sourceMode: "sample",
        amountCentavos: 1000,
      },
      {
        SAP_MODE: "real",
        SAP_ORIGIN: "https://example.invalid",
        SAP_TOKEN: "test-only",
      },
    ),
  ).rejects.toThrow("Sample financial");
});
test("F-403 reservation identity survives SQL rollback and refuses changed replay", async () => {
  const ctx = { ...c, body: { requestKey: "rollback-reservation" } };
  const key = crypto.randomUUID();
  await expect(
    tx(h.db, async (db) => {
      await enqueueDistributorPosting({ ...ctx, db }, d, "primary_order", key, {
        totalCentavos: 1200,
        lines: [],
      });
      throw new Error("injected rollback");
    }),
  ).rejects.toThrow("injected rollback");
  const req = await tx(h.db, (db) =>
    enqueueDistributorPosting({ ...ctx, db }, d, "primary_order", key, {
      totalCentavos: 1200,
      lines: [],
    }),
  );
  expect(
    mock.db
      .query("select count(*) as n from reservations where request=?")
      .get("confirm:distributor_request:" + req.id).n,
  ).toBe(1);
  await expect(
    tx(h.db, (db) =>
      enqueueDistributorPosting({ ...ctx, db }, d, "primary_order", key, {
        totalCentavos: 1300,
        lines: [],
      }),
    ),
  ).rejects.toThrow("conflicts");
});

test("F-504/F-507 every financial family receives one real acknowledgement", async () => {
  for (const kind of ["reversal", "release", "credit_memo", "payment"]) {
    const p = await tx(h.db, (db) =>
      posting(
        { ...c, db },
        {
          sourceKey: "family:" + kind,
          kind,
          amountCentavos: 100,
          currency: "PHP",
        },
      ),
    );
    await runOutbox(h.db, { env: h.env });
    const [r] =
      await h.db`select * from tpm_posting_instructions where id=${p.id}`;
    expect(r.status).toBe("acknowledged");
  }
});

test("F-003 sample reset never deletes ordinary SAP trace; exact dual ownership is required", async () => {
  const e = await tx(h.db, (db) =>
    receiveEvent(db, {
      eventId: "sample-reset-guard",
      direction: "outbound",
      kind: "test",
      payload: {},
    }),
  );
  const [trace] =
    await h.db`select id from integration_resolution_events where event_id=${e.id}`;
  await expect(
    (async () => {
      await h.db`delete from integration_resolution_events where id=${trace.id}`;
    })(),
  ).rejects.toThrow("append only");
  await expect(
    tx(h.db, async (db) => {
      await db`set local sunpride.seed_reset='sunpride-demo-v2'`;
      await db`delete from integration_resolution_events where id=${trace.id}`;
    }),
  ).rejects.toThrow("append only");
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-demo-v2','integration_events',${e.id},'test:parent')`;
  await expect(
    tx(h.db, async (db) => {
      await db`set local sunpride.seed_reset='sunpride-demo-v2'`;
      await db`delete from integration_resolution_events where id=${trace.id}`;
    }),
  ).rejects.toThrow("append only");
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-demo-v2','integration_resolution_events',${trace.id},'test:child')`;
  await tx(h.db, async (db) => {
    await db`set local sunpride.seed_reset='sunpride-demo-v2'`;
    await db`delete from integration_resolution_events where id=${trace.id}`;
  });
  expect(
    await h.db`select id from integration_resolution_events where id=${trace.id}`,
  ).toHaveLength(0);
});

test("F-407 partner configuration comes from the one call-flow engine", async () => {
  await ensureCallflowSamples(h.db);
  const [outlet] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride','BRIDGE','Sample retailer','active',${d.org_unit_id},'gt',${partner.subject}) returning id`;
  const [m] =
    await h.db`select id from distributor_master_versions where distributor_id=${d.id}`;
  await h.db`insert into distributor_outlets(distributor_id,outlet_id,master_version_id,effective_from) values(${d.id},${outlet.id},${m.id},'2020-01-01')`;
  const config = await distributorCallflowConfig({ ...c, now: Date.now() }, d);
  expect(config.configurations[outlet.id].definition.channelProfile).toBe(
    "distributor_rep",
  );
  expect(config.configurations[outlet.id].definition.steps[0].adapter).toBe(
    "check_in",
  );
  expect(config.nativeReady).toBe(false);
});
test("F-409/F-505 partner intake shares TPM claim identity and grants deny foreign claimants", async () => {
  await expect(
    authorizeClaimant(c, "distributor", crypto.randomUUID()),
  ).rejects.toThrow();
  const row = {
    id: crypto.randomUUID(),
    kind: "damage",
    claim_number: "BRIDGE",
    period_from: new Date("2020-01-01"),
    period_to: new Date("2020-01-02"),
    amount_centavos: 1000,
  };
  await tx(h.db, (db) =>
    bridgeClaim({ ...c, db, now: Date.now() }, d, row, []),
  );
  expect(
    await tx(h.db, (db) =>
      bridgeClaim({ ...c, db, now: Date.now() }, d, row, []),
    ),
  ).toBe(row.id);
  const [saved] = await h.db`select * from claims where id=${row.id}`;
  expect(saved.claimant_party_id).toBe(d.id);
  expect(saved.status).toBe("submitted");
  await h.db`update distributor_users set effective_to=now() where distributor_id=${d.id}`;
  await expect(authorizeClaimant(c, "distributor", d.id)).rejects.toThrow();
});
