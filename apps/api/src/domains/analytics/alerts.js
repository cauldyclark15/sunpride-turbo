import { inputObject, uuidInput } from "./inputs.js";
import { tx } from "@sunpride/db/client";
import { actorFor } from "../../core/context.js";
import { ApiError } from "../../core/errors.js";
import { requireCapability } from "../../core/capabilities.js";
import { enqueue } from "../../core/jobs.js";
import { scopeFor, periodFor, dateOf } from "./measures.js";
import { readVisits, visitSummary } from "./data.js";
import { availabilityModel } from "./availability-adapter.js";
import { fraudPage } from "./context-adapter.js";
import {
  sendNotificationMail,
  notificationMailMode,
} from "../../core/notification-mail.js";

/** F-608 injectable mail adapter. Dev is a durable, idempotent local sink, NEVER a real send.
 * Production adapter must honor alertId as provider idempotency key.
 * @param {any} db @param {{alertId:string,to:string,subject:string,body:string}} message */
export async function devMailAdapter(db, message) {
  await db`insert into analytics_mail_sink(alert_id,recipient,subject,body) values(${message.alertId},${message.to},${message.subject},${message.body}) on conflict(alert_id) do nothing`;
}
/** Reconstruct current permissions and current metric for EVERY evaluation AND delivery.
 * @param {any} db @param {any} subscription @param {number} now */
async function currentBreach(db, subscription, now) {
  const [profile] =
    await db`select user_id,status from profiles where id=${subscription.profile_id} and deleted_at is null`;
  if (profile?.status !== "active" || !profile.user_id) return null;
  const [user] =
    await db`select disabled_at from users where id=${profile.user_id}`;
  if (!user || user.disabled_at) return null;
  const actor = await actorFor(db, profile.user_id);
  if (!actor) return null;
  const url = new URL("http://alerts.local");
  url.searchParams.set("unitId", subscription.org_unit_id);
  url.searchParams.set("from", dateOf(now));
  url.searchParams.set("to", dateOf(now));
  const ctx = { db, actor, url, now };
  let s;
  try {
    s = await scopeFor(ctx);
  } catch (error) {
    if (error instanceof ApiError && [401, 403].includes(error.status))
      return null;
    throw error;
  }
  const p = periodFor(ctx);
  let value;
  if (subscription.metric === "missed_stops")
    value = visitSummary(await readVisits(db, p, s)).missed;
  else if (subscription.metric === "availability_below")
    value = (await availabilityModel(db, p, s)).osa;
  else
    value = (await fraudPage(ctx, p, s)).rows.filter((/** @type {any} */ r) =>
      ["open", "reviewing"].includes(r.status),
    ).length;
  const breach =
    value !== null &&
    (subscription.metric === "availability_below"
      ? value < Number(subscription.threshold)
      : value > Number(subscription.threshold));
  return breach
    ? {
        value,
        title:
          subscription.metric === "missed_stops"
            ? "Planned calls need attention"
            : subscription.metric === "availability_below"
              ? "Shelf availability below threshold"
              : "Integrity signals need review",
        email: profile.user_id,
        scope: s.label,
      }
    : null;
}
/** @param {any} db @param {number} [now] @param {string|null} [profileId] */
export async function evaluateAlerts(db, now = Date.now(), profileId = null) {
  const subscriptions =
    await db`select id from analytics_alert_subscriptions where enabled and effective_from<=${new Date(now)} and (effective_to is null or effective_to>${new Date(now)}) and (${profileId}::uuid is null or profile_id=${profileId})`;
  let queued = 0;
  for (const entry of subscriptions)
    await tx(db, async (t) => {
      const [sub] =
        await t`select * from analytics_alert_subscriptions where id=${entry.id} for update`;
      if (
        !sub?.enabled ||
        (sub.last_triggered_at &&
          now - new Date(sub.last_triggered_at).getTime() <
            sub.cooldown_minutes * 60000)
      )
        return;
      const breach = await currentBreach(t, sub, now);
      if (!breach) return;
      const fingerprint = `${dateOf(now)}:${Math.floor(now / (sub.cooldown_minutes * 60000))}`;
      const [alert] =
        await t`insert into analytics_alert_instances(subscription_id,fingerprint,title,payload,status) values(${sub.id},${fingerprint},${breach.title},${{ metric: sub.metric, value: breach.value, scope: breach.scope }},'pending') on conflict(subscription_id,fingerprint) do nothing returning id`;
      if (!alert) return;
      await t`update analytics_alert_subscriptions set last_triggered_at=${new Date(now)},updated_at=now() where id=${sub.id}`;
      await enqueue(t, {
        kind: "analytics.alert-deliver",
        key: alert.id,
        payload: { id: alert.id },
      });
      queued++;
    });
  return { queued };
}
/** @param {any} db @param {string} id @param {typeof devMailAdapter} [mail] @param {number} [now] */
export async function deliverAlert(
  db,
  id,
  mail = devMailAdapter,
  now = Date.now(),
) {
  try {
    await tx(db, async (t) => {
      const [alert] =
        await t`select a.* from analytics_alert_instances a where a.id=${id} for update`;
      if (!alert || !["pending", "delivered"].includes(alert.status)) return;
      const [sub] =
        await t`select * from analytics_alert_subscriptions where id=${alert.subscription_id} for update`;
      // Serialize ordinary profile disablement with delivery's permission read.
      await t`select id from profiles where id=${sub.profile_id} for share`;
      const breach =
        sub.enabled &&
        new Date(sub.effective_from).getTime() <= now &&
        (!sub.effective_to || new Date(sub.effective_to).getTime() > now)
          ? await currentBreach(t, sub, now)
          : null;
      if (!breach) {
        await t`update analytics_alert_instances set status='suppressed',updated_at=now() where id=${id}`;
        await t`insert into analytics_alert_attempts(alert_id,channel,outcome) values(${id},'app','suppressed')`;
        return;
      }
      if (sub.email && !alert.email_at) {
        const [user] =
          await t`select u.email from users u join profiles p on p.user_id=u.id where p.id=${sub.profile_id} and u.disabled_at is null`;
        await mail(t, {
          alertId: id,
          to: user.email,
          subject: breach.title,
          body: "A subscribed threshold needs attention. Sign in and open Account notifications for current authorized details.",
        });
        await t`update analytics_alert_instances set email_at=now() where id=${id}`;
        await t`insert into analytics_alert_attempts(alert_id,channel,outcome) values(${id},'email','delivered')`;
      }
      if (sub.in_app && !alert.in_app_at) {
        await t`update analytics_alert_instances set in_app_at=now() where id=${id}`;
        await t`insert into analytics_alert_attempts(alert_id,channel,outcome) values(${id},'app','delivered')`;
      }
      await t`update analytics_alert_instances set status='delivered',payload=${{ metric: sub.metric, value: breach.value, scope: breach.scope }},updated_at=now() where id=${id}`;
    });
  } catch {
    await db`insert into analytics_alert_attempts(alert_id,channel,outcome) select id,'email','retry' from analytics_alert_instances where id=${id}`;
    throw new ApiError(
      "delivery_retry",
      503,
      "Alert delivery will retry.",
      true,
    );
  }
}
/** @param {any} router @param {any} installCtx @param {typeof devMailAdapter} [mail] */
export function installAlerts(router, installCtx, mail) {
  const send =
    mail ??
    (async (/** @type {any} */ db, /** @type {any} */ message) => {
      if (notificationMailMode(installCtx.env) === "dev_sink")
        await devMailAdapter(db, message);
      const [alert] =
        await db`select created_at from analytics_alert_instances where id=${message.alertId}`;
      await sendNotificationMail(
        db,
        {
          key: "alert:" + message.alertId,
          to: message.to,
          subject: message.subject,
          body: message.body,
          createdAt: +new Date(alert.created_at),
        },
        installCtx.env,
      );
    });
  installCtx.registerJob(
    "analytics.alert-deliver",
    async (/** @type {any} */ ctx) => {
      await deliverAlert(ctx.db, ctx.payload.id, send);
      await installCtx.publish("analytics");
    },
  );
  installCtx.scheduler.every(
    300000,
    "analytics.alert-evaluate",
    async (/** @type {any} */ ctx) => {
      await evaluateAlerts(ctx.db);
    },
  );
  router.post("/api/v1/alerts/subscribe", async (/** @type {any} */ ctx) => {
    const s = await scopeFor(ctx),
      b = inputObject(ctx.body);
    if (
      !s.ids.includes(b.unitId) ||
      !["missed_stops", "availability_below", "integrity_open"].includes(
        b.metric,
      ) ||
      !Number.isFinite(b.threshold) ||
      b.threshold < 0 ||
      !Number.isInteger(b.cooldownMinutes) ||
      b.cooldownMinutes < 1 ||
      b.cooldownMinutes > 10080 ||
      typeof b.inApp !== "boolean" ||
      typeof b.email !== "boolean" ||
      typeof b.enabled !== "boolean" ||
      (!b.inApp && !b.email)
    )
      throw new ApiError(
        "invalid_subscription",
        400,
        "Choose a team, metric, threshold and delivery channel.",
      );
    const result = await tx(ctx.db, async (db) => {
      const [row] =
        await db`insert into analytics_alert_subscriptions(profile_id,org_unit_id,metric,threshold,cooldown_minutes,in_app,email,enabled) values(${ctx.actor.profileId},${b.unitId},${b.metric},${b.threshold},${b.cooldownMinutes},${b.inApp},${b.email},${b.enabled}) on conflict(profile_id,org_unit_id,metric) do update set threshold=excluded.threshold,cooldown_minutes=excluded.cooldown_minutes,in_app=excluded.in_app,email=excluded.email,enabled=excluded.enabled,updated_at=now() returning id`;
      await db`insert into audit_logs(subject,action,entity_type,entity_id) values(${ctx.actor.subject},'analytics.subscription_set','alert_subscription',${row.id})`;
      return { id: row.id };
    });
    await installCtx.publish("analytics");
    return result;
  });
  router.get("/api/v1/alerts", async (/** @type {any} */ ctx) => {
    await scopeFor(ctx);
    const subscriptions =
      await ctx.db`select id,org_unit_id,metric,threshold,cooldown_minutes,in_app,email,enabled from analytics_alert_subscriptions where profile_id=${ctx.actor.profileId}`;
    const candidates =
      await ctx.db`select a.*,s.org_unit_id from analytics_alert_instances a join analytics_alert_subscriptions s on s.id=a.subscription_id where s.profile_id=${ctx.actor.profileId} and a.in_app_at is not null and a.status in ('delivered','acknowledged') order by a.created_at desc limit 100`;
    const rows = [];
    for (const candidate of candidates) {
      const [sub] =
        await ctx.db`select * from analytics_alert_subscriptions where id=${candidate.subscription_id}`;
      if (await currentBreach(ctx.db, sub, ctx.now))
        rows.push({
          id: candidate.id,
          title: candidate.title,
          payload: candidate.payload,
          read: !!candidate.read_at,
          status: candidate.status,
        });
    }
    return {
      rows,
      subscriptions,
      mailMode:
        notificationMailMode(ctx.env) === "dev_sink"
          ? "Development mail sink; no external email sent"
          : "Configured email provider; acceptance does not prove inbox delivery",
    };
  });
  router.post("/api/v1/alerts/read", async (/** @type {any} */ ctx) => {
    await scopeFor(ctx);
    const [row] = await tx(
      ctx.db,
      (db) =>
        db`update analytics_alert_instances a set read_at=now(),status='acknowledged',updated_at=now() from analytics_alert_subscriptions s where a.id=${uuidInput(inputObject(ctx.body).id)} and s.id=a.subscription_id and s.profile_id=${ctx.actor.profileId} returning a.id`,
    );
    if (!row) throw new ApiError("not_found", 404, "Alert not found.");
    return { ok: true };
  });
  router.post("/api/v1/alerts/evaluate", async (/** @type {any} */ ctx) => {
    await scopeFor(ctx);
    return evaluateAlerts(ctx.db, ctx.now, ctx.actor.profileId);
  });
  router.get("/api/v1/alerts/mail-sink", async (/** @type {any} */ ctx) => {
    await requireCapability(ctx, "admin.manage");
    const rows =
      await ctx.db`select m.subject,m.body,m.created_at from analytics_mail_sink m join analytics_alert_instances a on a.id=m.alert_id join analytics_alert_subscriptions s on s.id=a.subscription_id where s.profile_id=${ctx.actor.profileId} order by m.created_at desc limit 100`;
    return { rows, mode: "dev-sink" };
  });
}
