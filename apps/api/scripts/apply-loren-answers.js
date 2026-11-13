#!/usr/bin/env bun
// SP-0172 follow-up: apply Sunpride's (Loren, 2026-11-13 15:06) answers to the org hierarchy.
//
//   DATABASE_URL=... bun apps/api/scripts/apply-loren-answers.js            (dry run, rolls back)
//   DATABASE_URL=... bun apps/api/scripts/apply-loren-answers.js --apply
//   ... --snapshot <file.json>   write every profile's effective scope before/after
//
//  1. Region names = the client's coverage (codes, parents and branches unchanged), via orgCommand edit.
//     org_units has no short-label column, so only the full name is set.
//  2. Positions: Benedicto Perez = SR_CDM (Senior Channel Development Manager); Carlo Olasiman,
//     June Pascua, Alan Dapar = CDM (Channel Development Manager), supervisor Benedicto. Written with
//     assignPerson (the people/assign admin command): role, org unit and supervisor are kept.
//  3. org_unit_types 'department' label 'Sales Department' -> 'Distribution Channel' (no admin
//     command for types: SQL + audit, as SP-0172/SP-0173).
// Idempotent. One transaction; audit_logs + change_log rows like the admin API. Hard guard: every
// active profile's scopeUnitIds and role before == after, else rollback.
import { writeFileSync } from "node:fs";
import { createDb, tx } from "@sunpride/db/client";
import { setHooks } from "../src/core/hooks.js";
import { actorFor } from "../src/core/context.js";
import { recordChange } from "../src/core/sync.js";
import { identityHooks, ORG_LOCK } from "../src/domains/org/identity.js";
import { writeAudit } from "../src/domains/org/audit.js";
import { personAt, topology } from "../src/domains/org/scope.js";
import { orgCommand, assignPerson } from "../src/domains/org/commands.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const ACTOR_EMAIL = opt("--actor", "jcing.jc@gmail.com").toLowerCase();
const SNAPSHOT = opt("--snapshot");
if (!process.env.DATABASE_URL) {
  console.error("Need DATABASE_URL");
  process.exit(2);
}
const REASON = "SP-0172 client answers (Loren 2026-11-13): region coverage, CDM titles, Distribution Channel";

const REGIONS = [
  { code: "RG-VISAYAS", name: "Western Visayas, Central Visayas, Eastern Visayas, Negros Island Region" },
  { code: "RG-NW-MINDANAO", name: "Cagayan Valley, Zamboanga Peninsula, Northern Mindanao" },
  { code: "RG-ES-MINDANAO", name: "Davao Region, SOCCSKSARGEN, Caraga Region" },
];
const BOSS = "bperez@sunpride.com.ph";
const PEOPLE = [
  { email: BOSS, position: "SR_CDM" },
  { email: "colasiman@sunpride.com.ph", position: "CDM", supervisor: BOSS },
  { email: "jpascua@sunpride.com.ph", position: "CDM", supervisor: BOSS },
  { email: "adapar@sunpride.com.ph", position: "CDM", supervisor: BOSS },
];
const POSITION_LABELS = { SR_CDM: "Senior Channel Development Manager", CDM: "Channel Development Manager" };
const TYPE = { code: "department", from: "Sales Department", to: "Distribution Channel" };

class Rollback extends Error {}
const db = createDb(process.env.DATABASE_URL, { max: 2 });
const hooks = identityHooks({});
setHooks(hooks);
const summary = { mode: APPLY ? "apply" : "dry-run", changes: [] };
const change = (x) => summary.changes.push(x);

async function scopes(t, at) {
  const people = await t`select * from profiles where status='active' and deleted_at is null order by email`;
  const out = {};
  for (const p of people) {
    const eff = await personAt(t, p, at);
    out[p.email.toLowerCase()] = {
      role: eff.role,
      unit: eff.org_unit_id,
      units: (await hooks.scopeUnitIds(t, { role: eff.role, orgUnitId: eff.org_unit_id })).sort(),
    };
  }
  return out;
}

try {
  await tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(${ORG_LOCK})`;
    const [{ now }] = await t`select (extract(epoch from now())*1000)::bigint as now`;
    const at = Number(now);
    const before = await scopes(t, at);
    const [actorUser] = await t`select id from users where email=${ACTOR_EMAIL}`;
    if (!actorUser) throw new Error("Actor user not found");
    const actor = await actorFor(t, actorUser.id);
    if (actor?.role !== "super_admin") throw new Error("Actor must be an active super_admin");
    const c = { db: t, actor, now: at, env: {} };
    await t`select set_config('sunpride.actor',${actor.userId},true)`;
    const audit = (action, entityType, entityId, details) =>
      writeAudit(t, { subject: actor.subject, action, entityType, entityId, details });
    const command = async (path, body, fn) => {
      const value = await fn(c, body);
      const entityId = body.profileId ?? body.unitId ?? value;
      await audit(path.replaceAll("/", "."), path.split("/")[0], entityId, body.reason);
      await recordChange(t, { entity: "org.reference", entityId, scopeKey: "global", op: "upsert" });
      return value;
    };

    // 1. Region names.
    for (const r of REGIONS) {
      const [u] = await t`select * from org_units where organization_id='sunpride' and code=${r.code} and deleted_at is null`;
      if (!u || u.type_code !== "region") throw new Error(`${r.code} missing or not a region`);
      if (u.name === r.name) continue;
      await command("org/edit", { unitId: u.id, name: r.name, reason: REASON }, (cc, b) => orgCommand(cc, "edit", b));
      change({ unit: r.code, action: "renamed", from: u.name, to: r.name });
    }

    // 2. Positions.
    const pos = {};
    for (const [code, label] of Object.entries(POSITION_LABELS)) {
      const [p] = await t`select * from positions where organization_id='sunpride' and code=${code}`;
      if (!p || !p.active || p.label !== label) throw new Error(`Position ${code} '${label}' missing/inactive`);
      pos[code] = p.id;
    }
    const prof = async (email) => {
      const [p] = await t`select * from profiles where lower(email)=${email} and deleted_at is null`;
      if (!p) throw new Error(`Profile ${email} missing`);
      return p;
    };
    const boss = await prof(BOSS);
    for (const person of PEOPLE) {
      const p = await prof(person.email);
      const [cur] = await t`select * from employee_assignments where profile_id=${p.id} and deleted_at is null
        and effective_from <= to_timestamp(${at}/1000.0) and (effective_to is null or effective_to > to_timestamp(${at}/1000.0))`;
      if (!cur) throw new Error(`${person.email} has no current assignment`);
      const wantSup = person.supervisor ? boss.id : cur.supervisor_id;
      if (cur.position_id === pos[person.position] && p.position_id === pos[person.position] && cur.supervisor_id === wantSup) continue;
      const body = { profileId: p.id, positionId: pos[person.position], reason: REASON };
      if (cur.supervisor_id !== wantSup) body.supervisorId = wantSup;
      await command("people/assign", body, (cc, b) => assignPerson(cc, b));
      const [after] = await t`select role, org_unit_id from profiles where id=${p.id}`;
      if (after.role !== p.role || after.org_unit_id !== p.org_unit_id) throw new Error(`${person.email} role/unit changed`);
      change({ person: p.name, action: "position", to: POSITION_LABELS[person.position], supervisorSet: !!body.supervisorId });
    }
    // 2b. Pending invitations carry the roster position shown in the admin invite list; keep it in step.
    for (const person of PEOPLE) {
      const rows = await t`update access_invitations set position_id=${pos[person.position]}
        where lower(email)=${person.email} and status='pending' and position_id is distinct from ${pos[person.position]} returning id`;
      for (const r of rows) {
        await audit("people.invitation.edit", "people", r.id, `${REASON}: invitation position -> ${person.position}`);
        change({ invitation: person.email, action: "position", to: POSITION_LABELS[person.position] });
      }
    }

    // 3. Org type label.
    const [ty] = await t`select * from org_unit_types where organization_id='sunpride' and code=${TYPE.code}`;
    if (!ty) throw new Error("department type missing");
    if (ty.label !== TYPE.to) {
      await t`update org_unit_types set label=${TYPE.to}, updated_at=now() where id=${ty.id}`;
      await audit("org.type.edit", "org", ty.id, `${REASON}: type ${TYPE.code} label '${ty.label}' -> '${TYPE.to}'`);
      await recordChange(t, { entity: "org.reference", entityId: ty.id, scopeKey: "global", op: "upsert" });
      change({ type: TYPE.code, action: "relabelled", from: ty.label, to: TYPE.to });
    }

    // 4. Verify.
    const final = await topology(t, at);
    const types = new Map((await t`select code,label from org_unit_types where organization_id='sunpride'`).map((r) => [r.code, r.label]));
    const names = new Map((await t`select id,code,name from org_units`).map((r) => [r.id, r]));
    const kids = new Map();
    for (const u of final) kids.set(u.parent_id ?? null, [...(kids.get(u.parent_id ?? null) ?? []), u]);
    const lines = [];
    const walk = (pid, d) => {
      for (const u of (kids.get(pid) ?? []).sort((a, b) => a.code.localeCompare(b.code))) {
        lines.push(`${"  ".repeat(d)}${u.code} ${names.get(u.id).name} [${types.get(u.type_code) ?? u.type_code}]`);
        walk(u.id, d + 1);
      }
    };
    walk(null, 0);
    summary.tree = lines;
    summary.people = await t`select p.name, po.label as position, s.name as supervisor, p.role, ou.code as unit
      from profiles p join employee_assignments e on e.profile_id=p.id and e.deleted_at is null and e.effective_to is null
      left join positions po on po.id=e.position_id left join profiles s on s.id=e.supervisor_id left join org_units ou on ou.id=p.org_unit_id
      where lower(p.email) in ${t(PEOPLE.map((x) => x.email))} order by po.label desc, p.name`;
    const after = await scopes(t, at);
    const lost = [];
    for (const [email, b] of Object.entries(before)) {
      const a = after[email];
      const miss = b.units.filter((id) => !a?.units.includes(id));
      if (miss.length || a?.role !== b.role || a?.unit !== b.unit) lost.push({ email, lost: miss.length });
    }
    const same = Object.keys(before).filter((e) => JSON.stringify(before[e].units) === JSON.stringify(after[e]?.units)).length;
    summary.scope = { profiles: Object.keys(before).length, lost: lost.length, identicalScope: same };
    if (SNAPSHOT) writeFileSync(SNAPSHOT, JSON.stringify({ at, before, after }, null, 1));
    if (lost.length) throw new Error(`Scope/role change for ${lost.length} profiles`);
    summary.changed = summary.changes.length;
    if (!APPLY) throw new Rollback();
  });
  summary.committed = APPLY;
} catch (e) {
  if (!(e instanceof Rollback)) {
    summary.committed = false;
    summary.error = String(e?.message ?? e);
    console.log(JSON.stringify(summary, null, 2));
    await db.close();
    process.exit(1);
  }
  summary.note = "dry run: rolled back";
}
console.log(JSON.stringify(summary, null, 2));
await db.close();
