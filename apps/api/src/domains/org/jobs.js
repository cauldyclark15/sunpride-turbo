import { tx } from "@sunpride/db/client";
import { ORG_LOCK } from "./identity.js";
import { activeAt, get, history, ms, update } from "./model.js";
import { personAt } from "./scope.js";

/** Materialized columns serve direct-table readers; authorization always reads effective edges.
 * @param {any} platform
 */
export function installOrgJobs(platform) {
  platform.registerJob(
    "org.materialize",
    async (/** @type {any} */ { db, payload }) => {
      await tx(db, async (t) => {
        await t`select pg_advisory_xact_lock(${ORG_LOCK})`;
        const row = await get(t, payload.table, payload.id),
          now = Date.now();
        const values = {
          status:
            row.effective_to && ms(row.effective_to) <= now
              ? "inactive"
              : row.status,
        };
        if (payload.table === "org_units") {
          const edges = await history(
            t,
            "org_unit_parent_edges",
            "unit_id",
            row.id,
          );
          const edge = edges.find((e) => !e.deleted_at && activeAt(e, now));
          Object.assign(values, {
            parent_id: edge?.parent_id ?? (edges.length ? null : row.parent_id),
          });
        }
        if (payload.table === "profiles") {
          const effective = await personAt(t, row, now);
          const supervisor = effective.supervisor_id
            ? await get(t, "profiles", effective.supervisor_id)
            : null;
          Object.assign(values, {
            role: effective.role,
            org_unit_id: effective.org_unit_id,
            position_id: effective.position_id,
            supervisor_subject: supervisor?.auth_subject,
          });
        }
        await update(t, payload.table, row.id, values);
        await platform.recordChange(t, {
          entity: "org.reference",
          entityId: row.id,
          scopeKey: "global",
          op: "upsert",
        });
      });
      await platform.publish("org");
      await platform.publish("outlets");
      await platform.publish("people");
    },
  );
}
