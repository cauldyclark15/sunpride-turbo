#!/usr/bin/env bun
// SP-0168: load Sunpride's real people from the client's roster CSV.
//
//   DATABASE_URL=... bun apps/api/scripts/load-client-users.js --csv <roster.csv> --dry-run
//   DATABASE_URL=... bun apps/api/scripts/load-client-users.js --csv <roster.csv> --yes
//
// Writes go through the org domain's own commands (orgCommand, invitationCommand,
// assignPerson) inside ONE transaction, acting as an existing super admin (--actor,
// default jcing.jc@gmail.com), with the same audit_logs + change_log rows the admin API
// writes. Nothing here sends mail: invitations in this app are an allow-list only (the
// person later chooses a password on the web "Create account" screen). The script fails
// closed if any mail / notification / job table changes inside its transaction.
// Output: one JSON summary (no secrets, no URLs). --dry-run rolls everything back.
import { readFileSync } from "node:fs";
import { createDb, tx } from "@sunpride/db/client";
import { setHooks } from "../src/core/hooks.js";
import { actorFor } from "../src/core/context.js";
import { recordChange } from "../src/core/sync.js";
import { identityHooks, ORG_LOCK } from "../src/domains/org/identity.js";
import { writeAudit } from "../src/domains/org/audit.js";
import { insert, history, activeAt } from "../src/domains/org/model.js";
import {
  assignPerson,
  invitationCommand,
  orgCommand,
} from "../src/domains/org/commands.js";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const DRY = flag("--dry-run");
if (DRY === flag("--yes")) {
  console.error("Choose exactly one of --dry-run or --yes");
  process.exit(2);
}
const CSV = opt("--csv");
const ACTOR_EMAIL = opt("--actor", "jcing.jc@gmail.com").toLowerCase();
if (!CSV || !process.env.DATABASE_URL) {
  console.error("Need --csv <file> and DATABASE_URL");
  process.exit(2);
}

// ---- Client data (their labels win) -------------------------------------------------
const COMPANY_NAME = "Sunpride Foods Inc.";
const BRANCH_TYPE = "area"; // org_unit_types 'area' (Area, level 2) under root 'national'
const BRANCHES = [
  "Zamboanga",
  "Cagayan",
  "Butuan",
  "Cebu",
  "Ormoc",
  "Davao",
  "Iloilo",
  "Dumaguete",
  "Ozamis",
  "Gensan",
  "Bacolod",
];
const branchCode = (b) => `BR-${b.toUpperCase()}`;
// Client title -> position. 'Sales Manager' already exists as SCDM (same label); reuse it.
const POSITIONS = {
  "Senior Route Salesman": { code: "SR_ROUTE_SALESMAN", category: "field" },
  "Senior Channel Development Manager": { code: "SR_CDM", category: "supervisory" },
  "Channel Development Manager": { code: "CDM", category: "leadership" },
  "Sales Manager": { code: "SCDM", category: "leadership", existing: true },
};
const NO_TITLE = "(not given yet)";

// ---- CSV ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}
const titleCase = (s) =>
  s === s.toUpperCase()
    ? s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase())
    : s;
const key = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

const roster = parseCsv(readFileSync(CSV, "utf8")).map((r) => {
  const first = titleCase(r.first), middle = titleCase(r.middle), last = titleCase(r.last);
  return {
    code: r.id_no,
    first, last,
    name: [first, middle, last].filter(Boolean).join(" "),
    email: r.email.trim().toLowerCase(),
    title: r.position,
    branch: r.branch,
    head: r.immediate_head,
    role: r.app_role.startsWith("sales") ? "sales" : r.app_role.startsWith("manager") ? "manager" : null,
  };
});
// Validate the input before touching the database.
const problems = [];
const uniq = (f) => new Set(roster.map(f)).size === roster.length;
if (!uniq((p) => p.code)) problems.push("duplicate id_no");
if (!uniq((p) => p.email)) problems.push("duplicate email");
const byName = new Map();
for (const p of roster) {
  byName.set(key(`${p.last}, ${p.first}`), p);
  byName.set(key(`${p.first} ${p.last}`), p);
}
for (const p of roster) {
  if (!/^[0-9A-Za-z_-]{1,40}$/.test(p.code)) problems.push(`bad id_no ${p.code}`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) problems.push(`bad email for ${p.code}`);
  if (!BRANCHES.includes(p.branch)) problems.push(`unknown branch ${p.branch} (${p.code})`);
  if (!p.role) problems.push(`unknown app_role for ${p.code}`);
  if (p.title !== NO_TITLE && !POSITIONS[p.title]) problems.push(`unknown title ${p.title}`);
  if (p.head && !byName.has(key(p.head))) problems.push(`unknown head ${p.head} (${p.code})`);
  p.supervisor = p.head ? byName.get(key(p.head)) : null;
}
const reports = (p) => roster.filter((r) => r.supervisor === p);
for (const p of roster)
  // A supervisor's unit must contain every report's branch (assignPerson invariant);
  // teams cross branches and the client gives no grouping, so supervisors sit at the root.
  p.home = reports(p).length || !p.supervisor ? "ROOT" : branchCode(p.branch);
// Top-down order so a supervisor exists before their reports.
const depth = (p) => (p.supervisor ? 1 + depth(p.supervisor) : 0);
roster.sort((a, b) => depth(a) - depth(b) || a.code.localeCompare(b.code));
if (problems.length) {
  console.log(JSON.stringify({ ok: false, problems }, null, 2));
  process.exit(1);
}

// ---- Run ---------------------------------------------------------------------------
const WATCH = [
  "users", "profiles", "employee_assignments", "access_invitations", "org_units",
  "org_unit_parent_edges", "positions", "teams", "team_memberships", "audit_logs",
  "change_log", "sessions",
];
const MAIL = [
  "notification_email_deliveries", "jobs", "delivery_notification_outbox",
  "delivery_notification_sink", "analytics_mail_sink", "claim_notifications",
];
const counts = async (t, tables) => {
  const out = {};
  for (const n of tables) {
    const [r] = await t`select to_regclass(${"public." + n}) is not null as ok`;
    out[n] = r.ok ? Number((await t.unsafe(`select count(*)::int as n from public.${n}`))[0].n) : null;
  }
  return out;
};

class Rollback extends Error {}
const db = createDb(process.env.DATABASE_URL, { max: 2 });
setHooks(identityHooks({}));
const summary = { mode: DRY ? "dry-run" : "apply", input: { people: roster.length } };
const changes = { org: [], positions: [], invitations: [], profiles: [], assignments: [] };

try {
  await tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(${ORG_LOCK})`;
    const before = await counts(t, [...WATCH, ...MAIL]);
    const [{ now }] = await t`select (extract(epoch from now())*1000)::bigint as now`;
    const [actorUser] = await t`select id from users where email=${ACTOR_EMAIL}`;
    if (!actorUser) throw new Error("Actor user not found");
    const actor = await actorFor(t, actorUser.id);
    if (actor?.role !== "super_admin") throw new Error("Actor must be an active super_admin");
    const c = { db: t, actor, now: Number(now), env: {} };
    await t`select set_config('sunpride.actor',${actor.userId},true)`;

    /** Mirror the admin API command wrapper: domain fn, audit row, change_log row. */
    const command = async (path, body, fn) => {
      const value = await fn(c, body);
      const entityId = body.profileId ?? body.unitId ?? (typeof value === "string" ? value : actor.profileId);
      await writeAudit(t, {
        subject: actor.subject,
        action: path.replaceAll("/", "."),
        entityType: path.split("/")[0],
        entityId,
        details: body.reason ?? "SP-0168 client roster load",
      });
      await recordChange(t, { entity: "org.reference", entityId, scopeKey: "global", op: "upsert" });
      return value;
    };

    // 1. Org: root rename + 11 branches.
    const [root] = await t`select * from org_units where organization_id='sunpride' and code='SUNPRIDE' and deleted_at is null`;
    if (!root) throw new Error("Root SUNPRIDE missing");
    if (root.name !== COMPANY_NAME) {
      await command("org/edit", { unitId: root.id, name: COMPANY_NAME, reason: "SP-0168 client company name" }, (cc, b) => orgCommand(cc, "edit", b));
      changes.org.push({ code: "SUNPRIDE", action: "renamed", from: root.name, to: COMPANY_NAME });
    }
    const [type] = await t`select * from org_unit_types where organization_id='sunpride' and code=${BRANCH_TYPE} and active`;
    if (!type) throw new Error(`org_unit_type ${BRANCH_TYPE} missing`);
    const units = { ROOT: root.id };
    for (const b of BRANCHES) {
      const code = branchCode(b);
      const [u] = await t`select * from org_units where organization_id='sunpride' and code=${code}`;
      if (u) {
        if (u.deleted_at || u.status !== "active" || u.effective_to) throw new Error(`Branch ${code} exists but is inactive`);
        if (u.name !== b) {
          await command("org/edit", { unitId: u.id, name: b, reason: "SP-0168 client branch name" }, (cc, x) => orgCommand(cc, "edit", x));
          changes.org.push({ code, action: "renamed", to: b });
        }
        units[code] = u.id;
      } else {
        units[code] = await command(
          "org/create",
          { parentId: root.id, typeCode: BRANCH_TYPE, code, name: b, effectiveFrom: c.now, reason: "SP-0168 client branch" },
          (cc, x) => orgCommand(cc, "create", x),
        );
        changes.org.push({ code, action: "created", name: b, type: BRANCH_TYPE });
      }
    }

    // 2. Positions (same insert the catalog foundation uses; existing spec rows untouched).
    const positions = {};
    for (const [label, p] of Object.entries(POSITIONS)) {
      let [row] = await t`select * from positions where organization_id='sunpride' and code=${p.code}`;
      if (!row) {
        if (p.existing) throw new Error(`Expected existing position ${p.code}`);
        [row] = await t`insert into positions(organization_id,code,label,category,active) values('sunpride',${p.code},${label},${p.category},true) returning *`;
        await writeAudit(t, { subject: actor.subject, action: "catalog.position.create", entityType: "catalog", entityId: row.id, details: `SP-0168 ${p.code}` });
        changes.positions.push({ code: p.code, label, category: p.category, action: "created" });
      } else if (row.label !== label || !row.active)
        throw new Error(`Position ${p.code} exists with label '${row.label}' (expected '${label}')`);
      positions[label] = row.id;
    }

    // 3. People, top-down.
    const ids = new Map();
    for (const p of roster) {
      const orgUnitId = units[p.home];
      const positionId = positions[p.title] ?? null;
      const supervisorId = p.supervisor ? ids.get(p.supervisor.code) : null;
      let [person] = await t`select * from profiles where lower(email)=${p.email} or employee_code=${p.code}`;
      const others = await t`select id from profiles where (lower(email)=${p.email} or employee_code=${p.code}) and id<>${person?.id ?? "00000000-0000-0000-0000-000000000000"}`;
      if (others.length) throw new Error(`Email and id_no ${p.code} match different people`);
      if (person && (person.email.toLowerCase() !== p.email || (person.employee_code && person.employee_code !== p.code)))
        throw new Error(`Person ${p.code}: email/employee code mismatch with existing profile`);
      if (person && ["super_admin", "admin"].includes(person.role)) throw new Error(`Person ${p.code} is an administrator; not touched`);
      // Invitation = sign-up allow-list (no mail). Only for people not signed up yet.
      const [invite] = await t`select * from access_invitations where lower(email)=${p.email} order by invited_at desc limit 1`;
      if (!person) {
        if (invite?.status === "revoked") throw new Error(`Invitation for ${p.code} was revoked; not re-inviting`);
        if (!invite || invite.status !== "pending" || invite.role !== p.role || invite.org_unit_id !== orgUnitId || invite.position_id !== positionId || invite.name !== p.name) {
          await command("people/invite", { email: p.email, name: p.name, role: p.role, orgUnitId, positionId, reason: "SP-0168 client roster" }, (cc, b) => invitationCommand(cc, "invite", b));
          changes.invitations.push({ code: p.code, action: invite ? "updated" : "created", status: "pending" });
        }
        // Pre-provision the profile exactly like first sign-in would (identity.loadProfile),
        // minus the login link; loadProfile attaches user_id/auth_subject when they sign up.
        person = await insert(t, "profiles", {
          email: p.email, name: p.name, role: p.role, status: "active",
          org_unit_id: orgUnitId, position_id: positionId, effective_from: new Date(c.now),
        });
        await writeAudit(t, { subject: actor.subject, action: "profile.provisioned", entityType: "profile", entityId: person.id, details: `${p.role}; SP-0168 client roster; awaiting first sign-in` });
        changes.profiles.push({ code: p.code, action: "created" });
      } else if (person.name !== p.name || person.status !== "active") {
        if (person.status !== "active") throw new Error(`Person ${p.code} is disabled; not re-enabling`);
        await t`update profiles set name=${p.name} where id=${person.id}`;
        changes.profiles.push({ code: p.code, action: "renamed" });
      }
      ids.set(p.code, person.id);
      const current = (await history(t, "employee_assignments", "profile_id", person.id)).find((r) => !r.deleted_at && activeAt(r, c.now));
      const same =
        current && current.org_unit_id === orgUnitId && current.role === p.role &&
        current.position_id === positionId && (current.supervisor_id ?? null) === supervisorId &&
        person.employee_code === p.code && person.org_unit_id === orgUnitId &&
        person.role === p.role && person.position_id === positionId;
      if (!same) {
        if (current && current.supervisor_id && !supervisorId) throw new Error(`Person ${p.code}: refusing to clear an existing supervisor`);
        await command(
          "people/assign",
          { profileId: person.id, orgUnitId, role: p.role, positionId: positionId ?? undefined, supervisorId: supervisorId ?? undefined, employeeCode: p.code, reason: "SP-0168 client roster" },
          assignPerson,
        );
        changes.assignments.push({ code: p.code, action: current ? "changed" : "created" });
      }
    }

    // 4. Checks inside the transaction.
    const after = await counts(t, [...WATCH, ...MAIL]);
    const mailDelta = MAIL.filter((n) => before[n] !== after[n]);
    if (mailDelta.length) throw new Error(`Mail/notification/job tables changed: ${mailDelta.join(",")}`);
    const loaded = await t`select p.employee_code, p.role, p.user_id is null as no_login, u.code as unit, pos.code as position, s.employee_code as supervisor
      from profiles p left join org_units u on u.id=p.org_unit_id left join positions pos on pos.id=p.position_id
      left join employee_assignments a on a.profile_id=p.id and a.deleted_at is null and a.effective_to is null
      left join profiles s on s.id=a.supervisor_id where p.employee_code in ${t(roster.map((r) => r.code))}`;
    const byRole = {}, byUnit = {}, byPosition = {}, bySupervisor = {};
    const bump = (m, k) => (m[k ?? "(none)"] = (m[k ?? "(none)"] ?? 0) + 1);
    for (const r of loaded) bump(byRole, r.role), bump(byUnit, r.unit), bump(byPosition, r.position), bump(bySupervisor, r.supervisor);
    for (const p of roster) {
      const r = loaded.find((x) => x.employee_code === p.code);
      if (!r || r.unit !== (p.home === "ROOT" ? "SUNPRIDE" : p.home) || r.role !== p.role || (r.supervisor ?? null) !== (p.supervisor?.code ?? null))
        throw new Error(`Verification failed for ${p.code}`);
    }
    const pending = await t`select count(*)::int n from access_invitations where status='pending' and lower(email) in ${t(roster.map((r) => r.email))}`;
    Object.assign(summary, {
      changes: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.length])),
      changed: Object.values(changes).reduce((n, v) => n + v.length, 0),
      details: changes,
      loaded: { people: loaded.length, withoutLogin: loaded.filter((r) => r.no_login).length, pendingInvitations: pending[0].n, byRole, byUnit, byPosition, bySupervisor },
      counts: { before, after },
      mailTablesUnchanged: true,
    });
    if (DRY) throw new Rollback();
  });
  summary.committed = true;
} catch (e) {
  if (!(e instanceof Rollback)) {
    summary.committed = false;
    summary.error = String(e?.message ?? e);
    console.log(JSON.stringify(summary, null, 2));
    await db.close();
    process.exit(1);
  }
  summary.committed = false;
  summary.note = "dry run: rolled back";
}
console.log(JSON.stringify(summary, null, 2));
await db.close();
