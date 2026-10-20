#!/usr/bin/env bun
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { createDb, tx } from "../src/client.js";
import { privateWrite } from "./trial-accounts.js";
import { rowId } from "./store.js";

/** F-611: database-keyed private trial credential record, no employee profiles.
 * @param {import('../src/client.js').Db} db
 * @param {{recordPath?:string,outPath?:string}} [options] */
export async function createPortalAccounts(
  db,
  {
    recordPath = `${homedir()}/.sunpride-keys/mt-portal-accounts.json`,
    outPath = `${homedir()}/Downloads/sunpride-customer-portal-accounts.txt`,
  } = {},
) {
  if (recordPath === outPath)
    throw new Error("Credential record and handout must be different files");
  await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
  const lock = `${recordPath}.lock`;
  await mkdir(lock, { mode: 0o700 });
  try {
    /** @type {{version:number,databases:Record<string,any[]>}} */ let record =
      { version: 1, databases: {} };
    try {
      record = JSON.parse(await readFile(recordPath, "utf8"));
      await chmod(recordPath, 0o600);
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT")
        throw new Error("Private portal record cannot be read");
    }
    if (record.version !== 1 || !record.databases)
      throw new Error("Private portal record is invalid");
    const [identity] =
      await db`select current_database() as name,inet_server_addr()::text as host,inet_server_port() as port`;
    const dbKey = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(identity))
      .digest("hex");
    const saved = record.databases[dbKey] ?? [];
    const accounts = await tx(db, async (t) => {
      await t`select pg_advisory_xact_lock(4900001)`;
      const result = [];
      for (const [index, scope] of [
        "SAMPLE-CHAIN-A",
        "SAMPLE-CHAIN-B",
      ].entries()) {
        const [binding] =
          await t`select id from mt_account_bindings where account_key=${scope} and source='sample' limit 1`;
        if (!binding)
          throw new Error("Seed the sample modern-trade branches first");
        const email = `customer${index + 1}@trial.sunpride.test`,
          name = `Sample customer ${index + 1}`;
        let credential = saved.find((a) => a.email === email);
        let [user] = await t`select * from users where email=${email}`;
        if (user) {
          const [owned] =
            await t`select id from sample_data_rows where batch='sunpride-mt-v1' and table_name='users' and row_id=${user.id}::text`;
          const [employee] =
            await t`select id from profiles where user_id=${user.id}`;
          if (!owned || employee || !credential)
            throw new Error(
              "Existing portal identity does not match the private record; nothing was overwritten",
            );
          credential = {
            ...credential,
            passwordChanged: !(await Bun.password.verify(
              credential.password,
              user.password_hash,
            )),
          };
        } else {
          credential = {
            email,
            name,
            userId: rowId("users", `mt:portal-${index + 1}`),
            scope,
            password: `Mt-${Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url")}`,
            passwordChanged: false,
          };
          const hash = await Bun.password.hash(credential.password, {
            algorithm: "argon2id",
          });
          [user] =
            await t`insert into users(id,email,password_hash) values(${credential.userId},${email},${hash}) returning id`;
          await t`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-mt-v1','users',${user.id},${`users:mt:portal-${index + 1}`})`;
          const memberId = rowId(
            "mt_portal_memberships",
            `mt:portal-${index + 1}`,
          );
          await t`insert into mt_portal_memberships(id,user_id,name,scope_kind,scope_key,effective_from) values(${memberId},${user.id},${name},'account',${scope},'2020-01-01')`;
          await t`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-mt-v1','mt_portal_memberships',${memberId},${`mt_portal_memberships:mt:portal-${index + 1}`})`;
        }
        result.push(credential);
      }
      // Save the recovery record before commit, so a failed handout never loses passwords.
      record.databases[dbKey] = result;
      await privateWrite(recordPath, JSON.stringify(record, null, 2));
      return result;
    });
    const lines = [
      "Sunpride customer portal · marked sample accounts",
      "https://sunpride.cauldnclark.com/portal/login",
      "Sample data, not real Sunpride customer accounts.",
      "Keep this file private. Each login sees only its own sample chain.",
      "",
    ];
    for (const a of accounts)
      lines.push(
        `${a.name} · ${a.email} · ${a.passwordChanged ? "Password changed by tester; use the chosen password" : a.password}`,
      );
    await privateWrite(outPath, lines.join("\n") + "\n");
    return { accounts: accounts.length, recordPath, outPath };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const db = createDb(process.env.DATABASE_URL, { max: 1 });
  try {
    const args = process.argv.slice(2);
    const result = await createPortalAccounts(db, {
      recordPath: args[0],
      outPath: args[1],
    });
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      "Portal accounts could not be created safely; verify sample data and the private credential record",
    );
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
