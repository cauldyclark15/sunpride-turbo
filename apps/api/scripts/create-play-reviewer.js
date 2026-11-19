#!/usr/bin/env bun
// SP-0209: ONE Google Play reviewer login for the Sunpride Field app. A salesman ("sales") on the TEST branch
// (BR-TEST, created by SP-0199's create-test-superadmins.js) who sees only the TEST stores, in app mode "mapping"
// (Customer mapping), whose phones register themselves on sign-in (profiles.phone_auto_approve, migration 0834).
//
//   DATABASE_URL=... bun apps/api/scripts/create-play-reviewer.js --dry-run   # rolls back
//   DATABASE_URL=... bun apps/api/scripts/create-play-reviewer.js --apply
//   options: --actor <email>  (default jcing.jc@gmail.com, an active super admin; read only)
//            --record <file>  (default ~/.sunpride-keys/play-reviewer.json, 0600)
//
// Idempotent: a second --apply changes 0 rows. The password is generated once, written ONLY to the 0600 record,
// never printed and never reset by a rerun (an existing account without its record is refused). The account has
// no temporary-password flag, so it never expires and never forces a change on first sign-in.
// Territory/route links go through the app's own route handlers (audit + receipts + change feed). The person is
// inserted the way identity.js provisions a profile and audited as profile.provisioned; the phone flag is audited
// as profile.phone_auto_approve_set. Guard: every other active profile's effective scope must be unchanged.
// Output: one JSON summary (counts, codes, ids). Never passwords, hashes or URLs.
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createDb } from "@sunpride/db/client";
import { createApp } from "../src/core/app.js";
import { actorFor } from "../src/core/context.js";
import { recordChange } from "../src/core/sync.js";
import { identityHooks, ORG_LOCK } from "../src/domains/org/identity.js";
import { writeAudit } from "../src/domains/org/audit.js";
import { personAt } from "../src/domains/org/scope.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
if (APPLY === args.includes("--dry-run")) {
  console.error("Choose exactly one of --dry-run or --apply");
  process.exit(2);
}
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const home = (p) => resolve(p.replace(/^~(?=\/)/, homedir()));
const ACTOR_EMAIL = opt("--actor", "jcing.jc@gmail.com").toLowerCase();
const RECORD = home(
  opt("--record", join(homedir(), ".sunpride-keys/play-reviewer.json")),
);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}

const TAG = "SP-0209 Google Play reviewer";
const REASON =
  "SP-0209: Google Play reviewer login, TEST branch only (test data, not real sales)";
const PERSON = {
  email: "play-review@sp.test",
  name: "Google Play Reviewer",
  code: "TEST-REVIEW",
};
const BRANCH_CODE = "BR-TEST";
const TERRITORY_CODE = "TEST-T1";
const ROUTE_CODE = "TEST-R1";

// ---- credentials ------------------------------------------------------------------------------------
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // no 0/O/1/l/I
function randomInt(limit) {
  const bound = Math.floor(0x100000000 / limit) * limit;
  let n;
  do n = crypto.getRandomValues(new Uint32Array(1))[0];
  while (n >= bound);
  return n % limit;
}
/** 3 groups of 6 from a 56-symbol alphabet (~104 bits), easy to type on a phone. */
const password = () =>
  [0, 1, 2]
    .map(() =>
      Array.from(
        { length: 6 },
        () => ALPHABET[randomInt(ALPHABET.length)],
      ).join(""),
    )
    .join("-");
async function privateWrite(path, text) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

// ---- app + helpers ----------------------------------------------------------------------------------
const db = createDb(url, { max: 2 });
const app = createApp({ db, dbUrl: url, env: process.env });
const hooks = identityHooks({});
const changes = [];
const note = (step, what, detail = {}) =>
  changes.push({ step, what, ...detail });
class Rollback extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const future = () => Date.now() + 1500;
const settle = async (at) => {
  while (Date.now() <= at + 50) await sleep(100);
};

/** Invoke a real route handler inside the script transaction, as `userId` (create-test-superadmins.js pattern). */
async function call(t, userId, method, path, body, key) {
  const m = app.router.match(method, path);
  if (!m || !m.route) throw new Error(`No route ${method} ${path}`);
  const actor = await actorFor(t, userId);
  const u = new URL(`http://sp0209.local${path}`);
  const ctx = {
    db: t,
    actor,
    req: new Request(u, { method, headers: { "idempotency-key": key } }),
    url: u,
    body,
    rawBody: null,
    now: Date.now(),
    params: m.params ?? {},
    user: { id: userId },
    session: null,
    via: "script",
    device: null,
    v2: true,
    cookies: [],
    env: process.env,
    server: null,
    publish: async () => {},
    enqueue: async () => null,
    recordChange,
  };
  const out = await m.route.handler(ctx);
  return out?.body ?? out;
}

async function scopes(t) {
  const at = Date.now();
  const people =
    await t`select * from profiles where status='active' and deleted_at is null order by id`;
  const out = {};
  for (const p of people) {
    const eff = await personAt(t, p, at);
    out[p.id] = {
      role: eff.role,
      unit: eff.org_unit_id,
      units: (
        await hooks.scopeUnitIds(t, {
          role: eff.role,
          orgUnitId: eff.org_unit_id,
        })
      ).sort(),
    };
  }
  return out;
}

const WATCH = [
  "users",
  "profiles",
  "employee_assignments",
  "access_invitations",
  "org_units",
  "territories",
  "territory_salespeople",
  "routes",
  "route_salespeople",
  "outlets",
  "outlet_assignments",
  "registered_devices",
  "sessions",
  "audit_logs",
  "change_log",
  "org_command_receipts",
  "sample_data_rows",
];
async function counts(t) {
  const out = {};
  for (const n of WATCH)
    out[n] = Number(
      (await t.unsafe(`select count(*)::int as n from public.${n}`))[0].n,
    );
  return out;
}

// ---- credential record ------------------------------------------------------------------------------
let record = null;
try {
  record = JSON.parse(await readFile(RECORD, "utf8"));
  if (record.version !== 1 || typeof record.password !== "string")
    throw new Error("bad");
  await chmod(RECORD, 0o600);
} catch (e) {
  if (e?.code !== "ENOENT") {
    console.error(
      "Credential record could not be read safely; nothing changed",
    );
    process.exit(1);
  }
  record = null;
}
const [identity] =
  await db`select current_database() as name, inet_server_addr()::text as host, inet_server_port() as port`;
const DBKEY = new Bun.CryptoHasher("sha256")
  .update(JSON.stringify(identity))
  .digest("hex");
if (record && record.database !== DBKEY) {
  console.error(
    "The credential record belongs to another database; pass --record <file> for this one",
  );
  process.exit(1);
}

let before = null,
  after = null,
  ids = {},
  credential = null,
  scopeReport = null;

async function run(t) {
  t.__inTx = true;
  await t`select pg_advisory_xact_lock(${ORG_LOCK})`;
  const [col] =
    await t`select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='phone_auto_approve'`;
  if (!col)
    throw new Error(
      "profiles.phone_auto_approve is missing: release the SP-0209 code + migration 0834 first",
    );
  before = await counts(t);
  const scopeBefore = await scopes(t);
  const [u] = await t`select id from users where lower(email)=${ACTOR_EMAIL}`;
  if (!u) throw new Error("actor not found");
  const actor = await actorFor(t, u.id);
  if (!actor || actor.role !== "super_admin")
    throw new Error("actor is not an active super admin");
  const A = u.id;
  const sub = actor.subject;

  const [branch] =
    await t`select * from org_units where organization_id='sunpride' and code=${BRANCH_CODE} and deleted_at is null and status='active'`;
  const [territory] =
    await t`select * from territories where code=${TERRITORY_CODE} and deleted_at is null`;
  const [route] =
    await t`select * from routes where code=${ROUTE_CODE} and deleted_at is null`;
  if (!branch || !territory || !route)
    throw new Error(
      "TEST branch/territory/route missing: run create-test-superadmins.js (SP-0199) first",
    );
  ids.branch = branch.id;
  ids.territory = territory.id;
  ids.route = route.id;

  // ---- 1. the reviewer --------------------------------------------------------------------------------
  let [user] = await t`select * from users where lower(email)=${PERSON.email}`;
  let prof;
  if (user) {
    [prof] =
      await t`select * from profiles where user_id=${user.id} and deleted_at is null`;
    if (
      !prof ||
      prof.role !== "sales" ||
      prof.employee_code !== PERSON.code ||
      prof.org_unit_id !== branch.id ||
      prof.status !== "active"
    )
      throw new Error(
        `${PERSON.email} belongs to an unexpected account; nothing was overwritten`,
      );
    if (!record)
      throw new Error(
        `${PERSON.email} exists but its saved credential is missing; nothing was reset`,
      );
    credential = {
      ...record,
      passwordChanged: !(await Bun.password.verify(
        record.password,
        user.password_hash,
      )),
    };
    if (user.must_change_password || user.disabled_at)
      throw new Error(
        `${PERSON.email} is disabled or on a temporary password; fix it from Setup > People`,
      );
  } else {
    const secret = record?.password ?? password();
    const hash = await Bun.password.hash(secret, { algorithm: "argon2id" });
    [user] =
      await t`insert into users(email,password_hash) values(${PERSON.email},${hash}) returning *`;
    [prof] =
      await t`insert into profiles(user_id,auth_subject,email,name,role,status,org_unit_id,employee_code,effective_from,app_mode,selling)
      values(${user.id},${user.id},${PERSON.email},${PERSON.name},'sales','active',${branch.id},${PERSON.code},${new Date()},'mapping',false) returning *`;
    await t`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason)
      values(${prof.id},${branch.id},'sales',${prof.effective_from},${sub},${REASON})`;
    await writeAudit(t, {
      subject: sub,
      action: "profile.provisioned",
      entityType: "profile",
      entityId: prof.id,
      details: `sales; ${TAG}; employee ${PERSON.code} at ${BRANCH_CODE}; app mode mapping`,
    });
    await recordChange(t, {
      entity: "org.reference",
      entityId: prof.id,
      scopeKey: "global",
      op: "upsert",
    });
    credential = {
      version: 1,
      database: DBKEY,
      email: PERSON.email,
      name: PERSON.name,
      password: secret,
      site: "https://sunpride.cauldnclark.com",
      app: "Sunpride Field (com.sunpride.field.beta)",
      userId: user.id,
      profileId: prof.id,
    };
    note("person", "create", {
      email: PERSON.email,
      code: PERSON.code,
      role: "sales",
      unit: BRANCH_CODE,
    });
  }
  ids.profile = prof.id;
  if (prof.app_mode !== "mapping" || prof.selling) {
    await t`update profiles set app_mode='mapping',selling=false,updated_at=now() where id=${prof.id}`;
    note("person", "app_mode", { mode: "mapping" });
  }
  if (!prof.phone_auto_approve) {
    await t`update profiles set phone_auto_approve=true,updated_at=now() where id=${prof.id}`;
    await writeAudit(t, {
      subject: sub,
      action: "profile.phone_auto_approve_set",
      entityType: "profile",
      entityId: prof.id,
      details: `${TAG}: store-review account; its phones register on sign-in (no office approval)`,
    });
    note("person", "phone_auto_approve", { value: true });
  }
  const assignments =
    await t`select * from employee_assignments where profile_id=${prof.id} and deleted_at is null and (effective_to is null or effective_to>now())`;
  if (
    assignments.length !== 1 ||
    assignments[0].org_unit_id !== branch.id ||
    assignments[0].role !== "sales"
  )
    throw new Error("expected exactly one sales assignment at BR-TEST");

  // ---- 2. territory + route links (secondary / not primary: Test User 1 stays primary) --------------
  const [ts] =
    await t`select 1 from territory_salespeople where territory_id=${territory.id} and profile_id=${prof.id} and deleted_at is null and effective_to is null`;
  if (!ts) {
    const at = future();
    await call(
      t,
      A,
      "POST",
      "/api/v1/territories/assignSalesperson",
      {
        territoryId: territory.id,
        profileId: prof.id,
        kind: "secondary",
        effectiveFrom: at,
        reason: REASON,
      },
      "sp0209:territory-sp",
    );
    await settle(at);
    note("territory", "salesperson", { kind: "secondary" });
  }
  const [rs] =
    await t`select 1 from route_salespeople where route_id=${route.id} and profile_id=${prof.id} and deleted_at is null and effective_to is null`;
  if (!rs) {
    const at = future();
    await call(
      t,
      A,
      "POST",
      "/api/v1/territories/routes/assignSalesperson",
      {
        routeId: route.id,
        profileId: prof.id,
        primary: false,
        effectiveFrom: at,
        reason: REASON,
      },
      "sp0209:route-sp",
    );
    await settle(at);
    note("route", "salesperson", { primary: false });
  }

  // ---- 3. guards ----------------------------------------------------------------------------------------
  const mine = (
    await hooks.scopeUnitIds(t, { role: "sales", orgUnitId: branch.id })
  ).sort();
  if (mine.some((id) => String(id) !== String(branch.id)))
    throw new Error("reviewer scope reaches outside BR-TEST");
  const scopeAfter = await scopes(t);
  const violations = [];
  for (const [id, b] of Object.entries(scopeBefore)) {
    const a = scopeAfter[id];
    if (
      !a ||
      a.role !== b.role ||
      a.unit !== b.unit ||
      JSON.stringify(a.units) !== JSON.stringify(b.units)
    )
      violations.push(id);
  }
  scopeReport = {
    otherProfiles:
      Object.keys(scopeBefore).length - (scopeBefore[prof.id] ? 1 : 0),
    violations: violations.filter((v) => v !== prof.id).length,
    reviewerUnits: mine.length,
  };
  if (scopeReport.violations)
    throw new Error(
      `scope guard: ${scopeReport.violations} other profiles changed`,
    );
  after = await counts(t);
  if (!APPLY) throw new Rollback();
}

let error = null;
try {
  await db.begin(run);
} catch (e) {
  if (!(e instanceof Rollback)) error = String(e?.message ?? e).slice(0, 400);
}
let saved = false;
if (!error && APPLY && credential && !credential.passwordChanged) {
  const { passwordChanged: _, ...keep } = credential;
  if (JSON.stringify(keep) !== JSON.stringify(record)) {
    await privateWrite(RECORD, `${JSON.stringify(keep, null, 1)}\n`);
    saved = true;
  }
  const [row] =
    await db`select password_hash from users where lower(email)=${PERSON.email}`;
  if (!row || !(await Bun.password.verify(keep.password, row.password_hash)))
    error = "credential verification failed";
}
const delta = {};
if (before && after)
  for (const k of WATCH)
    if (after[k] !== before[k]) delta[k] = after[k] - before[k];
console.log(
  JSON.stringify(
    {
      mode: APPLY ? "apply" : "dry-run",
      committed: APPLY && !error,
      changes: changes.length,
      steps: changes,
      rowDelta: delta,
      scope: scopeReport,
      ids,
      passwordChanged: credential?.passwordChanged ?? null,
      recordWritten: saved,
      record: RECORD,
      error,
    },
    null,
    1,
  ),
);
await db.close();
process.exit(error ? 1 : 0);
