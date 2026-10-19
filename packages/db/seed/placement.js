#!/usr/bin/env bun
import { createDb, tx } from "../src/client.js";
import { BATCH, rowId, todayManila } from "./store.js";
import { ensureTrip } from "./trial-wiring.js";

/** Repair only seed-owned placement, without resetting stock, sales, identities or passwords.
 * Call inside the seed transaction. Extra area trips are planned and unloaded, never funded
 * by invented balances or by borrowing another seller's stock.
 * @param {import('../src/client.js').Db} db */
export async function placeDemoStock(db) {
  let locations = 0,
    vehicles = 0,
    plannedTrips = 0;
  const [depotArea] =
    await db`select id from org_units where id=${rowId("org_units", "territory-0")} and deleted_at is null`;
  if (!depotArea) throw new Error("Sample depot area is missing");
  const owned =
    await db`select l.* from inventory_locations l join sample_data_rows m on m.row_id=l.id::text and m.table_name='inventory_locations' and m.batch=${BATCH} where l.deleted_at is null`;
  for (const l of owned) {
    const [seller] =
      l.type === "truck"
        ? await db`select coalesce(a.org_unit_id,p.org_unit_id) unit_id from van_trips t join profiles p on p.id=t.salesperson_profile_id left join lateral (select org_unit_id from employee_assignments where profile_id=p.id and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now()) order by effective_from desc limit 1) a on true join sample_data_rows m on m.row_id=t.id::text and m.table_name='van_trips' and m.batch=${BATCH} where t.truck_location_id=${l.id} and t.deleted_at is null order by t.service_date desc,t.created_at desc limit 1`
        : [];
    const unit =
      l.id === rowId("inventory_locations", "depot")
        ? depotArea.id
        : seller?.unit_id;
    if (!unit) continue;
    const changed =
      await db`update inventory_locations set org_unit_id=${unit} where id=${l.id} and org_unit_id is distinct from ${unit} returning id`;
    locations += changed.length;
    const changedVehicles =
      await db`update vehicles v set org_unit_id=${unit} where truck_location_id=${l.id} and org_unit_id is distinct from ${unit} and exists(select 1 from sample_data_rows m where m.row_id=v.id::text and m.table_name='vehicles' and m.batch=${BATCH}) returning id`;
    vehicles += changedVehicles.length;
  }
  const areas =
    await db`select distinct p.org_unit_id,u.code from profiles p join users login on login.id=p.user_id join org_units u on u.id=p.org_unit_id where login.email like 'supervisor%@trial.sunpride.test' and exists(select 1 from sample_data_rows m where m.row_id=p.id::text and m.table_name='profiles' and m.batch=${BATCH})`;
  for (const area of areas) {
    const [existing] =
      await db`select id from van_trips where org_unit_id=${area.org_unit_id} and service_date=${todayManila()} and deleted_at is null and status<>'cancelled' limit 1`;
    if (existing) continue;
    const [seller] =
      await db`select p.* from profiles p where org_unit_id=${area.org_unit_id} and role='sales' and status='active' and deleted_at is null and exists(select 1 from sample_data_rows m where m.row_id=p.id::text and m.table_name='profiles' and m.batch=${BATCH}) order by employee_code,id limit 1`;
    if (!seller) continue;
    await ensureTrip(
      db,
      { ...seller, user_id: seller.user_id ?? seller.auth_subject },
      seller,
      `area-${area.code.toLowerCase()}`,
    );
    plannedTrips++;
  }
  return { locations, vehicles, plannedTrips };
}

if (import.meta.main) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const db = createDb(process.env.DATABASE_URL);
  try {
    const result = await tx(db, async (t) => {
      await t`select pg_advisory_xact_lock(4310090)`;
      return placeDemoStock(t);
    });
    console.log(JSON.stringify(result));
  } finally {
    await db.close();
  }
}
