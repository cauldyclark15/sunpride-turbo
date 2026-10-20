import { tx } from "@sunpride/db/client";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { recordChange } from "../../core/sync.js";
import { bounded, DAY_MS, midnight, rebootstrap } from "./model.js";

/**
 * A manifest fence complements transactional SQL triggers. In particular a future
 * assignment may become current without a write after the phone's snapshot.
 * The fence is persisted in change_log BEFORE refusing the pull, so bootstrapping
 * elsewhere cannot accidentally make an older cursor valid again.
 * @param {import('../../core/sync.js').ProjectionCtx} ctx
 */
export async function checkDayManifest(ctx) {
  const changed = await tx(ctx.db, async (db) => {
    await db`select pg_advisory_xact_lock(hashtext(${`fieldsync-manifest:${ctx.actor.profileId}`}))`;
    const date = ctx.params.dayFrom;
    const at = new Date(ctx.now);
    const visits = bounded(
      await db`select pv.id,pv.change_seq,pv.outlet_id,pv.plan_id,cp.change_seq as plan_revision,
      s.change_seq as slot_revision from planned_visits pv join coverage_plans cp on cp.id=pv.plan_id join coverage_plan_slots s on s.id=pv.plan_slot_id
      where pv.assignee_profile_id=${ctx.actor.profileId} and pv.service_date>=${date}::date and pv.service_date<${date}::date+3
        and pv.status='planned' and pv.deleted_at is null and cp.status in ('approved','active') and cp.deleted_at is null
      order by pv.id limit 501`,
      500,
    );
    const person =
      await db`select id,change_seq from employee_assignments where profile_id=${ctx.actor.profileId} and deleted_at is null
      and effective_from<=${at} and (effective_to is null or effective_to>${at}) order by id limit 2`;
    const assignments = bounded(
      await db`select a.id,a.change_seq,own.id as owner_id,own.change_seq as owner_revision
      from outlet_assignments a left join territory_ownerships own on own.territory_id=a.territory_id and own.deleted_at is null
        and own.effective_from<=${at} and (own.effective_to is null or own.effective_to>${at})
      where a.outlet_id in (select outlet_id from planned_visits where assignee_profile_id=${ctx.actor.profileId}
        and service_date>=${date}::date and service_date<${date}::date+3 and status='planned' and deleted_at is null)
        and a.deleted_at is null and a.effective_from<=${at} and (a.effective_to is null or a.effective_to>${at}) order by a.id limit 501`,
      500,
    );
    const routes = bounded(
      await db`select id,change_seq from route_salespeople where profile_id=${ctx.actor.profileId} and deleted_at is null
      and effective_from<=${at} and (effective_to is null or effective_to>${at}) order by id limit 501`,
      500,
    );
    const territories = bounded(
      await db`select id,change_seq from territory_salespeople where profile_id=${ctx.actor.profileId} and deleted_at is null
      and effective_from<=${at} and (effective_to is null or effective_to>${at}) order by id limit 501`,
      500,
    );
    const tasks = bounded(
      await db`select id,change_seq from field_tasks where assignee_profile_id=${ctx.actor.profileId} and deleted_at is null and status='open'
      and effective_from<=${at} and (effective_to is null or effective_to>${at}) order by id limit 501`,
      500,
    );
    const pins = bounded(
      await db`select p.id,p.change_seq from outlet_pins p where p.deleted_at is null and p.status='verified'
      and p.effective_from<=${at} and (p.effective_to is null or p.effective_to>${at})
      and p.outlet_id in (select outlet_id from planned_visits where assignee_profile_id=${ctx.actor.profileId}
        and service_date>=${date}::date and service_date<${date}::date+3 and status='planned' and deleted_at is null) order by p.id limit 501`,
      500,
    );
    const assortments = bounded(
      await db`select a.id,a.change_seq from outlet_assortments a where a.deleted_at is null
      and a.effective_from<=${at} and (a.effective_to is null or a.effective_to>${at})
      and a.outlet_id in (select outlet_id from planned_visits where assignee_profile_id=${ctx.actor.profileId}
        and service_date>=${date}::date and service_date<${date}::date+3 and status='planned' and deleted_at is null) order by a.id limit 501`,
      500,
    );
    const prices = bounded(
      await db`select l.id,l.change_seq,p.id as list_id,p.change_seq as list_revision from price_list_lines l join price_lists p on p.id=l.price_list_id
      where l.deleted_at is null and p.deleted_at is null and p.status='active' and p.organization_id='sunpride'
        and l.effective_from<=${at} and (l.effective_to is null or l.effective_to>${at})
        and p.effective_from<=${at} and (p.effective_to is null or p.effective_to>${at}) order by l.id limit 5001`,
      5000,
    );
    const catalogue = bounded(
      await db`select id,product_id,revision from product_catalogue_versions where effective_from<=${at} and (effective_to is null or effective_to>${at}) order by id limit 10001`,
      10000,
    );
    const stamp = sha256Hex(
      canonicalJson({
        visits,
        catalogue,
        person,
        assignments,
        routes,
        territories,
        tasks,
        pins,
        assortments,
        prices,
        day: date,
      }),
    );
    const [prior] =
      await db`select stamp from fieldsync_day_manifests where profile_id=${ctx.actor.profileId} and service_date=${date}::date`;
    if (prior?.stamp === stamp) return false;
    await db`insert into fieldsync_day_manifests(profile_id,service_date,stamp) values (${ctx.actor.profileId},${date},${stamp})
      on conflict(profile_id,service_date) do update set stamp=excluded.stamp`;
    if (prior)
      await recordChange(db, {
        entity: "field.manifest",
        entityId: ctx.actor.profileId,
        scopeKey: `profile:${ctx.actor.profileId}`,
      });
    return Boolean(prior);
  });
  if (changed) throw rebootstrap();
}
