#!/usr/bin/env bun
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
import { createDb, tx } from "../src/client.js";
import { BATCH, rowId } from "./store.js";
import {
  addTrialRow,
  bindSampleSubject,
  copyTrialRow,
  wirePerson,
} from "./trial-wiring.js";

export const TRIAL_ROLES = Object.freeze([
  {
    slug: "admin",
    role: "admin",
    template: "admin",
    label: "Administrator",
    description:
      "Sets up people, areas, stores and products, and checks the company's sales and stock.",
  },
  {
    slug: "salesmanager",
    role: "manager",
    template: "manager",
    label: "Sales manager",
    description:
      "Reviews regional sales, targets and field performance, and approves plans and orders.",
  },
  {
    slug: "supervisor",
    role: "manager",
    template: "supervisor",
    label: "Supervisor",
    description:
      "Reviews one sample team's area, daily calls and coaching, and follows up work needing attention.",
  },
  {
    slug: "agent",
    role: "sales",
    template: "agent",
    label: "Field agent",
    description:
      "Sees their assigned route, today's planned visits and their own sales work.",
  },
  {
    slug: "van",
    role: "sales",
    template: "van",
    label: "Van seller",
    description:
      "Sees their assigned truck trip and stock. Extra trial trucks start empty and need a load before selling.",
  },
  {
    slug: "approver",
    role: "approver",
    template: "approver",
    label: "Approver",
    description:
      "Reviews orders and stock or cash decisions within the sample company.",
  },
  {
    slug: "operations",
    role: "operations",
    template: "admin",
    label: "Operations",
    description:
      "Maintains stores, routes and products, encodes orders and manages inventory operations.",
  },
  {
    slug: "analyst",
    role: "analyst",
    template: "viewer",
    label: "Analyst",
    description:
      "Reads company-wide sales, coverage, stock and money reports without changing business records.",
  },
  {
    slug: "viewer",
    role: "viewer",
    template: "viewer",
    label: "Viewer",
    description:
      "Reads sample-company dashboards and reports without changing business records.",
  },
]);

const WORDS = [
  "Mango",
  "River",
  "Coral",
  "Sunny",
  "Cedar",
  "Ocean",
  "Maple",
  "Cloud",
  "Amber",
  "Fern",
  "Robin",
  "Peach",
  "Willow",
  "Meadow",
  "Daisy",
  "Lemon",
  "Bamboo",
  "Pebble",
  "Clover",
  "Tulip",
  "Silver",
  "Cherry",
  "Island",
  "Forest",
  "Garden",
  "Morning",
  "Breeze",
  "Orchid",
  "Olive",
  "Lagoon",
  "Honey",
  "Lotus",
];
/** Uniform rejection sampling, not Math.random or biased modulo of a random byte. @param {number} limit */
function randomInt(limit) {
  const bound = Math.floor(0x100000000 / limit) * limit;
  let n;
  do {
    n = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (n >= bound);
  return n % limit;
}
function password() {
  return `${WORDS[randomInt(WORDS.length)]}-${WORDS[randomInt(WORDS.length)]}-${1000 + randomInt(9000)}`;
}
const DEFAULT_RECORD = join(homedir(), ".sunpride-keys/trial-accounts.json");
const DEFAULT_OUT = join(homedir(), "Downloads/sunpride-trial-accounts.txt");

/** @typedef {{email:string,name:string,role:string,persona:string,userId:string,profileId:string,password:string,passwordChanged?:boolean}} Credential */
/** @typedef {{version:number,databases:Record<string,Credential[]>}} RecordFile */
/** Atomically replace files with private permissions even if an earlier file was public.
 * @param {string} path @param {string} text */
export async function privateWrite(path, text) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

/** @param {Credential[]} accounts */
export function trialAccountText(accounts) {
  const lines = [
    "Sunpride Sales System: trial accounts",
    "https://sunpride.cauldnclark.com",
    "Demo data: invented sample company, not real Sunpride data",
    "",
    "How to sign in",
    "1. Open https://sunpride.cauldnclark.com/login",
    "2. Enter one email and its password below, then choose Sign in. Do not create a new account.",
    "3. Use one account per tester. Keep this file private; do not post it in a shared issue or screenshot.",
    "",
    "How to change your password",
    "Open your name at the bottom left → Account → Change password.",
    "Or open https://sunpride.cauldnclark.com/account",
    "Enter your current password, choose and confirm a new one, then choose Change password.",
    "Your other devices will be signed out. This file will not know a password you choose yourself.",
    "",
  ];
  for (const role of TRIAL_ROLES) {
    lines.push(role.label, role.description);
    for (const a of accounts.filter((a) => a.persona === role.slug))
      lines.push(
        `${a.name} · ${a.email} · ${a.passwordChanged ? "Password changed by tester; use your chosen password" : a.password}`,
      );
    lines.push("");
  }
  return lines.join("\n");
}

/** Create all client personas on the existing invented demo company. The record and
 * text are private artifacts, never stdout. Tests supply isolated paths.
 * @param {import('../src/client.js').Db} db
 * @param {{perRole?:number,rotate?:boolean,recordPath?:string,outPath?:string}} [options] */
export async function createTrialAccounts(
  db,
  {
    perRole = 3,
    rotate = false,
    recordPath = DEFAULT_RECORD,
    outPath = DEFAULT_OUT,
  } = {},
) {
  if (!Number.isInteger(perRole) || perRole < 1 || perRole > 20)
    throw new Error("Trial per-role must be between 1 and 20");
  recordPath = resolve(recordPath.replace(/^~(?=\/)/, homedir()));
  outPath = resolve(outPath.replace(/^~(?=\/)/, homedir()));
  if (recordPath === outPath)
    throw new Error(
      "Trial output and credential record must be different files",
    );
  await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
  const lock = `${recordPath}.lock`;
  await mkdir(lock, { mode: 0o700 });
  try {
    /** @type {RecordFile} */ let record = { version: 1, databases: {} };
    try {
      record = JSON.parse(await readFile(recordPath, "utf8"));
      if (
        record.version !== 1 ||
        !record.databases ||
        typeof record.databases !== "object"
      )
        throw new Error("Invalid credential record");
      await chmod(recordPath, 0o600);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT")
        throw new Error("Trial credential record could not be read safely");
    }
    const [identity] =
      await db`select current_database() as name, inet_server_addr()::text as host, inet_server_port() as port`;
    const databaseKey = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(identity))
      .digest("hex");
    const saved = record.databases[databaseKey] ?? [];
    const result = await tx(db, async (t) => {
      await t`select pg_advisory_xact_lock(4310090)`;
      const [manifest] =
        await t`select 1 from sample_data_rows where batch=${BATCH} and key='audit_logs:manifest'`;
      if (!manifest)
        throw new Error("Trial accounts require the seeded sample company");
      /** @type {Credential[]} */ const accounts = [];
      let created = 0,
        rotated = 0;
      for (const persona of TRIAL_ROLES) {
        const [template] =
          await t`select * from profiles where id=${rowId("profiles", persona.template)} and status='active' and deleted_at is null`;
        if (!template) throw new Error("Trial sample role template is missing");
        for (let n = 1; n <= perRole; n++) {
          const slug = `${persona.slug}${n}`;
          const email = `${slug}@trial.sunpride.test`;
          const [existing] =
            await t`select u.*,p.id profile_id,p.name,p.role from users u left join profiles p on p.user_id=u.id where u.email=${email}`;
          let credential = saved.find((a) => a.email === email);
          if (existing) {
            const [owned] =
              await t`select 1 from sample_data_rows where batch=${BATCH} and table_name='users' and row_id=${existing.id} and key=${`users:trial-${slug}`}`;
            if (
              !owned ||
              !existing.profile_id ||
              existing.role !== persona.role
            )
              throw new Error(
                "Trial email belongs to an unexpected account; nothing was overwritten",
              );
            if (!credential && !rotate)
              throw new Error(
                "Trial credential record is missing; use --rotate to issue new passwords",
              );
            credential = {
              email,
              name: existing.name,
              role: persona.role,
              persona: persona.slug,
              userId: existing.id,
              profileId: existing.profile_id,
              password: rotate
                ? password()
                : /** @type {Credential} */ (credential).password,
            };
            if (rotate) {
              const hash = await Bun.password.hash(credential.password, {
                algorithm: "argon2id",
              });
              await t`update users set password_hash=${hash} where id=${existing.id}`;
              await t`update sessions set revoked_at=now() where user_id=${existing.id} and revoked_at is null`;
              await t`delete from access_tokens where session_id in (select id from sessions where user_id=${existing.id})`;
              rotated++;
            } else
              credential.passwordChanged = !(await Bun.password.verify(
                credential.password,
                existing.password_hash,
              ));
          } else {
            const secret = credential?.password ?? password();
            const hash = await Bun.password.hash(secret, {
              algorithm: "argon2id",
            });
            const user = await addTrialRow(t, "users", slug, {
              email,
              password_hash: hash,
            });
            // Only adopt owned, active people with no login, keeping their profile IDs,
            // route/planned visits and employee/team history intact.
            const candidates =
              await t`select p.* from profiles p join sample_data_rows m on m.row_id=p.id::text and m.table_name='profiles' and m.batch=${BATCH} left join positions pos on pos.id=p.position_id where p.user_id is null and p.status='active' and p.deleted_at is null and p.role=${persona.role} and (
              (${persona.slug}='agent' and pos.code not like 'PMOT%') or
              (${persona.slug}='van' and pos.code like 'PMOT%') or
              (${persona.slug}='supervisor' and exists(select 1 from teams team where team.supervisor_profile_id=p.id))
            ) order by p.employee_code,p.id limit 1`;
            const candidate = candidates[0];
            let person;
            if (candidate) {
              await bindSampleSubject(t, candidate.auth_subject, user.id);
              await t`update profiles set user_id=${user.id},auth_subject=${user.id},email=${email} where id=${candidate.id}`;
              person = {
                ...candidate,
                user_id: user.id,
                auth_subject: user.id,
                email,
              };
            } else {
              person = await copyTrialRow(t, "profiles", template, slug, {
                user_id: user.id,
                auth_subject: user.id,
                email,
                role: persona.role,
                name: `Sample Trial ${persona.label} ${n}`,
                employee_code: `SMP-TRIAL-${slug.toUpperCase()}`,
              });
            }
            await wirePerson(
              t,
              person,
              candidate ?? template,
              slug,
              Boolean(candidate),
            );
            credential = {
              email,
              name: person.name,
              role: persona.role,
              persona: persona.slug,
              userId: user.id,
              profileId: person.id,
              password: secret,
            };
            created++;
          }
          accounts.push(credential);
        }
      }
      // Write before commit: an interrupted commit can be retried with the same secrets.
      // A tester-changed password is never silently reset by a normal rerun.
      record.databases[databaseKey] = [
        ...saved.filter(
          (a) => !accounts.some((current) => current.email === a.email),
        ),
        ...accounts,
      ];
      await privateWrite(recordPath, JSON.stringify(record, null, 2) + "\n");
      return { created, rotated, accounts };
    });
    // Read back each persisted login/hash before making the distributable artifact.
    for (const account of result.accounts) {
      const [row] =
        await db`select password_hash from users where id=${account.userId} and email=${account.email}`;
      if (
        !row ||
        (!account.passwordChanged &&
          !(await Bun.password.verify(account.password, row.password_hash)))
      )
        throw new Error("Trial credential verification failed");
    }
    await privateWrite(outPath, trialAccountText(result.accounts));
    return {
      created: result.created,
      rotated: result.rotated,
      total: result.accounts.length,
      counts: Object.fromEntries(
        TRIAL_ROLES.map((r) => [
          r.slug,
          result.accounts.filter((a) => a.persona === r.slug).length,
        ]),
      ),
      recordPath,
      outPath,
    };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  /** @type {{perRole?:number,rotate?:boolean,outPath?:string}} */ const options =
    {};
  let invalid = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rotate") options.rotate = true;
    else if (args[i] === "--per-role" && args[i + 1])
      options.perRole = Number(args[++i]);
    else if (args[i] === "--out" && args[i + 1]) options.outPath = args[++i];
    else invalid = true;
  }
  if (invalid || !process.env.DATABASE_URL) {
    console.error(
      "Usage: DATABASE_URL=… bun packages/db/seed/trial-accounts.js [--per-role 3] [--rotate] [--out path]",
    );
    process.exitCode = 2;
  } else {
    const db = createDb(process.env.DATABASE_URL, { max: 2 });
    try {
      const result = await createTrialAccounts(db, options);
      console.log(
        JSON.stringify({
          created: result.created,
          rotated: result.rotated,
          total: result.total,
          counts: result.counts,
          file: result.outPath,
        }),
      );
    } catch {
      // Never serialize SQL errors, credential records, URLs or password parameters.
      console.error(
        "Trial accounts failed. Check migrations, sample seed, private credential record and file permissions. Existing credentials are not overwritten without --rotate.",
      );
      process.exitCode = 1;
    } finally {
      await db.close();
    }
  }
}
