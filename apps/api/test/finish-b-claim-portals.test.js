import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";
import { sha256Hex } from "../src/core/util.js";
import { ensureRoot } from "../src/domains/org/identity.js";
import { install as org } from "../src/domains/org/index.js";
import { install as mt } from "../src/domains/mt/index.js";
import { install as tpm } from "../src/domains/tpm/index.js";
import { manilaDate } from "../src/domains/visits/shared.js";
/** @type {any} */ let h;
/** @type {any[]} */ const parties = [];
const day = manilaDate(Date.now()),
  policy = crypto.randomUUID(),
  proof = crypto.randomUUID();
/** @param {string} name @param {string|null} role @param {string} unit */
async function person(name, role, unit) {
  const [u] =
    await h.db`insert into users(email,password_hash) values(${name + "@example.com"},'fixture-not-a-login') returning id`;
  let profile = null;
  if (role) {
    [profile] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${u.id},${u.id},${"Sample " + name},${name + "@example.com"},${role},'active',${unit}) returning id`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${profile.id},${unit},${role},now()-interval '1 day',${u.id},'Sample fixture')`;
  }
  const token = "sps_" + crypto.randomUUID().replaceAll("-", "");
  const [session] =
    await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${u.id},${sha256Hex(token)},'web',now()+interval '1 day') returning id`;
  return {
    userId: u.id,
    profileId: profile?.id,
    cookie: "sp_session=" + token,
    sessionId: session.id,
  };
}
/** @param {any} p @param {string} action @param {any} [body] */
async function api(p, action = "", body = null) {
  const r = await h.fetch(
    p.base + action + (body ? "" : "?partyId=" + p.partyId),
    {
      method: body ? "POST" : "GET",
      headers: { cookie: p.cookie, "content-type": "application/json" },
      ...(body
        ? {
            body: JSON.stringify({
              ...body,
              partyId: body.partyId ?? p.partyId,
            }),
          }
        : {}),
    },
  );
  return { status: r.status, body: /** @type {any} */ (await r.json()) };
}
beforeAll(async () => {
  h = await startHarness({ installers: [org, mt, tpm] });
  const root = await ensureRoot(h.db),
    office = await person("sample-claim-office", "super_admin", root);
  await h.db`insert into claim_types(id,code,effective_from,effective_to,required_evidence,source) values(${policy},'SAMPLE-SOURCE',now()-interval '1 day',now()+interval '1 year','["source_document"]'::jsonb,'sample')`;
  for (const kind of ["agency", "distributor"]) {
    const [privateUnit] =
      await h.db`insert into org_units(organization_id,code,name,type_code,status,parent_id,effective_from) values('sunpride',${"SAMPLE-" + kind},${"Sample " + kind},'team','active',${root},now()-interval '1 day') returning id`;
    const user = await person(
      "sample-claim-" + kind,
      kind === "agency" ? "sales" : "distributor",
      privateUnit.id,
    );
    const [p] =
      await h.db`insert into distributors(code,name,org_unit_id,device_org_unit_id,status,source,partner_kind,effective_from) values(${kind.toUpperCase()},${"Sample " + kind},${root},${privateUnit.id},'accredited','sample',${kind},now()-interval '1 day') returning id`;
    await h.db`insert into distributor_users(distributor_id,profile_id,grants,effective_from) values(${p.id},${user.profileId},${kind === "agency" ? "{portal,read,billing}" : "{read,claim}"}::text[],now()-interval '1 day')`;
    parties.push({
      ...user,
      partyId: p.id,
      base:
        kind === "agency"
          ? "/api/v1/partners/claims/shared"
          : "/api/v1/distributors/claims/shared",
      kind,
    });
  }
  const customer = await person("sample-claim-customer", null, root);
  for (const n of [1, 2]) {
    const [account] =
      await h.db`insert into customers(code,name,channel,territory,credit_limit,active) values(${"SAMPLE-C" + n},${"Sample branch " + n},'mt','Sample',0,true) returning id`;
    const [outlet] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride',${"SAMPLE-C" + n},${"Sample branch " + n},'active',${root},'mt',${office.userId}) returning id`;
    const [b] =
      await h.db`insert into mt_account_bindings(customer_id,outlet_id,account_key,banner_key,branch_key,label,source,source_version,effective_from) values(${account.id},${outlet.id},'SAMPLE-ACCOUNT','SAMPLE-BANNER',${"SAMPLE-BRANCH-" + n},${"Sample branch " + n},'sample','1',now()-interval '1 day') returning id`;
    parties.push({
      ...customer,
      partyId: b.id,
      base: "/api/v1/portal/claims",
      kind: n === 1 ? "modern_trade" : "foreign_branch",
    });
    if (n === 1) {
      const [type] =
        await h.db`insert into mt_deduction_types(code,label,sla_days,effective_from) values('SAMPLE','Sample deduction',7,now()-interval '1 day') returning id`;
      const [remit] =
        await h.db`insert into mt_remittances(binding_id,reference,received_on,gross_centavos,paid_centavos,created_by) values(${b.id},'SAMPLE-CLAIM',${day},1005,0,${office.userId}) returning id`;
      await h.db`insert into mt_deductions(id,remittance_id,binding_id,type_id,amount_centavos,owner_profile_id,due_on) values(${proof},${remit.id},${b.id},${type.id},1005,${office.profileId},${day})`;
    }
  }
  await h.db`insert into mt_portal_memberships(user_id,name,scope_kind,scope_key,effective_from) values(${customer.userId},'Sample branch customer','branch','SAMPLE-BRANCH-1',now()-interval '1 day')`;
}, 60000);
afterAll(async () => {
  await h?.close();
});
/** @param {any} p @param {string} reference */
const packet = (p, reference) => ({
  idempotencyKey: crypto.randomUUID(),
  reference,
  typeId: policy,
  periodFrom: day,
  periodTo: day,
  amountCentavos: 1005,
  sources:
    p.kind === "modern_trade"
      ? [{ kind: "source_document", sourceId: proof }]
      : [],
});
test("F-505 F-507 all three portals submit to one claim object and receive their own notices; a branch cannot read its sibling", async () => {
  for (const p of parties.filter((p) => p.kind !== "foreign_branch")) {
    expect((await api(p)).status).toBe(200);
    const b = packet(p, "SAMPLE-" + p.kind),
      r = await api(p, "/submit", b);
    expect(r.status).toBe(200);
    expect((await api(p, "/submit", b)).body.rows[0].id).toBe(
      r.body.rows[0].id,
    );
    const q = await api(p);
    expect(q.body.rows[0].id).toBe(r.body.rows[0].id);
    expect(q.body.notices.length).toBeGreaterThan(0);
    const notice = q.body.notices[0];
    expect(
      (
        await api(p, "/read", {
          id: notice.id,
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect(
      (await api(p)).body.notices.find(
        (/** @type {any} */ n) => n.id === notice.id,
      ).read_at,
    ).not.toBeNull();
  }
  expect((await api(parties[3])).status).toBe(403);
  expect(
    Number(
      (
        await h.db`select count(*)::int n from claim_evidence where source_id=${proof}`
      )[0].n,
    ),
  ).toBe(1);
});
test("F-505 bulk intake rolls back every row on an invalid policy, and a revised fingerprint cannot reuse an original source", async () => {
  const p = parties[2];
  const first = { ...packet(p, "SAMPLE-ATOMIC-1"), sources: [] },
    bad = {
      ...packet(p, "SAMPLE-ATOMIC-2"),
      sources: [],
      typeId: crypto.randomUUID(),
    };
  expect(
    (
      await api(p, "/bulk", {
        idempotencyKey: crypto.randomUUID(),
        rows: [first, bad],
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    Number(
      (
        await h.db`select count(*)::int n from claims where reference='SAMPLE-ATOMIC-1'`
      )[0].n,
    ),
  ).toBe(0);
  await h.db`update mt_deductions set updated_at=clock_timestamp() where id=${proof}`;
  expect(
    (await api(p, "/submit", packet(p, "SAMPLE-REUSE"))).status,
  ).toBeGreaterThanOrEqual(400);
  await h.db`update mt_portal_memberships set effective_to=now() where user_id=${p.userId}`;
  expect((await api(p)).status).toBe(403);
});
