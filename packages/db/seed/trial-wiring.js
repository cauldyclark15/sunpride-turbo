import {
  ACTOR,
  BATCH,
  at,
  ident,
  insertRows,
  plusDays,
  rowId,
  todayManila,
} from "./store.js";

/** @typedef {import('../src/client.js').Db} Db */
/** @typedef {import('./store.js').Row} Row */

/** Every newly created row uses the seed's deterministic identity and reset marker.
 * @param {Db} db @param {string} table @param {string} key @param {Record<string,any>} values @returns {Promise<Row>} */
export async function addTrialRow(db, table, key, values) {
  const stamp = new Date().toISOString();
  const row = {
    ...values,
    id: rowId(table, `trial-${key}`),
    created_at: stamp,
    updated_at: stamp,
  };
  await insertRows(db, table, [row]);
  const markerKey = `${table}:trial-${key}`;
  await insertRows(db, "sample_data_rows", [
    {
      id: rowId("sample_data_rows", markerKey),
      batch: BATCH,
      table_name: table,
      row_id: row.id,
      key: markerKey,
      created_at: stamp,
      updated_at: stamp,
    },
  ]);
  return row;
}

/** Copy only writable business columns, not generated search/sequence or row metadata.
 * @param {Db} db @param {string} table @param {Row} source @param {string} key @param {Record<string,any>} overrides */
export async function copyTrialRow(db, table, source, key, overrides) {
  const columns =
    await db`select column_name from information_schema.columns where table_schema='public' and table_name=${table} and is_generated='NEVER'`;
  const names = new Set(columns.map((/** @type {any} */ c) => c.column_name));
  const values = Object.fromEntries(
    Object.entries(source).filter(
      ([name]) =>
        names.has(name) &&
        ![
          "id",
          "created_at",
          "updated_at",
          "change_seq",
          "deleted_at",
        ].includes(name),
    ),
  );
  return addTrialRow(db, table, key, { ...values, ...overrides });
}

/** Link a real sample person's ownership references to their new login without altering
 * frozen signed snapshots or historical authorship. Never touch untracked client work.
 * @param {Db} db @param {string} oldSubject @param {string} userId */
export async function bindSampleSubject(db, oldSubject, userId) {
  for (const [table, column] of [
    ["orders", "salesperson_subject"],
    ["visits", "salesperson_subject"],
    ["sales_assignments", "salesperson_subject"],
    ["truck_route_sessions", "salesperson_subject"],
    ["van_trips", "salesperson_subject"],
    ["profiles", "supervisor_subject"],
  ]) {
    await db.unsafe(
      `update ${ident(table)} r set ${ident(column)}=$1 where ${ident(column)}=$2 and exists (select 1 from sample_data_rows m where m.batch=$3 and m.table_name=$4 and m.row_id=r.id::text)`,
      [userId, oldSubject, BATCH, table],
    );
  }
}

/** Give a copied employee the same current assignment, team and routes, with narrower
 * team-unit scope for supervisor trial personas. Existing people's work is retained.
 * @param {Db} db @param {Row} person @param {Row} template @param {string} slug @param {boolean} adopted */
export async function wirePerson(db, person, template, slug, adopted) {
  if (!adopted) {
    const assignments =
      await db`select * from employee_assignments where profile_id=${template.id} and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now())`;
    for (const a of assignments)
      await copyTrialRow(db, "employee_assignments", a, `${slug}-assignment`, {
        profile_id: person.id,
        org_unit_id: person.org_unit_id,
        role: person.role,
        actor_subject: ACTOR,
        reason: "Sample trial account",
      });
    for (const table of [
      "route_salespeople",
      "territory_salespeople",
      "team_memberships",
    ]) {
      const rows = await db.unsafe(
        `select * from ${ident(table)} where profile_id=$1 ${table === "team_memberships" ? "" : "and deleted_at is null"} and effective_from<=now() and (effective_to is null or effective_to>now())`,
        [template.id],
      );
      for (const r of rows)
        await copyTrialRow(db, table, r, `${slug}-${r.id}`, {
          profile_id: person.id,
          ...(table === "route_salespeople" ? { is_primary: false } : {}),
          actor_subject: ACTOR,
          reason: "Sample trial account",
        });
    }
  }
  if (slug.startsWith("supervisor")) {
    const [team] =
      await db`select * from teams where supervisor_profile_id=${template.id} and status='active' order by code limit 1`;
    if (!team) throw new Error("Trial sample supervisor team is missing");
    await db`update profiles set org_unit_id=${team.org_unit_id} where id=${person.id}`;
    await db`update employee_assignments set org_unit_id=${team.org_unit_id} where profile_id=${person.id} and deleted_at is null and effective_to is null`;
    const ownTeam = await copyTrialRow(db, "teams", team, slug, {
      code: `SMP-TRIAL-${slug.toUpperCase()}`,
      name: `Sample ${person.name} team`,
      supervisor_profile_id: person.id,
    });
    const members =
      await db`select * from team_memberships where team_id=${team.id} and effective_to is null`;
    for (const m of members)
      await copyTrialRow(db, "team_memberships", m, `${slug}-${m.id}`, {
        team_id: ownTeam.id,
      });
  }
  if (person.role === "sales") {
    await ensureTodayPlan(db, person, template, slug);
    if (slug.startsWith("van")) await ensureTrip(db, person, template, slug);
  }
}

/** Clone only today's sample plan when a fallback person needs work; no fake executions.
 * Existing approved sample snapshots are left untouched.
 * @param {Db} db @param {Row} person @param {Row} template @param {string} slug */
async function ensureTodayPlan(db, person, template, slug) {
  const today = todayManila();
  const [existing] =
    await db`select id from planned_visits where assignee_profile_id=${person.id} and service_date=${today} and status='planned' and deleted_at is null limit 1`;
  if (existing) return;
  const [source] =
    await db`select * from coverage_plans where assignee_profile_id=${template.id} and status='active' and deleted_at is null order by local_month desc limit 1`;
  if (!source) throw new Error("Trial sample field plan is missing");
  const [version] =
    await db`select coalesce(max(version),0)::int n from coverage_plans where assignee_profile_id=${person.id} and local_month=${today.slice(0, 7)}`;
  const plan = await copyTrialRow(
    db,
    "coverage_plans",
    source,
    `${slug}-${today}`,
    {
      assignee_profile_id: person.id,
      org_unit_id: person.org_unit_id,
      local_month: today.slice(0, 7),
      version: version.n + 1,
      requested_from: new Date(at(today)).toISOString(),
      effective_from: new Date(at(today)).toISOString(),
      requested_to: new Date(at(plusDays(today, 1))).toISOString(),
      effective_to: new Date(at(plusDays(today, 1))).toISOString(),
      content_hash: null,
      approval_signature: null,
      signed_content: null,
    },
  );
  const assignment = await addTrialRow(
    db,
    "coverage_assignments",
    `${slug}-${today}`,
    {
      plan_id: plan.id,
      assignee_profile_id: person.id,
      org_unit_id: person.org_unit_id,
      is_primary: true,
      effective_from: plan.effective_from,
      effective_to: plan.effective_to,
      actor_subject: ACTOR,
      reason: "Sample trial day",
    },
  );
  const territories =
    await db`select * from coverage_plan_territories where coverage_plan_id=${source.id}`;
  for (const r of territories)
    await copyTrialRow(
      db,
      "coverage_plan_territories",
      r,
      `${slug}-${today}-${r.id}`,
      { coverage_plan_id: plan.id },
    );
  const slots =
    await db`select * from coverage_plan_slots where plan_id=${source.id} and kind='outlet_visit' and deleted_at is null and service_date=(select max(service_date) from coverage_plan_slots where plan_id=${source.id} and kind='outlet_visit' and deleted_at is null) order by sequence`;
  if (!slots.length) throw new Error("Trial sample plan has no stops");
  const snapshots = [];
  for (const [i, s] of slots.entries()) {
    const snapshot = {
      ...s.approved_snapshot,
      source: "sample",
      approvedAssigneeProfileId: person.id,
      orgUnitId: person.org_unit_id,
      employeeAssignmentId: rowId(
        "employee_assignments",
        `trial-${slug}-assignment`,
      ),
      coverageAssignmentId: assignment.id,
    };
    const slot = await copyTrialRow(
      db,
      "coverage_plan_slots",
      s,
      `${slug}-${today}-${i}`,
      {
        slot_key: `SMP-TRIAL-${slug}-${today}-${i}`,
        plan_id: plan.id,
        assignee_profile_id: person.id,
        service_date: today,
        approved_snapshot: snapshot,
      },
    );
    await addTrialRow(db, "planned_visits", `${slug}-${today}-${i}`, {
      generation_key: `sample:trial:${slug}:${today}:${i}`,
      plan_id: plan.id,
      plan_version: plan.version,
      plan_slot_id: slot.id,
      assignee_profile_id: person.id,
      outlet_id: s.outlet_id,
      service_date: today,
      status: "planned",
      approved_snapshot: snapshot,
      required_objectives: s.required_objectives,
      intents: s.intents,
      expected_duration_minutes: s.expected_duration_minutes,
      generated_at: plan.effective_from,
    });
    snapshots.push(snapshot);
  }
  const hash = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ source: "sample", planId: plan.id, snapshots }))
    .digest("hex");
  await db`update coverage_plans set content_hash=${hash},approval_signature=${`sample-trial-sql-v1:${hash}`} where id=${plan.id}`;
}

/** Extra sellers receive a separate empty sample truck and a planned trip, never a
 * duplicate active trip on somebody else's truck or a fabricated stock balance.
 * @param {Db} db @param {Row} person @param {Row} template @param {string} slug */
export async function ensureTrip(db, person, template, slug) {
  const today = todayManila();
  const [existing] =
    await db`select id from van_trips where salesperson_profile_id=${person.id} and service_date=${today} and deleted_at is null and status not in ('cancelled','closed')`;
  if (existing) return;
  const [trip] =
    await db`select * from van_trips where salesperson_profile_id=${template.id} order by service_date desc limit 1`;
  const [fallback] = trip
    ? [trip]
    : await db`select * from van_trips order by service_date desc,trip_number limit 1`;
  if (!fallback) throw new Error("Trial sample truck trip is missing");
  const [vehicle] =
    await db`select * from vehicles where id=${fallback.vehicle_id}`;
  const [location] =
    await db`select * from inventory_locations where id=${fallback.truck_location_id}`;
  // F-008 F-025: the truck is a permanent trial master, not a new daily row.
  // Reuse only this persona's marked truck; never adopt an unowned collision.
  const [savedTruck] =
    await db`select l.* from inventory_locations l where l.id=${rowId("inventory_locations", `trial-${slug}`)}`;
  const [savedVehicle] =
    await db`select v.* from vehicles v where v.id=${rowId("vehicles", `trial-${slug}`)}`;
  for (const [table, row] of [
    ["inventory_locations", savedTruck],
    ["vehicles", savedVehicle],
  ]) {
    if (!row) continue;
    const [owned] =
      await db`select 1 from sample_data_rows where batch=${BATCH} and table_name=${table} and row_id=${row.id}`;
    if (!owned || row.deleted_at || row.org_unit_id !== person.org_unit_id)
      throw new Error(
        "Trial truck requires office reconciliation; refusing to overwrite existing data",
      );
  }
  const truck =
    savedTruck ??
    (await copyTrialRow(db, "inventory_locations", location, slug, {
      code: `SMP-TRIAL-${slug.toUpperCase()}`,
      name: `Sample trial truck ${slug}`,
      org_unit_id: person.org_unit_id,
    }));
  const v =
    savedVehicle ??
    (await copyTrialRow(db, "vehicles", vehicle, slug, {
      vehicle_code: `SMP-TRIAL-${slug.toUpperCase()}`,
      plate_number: `TRIAL-${slug.toUpperCase()}`,
      name: `Sample trial truck ${slug}`,
      truck_location_id: truck.id,
      org_unit_id: person.org_unit_id,
    }));
  if (v.truck_location_id !== truck.id)
    throw new Error(
      "Trial vehicle no longer points to its owned truck; reconcile in office",
    );
  const [route] =
    await db`select route_id from route_salespeople where profile_id=${person.id} and deleted_at is null and effective_to is null limit 1`;
  const t = await addTrialRow(db, "van_trips", `${slug}-${today}`, {
    organization_id: fallback.organization_id,
    org_unit_id: person.org_unit_id,
    trip_number: `SMP-TRIAL-${slug}-${today}`,
    vehicle_id: v.id,
    truck_location_id: truck.id,
    source_location_id: fallback.source_location_id,
    route_id: route?.route_id ?? fallback.route_id,
    service_date: today,
    salesperson_profile_id: person.id,
    salesperson_subject: person.user_id,
    status: "planned",
    created_by: ACTOR,
  });
  await addTrialRow(db, "van_trip_loads", `${slug}-${today}`, {
    organization_id: fallback.organization_id,
    trip_id: t.id,
    load_number: 1,
    status: "planned",
    created_by: ACTOR,
  });
}
