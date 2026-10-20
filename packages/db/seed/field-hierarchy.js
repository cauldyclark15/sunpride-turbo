import { BATCH, ACTOR, rowId } from "./store.js";
import { addTrialRow } from "./trial-wiring.js";

/** F-008: data-defined sample reporting chain. Existing app-role grants stay unchanged.
 * Idempotent and additive; never adopts or reparents unmarked client units.
 * @param {import('../src/client.js').Db} db */
export async function seedFieldHierarchy(db) {
  const [manifest] =
    await db`select 1 from sample_data_rows where batch=${BATCH} and key='audit_logs:manifest'`;
  if (!manifest) throw new Error("Field hierarchy requires the sample company");
  await db`select pg_advisory_xact_lock(4310080)`;
  /** @param {string} table @param {string} key @param {Record<string,any>} values @returns {Promise<import('./store.js').Row>} */
  async function ensure(table, key, values) {
    const [marker] =
      await db`select row_id from sample_data_rows where batch=${BATCH} and table_name=${table} and key=${`${table}:trial-${key}`}`;
    return marker
      ? { ...values, id: marker.row_id }
      : addTrialRow(db, table, key, values);
  }
  const [root] =
    await db`select * from org_units where id=${rowId("org_units", "national")}`;
  const [region] =
    await db`select * from org_units where id=${rowId("org_units", "visayas")}`;
  const [manager] =
    await db`select * from profiles where id=${rowId("profiles", "manager")}`;
  const [supervisor] =
    await db`select * from profiles where id=${rowId("profiles", "supervisor")}`;
  const from = new Date();
  await ensure("org_unit_types", "area", {
    organization_id: "sunpride",
    code: "area",
    label: "Area",
    level: 2,
    active: true,
  });
  const area = await ensure("org_units", "sample-area", {
    organization_id: "sunpride",
    code: "SMP-AREA-CEBU",
    name: "Sample Cebu Area",
    type_code: "area",
    parent_id: region.id,
    status: "active",
    effective_from: from,
  });
  await ensure("org_unit_parent_edges", "sample-area", {
    unit_id: area.id,
    parent_id: region.id,
    effective_from: from,
    actor_subject: ACTOR,
    reason: "F-008 marked sample area",
  });
  for (const i of [0, 1]) {
    const id = rowId("org_units", `territory-${i}`);
    const [owned] =
      await db`select 1 from sample_data_rows where batch=${BATCH} and table_name='org_units' and row_id=${id}`;
    if (!owned) throw new Error("Sample territory ownership is missing");
    const [done] =
      await db`select 1 from org_unit_parent_edges where unit_id=${id} and parent_id=${area.id} and effective_to is null`;
    if (done) continue;
    await db`update org_unit_parent_edges set effective_to=${from} where unit_id=${id} and effective_to is null and deleted_at is null`;
    await ensure("org_unit_parent_edges", `sample-area-${i}`, {
      unit_id: id,
      parent_id: area.id,
      effective_from: from,
      actor_subject: ACTOR,
      reason: "F-008 sample hierarchy; earlier ownership retained",
    });
    await db`update org_units set parent_id=${area.id} where id=${id}`;
  }
  const positions = new Map();
  for (const [key, label, category] of [
    ["nationalmanager", "National Sales Manager", "leadership"],
    ["regionalmanager", "Regional Manager", "leadership"],
    ["areamanager", "Area Manager", "supervisory"],
  ]) {
    positions.set(
      key,
      await ensure("positions", key, {
        organization_id: "sunpride",
        code: `SMP-${key.toUpperCase()}`,
        label,
        category,
        active: true,
      }),
    );
  }
  const national = await ensure("profiles", "nationalmanager", {
    auth_subject: "sample:nationalmanager",
    name: "Sample National Sales Manager",
    email: "nationalmanager@sunpride.test",
    role: "manager",
    status: "active",
    org_unit_id: root.id,
    position_id: positions.get("nationalmanager").id,
    employment_type: "sfi_employee",
    effective_from: from,
  });
  const areaManager = await ensure("profiles", "areamanager", {
    auth_subject: "sample:areamanager",
    name: "Sample Cebu Area Manager",
    email: "areamanager@sunpride.test",
    role: "manager",
    status: "active",
    org_unit_id: area.id,
    position_id: positions.get("areamanager").id,
    employment_type: "sfi_employee",
    effective_from: from,
  });
  // The region template shares the existing manager's scope, not an extra permission role.
  await ensure("profiles", "regionalmanager", {
    auth_subject: "sample:regionalmanager",
    name: "Sample Visayas Regional Manager",
    email: "regionalmanager@sunpride.test",
    role: "manager",
    status: "active",
    org_unit_id: region.id,
    position_id: positions.get("regionalmanager").id,
    employment_type: "sfi_employee",
    effective_from: from,
  });
  for (const [person, parent, position] of [
    [national, null, national.position_id],
    [manager, national.id, positions.get("regionalmanager").id],
    [areaManager, manager.id, areaManager.position_id],
    [supervisor, areaManager.id, supervisor.position_id],
    [
      {
        id: rowId("profiles", "trial-regionalmanager"),
        org_unit_id: region.id,
      },
      national.id,
      positions.get("regionalmanager").id,
    ],
  ]) {
    const [done] =
      await db`select 1 from employee_assignments where profile_id=${person.id} and supervisor_id is not distinct from ${parent} and position_id=${position} and effective_to is null and deleted_at is null`;
    if (done) continue;
    await db`update employee_assignments set effective_to=${from} where profile_id=${person.id} and effective_to is null and deleted_at is null`;
    await ensure("employee_assignments", `hierarchy-${person.id}`, {
      profile_id: person.id,
      org_unit_id: person.org_unit_id,
      role: "manager",
      position_id: position,
      supervisor_id: parent,
      effective_from: from,
      actor_subject: ACTOR,
      reason: "F-008 sample rep → supervisor → area → regional → national",
    });
    await db`update profiles set position_id=${position} where id=${person.id}`;
  }
}
