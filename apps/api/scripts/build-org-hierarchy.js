#!/usr/bin/env bun
// SP-0172: build Sunpride's org hierarchy from the client's roster reporting lines.
//
//   DATABASE_URL=... bun apps/api/scripts/build-org-hierarchy.js            (dry run, rolls back)
//   DATABASE_URL=... bun apps/api/scripts/build-org-hierarchy.js --apply
//   ... --snapshot <file.json>   also write every profile's effective scope (after the change)
//
// Target (client Master Data Hierarchies: Sales Organization > Sales Department > Regional > Area):
//   SUNPRIDE (national) > RS Route Sales (department) > 3 regions (region) > the 11 BR-* branches (area).
// Region names are geographic PLACEHOLDERS; the client may rename them.
//
// Unit writes go through orgCommand (create / reparent) inside ONE transaction, as an existing
// super admin, with the same audit_logs + change_log rows the admin API writes; parent_id is
// materialized the way the org.materialize job does. Unit types have no admin command (the app
// inserts them directly in identity.js / distributors), so the type step is direct SQL + audit.
// Hard guard: every active profile's effective scope (scopeUnitIds, as the API resolves it) is
// snapshotted before and after inside the transaction; any lost unit aborts and rolls back.
// People, supervisors and assignments are not touched.
import { writeFileSync } from "node:fs";
import { createDb, tx } from "@sunpride/db/client";
import { setHooks } from "../src/core/hooks.js";
import { actorFor } from "../src/core/context.js";
import { recordChange } from "../src/core/sync.js";
import { identityHooks, ORG_LOCK } from "../src/domains/org/identity.js";
import { writeAudit } from "../src/domains/org/audit.js";
import { personAt, topology } from "../src/domains/org/scope.js";
import { orgCommand } from "../src/domains/org/commands.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const ACTOR_EMAIL = opt("--actor", "jcing.jc@gmail.com").toLowerCase();
const SNAPSHOT = opt("--snapshot");
if (!process.env.DATABASE_URL) {
  console.error("Need DATABASE_URL");
  process.exit(2);
}
const REASON = "SP-0172 org hierarchy from client roster";

// Type levels: parent level must be strictly below child level (commands.parentFor).
const TYPES = [
  { code: "national", level: 0 },
  { code: "department", level: 1, label: "Sales Department" }, // created if missing
  { code: "region", level: 2 },
  { code: "area", level: 3 },
  { code: "territory", level: 4 },
];
const DEPT = { code: "RS", name: "Route Sales", type: "department" };
const REGIONS = [
  { code: "RG-VISAYAS", name: "Visayas", head: "Carlo Olasiman", branches: ["Cebu", "Ormoc", "Iloilo", "Dumaguete", "Bacolod"] },
  { code: "RG-NW-MINDANAO", name: "Northern & Western Mindanao", head: "June Bernabe Pascua", branches: ["Zamboanga", "Cagayan", "Ozamis"] },
  { code: "RG-ES-MINDANAO", name: "Eastern & Southern Mindanao", head: "Alan Dapar", branches: ["Butuan", "Davao", "Gensan"] },
];
const branchCode = (b) => `BR-${b.toUpperCase()}`;

class Rollback extends Error {}
const db = createDb(process.env.DATABASE_URL, { max: 2 });
const hooks = identityHooks({});
setHooks(hooks);
const summary = { mode: APPLY ? "apply" : "dry-run", changes: [] };
const change = (x) => summary.changes.push(x);

/** Effective scope of every active profile, resolved like /org/permissions scopeUnitIds. */
async function scopes(t, at) {
  const people = await t`select * from profiles where status='active' and deleted_at is null order by email`;
  const out = {};
  for (const p of people) {
    const eff = await personAt(t, p, at);
    out[p.email.toLowerCase()] = {
      role: eff.role,
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
    /** Admin API command wrapper (audit + change_log) plus the org.materialize parent projection. */
    const command = async (path, body, fn) => {
      const value = await fn(c, body);
      const entityId = body.unitId ?? value;
      await audit(path.replaceAll("/", "."), "org", entityId, body.reason);
      await recordChange(t, { entity: "org.reference", entityId, scopeKey: "global", op: "upsert" });
      return value;
    };

    // 1. Unit types (levels).
    for (const ty of TYPES) {
      const [row] = await t`select * from org_unit_types where organization_id='sunpride' and code=${ty.code}`;
      if (!row) {
        if (!ty.label) throw new Error(`org_unit_type ${ty.code} missing`);
        const [n] = await t`insert into org_unit_types(organization_id,code,label,level,active) values('sunpride',${ty.code},${ty.label},${ty.level},true) returning id`;
        await audit("org.type.create", "org", n.id, `${REASON}: type ${ty.code} level ${ty.level}`);
        change({ type: ty.code, action: "created", level: ty.level });
      } else {
        if (!row.active) throw new Error(`org_unit_type ${ty.code} inactive`);
        if (row.level !== ty.level) {
          await t`update org_unit_types set level=${ty.level}, updated_at=now() where id=${row.id}`;
          await audit("org.type.edit", "org", row.id, `${REASON}: type ${ty.code} level ${row.level} -> ${ty.level}`);
          change({ type: ty.code, action: "relevelled", from: row.level, to: ty.level });
        }
      }
    }

    // 2. Units.
    const tree = await topology(t, at);
    const byCode = new Map(tree.map((u) => [u.code, u]));
    const root = byCode.get("SUNPRIDE");
    if (!root) throw new Error("Root SUNPRIDE missing");
    const ensureUnit = async (code, name, type, parent) => {
      const [any] = await t`select * from org_units where organization_id='sunpride' and code=${code}`;
      if (any && (any.deleted_at || any.status !== "active" || any.effective_to)) throw new Error(`${code} exists but is inactive`);
      if (!any) {
        const id = await command("org/create", { parentId: parent.id, typeCode: type, code, name, effectiveFrom: at, reason: REASON }, (cc, b) => orgCommand(cc, "create", b));
        change({ unit: code, action: "created", name, type, parent: parent.code });
        return { id, code };
      }
      if (any.type_code !== type) throw new Error(`${code} has type ${any.type_code}, expected ${type}`);
      const cur = (await topology(t, at)).find((u) => u.id === any.id);
      if (cur.parent_id !== parent.id) throw new Error(`${code} exists under another parent`);
      return any;
    };
    const dept = await ensureUnit(DEPT.code, DEPT.name, DEPT.type, root);
    for (const r of REGIONS) {
      const region = await ensureUnit(r.code, r.name, "region", dept);
      for (const b of r.branches) {
        const unit = byCode.get(branchCode(b));
        if (!unit || unit.type_code !== "area") throw new Error(`Branch ${branchCode(b)} missing or not an area`);
        const cur = (await topology(t, at)).find((u) => u.id === unit.id);
        if (cur.parent_id === region.id) continue;
        if (cur.parent_id !== root.id) throw new Error(`${unit.code} sits under an unexpected parent`);
        await command("org/reparent", { unitId: unit.id, parentId: region.id, effectiveFrom: at, reason: REASON }, (cc, x) => orgCommand(cc, "reparent", x));
        change({ unit: unit.code, action: "moved", to: r.code });
      }
    }
    // org.materialize equivalent: keep org_units.parent_id (direct-table readers) in step.
    for (const u of await topology(t, at)) {
      const [row] = await t`select parent_id from org_units where id=${u.id}`;
      if ((row.parent_id ?? null) !== (u.parent_id ?? null)) {
        await t`update org_units set parent_id=${u.parent_id} where id=${u.id}`;
        change({ unit: u.code, action: "parent_id materialized" });
      }
    }

    // 3. Verify: tree shape and no scope loss.
    const final = await topology(t, at);
    const code = new Map(final.map((u) => [u.id, u.code]));
    summary.tree = final
      .map((u) => `${u.code} (${u.type_code}) <- ${code.get(u.parent_id) ?? "-"}`)
      .sort();
    const after = await scopes(t, at);
    const lost = [];
    let gained = 0;
    for (const [email, b] of Object.entries(before)) {
      const a = after[email];
      const miss = b.units.filter((id) => !a?.units.includes(id));
      if (miss.length || a?.role !== b.role) lost.push({ email, lost: miss.map((id) => code.get(id) ?? id) });
      gained += (a?.units.length ?? 0) - b.units.length;
    }
    const withSameScope = Object.keys(before).filter((e) => before[e].units.length === after[e].units.length).length;
    summary.scope = { profiles: Object.keys(before).length, lost: lost.length, sameSize: withSameScope, unitsGainedTotal: gained,
      byUnitCount: Object.entries(Object.values(after).reduce((m, s) => ((m[`${s.role}:${s.units.length}`] = (m[`${s.role}:${s.units.length}`] ?? 0) + 1), m), {})).sort() };
    if (SNAPSHOT) writeFileSync(SNAPSHOT, JSON.stringify({ at, before, after }, null, 1));
    if (lost.length) throw new Error(`Scope loss for ${lost.length} profiles: ${JSON.stringify(lost.slice(0, 5))}`);
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
