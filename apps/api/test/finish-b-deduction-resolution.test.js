import { test, expect } from "bun:test";
import { startHarness, createUser, profileStore } from "./harness.js";
import { install } from "../src/domains/tpm/index.js";
import { sha256Hex } from "../src/core/util.js";
import { applySapAcknowledgement } from "../src/domains/tpm/finance.js";

test("F-509 independent resolution waits for exact SAP acknowledgement, rejects overcommit and preserves write-off separately", async () => {
  const h = await startHarness({ installers: [install] });
  try {
    const profiles = profileStore(h);
    const [unit] =
      await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values('sunpride','SAMPLE-ROOT','Sample national','region','active','2020-01-01') returning id`;
    h.setHooks({ rootUnitId: async () => unit.id });
    async function person() {
      const email = crypto.randomUUID() + "@example.com";
      const user = await createUser(h, email, "Sample fixture password only");
      const p = profiles.set(user, { role: "super_admin", orgUnitId: unit.id });
      await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user},${user},'Sample Finance',${email},'super_admin','active',${unit.id})`;
      const token = "sps_" + crypto.randomUUID().replaceAll("-", "");
      await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${user},${sha256Hex(token)},'web',now()+interval '1 day')`;
      return { id: p.id, cookie: "sp_session=" + token };
    }
    const author = await person(),
      approver = await person();
    /** @param {any} who @param {string} path @param {any} body */
    async function post(who, path, body) {
      const r = await h.fetch("/api/v1/tpm/deductions/" + path, {
        method: "POST",
        headers: { cookie: who.cookie, "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...body }),
      });
      return { status: r.status, body: await r.json() };
    }
    const created = await post(author, "capture", {
      sourceKey: "sample-resolution",
      accountKey: "SAMPLE",
      classification: "unknown",
      invoiceReference: "SAMPLE-INVOICE",
      remittanceReference: "SAMPLE-REMIT",
      amountCentavos: 1000,
      ownerProfileId: author.id,
      openedOn: "2026-10-01",
      dueOn: "2026-10-30",
    });
    expect(created.status).toBe(200);
    const id = created.body.id;
    const base = { id, reason: "Sample Finance review" };
    expect(
      (
        await post(approver, "decide", {
          ...base,
          action: "classify",
          classification: "short_delivery",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(author, "decide", {
          ...base,
          action: "recover",
          amountCentavos: 600,
        })
      ).status,
    ).not.toBe(200);
    const request = {
      ...base,
      action: "recover",
      amountCentavos: 600,
      idempotencyKey: crypto.randomUUID(),
    };
    expect((await post(approver, "decide", request)).status).toBe(200);
    expect((await post(approver, "decide", request)).status).toBe(200);
    expect(
      (
        await post(approver, "decide", {
          ...base,
          action: "write_off",
          amountCentavos: 401,
        })
      ).status,
    ).not.toBe(200);
    expect(
      (await post(approver, "decide", { ...base, action: "resolve" })).status,
    ).not.toBe(200);
    const [before] = await h.db`select * from deductions where id=${id}`;
    expect(Number(before.recovered_centavos)).toBe(0);
    expect(before.classification).toBe("short_delivery");
    const [recovery] =
      await h.db`select * from tpm_posting_instructions where payload->>'deductionId'=${id}`;
    expect(recovery.payload.sourceMode).toBe("sample");
    const ack = {
      instructionId: recovery.id,
      status: /** @type {'acknowledged'} */ ("acknowledged"),
      sapDocument: "SAMPLE-PAYMENT",
      sourceEventId: "sample-ack",
    };
    await applySapAcknowledgement(h.db, ack, h.env);
    expect((await applySapAcknowledgement(h.db, ack, h.env)).duplicate).toBe(
      true,
    );
    expect(
      (
        await post(approver, "decide", {
          ...base,
          action: "write_off",
          amountCentavos: 400,
        })
      ).status,
    ).toBe(200);
    const [writeoff] =
      await h.db`select * from tpm_posting_instructions where payload->>'deductionId'=${id} and kind='credit_memo'`;
    await applySapAcknowledgement(
      h.db,
      {
        instructionId: writeoff.id,
        status: "rejected",
        sourceEventId: "sample-reject",
      },
      h.env,
    );
    const [rejected] = await h.db`select * from deductions where id=${id}`;
    expect(Number(rejected.written_off_centavos)).toBe(0);
    expect(
      (
        await post(approver, "decide", {
          ...base,
          action: "write_off",
          amountCentavos: 400,
        })
      ).status,
    ).toBe(200);
    const [retry] =
      await h.db`select * from tpm_posting_instructions where payload->>'deductionId'=${id} and kind='credit_memo' and status<>'rejected'`;
    await applySapAcknowledgement(
      h.db,
      {
        instructionId: retry.id,
        status: "acknowledged",
        sapDocument: "SAMPLE-CREDIT",
        sourceEventId: "sample-credit",
      },
      h.env,
    );
    expect(
      (await post(approver, "decide", { ...base, action: "resolve" })).status,
    ).toBe(200);
    const [after] = await h.db`select * from deductions where id=${id}`;
    expect([
      Number(after.recovered_centavos),
      Number(after.written_off_centavos),
      after.status,
    ]).toEqual([600, 400, "resolved"]);
  } finally {
    await h.close();
  }
}, 30000);
