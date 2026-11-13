#!/usr/bin/env bun
// SP-0177: remove the launch role smoke's QA dummy users and everything they created.
//
//   bun apps/api/scripts/remove-qa-role-smoke.js --ids <qa-ids.json> --since <ISO> --dry-run
//   bun apps/api/scripts/remove-qa-role-smoke.js --ids <qa-ids.json> --since <ISO> --yes
//
// DATABASE_URL is read from the env, or from ~/.sunpride-keys/k8s-pg-url (never printed).
// <qa-ids.json> = {"emails":[...]} captured at creation; every row is matched by the QA
// user ids / profile ids / device ids / outlet ids derived from those emails (all ending
// in @qa.sunpride.invalid — anything else is refused). --since = when the smoke started;
// it only bounds the outlet code counter row and jobs. Idempotent: a rerun deletes 0.
// audit_logs and fiscal_audit_events are immutable by trigger; their QA rows are kept
// and counted. Prints JSON with per-table counts and the storage paths of deleted files
// (the blobs live in the api pod's FILES_DIR; remove them separately).
import { SQL } from "bun";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const DRY = args.includes("--dry-run");
if (DRY === args.includes("--yes")) { console.error("Choose exactly one of --dry-run or --yes"); process.exit(2); }
const idsFile = opt("--ids"), since = opt("--since");
if (!idsFile || !since || Number.isNaN(Date.parse(since))) { console.error("Need --ids <file> --since <ISO time>"); process.exit(2); }
const emails = JSON.parse(readFileSync(idsFile, "utf8")).emails.map((e) => e.toLowerCase());
if (!emails.length || emails.some((e) => !e.endsWith("@qa.sunpride.invalid"))) { console.error("Only @qa.sunpride.invalid emails allowed"); process.exit(2); }

const url = process.env.DATABASE_URL ?? readFileSync(`${process.env.HOME}/.sunpride-keys/k8s-pg-url`, "utf8").trim();
const sql = new SQL(url, { max: 1 });
class Rollback extends Error {}
const out = { mode: DRY ? "dry-run" : "apply", deleted: {}, kept: {}, files: [] };

try {
  await sql.begin(async (t) => {
    const users = (await t`select id from users where lower(email) in ${t(emails)}`).map((r) => r.id);
    const profiles = (await t`select id from profiles where lower(email) in ${t(emails)}`).map((r) => r.id);
    const ids = [...users, ...profiles];
    const none = ["00000000-0000-0000-0000-000000000000"];
    const U = users.length ? users : none, P = profiles.length ? profiles : none;
    const devices = (await t`select id from registered_devices where profile_id in ${t(P)}`).map((r) => r.id);
    const D = devices.length ? devices : none;
    const outlets = (await t`
      select distinct o.id from outlets o
      left join outlet_enrolments e on e.outlet_id = o.id or e.resolved_outlet_id = o.id
      where o.created_by::text in ${t([...U, ...P])} or e.proposed_by_profile_id in ${t(P)}`).map((r) => r.id);
    const O = outlets.length ? outlets : none;
    const enrol = (await t`select id from outlet_enrolments where outlet_id in ${t(O)} or proposed_by_profile_id in ${t(P)}`).map((r) => r.id);
    const E = enrol.length ? enrol : none;
    const files = await t`
      select f.id, f.path from files f
      where f.created_by in ${t(U)} or f.device_id in ${t(D)}
         or f.id in (select file_id from outlet_enrolment_photos where outlet_enrolment_id in ${t(E)})`;
    const F = files.length ? files.map((f) => f.id) : none;
    out.files = files.map((f) => f.path);
    out.matched = { users: users.length, profiles: profiles.length, devices: devices.length, outlets: outlets.length, enrolments: enrol.length, files: files.length };
    const linkedCustomers = (await t`select customer_id from outlet_customer_links where outlet_id in ${t(O)}`).map((r) => r.customer_id);
    const invites = (await t`select id from access_invitations where lower(email) in ${t(emails)}`).map((r) => r.id);
    const assigns = (await t`select id from employee_assignments where profile_id in ${t(P)}`).map((r) => r.id);
    const allIds = [...ids, ...devices, ...outlets, ...enrol, ...linkedCustomers, ...invites, ...assigns].map(String);
    const A = allIds.length ? allIds : none;
    const scopes = profiles.map((p) => `profile:${p}`);
    const [ka] = await t`select count(*)::int n from audit_logs where subject in ${t(A)} or entity_id::text in ${t(A)}`;
    const [kf] = await t`select count(*)::int n from fiscal_audit_events where row_id::text in ${t(A)}`;

    const del = async (name, q) => { const r = await q; out.deleted[name] = (out.deleted[name] ?? 0) + r.count; };
    await del("access_tokens", t`delete from access_tokens where session_id in (select id from sessions where user_id in ${t(U)})`);
    await del("sessions", t`delete from sessions where user_id in ${t(U)}`);
    await del("op_receipts", t`delete from op_receipts where subject in ${t(A)} or device_id in ${t(D)}`);
    await del("rate_limits", t`delete from rate_limits where split_part(bucket_key, ':', 2) in ${t(A)}`);
    await del("outlet_enrolment_photos", t`delete from outlet_enrolment_photos where outlet_enrolment_id in ${t(E)}`);
    await del("outlet_enrolment_events", t`delete from outlet_enrolment_events where enrolment_id in ${t(E)} or outlet_id in ${t(O)}`);
    await del("outlet_enrolments", t`delete from outlet_enrolments where id in ${t(E)}`);
    await del("outlet_pins", t`delete from outlet_pins where outlet_id in ${t(O)}`);
    await del("outlet_contacts", t`delete from outlet_contacts where outlet_id in ${t(O)}`);
    await del("customer_ship_tos", t`delete from customer_ship_tos where outlet_id in ${t(O)}`);
    await del("customer_profiles", t`delete from customer_profiles where outlet_id in ${t(O)}`);
    // Approval links the outlet to a new customers row (SP code); remove both.
    const custs = (await t`select customer_id from outlet_customer_links where outlet_id in ${t(O)}`).map((r) => r.customer_id);
    await del("outlet_customer_links", t`delete from outlet_customer_links where outlet_id in ${t(O)}`);
    await del("customers", t`delete from customers where id in ${t(custs.length ? custs : none)}
      and not exists (select 1 from outlet_customer_links l where l.customer_id = customers.id)`);
    await del("outlets", t`delete from outlets where id in ${t(O)}`);
    // Idempotency receipts of commands the QA office users sent.
    await del("master_command_receipts", t`delete from master_command_receipts where actor_profile_id in ${t(P)}`);
    await del("org_command_receipts", t`delete from org_command_receipts where profile_id in ${t(P)}`);
    await del("files", t`delete from files where id in ${t(F)}`);
    await del("location_pings", t`delete from location_pings where profile_id in ${t(P)} or device_id in ${t(D)}`);
    await del("live_locations", t`delete from live_locations where profile_id in ${t(P)} or device_id in ${t(D)}`);
    await del("fieldsync_work_days", t`delete from fieldsync_work_days where profile_id in ${t(P)}`);
    await del("fieldsync_location_consents", t`delete from fieldsync_location_consents where profile_id in ${t(P)}`);
    await del("sap_projection_grants", t`delete from sap_projection_grants where profile_id in ${t(P)}`);
    await del("device_challenges", t`delete from device_challenges where device_id in ${t(D)}`);
    await del("device_integrity_assessments", t`delete from device_integrity_assessments where device_id in ${t(D)}`);
    await del("phone_registration_requests", t`delete from phone_registration_requests where profile_id in ${t(P)}`);
    await del("registered_devices", t`delete from registered_devices where id in ${t(D)}`);
    await del("access_invitations", t`delete from access_invitations where lower(email) in ${t(emails)}`);
    await del("employee_assignments", t`delete from employee_assignments where profile_id in ${t(P)}`);
    await del("fieldsync_day_manifests", t`delete from fieldsync_day_manifests where profile_id in ${t(P)}`);
    await del("profiles", t`delete from profiles where id in ${t(P)}`);
    await del("users", t`delete from users where id in ${t(U)}`);
    // Background jobs the QA day queued (empty payload, kind specific to field location).
    await del("jobs", t`delete from jobs where kind = 'fieldsync.location-publish' and created_at >= ${new Date(since)} and status = 'done'`);
    // The outlet code counter row did not exist before the smoke; drop it only if it was
    // created by the smoke and no outlet is left, so the first real store is SP000001 again.
    await del("outlet_code_settings", t`
      delete from outlet_code_settings where created_at >= ${new Date(since)}
        and not exists (select 1 from outlets)`);

    // Sync feed rows for the removed entities and the QA people's own scopes (last, so rows
    // the delete triggers above wrote for them go too). Global field:reference bumps stay.
    await del("change_log", t`delete from change_log where entity_id::text in ${t(A)} or scope_key in ${t(scopes.length ? scopes : none)}`);
    out.kept = { audit_logs: ka.n, fiscal_audit_events: kf.n, note: "immutable by trigger; kept (plus fiscal DELETE events the outlet delete writes)" };
    out.changed = Object.values(out.deleted).reduce((s, n) => s + n, 0);
    if (DRY) throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { out.error = String(e?.message ?? e); console.log(JSON.stringify(out, null, 2)); await sql.close(); process.exit(1); }
}
console.log(JSON.stringify(out, null, 2));
await sql.close();
