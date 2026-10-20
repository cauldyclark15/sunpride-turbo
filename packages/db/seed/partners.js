import { chmod, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { tx } from "../src/client.js";
import {
  BATCH,
  insertRows,
  rowId,
  at,
  plusDays,
  todayManila,
} from "./store.js";

/** F-319 F-322: additive fictional agency, dedicated logins and canonical call
 * facts. Reuses distributors/distributor_users and the single shared outlet list.
 * @param {import('../src/client.js').Db} db
 * @param {{date?:string,credentialsPath?:string}} [options] */
export async function ensurePartnerSamples(
  db,
  {
    date = todayManila(),
    credentialsPath = join(
      homedir(),
      ".sunpride-keys/agency-portal-logins.json",
    ),
  } = {},
) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(4310550)`;
    const [database] = await t`select current_database() as name`;
    await mkdir(dirname(credentialsPath), { recursive: true, mode: 0o700 });
    /** @type {Record<string,any>} */ let record = {};
    try {
      record = JSON.parse(await readFile(credentialsPath, "utf8"));
    } catch (e) {
      if (/** @type {any} */ (e).code !== "ENOENT") throw e;
    }
    record[database.name] ??= {};
    const accounts = [
      ["portal", "Agency coordinator", "agency"],
      ["merch1", "Agency merchandiser 1", "sales"],
      ["merch2", "Agency merchandiser 2", "sales"],
    ];
    for (const [key, name, role] of accounts) {
      const [retained] =
        await t`select id from users where id=${rowId("users", `agency-${key}`)}`;
      if (retained && !record[database.name][key])
        throw new Error(
          "Retained sample agency credentials are missing; refusing to replace them",
        );
      record[database.name][key] ??= {
        email: `${key}@agency.sunpride.test`,
        name,
        role,
        password: crypto.randomUUID() + crypto.randomUUID(),
      };
    }
    const temporary = `${credentialsPath}.${crypto.randomUUID()}`;
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(temporary, credentialsPath);
    await chmod(credentialsPath, 0o600);
    const [office] =
      await t`select p.* from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text and m.batch=${BATCH} where p.role in ('super_admin','admin') and p.status='active' and p.deleted_at is null order by (p.role='super_admin') desc limit 1`;
    const [source] =
      await t`select p.* from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text and m.batch=${BATCH} where p.role='sales' and p.position_id is not null and p.status='active' and p.deleted_at is null and not exists(select 1 from distributor_users u where u.profile_id=p.id) order by p.name limit 1`;
    if (!office || !source)
      return { status: "needs_sample_company", partners: 0, credentialsPath };
    const beginning = new Date("2026-01-01T00:00:00+08:00");
    /** @param {string} table @param {string} key @param {Record<string,any>} value */
    async function ensure(table, key, value) {
      const id = rowId(table, `agency-${key}`);
      const [old] = await t.unsafe(`select id from "${table}" where id=$1`, [
        id,
      ]);
      if (!old) {
        await insertRows(t, table, [
          {
            id,
            created_at: beginning.toISOString(),
            updated_at: beginning.toISOString(),
            ...value,
          },
        ]);
        await t`insert into sample_data_rows(id,batch,table_name,row_id,key) values(${rowId("sample_data_rows", `agency-${table}-${key}`)},${BATCH},${table},${id},${`agency:${table}:${key}`})`;
      }
      return id;
    }
    const agency = await ensure("distributors", "agency", {
      code: "SAMPLE-AGENCY",
      name: "Sample agency · Cebu Merchandising",
      org_unit_id: source.org_unit_id,
      status: "accredited",
      source: "sample",
      partner_kind: "agency",
      effective_from: beginning,
    });
    for (const [key, name, role] of accounts) {
      const account = record[database.name][key];
      const [known] =
        await t`select id from users where lower(email)=${account.email}`;
      const expected = rowId("users", `agency-${key}`);
      if (known && known.id !== expected)
        throw new Error("Sample agency email belongs to another identity");
      const user = await ensure("users", key, {
        email: account.email,
        password_hash: await Bun.password.hash(account.password, {
          algorithm: "argon2id",
        }),
      });
      const profile = await ensure("profiles", key, {
        user_id: user,
        auth_subject: user,
        name: `Sample · ${name}`,
        email: account.email,
        role,
        status: "active",
        org_unit_id: source.org_unit_id,
        position_id: role === "sales" ? source.position_id : null,
        employment_type: "third_party",
        scope_epoch: 1,
      });
      await ensure("distributor_users", key, {
        distributor_id: agency,
        profile_id: profile,
        grants: role === "sales" ? ["field"] : ["portal", "billing"],
        effective_from: beginning,
      });
      if (role !== "sales") continue;
      await ensure("employee_assignments", key, {
        profile_id: profile,
        org_unit_id: source.org_unit_id,
        role: "sales",
        position_id: source.position_id,
        effective_from: beginning,
        actor_subject: "system:sample",
        reason: "SAMPLE agency merchandiser",
      });
      const territories =
        await t`select * from territory_salespeople where profile_id=${source.id} and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now())`;
      for (const territory of territories)
        await ensure(
          "territory_salespeople",
          `${key}-${territory.territory_id}`,
          {
            territory_id: territory.territory_id,
            profile_id: profile,
            effective_from: beginning,
            actor_subject: "system:sample",
            reason: "SAMPLE agency territory",
          },
        );
      const stores =
        await t`select distinct o.id,o.name from outlets o join outlet_assignments a on a.outlet_id=o.id join territory_salespeople s on s.territory_id=a.territory_id where s.profile_id=${source.id}
        and o.deleted_at is null and o.status='active' and a.deleted_at is null and s.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())
        and s.effective_from<=now() and (s.effective_to is null or s.effective_to>now()) order by o.id limit 6`;
      for (const store of stores)
        await ensure("partner_outlet_assignments", store.id, {
          distributor_id: agency,
          outlet_id: store.id,
          effective_from: beginning,
        });
      // Historical examples are marked fictional facts, not claims of a phone journey.
      for (let n = 13; n >= 0; n--) {
        const day = plusDays(date, -n),
          start = at(day, 9 * 60 + (key === "merch1" ? 0 : 60)),
          end = start + 20 * 60000;
        if (end > Date.now() || !stores.length) continue;
        const store = stores[n % stores.length],
          good = n % 5 !== 0;
        const visit = await ensure("visit_executions", `${key}-${day}`, {
          organization_id: "sunpride",
          client_visit_id: rowId("visit_executions", `agency-${key}-${day}`),
          assignee_profile_id: profile,
          outlet_id: store.id,
          org_unit_id: source.org_unit_id,
          service_date: day,
          source: "unplanned",
          intents: ["merchandise"],
          state: "checked-out",
          outcome: "completed",
          unplanned_reason: "SAMPLE agency execution",
          productivity: "nonproductive",
          last_server_time: new Date(end),
          checked_in_at: new Date(start),
          checked_out_at: new Date(end),
          started_at: new Date(start),
          ended_at: new Date(end),
          call_duration_ms: end - start,
          activity_rules_snapshot: [
            {
              intent: "merchandise",
              activities: [{ kind: "merchandising", required: true }],
            },
          ],
        });
        await ensure("visit_activities", `${key}-${day}`, {
          organization_id: "sunpride",
          org_unit_id: source.org_unit_id,
          visit_id: visit,
          assignee_profile_id: profile,
          outlet_id: store.id,
          activity_kind: "merchandising",
          activity: {
            kind: "merchandising",
            displayCondition: good ? "compliant" : "needs_action",
            actionTaken: "SAMPLE fixture",
          },
          device_time: new Date(start + 60000),
          server_time: new Date(start + 60000),
        });
        for (const event of ["check_in", "check_out"])
          await ensure("visit_location_evidence", `${key}-${day}-${event}`, {
            organization_id: "sunpride",
            org_unit_id: source.org_unit_id,
            visit_id: visit,
            event,
            provider: "gps",
            accuracy_meters: 5,
            mock_signal: false,
            policy_version: "SAMPLE agency evidence",
            result: "within_radius",
            review_status: "verified",
            device_time: new Date(event === "check_in" ? start : end),
            server_time: new Date(event === "check_in" ? start : end),
          });
      }
    }
    await ensure("partner_contracts", "v1", {
      distributor_id: agency,
      version: 1,
      source_ref: "SAMPLE invented agency day rate; not payable client policy",
      sample: true,
      rate_centavos: 65000,
      minimum_calls: 1,
      minimum_dwell_ms: 180000,
      minimum_retail_score: 100,
      required_kinds: ["merchandising"],
      effective_from: beginning,
      created_by: office.id,
    });
    const [count] =
      await t`select count(*)::int n from distributor_users where distributor_id=${agency}`;
    return { status: "ready", partners: 1, accounts: count.n, credentialsPath };
  });
}
