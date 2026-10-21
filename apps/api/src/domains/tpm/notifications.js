import { tx } from "@sunpride/db/client";
import { actorFor } from "../../core/context.js";
import { ApiError } from "../../core/errors.js";
import { enqueue } from "../../core/jobs.js";
import {
  sendNotificationMail,
  notificationMailMode,
} from "../../core/notification-mail.js";
import { partnerContext } from "../partners/boundary.js";
import { bindings, within } from "../mt/hierarchy.js";
import { portalAccess } from "../mt/portal.js";
import { office, bounded } from "./common.js";
import { claimApprovalBand } from "./claim-overrides.js";
import { seams } from "./seams.js";
import { uuid, fail } from "../orders/validation.js";

/** @param {unknown} error */
const denied = (error) =>
  error instanceof ApiError && [401, 403].includes(error.status);
/** F-507 uses the EXISTING claim value band and current independent national approver.
 * @param {any} db @param {any} r @param {string} profileId @param {number} now */
async function financeRecipient(db, r, profileId, now) {
  const [p] =
    await db`select user_id from profiles where id=${profileId} and status='active' and deleted_at is null`;
  const actor = p?.user_id ? await actorFor(db, p.user_id) : null;
  if (!actor || [r.created_by, r.last_material_by].includes(actor.subject))
    return null;
  const c = { db, actor, now };
  try {
    await office(c, "order.approve");
  } catch (error) {
    if (denied(error)) return null;
    throw error;
  }
  const rule = await claimApprovalBand(c, r);
  return rule ? { actor, rule } : null;
}
/** @param {any} db @param {string} noticeId */
export async function queueClaimMail(db, noticeId) {
  await enqueue(db, {
    kind: "tpm.claim-mail",
    key: noticeId,
    payload: { noticeId },
  });
}
/** Email needs current membership, not a signed-in browser. MT uses exactly the portal's hierarchy predicate.
 * @param {any} db @param {any} n @param {string} userId @param {number} now */
async function claimantRecipient(db, n, userId, now) {
  const [u] =
    await db`select id,email from users where id=${userId} and disabled_at is null`;
  if (!u) return null;
  if (n.party_type === "modern_trade") {
    const [m] =
      await db`select * from mt_portal_memberships where user_id=${userId} and effective_from<=${new Date(now)} and (effective_to is null or effective_to>${new Date(now)})`;
    if (!m) return null;
    const b = (await bindings(db, now)).find(
      (/** @type {any} */ row) => row.id === n.party_id,
    );
    return b && within(b, m.scope_kind, m.scope_key) ? u : null;
  }
  const actor = await actorFor(db, userId);
  if (!actor) return null;
  try {
    await seams.authorizeClaimant(
      { db, actor, user: u, now },
      n.party_type,
      n.party_id,
    );
    return u;
  } catch (error) {
    if (denied(error)) return null;
    throw error;
  }
}
/** Bounded pages keep a large recipient list off one transaction. Durable jobs resume the next page.
 * @param {any} db @param {string} noticeId @param {any} env @param {string|null} [after] */
export async function deliverClaimMail(db, noticeId, env, after = null) {
  const [n] =
    await db`select n.*,t.email_notifications from claim_notifications n join claims c on c.id=n.claim_id join claim_types t on t.id=c.type_id where n.id=${noticeId}`;
  if (!n?.email_notifications) return;
  const users =
    n.party_type === "modern_trade"
      ? await db`select distinct user_id from mt_portal_memberships where effective_from<=now() and (effective_to is null or effective_to>now()) and (${after}::uuid is null or user_id>${after}::uuid) order by user_id limit 100`
      : await db`select distinct p.user_id from distributor_users m join profiles p on p.id=m.profile_id where m.distributor_id::text=${n.party_id} and p.status='active' and p.deleted_at is null and p.user_id is not null and m.effective_from<=now() and (m.effective_to is null or m.effective_to>now()) and (${after}::uuid is null or p.user_id>${after}::uuid) order by p.user_id limit 100`;
  for (const entry of users)
    await tx(db, async (t) => {
      await t`select id from users where id=${entry.user_id} for share`;
      await t`select id from profiles where user_id=${entry.user_id} for share`;
      if (n.party_type === "modern_trade")
        await t`select id from mt_portal_memberships where user_id=${entry.user_id} for share`;
      else
        await t`select m.id from distributor_users m join profiles p on p.id=m.profile_id where p.user_id=${entry.user_id} for share of m`;
      const user = await claimantRecipient(t, n, entry.user_id, Date.now());
      if (!user) return;
      await sendNotificationMail(
        t,
        {
          key: `claim:${n.id}:${user.id}`,
          to: user.email,
          subject: "Your claim status was updated",
          body: "Your organization has a claim notice. Sign in to read its current authorized status. Settlement is final only after SAP acknowledgement.",
          createdAt: +new Date(n.created_at),
        },
        env,
      );
    });
  if (users.length === 100)
    await enqueue(db, {
      kind: "tpm.claim-mail",
      key: `${noticeId}:${users.at(-1).user_id}`,
      payload: { noticeId, after: users.at(-1).user_id },
    });
}
/** @param {any} db @param {number} [now] @param {string|null} [after] */
export async function evaluateClaimEscalations(
  db,
  now = Date.now(),
  after = null,
) {
  const claims =
    await db`select c.*,c.updated_at::text as source_version from claims c join claim_types t on t.id=c.type_id where c.status in ('submitted','needs_evidence','validated','approved') and c.updated_at<=${new Date(now)}::timestamptz-make_interval(hours=>t.escalation_hours) and (${after}::uuid is null or c.id>${after}::uuid) order by c.id limit 100`;
  const people = bounded(
    await db`select id from profiles where status='active' and deleted_at is null and role in ('super_admin','manager','approver') order by id limit 501`,
  );
  let queued = 0;
  for (const r of claims)
    for (const p of people) {
      const recipient = await financeRecipient(db, r, p.id, now);
      if (!recipient) continue;
      const [e] =
        await db`insert into claim_escalations(claim_id,profile_id,source_version,approval_rule_id,message)values(${r.id},${p.id},${r.source_version},${recipient.rule.id},'Claim needs Finance attention after the configured inactivity window.') on conflict do nothing returning id`;
      if (e) {
        await enqueue(db, {
          kind: "tpm.claim-escalation-mail",
          key: e.id,
          payload: { id: e.id },
        });
        queued++;
      }
    }
  if (claims.length === 100)
    await enqueue(db, {
      kind: "tpm.claim-escalate",
      key: "after:" + claims.at(-1).id,
      payload: { after: claims.at(-1).id },
    });
  return { queued };
}
/** @param {any} db @param {string} id @param {any} env */
export async function deliverEscalation(db, id, env) {
  await tx(db, async (t) => {
    const [e] =
      await t`select * from claim_escalations where id=${id} for update`;
    if (!e) return;
    const [r] =
      await t`select c.*,c.updated_at::text as source_version,t.email_notifications from claims c join claim_types t on t.id=c.type_id where c.id=${e.claim_id}`;
    if (
      !r ||
      !r.email_notifications ||
      r.source_version !== e.source_version ||
      !["submitted", "needs_evidence", "validated", "approved"].includes(
        r.status,
      )
    )
      return;
    await t`select p.id from profiles p join users u on u.id=p.user_id where p.id=${e.profile_id} for share of p,u`;
    const recipient = await financeRecipient(t, r, e.profile_id, Date.now());
    if (!recipient || recipient.rule.id !== e.approval_rule_id) return;
    const [u] =
      await t`select email from users where id=${recipient.actor.userId} and disabled_at is null`;
    if (!u) return;
    await sendNotificationMail(
      t,
      {
        key: `claim-escalation:${e.id}`,
        to: u.email,
        subject: "Claim approval needs attention",
        body: "A claim is waiting in the Finance queue. Sign in to review current authorized details. This notice is not a payment approval.",
        createdAt: +new Date(e.created_at),
      },
      env,
    );
  });
}
/** Current grants fence the inbox just as they fence each portal; retained notifications never grant access.
 * @param {any} c @returns {Promise<any[]>} */
export async function claimInbox(c) {
  if (!c.user)
    throw new ApiError("unauthenticated", 401, "Sign in to read notifications");
  const keys = [];
  let member = null;
  try {
    member = await partnerContext(c.db, c.actor);
  } catch (error) {
    if (!denied(error)) throw error;
  }
  if (member) {
    try {
      await seams.authorizeClaimant(
        c,
        member.partner_kind,
        member.distributor_id,
      );
      keys.push({ type: member.partner_kind, id: member.distributor_id });
    } catch (error) {
      if (!denied(error)) throw error;
    }
  }
  try {
    const p = await portalAccess(c);
    for (const b of p.allowed) keys.push({ type: "modern_trade", id: b.id });
  } catch (error) {
    if (!denied(error)) throw error;
  }
  const rows = [];
  if (keys.length) {
    const notes =
      await c.db`select n.*,r.reference from claim_notifications n join claims r on r.id=n.claim_id where exists(select 1 from jsonb_to_recordset(${keys}::jsonb) as k(type text,id text) where n.party_type=k.type and n.party_id=k.id) order by n.created_at desc limit 101`;
    for (const n of notes.slice(0, 100))
      rows.push({
        id: n.id,
        kind: "claim",
        title: "Company claim · " + n.reference,
        message: n.message,
        read: !!n.read_at,
        at: +new Date(n.created_at),
        href:
          n.party_type === "modern_trade"
            ? "/portal"
            : n.party_type === "agency"
              ? "/agencies"
              : "/distributor",
      });
  }
  if (c.actor) {
    const entries =
      await c.db`select e.*,r.reference,r.created_by,r.last_material_by,r.amount_centavos,r.claimant_party_type,r.updated_at::text as current_version from claim_escalations e join claims r on r.id=e.claim_id where e.profile_id=${c.actor.profileId} and e.source_version=r.updated_at::text and r.status in ('submitted','needs_evidence','validated','approved') order by e.created_at desc limit 101`;
    for (const e of entries.slice(0, 100)) {
      const recipient = await financeRecipient(
        c.db,
        e,
        c.actor.profileId,
        c.now,
      );
      if (recipient?.rule.id === e.approval_rule_id)
        rows.push({
          id: e.id,
          kind: "claim_escalation",
          title: "Finance follow-up · " + e.reference,
          message: e.message,
          read: !!e.read_at,
          at: +new Date(e.created_at),
          href: "/finance-claims",
        });
    }
  }
  return rows.sort((a, b) => b.at - a.at);
}
/** @param {any} router @param {any} ctx */
export function installClaimNotifications(router, ctx) {
  ctx.registerJob("tpm.claim-mail", async (/** @type {any} */ job) =>
    deliverClaimMail(job.db, job.payload.noticeId, ctx.env, job.payload.after),
  );
  ctx.registerJob("tpm.claim-escalation-mail", async (/** @type {any} */ job) =>
    deliverEscalation(job.db, job.payload.id, ctx.env),
  );
  ctx.registerJob("tpm.claim-escalate", async (/** @type {any} */ job) => {
    await evaluateClaimEscalations(job.db, Date.now(), job.payload.after);
    await ctx.publish("tpm");
  });
  ctx.scheduler.every(
    900000,
    "tpm.claim-escalations",
    async (/** @type {any} */ job) => {
      await enqueue(job.db, {
        kind: "tpm.claim-escalate",
        key: "sweep",
        payload: {},
      });
    },
  );
  for (const base of [
    "/api/v1/account/claim-notices",
    "/api/v1/partners/notifications",
  ]) {
    router.get(base, async (/** @type {any} */ c) => ({
      rows: await claimInbox(c),
      mailMode: notificationMailMode(c.env),
      limitNote:
        "Latest 100 company notices and Finance follow-ups; full case history remains in the relevant workspace.",
    }));
    router.post(base + "/read", async (/** @type {any} */ c) => {
      const id = uuid(c.body?.id),
        kind = c.body?.kind,
        row = (await claimInbox(c)).find((n) => n.id === id && n.kind === kind);
      if (!row) fail("This notification is no longer available");
      if (kind === "claim")
        await c.db`update claim_notifications set read_at=coalesce(read_at,now()),updated_at=now() where id=${id}`;
      else
        await c.db`update claim_escalations set read_at=coalesce(read_at,now()) where id=${id} and profile_id=${c.actor.profileId}`;
      return { id, read: true };
    });
  }
  router.post(
    "/api/v1/tpm/claims/escalations/evaluate",
    async (/** @type {any} */ c) => {
      await office(c, "order.approve");
      return evaluateClaimEscalations(c.db, c.now);
    },
  );
}
