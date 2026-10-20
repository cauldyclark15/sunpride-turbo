import { tx } from "@sunpride/db/client";
import { join } from "node:path";
import { actorFor } from "../../core/context.js";
import { requireCapability } from "../../core/capabilities.js";
import { filesDir } from "../../core/media.js";
import { partnerContext } from "./boundary.js";
import { outletOwnerUnit } from "../org/scope.js";
import { evidence } from "./evidence.js";
import {
  authorize,
  bound,
  command,
  date,
  digest,
  fail,
  integer,
  read,
  text,
  today,
  uuid,
  wire,
} from "./model.js";

/** @param {any} c */
async function createAgency(c) {
  const b = c.body ?? {},
    code = text(b.code, 50),
    name = text(b.name),
    unit = uuid(b.orgUnitId);
  return tx(c.db, async (db) => {
    const actor = c.actor ? await actorFor(db, c.actor.userId) : null;
    await requireCapability({ ...c, db, actor }, "integration.manage", unit);
    const [u] =
      await db`select id from org_units where id=${unit} and status='active' and deleted_at is null`;
    if (!u) fail("Choose an active supervising unit");
    const [old] = await db`select * from distributors where code=${code}`;
    if (old) {
      await authorize({ ...c, db, actor }, old.id, "portal", true);
      if (old.name !== name || old.org_unit_id !== unit)
        fail("Code is already used", "conflict", 409);
      return { id: old.id, duplicate: true };
    }
    const [p] =
      await db`insert into distributors(code,name,org_unit_id,source,status,partner_kind) values(${code},${name},${unit},'office','accredited','agency') returning id`;
    await db`insert into partner_events(distributor_id,actor_id,action,details) values(${p.id},${actor?.profileId},'F-322.create',${{ code }})`;
    return p;
  });
}
/** @param {any} c @param {any} p @param {any} b */
async function invite(c, p, b) {
  const name = text(b.name),
    email = text(b.email).toLowerCase(),
    field = b.access === "field";
  if (
    !["field", "portal"].includes(b.access) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  )
    fail("Choose field staff or portal access and a valid email");
  const role = field ? "sales" : "agency",
    grants = field ? ["field"] : ["portal", "billing"];
  const [existing] =
    await c.db`select * from profiles where lower(email)=${email} for update`;
  if (
    existing &&
    (existing.employment_type !== "third_party" ||
      existing.role !== role ||
      existing.org_unit_id !== p.org_unit_id)
  )
    fail(
      "Use a dedicated third-party account; employee accounts cannot be adopted",
      "conflict",
      409,
    );
  const [profile] = existing
    ? [existing]
    : await c.db`insert into profiles(name,email,role,status,employment_type,org_unit_id) values(${name},${email},${role},'active','third_party',${p.org_unit_id}) returning *`;
  const future =
    await c.db`select * from distributor_users where profile_id=${profile.id} and (effective_to is null or effective_to>now()) for update`;
  if (
    future.some(
      (/** @type {any} */ m) =>
        m.distributor_id !== p.id ||
        new Date(m.effective_from).getTime() >= c.now,
    )
  )
    fail(
      "Account is already assigned or has scheduled access",
      "conflict",
      409,
    );
  for (const m of future)
    await c.db`update distributor_users set effective_to=now() where id=${m.id}`;
  const [m] =
    await c.db`insert into distributor_users(distributor_id,profile_id,grants) values(${p.id},${profile.id},${c.db.array(grants, "TEXT")}) returning id`;
  // SEAM(ORG): new field people use the SAME assignment history and call adapter.
  if (field && !existing)
    await c.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${profile.id},${p.org_unit_id},'sales',now(),${c.actor.subject},'F-322 agency field invitation')`;
  await c.db`update profiles set scope_epoch=scope_epoch+1 where id=${profile.id}`;
  if (!profile.user_id) {
    await c.db`update access_invitations set status='revoked' where lower(email)=${email} and status='pending'`;
    await c.db`insert into access_invitations(email,name,role,status,invited_by,invited_at,profile_id) values(${email},${name},${role},'pending',${c.actor.subject},now(),${profile.id})`;
  }
  return { id: m.id, profileId: profile.id, name, email, access: b.access };
}
/** @param {any} c @param {any} p @param {any} b */
async function revoke(c, p, b) {
  const [m] =
    await c.db`update distributor_users set effective_to=now() where id=${uuid(b.membershipId)} and distributor_id=${p.id} and effective_from<now() and (effective_to is null or effective_to>now()) returning id,profile_id`;
  if (!m) fail("Active membership unavailable");
  await c.db`update profiles set scope_epoch=scope_epoch+1 where id=${m.profile_id}`;
  return { id: m.id };
}
/** @param {any} c @param {any} p @param {any} b */
async function setOutlet(c, p, b) {
  const outletId = uuid(b.outletId),
    owner = await outletOwnerUnit(c.db, outletId, c.now);
  if (owner !== p.org_unit_id)
    fail("Choose a store owned by the supervising unit", "out_of_scope", 403);
  await requireCapability(c, "outlet.read", owner);
  const from = new Date(b.effectiveFrom ?? c.now);
  if (!Number.isFinite(from.getTime()) || from.getTime() < c.now - 1000)
    fail("Store access must start now or in the future");
  const pending =
    await c.db`select * from partner_outlet_assignments where distributor_id=${p.id} and outlet_id=${outletId} and (effective_to is null or effective_to>now()) and (effective_to is null or effective_to>effective_from) order by effective_from for update`;
  let id = null;
  for (const old of pending) {
    if (new Date(old.effective_from).getTime() >= from.getTime()) {
      // Withdraw/replace pending access too: it must never silently return later.
      await c.db`update partner_outlet_assignments set effective_to=effective_from where id=${old.id}`;
      id ??= old.id;
    } else if (
      !old.effective_to ||
      new Date(old.effective_to).getTime() > from.getTime()
    ) {
      await c.db`update partner_outlet_assignments set effective_to=${from} where id=${old.id}`;
      id ??= old.id;
    }
  }
  if (b.allowed !== false) {
    const [g] =
      await c.db`insert into partner_outlet_assignments(distributor_id,outlet_id,effective_from) values(${p.id},${outletId},${from}) returning id`;
    id = g.id;
  }
  await c.db`update profiles set scope_epoch=scope_epoch+1 where id in (select profile_id from distributor_users where distributor_id=${p.id})`;
  return { id: id ?? null };
}
/** @param {any} c @param {any} p @param {any} b */
async function setContract(c, p, b) {
  const rate = integer(b.rateCentavos),
    minimum = integer(b.minimumCalls, 1, 200),
    dwell = integer(b.minimumDwellMs, 0, 86400000),
    source = text(b.sourceRef);
  const kinds = b.requiredKinds;
  if (
    !Array.isArray(kinds) ||
    !kinds.length ||
    kinds.length > 5 ||
    new Set(kinds).size !== kinds.length ||
    kinds.some(
      (k) =>
        ![
          "merchandising",
          "inventory_check",
          "price_check",
          "promotion",
          "note",
        ].includes(k),
    )
  )
    fail("Choose supported required activity evidence");
  const from = new Date(b.effectiveFrom ?? c.now);
  if (!Number.isFinite(from.getTime()) || from.getTime() < c.now - 1000)
    fail("Contract changes must be prospective");
  const [old] =
    await c.db`select * from partner_contracts where distributor_id=${p.id} order by version desc limit 1`;
  if (old) {
    if (new Date(old.effective_from).getTime() >= from.getTime())
      fail("A later contract is already scheduled", "conflict", 409);
    await c.db`update partner_contracts set effective_to=${from} where id=${old.id}`;
  }
  const [k] =
    await c.db`insert into partner_contracts(distributor_id,version,source_ref,sample,rate_centavos,minimum_calls,minimum_dwell_ms,required_kinds,effective_from,created_by)
    values(${p.id},${Number(old?.version ?? 0) + 1},${source},${p.source === "sample"},${rate},${minimum},${dwell},${c.db.array(kinds, "TEXT")},${from},${c.actor.profileId}) returning id,version`;
  return k;
}
/** @param {any} c @param {any} p @param {any} b */
async function buildBilling(c, p, b) {
  await authorize(c, p.id, "billing");
  const e = await evidence(c, p.id, date(b.from), date(b.to));
  if (p.source !== "sample" && !e.retailIssueFeedAvailable)
    fail(
      "Connect operational incident evidence before building agency billing",
      "needs_setup",
    );
  const [old] =
    await c.db`select id from partner_billing_periods where distributor_id=${p.id} and period_from=${b.from}::date and period_to=${b.to}::date and evidence_hash=${e.evidenceHash}`;
  if (old) return { id: old.id, evidenceHash: e.evidenceHash, duplicate: true };
  // No two approved overlapping periods may represent the same staff/day.
  const [overlap] =
    await c.db`select x.id from partner_billing_periods x join partner_billing_decisions d on d.period_id=x.id
    where x.distributor_id=${p.id} and d.decision='approved' and x.period_from<=${b.to}::date and x.period_to>=${b.from}::date limit 1`;
  if (overlap)
    fail(
      "An approved billing period already covers these dates",
      "conflict",
      409,
    );
  const [period] =
    await c.db`insert into partner_billing_periods(distributor_id,period_from,period_to,evidence_hash,created_by) values(${p.id},${b.from},${b.to},${e.evidenceHash},${c.actor.profileId}) returning id`;
  for (const row of e.rows)
    await c.db`insert into partner_billing_lines(period_id,profile_id,service_date,amount_centavos,evidence) values(${period.id},${row.profileId},${row.date},${row.amountCentavos},${row})`;
  return {
    id: period.id,
    evidenceHash: e.evidenceHash,
    lines: e.rows.length,
    amountCentavos: e.summary.amountCentavos,
  };
}
/** @param {any} c @param {string} id @param {string} periodId */
async function billing(c, id, periodId) {
  await authorize(c, id, "billing");
  const [p] =
    await c.db`select * from partner_billing_periods where id=${uuid(periodId)} and distributor_id=${id}`;
  if (!p) fail("Billing package unavailable", "out_of_scope", 403);
  const lines =
    await c.db`select * from partner_billing_lines where period_id=${p.id} order by service_date,profile_id`;
  const current = await evidence(
    c,
    id,
    date(p.period_from.toISOString().slice(0, 10)),
    date(p.period_to.toISOString().slice(0, 10)),
  );
  const currentStaff = new Set(
    current.rows.map((/** @type {any} */ r) => r.profileId),
  );
  if (
    lines.some(
      (/** @type {any} */ l) =>
        !currentStaff.has(l.profile_id) ||
        l.evidence.visits.some(
          (/** @type {any} */ v) =>
            !current.visits.some((/** @type {any} */ x) => x.id === v.id),
        ),
    )
  )
    fail(
      "This package includes staff or stores no longer assigned to your organisation",
      "out_of_scope",
      403,
    );
  const [decision] =
    await c.db`select d.*,p.name as reviewer from partner_billing_decisions d join profiles p on p.id=d.actor_id where d.period_id=${p.id}`;
  return {
    id: p.id,
    from: p.period_from.toISOString().slice(0, 10),
    to: p.period_to.toISOString().slice(0, 10),
    evidenceHash: p.evidence_hash,
    stale: current.evidenceHash !== p.evidence_hash,
    createdBy: p.created_by,
    lines: lines.map((/** @type {any} */ l) => l.evidence),
    decision: decision
      ? {
          decision: decision.decision,
          reviewer: decision.reviewer,
          reason: decision.reason,
          at: decision.created_at,
        }
      : null,
  };
}
/** @param {any} c @param {any} p @param {any} b */
async function decideBilling(c, p, b) {
  const pack = await billing(c, p.id, uuid(b.periodId));
  if (pack.createdBy === c.actor.profileId)
    fail(
      "Another office person must sign off this evidence",
      "self_approval",
      403,
    );
  if (!["approved", "rejected"].includes(b.decision))
    fail("Choose approve or reject");
  if (pack.stale || b.evidenceHash !== pack.evidenceHash)
    fail(
      "System evidence changed; build a fresh package",
      "stale_evidence",
      409,
    );
  if (pack.decision)
    fail("This package already has a decision", "conflict", 409);
  if (b.decision === "approved") {
    const [overlap] =
      await c.db`select x.id from partner_billing_periods x join partner_billing_decisions d on d.period_id=x.id where x.distributor_id=${p.id} and x.id<>${pack.id} and d.decision='approved' and x.period_from<=${pack.to}::date and x.period_to>=${pack.from}::date limit 1`;
    if (overlap)
      fail("An approved package already covers these dates", "conflict", 409);
  }
  const [d] =
    await c.db`insert into partner_billing_decisions(period_id,evidence_hash,decision,reason,actor_id) values(${pack.id},${pack.evidenceHash},${b.decision},${text(b.reason, 500)},${c.actor.profileId}) returning id`;
  return { id: d.id, decision: b.decision };
}
/** @param {any} router @param {any} ctx */
export function install(router, ctx) {
  ctx.registerTopic(
    "partner",
    async (/** @type {any} */ actor, /** @type {string} */ topic) => {
      try {
        const c = { db: ctx.db, actor },
          id = topic.split(":")[1];
        await authorize(c, id);
        return true;
      } catch {
        return false;
      }
    },
  );
  router.get("/api/v1/partners", (/** @type {any} */ c) =>
    read(c, async (cc) => {
      const m = await partnerContext(cc.db, cc.actor);
      if (m) {
        if (m.partner_kind !== "agency")
          fail("Agency access required", "out_of_scope", 403);
        await authorize(cc, m.distributor_id);
        return {
          rows: [{ id: m.distributor_id, name: m.name, source: m.source }],
        };
      }
      await requireCapability(cc, "integration.read");
      const all = bound(
          await cc.db`select id,name,source,org_unit_id from distributors where partner_kind='agency' order by name,id limit 201`,
          200,
        ),
        rows = [];
      for (const p of all) {
        try {
          await authorize(cc, p.id);
          rows.push(p);
        } catch (e) {
          if (/** @type {any} */ (e).status !== 403) throw e;
        }
      }
      return { rows };
    }),
  );
  router.post("/api/v1/partners/create", createAgency);
  for (const [action, fn] of Object.entries({
    invite,
    revoke,
    "outlet/set": setOutlet,
    "contract/set": setContract,
    "billing/decide": decideBilling,
  }))
    router.post(`/api/v1/partners/${action}`, (/** @type {any} */ c) =>
      command(c, `F-322.${action}`, fn),
    );
  router.post("/api/v1/partners/billing/build", (/** @type {any} */ c) =>
    command(c, "F-319.billing.build", buildBilling, {
      office: false,
      grant: "billing",
      replay: (cc, p, response) => billing(cc, p.id, response.id),
    }),
  );
  router.get("/api/v1/partners/setup", (/** @type {any} */ c) =>
    read(c, async (cc) => {
      const id = uuid(cc.url.searchParams.get("partnerId"));
      const agency = await authorize(cc, id);
      const external = await partnerContext(cc.db, cc.actor);
      const candidates = external
        ? []
        : bound(
            await cc.db`select o.id,o.name from outlets o
        left join outlet_assignments a on a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())
        left join territory_ownerships own on own.territory_id=a.territory_id and own.deleted_at is null and own.effective_from<=now() and (own.effective_to is null or own.effective_to>now())
        where o.status='active' and o.deleted_at is null and coalesce(own.org_unit_id,o.custodian_org_unit_id)=${agency.org_unit_id} order by o.name,o.id limit 2001`,
            2000,
          );
      const staff =
        await cc.db`select m.id,m.profile_id,p.name,p.email,m.grants,m.effective_from,m.effective_to from distributor_users m join profiles p on p.id=m.profile_id where m.distributor_id=${id} and m.effective_from<=now() and (m.effective_to is null or m.effective_to>now()) order by p.name`;
      const contracts =
        await cc.db`select * from partner_contracts where distributor_id=${id} order by version desc limit 100`;
      const outlets =
        await cc.db`select g.id,g.outlet_id,o.name,g.effective_from,g.effective_to from partner_outlet_assignments g join outlets o on o.id=g.outlet_id
          left join outlet_assignments a on a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())
          left join territory_ownerships own on own.territory_id=a.territory_id and own.deleted_at is null and own.effective_from<=now() and (own.effective_to is null or own.effective_to>now())
          where g.distributor_id=${id} and o.deleted_at is null and coalesce(own.org_unit_id,o.custodian_org_unit_id)=${agency.org_unit_id}
            and g.effective_from<=now() and (g.effective_to is null or g.effective_to>now()) order by o.name`;
      const periods =
        await cc.db`select x.id,x.period_from,x.period_to,x.evidence_hash,d.decision from partner_billing_periods x left join partner_billing_decisions d on d.period_id=x.id where x.distributor_id=${id} order by x.created_at desc limit 100`;
      return { staff, contracts, outlets, periods, outletOptions: candidates };
    }),
  );
  router.get("/api/v1/partners/evidence", (/** @type {any} */ c) =>
    read(c, (cc) =>
      evidence(
        cc,
        uuid(cc.url.searchParams.get("partnerId")),
        date(cc.url.searchParams.get("from") ?? today()),
        date(cc.url.searchParams.get("to") ?? today()),
      ),
    ),
  );
  router.get("/api/v1/partners/billing", (/** @type {any} */ c) =>
    read(c, (cc) =>
      billing(
        cc,
        uuid(cc.url.searchParams.get("partnerId")),
        uuid(cc.url.searchParams.get("periodId")),
      ),
    ),
  );
  router.get(
    "/api/v1/partners/billing/export",
    async (/** @type {any} */ c) => {
      const pack = await read(c, (cc) =>
        billing(
          cc,
          uuid(cc.url.searchParams.get("partnerId")),
          uuid(cc.url.searchParams.get("periodId")),
        ),
      );
      const body = JSON.stringify({ feature: "F-319", ...pack }, null, 2);
      return new Response(body, {
        headers: {
          "content-type": "application/json",
          "content-disposition":
            'attachment; filename="agency-billing-evidence.json"',
          "cache-control": "private, no-store",
        },
      });
    },
  );
  router.get("/api/v1/partners/media/:id", async (/** @type {any} */ c) => {
    const file = await read(c, async (cc) => {
      const id = uuid(cc.url.searchParams.get("partnerId"));
      const [f] =
        await cc.db`select e.visit_id,b.* from field_evidence_files e join files b on b.id=e.storage_id where e.id=${uuid(cc.params.id)} and e.deleted_at is null and b.status='stored'`;
      if (!f) fail("Evidence unavailable", "out_of_scope", 403);
      const [v] =
        await cc.db`select service_date from visit_executions where id=${f.visit_id}`;
      if (!v) fail("Evidence unavailable", "out_of_scope", 403);
      const data = await evidence(
        cc,
        id,
        v.service_date.toISOString().slice(0, 10),
        v.service_date.toISOString().slice(0, 10),
      );
      if (!data.visits.some((x) => x.id === f.visit_id))
        fail("Evidence is not owned by this agency", "out_of_scope", 403);
      return f;
    });
    if (!file.path || !/^[0-9a-f]{2}\/[0-9a-f]{64}$/.test(file.path))
      fail("Evidence unavailable");
    return new Response(Bun.file(join(filesDir(c.env), file.path)), {
      headers: {
        "content-type": file.mime,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
