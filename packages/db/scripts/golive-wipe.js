#!/usr/bin/env bun
// SP-0167 go-live wipe: remove every sample/test/transactional row and keep only
// the two super-admin logins, the issue board, the client spec tracker and the
// fixed reference lists. Allowlist-based: any table not named below is wiped.
//
//   DATABASE_URL=... bun packages/db/scripts/golive-wipe.js --dry-run
//   DATABASE_URL=... bun packages/db/scripts/golive-wipe.js --yes
//
// One transaction, all-or-nothing. User triggers are disabled per table inside the
// transaction (so guard/immutability/change-log triggers neither block nor log the
// wipe) and re-enabled before commit. FK constraint triggers stay active, so every
// delete is checked by Postgres; an explicit orphan check over every FK runs after.
// Output is JSON on stdout; the connection URL is never printed.
import { SQL } from "bun";

const KEEP_EMAILS = ["jcing.jc@gmail.com", "hermes@system.sunpride.local"];

// Tables kept in full: migration-inserted lists, geography, UoM, org unit types,
// issue board, spec tracker, and system configuration not tied to sample masters.
const KEEP_ALL = new Set([
  "schema_migrations",
  "approval_tolerances",
  "customer_reference_values",
  "integrity_policy_versions",
  "inventory_reason_codes",
  "refund_policies",
  "units_of_measure",
  "ph_regions",
  "ph_provinces",
  "ph_municipalities",
  "ph_barangays",
  "ph_postal_codes",
  "ph_geography_releases",
  "org_unit_types",
  "issues",
  "issue_comments",
  "issue_activity",
  "issue_commands",
  "issue_counters",
  "issue_attachments",
  "spec_waves",
  "spec_features",
  "call_flow_definitions",
  "call_flow_policies",
  "call_flow_channel_bindings",
  "no_order_reasons",
  "claim_types",
  "claim_approval_rules",
  "presell_policies",
  "incentive_plans",
  "master_channel_aliases",
  "sap_feed_cursors",
]);

// Tables kept partially. Value = SQL predicate on alias `t` that is TRUE for kept rows.
// Predicates only read the _wipe_keep_* temp tables (fixed before any change).
const orgScoped = "(t.org_unit_id is null or t.org_unit_id in (select id from _wipe_keep_org_units))";
// Master definitions: global (non-org-scoped) channel/subchannel/class lists stay;
// must-stock lists (kind msl) name sample product ids, so they go.
const masterKeep = `${orgScoped} and t.kind <> 'msl'`;
const FILTERS = {
  users: "t.id in (select id from _wipe_keep_users)",
  profiles: "t.id in (select id from _wipe_keep_profiles)",
  sessions: "t.user_id in (select id from _wipe_login_users)",
  access_tokens:
    "t.session_id in (select s.id from sessions s where s.user_id in (select id from _wipe_login_users))",
  org_units: "t.id in (select id from _wipe_keep_org_units)",
  org_unit_parent_edges:
    "t.unit_id in (select id from _wipe_keep_org_units) and (t.parent_id is null or t.parent_id in (select id from _wipe_keep_org_units))",
  positions: "t.id in (select id from _wipe_keep_positions)",
  position_standards: "t.position_id in (select id from _wipe_keep_positions)",
  master_definitions: masterKeep,
  master_versions: `t.master_id in (select t.id from master_definitions t where ${masterKeep})`,
  fiscal_authority_rules: orgScoped,
  fiscal_tender_rules: orgScoped,
  analytics_cockpit_policies: orgScoped,
  van_policy_versions: orgScoped,
  sap_projection_grants: "t.profile_id in (select id from _wipe_keep_profiles)",
  audit_logs: "t.subject = 'system:migration'",
  files: "t.id in (select storage_id from issue_attachments where storage_id is not null)",
};

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
if (!dryRun && !args.has("--yes")) {
  console.error("Refusing: pass --dry-run to preview or --yes to wipe.");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}

const q = (s) => `"${String(s).replaceAll('"', '""')}"`;
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
class DryRunRollback extends Error {}

const db = new SQL({ url, max: 1 });
const report = { mode: dryRun ? "dry-run" : "wipe", database: null, keepUsers: [], retainedDisabledUsers: [], keptOrgUnits: [], keptPositions: [], nulled: [], tables: [], totals: {}, orphanCheck: null };

try {
  await db.begin(async (tx) => {
    const run = (text) => tx.unsafe(text);
    const [{ db: dbName }] = await run("select current_database() as db");
    report.database = dbName;
    await run("set local lock_timeout = '30s'");
    await run("set local statement_timeout = 0");

    const tables = (await run("select tablename from pg_tables where schemaname='public' order by 1")).map((r) => r.tablename);
    const notOwned = await run("select tablename from pg_tables where schemaname='public' and tableowner <> current_user and not pg_has_role(current_user, tableowner, 'USAGE')");
    if (notOwned.length) throw new Error(`Refusing: current role does not own ${notOwned.length} table(s), e.g. ${notOwned[0].tablename}; run as the schema owner`);

    // --- keep sets ---------------------------------------------------------
    const emails = KEEP_EMAILS.map(lit).join(",");
    const login = await run(`select id, email::text as email from users where email in (${emails})`);
    if (login.length !== KEEP_EMAILS.length) throw new Error(`Refusing: expected keep users ${KEEP_EMAILS.join(", ")} but found ${login.map((r) => r.email).join(", ") || "none"}`);
    report.keepUsers = login.map((r) => r.email);
    await run(`create temp table _wipe_login_users on commit drop as select id from users where email in (${emails})`);
    // issue_commands.user_id is NOT NULL: authors of kept commands stay as disabled rows.
    await run(`create temp table _wipe_keep_users on commit drop as select id from _wipe_login_users union select user_id from issue_commands`);
    await run(`create temp table _wipe_keep_profiles on commit drop as select id from profiles where user_id in (select id from _wipe_login_users)`);
    await run(`create temp table _wipe_keep_org_units on commit drop as
      with recursive up(id) as (
        select org_unit_id from profiles where id in (select id from _wipe_keep_profiles) and org_unit_id is not null
        union select o.parent_id from org_units o join up on o.id = up.id where o.parent_id is not null)
      select distinct id from up`);
    await run(`create temp table _wipe_keep_positions on commit drop as
      select id from positions where code not like 'SMP-%'
      union select position_id from profiles where id in (select id from _wipe_keep_profiles) and position_id is not null`);
    report.retainedDisabledUsers = (await run(`select email::text as email from users where id in (select id from _wipe_keep_users except select id from _wipe_login_users) order by 1`)).map((r) => r.email);
    report.keptOrgUnits = await run(`select code, name from org_units where id in (select id from _wipe_keep_org_units) order by code`);
    report.keptPositions = (await run(`select code from positions where id in (select id from _wipe_keep_positions) order by code`)).map((r) => r.code);

    for (const t of [...KEEP_ALL, ...Object.keys(FILTERS)]) {
      if (!tables.includes(t)) throw new Error(`Allowlisted table ${t} does not exist; update the script`);
    }
    const keepPred = (t) => (KEEP_ALL.has(t) ? "true" : FILTERS[t] ?? "false");

    // --- counts ------------------------------------------------------------
    const stats = new Map();
    for (const t of tables) {
      const [r] = await run(`select count(*)::bigint as total, count(*) filter (where not (${keepPred(t)}))::bigint as del from public.${q(t)} t`);
      stats.set(t, { table: t, decision: KEEP_ALL.has(t) ? "keep" : FILTERS[t] ? "filter" : "wipe", before: Number(r.total), toDelete: Number(r.del) });
    }
    const deleting = new Set([...stats.values()].filter((s) => s.toDelete > 0).map((s) => s.table));

    // --- FK metadata -------------------------------------------------------
    const fks = await run(`
      select c.conname, cl.relname as child, pl.relname as parent, c.confdeltype as on_delete,
        array_to_json(array(select a.attname from unnest(c.conkey) with ordinality k(n,i) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.n order by k.i)) as ccols,
        array_to_json(array(select a.attname from unnest(c.confkey) with ordinality k(n,i) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.n order by k.i)) as pcols,
        (select bool_and(not a.attnotnull and a.attgenerated = '') from unnest(c.conkey) k(n) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.n) as nullable
      from pg_constraint c join pg_class cl on cl.oid=c.conrelid join pg_namespace n on n.oid=cl.relnamespace
      join pg_class pl on pl.oid=c.confrelid
      where c.contype='f' and n.nspname='public'`);
    for (const f of fks) {
      if (typeof f.ccols === "string") f.ccols = JSON.parse(f.ccols);
      if (typeof f.pcols === "string") f.pcols = JSON.parse(f.pcols);
    }
    const tuple = (alias, cols) => `(${cols.map((c) => `${alias}.${q(c)}`).join(",")})`;

    // Disable user triggers (guards, immutability, change_seq/change_log) for the wipe.
    for (const t of tables) await run(`alter table public.${q(t)} disable trigger user`);

    // --- kept rows that reference deleted rows: null them or refuse ---------
    for (const f of fks) {
      if (!deleting.has(f.parent)) continue;
      if (stats.get(f.child).before - stats.get(f.child).toDelete === 0) continue;
      const where = `(${keepPred(f.child)}) and ${tuple("t", f.ccols)} in (select ${f.pcols.map((c) => `t.${q(c)}`).join(",")} from public.${q(f.parent)} t where not (${keepPred(f.parent)}))`;
      const [{ n }] = await run(`select count(*)::int as n from public.${q(f.child)} t where ${where}`);
      if (!n) continue;
      if (!f.nullable) throw new Error(`Refusing: ${n} kept ${f.child} row(s) need deleted ${f.parent} rows via NOT NULL ${f.conname}`);
      await run(`update public.${q(f.child)} t set ${f.ccols.map((c) => `${q(c)} = null`).join(", ")} where ${where}`);
      report.nulled.push({ table: f.child, columns: f.ccols, references: f.parent, rows: n });
    }

    // --- delete order: children before parents; break cycles by nulling ---
    const edges = fks.filter((f) => deleting.has(f.child) && deleting.has(f.parent));
    const order = [];
    const remaining = new Set(deleting);
    let live = edges.slice();
    while (remaining.size) {
      // a table is ready when no other remaining table still references it
      const ready = [...remaining].filter((t) => !live.some((e) => e.parent === t && e.child !== t && remaining.has(e.child)));
      if (ready.length) {
        for (const t of ready.sort()) { order.push(t); remaining.delete(t); }
        continue;
      }
      // cycle: null nullable FK columns on to-be-deleted rows of the remaining set
      const breakable = live.filter((e) => remaining.has(e.child) && remaining.has(e.parent) && e.child !== e.parent && e.nullable);
      if (!breakable.length) throw new Error(`Cannot order deletes; cycle among ${[...remaining].join(", ")}`);
      for (const e of breakable) {
        await run(`update public.${q(e.child)} t set ${e.ccols.map((c) => `${q(c)} = null`).join(", ")} where not (${keepPred(e.child)}) and ${tuple("t", e.ccols)} is not null`);
      }
      live = live.filter((e) => !breakable.includes(e));
    }
    // self references with RESTRICT/immediate semantics: null them first when possible
    for (const e of edges.filter((e) => e.child === e.parent && e.nullable)) {
      await run(`update public.${q(e.child)} t set ${e.ccols.map((c) => `${q(c)} = null`).join(", ")} where not (${keepPred(e.child)})`);
    }

    for (const t of order) {
      const pred = keepPred(t);
      const res = await run(pred === "false" ? `delete from public.${q(t)}` : `delete from public.${q(t)} t where not (${pred})`);
      stats.get(t).deleted = res.count;
    }

    // retained-only-for-reference users: disabled, no sessions/profiles left
    await run(`update users set disabled_at = coalesce(disabled_at, now()) where id in (select id from _wipe_keep_users except select id from _wipe_login_users)`);

    for (const t of tables) await run(`alter table public.${q(t)} enable trigger user`);

    // --- orphan check over every FK ---------------------------------------
    const violations = [];
    for (const f of fks) {
      const notNull = f.ccols.map((c) => `c.${q(c)} is not null`).join(" and ");
      const join = f.ccols.map((c, i) => `p.${q(f.pcols[i])} = c.${q(c)}`).join(" and ");
      const [{ n }] = await run(`select count(*)::int as n from public.${q(f.child)} c where ${notNull} and not exists (select 1 from public.${q(f.parent)} p where ${join})`);
      if (n) violations.push({ constraint: f.conname, child: f.child, parent: f.parent, rows: n });
    }
    report.orphanCheck = { foreignKeys: fks.length, violations };
    if (violations.length) throw new Error(`Orphan check failed: ${JSON.stringify(violations)}`);

    for (const t of tables) {
      const [r] = await run(`select count(*)::bigint as n from public.${q(t)}`);
      const s = stats.get(t);
      s.after = Number(r.n);
    }
    report.tables = [...stats.values()].filter((s) => s.before > 0 || s.after > 0).map(({ table, decision, before, toDelete, after }) => ({ table, decision, before, toDelete, after }));
    report.totals = {
      tables: tables.length,
      tablesWithRows: report.tables.length,
      rowsBefore: report.tables.reduce((a, s) => a + s.before, 0),
      rowsToDelete: report.tables.reduce((a, s) => a + s.toDelete, 0),
      rowsAfter: report.tables.reduce((a, s) => a + s.after, 0),
    };
    if (dryRun) throw new DryRunRollback();
  });
  report.committed = true;
} catch (e) {
  if (!(e instanceof DryRunRollback)) {
    report.committed = false;
    report.error = String(e?.message ?? e).replaceAll(url, "<redacted>");
    console.log(JSON.stringify(report, null, 2));
    await db.close();
    process.exit(1);
  }
  report.committed = false;
  report.note = "dry run: all changes rolled back";
}
console.log(JSON.stringify(report, null, 2));
await db.close();
