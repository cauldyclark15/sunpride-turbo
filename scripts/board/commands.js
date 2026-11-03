import { tx } from "../../packages/db/src/client.js";
import {
  capabilitiesFor,
  requireCapability,
} from "../../apps/api/src/core/capabilities.js";
import { forbidden } from "../../apps/api/src/core/errors.js";
import { publish } from "../../apps/api/src/core/realtime.js";
import { recordChange } from "../../apps/api/src/core/sync.js";
import * as S from "../../apps/api/src/domains/issues/service.js";
import { HERMES_EMAIL, HERMES_NAME, readBoard } from "./read.js";

/** Called under the HTTP board lock. Never reactivate a disabled system identity.
 * @param {import('../../packages/db/src/client.js').Db} db
 * @returns {Promise<S.Actor>} */
async function hermes(db) {
  // Bun.password.verify(_, '') is always false (unlike an invalid nonempty hash,
  // which throws). No password or recoverable secret is generated or stored.
  await db`insert into users(email,password_hash) values(${HERMES_EMAIL},'') on conflict(email) do nothing`;
  const [user] =
    await db`select * from users where email=${HERMES_EMAIL} for update`;
  if (user.disabled_at || user.password_hash !== "")
    throw forbidden("Hermes identity is disabled or is not a system account");
  await db`insert into profiles(user_id,auth_subject,name,email,role,status)
    values(${user.id},${user.id},${HERMES_NAME},${HERMES_EMAIL},'super_admin','active')
    on conflict(user_id) do nothing`;
  const [profile] =
    await db`select * from profiles where user_id=${user.id} for update`;
  if (
    profile.status !== "active" ||
    profile.deleted_at ||
    profile.role !== "super_admin"
  )
    throw forbidden("Hermes requires an active super administrator profile");
  return {
    userId: user.id,
    profileId: profile.id,
    role: profile.role,
    orgUnitId: profile.org_unit_id,
    name: profile.name,
    subject: user.id,
    scopeEpoch: profile.scope_epoch ?? null,
    capabilities: new Set(capabilitiesFor(profile.role)),
  };
}

/** The HTTP command wrapper is private to issues/index.js. Keep its transaction,
 * board lock, fresh capability check, service calls, sync change and post-commit
 * publication here rather than modifying the domain. --ref replay is provided by
 * createIssue under that same lock; CLI commands have no HTTP idempotency-key flag.
 * @param {import('../../packages/db/src/client.js').Db} db
 * @param {ReturnType<import('./args.js').parseCommand>} input
 * @param {Record<string,string|undefined>} [env] */
export async function runBoard(db, input, env = process.env) {
  const write = ["create", "move", "comment"].includes(input.command);
  const result = await tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(hashtext('sunpride:issues'))`;
    const actor = await hermes(t);
    await requireCapability(
      { db: t, actor },
      write
        ? input.command === "comment"
          ? "issues.write"
          : "issues.triage"
        : "issues.read",
    );
    if (!write) return { output: await readBoard(t, input, env), number: null };
    const v = input.values;
    let output;
    let issueId;
    let number;
    let changed = true;
    if (input.command === "create") {
      const created = await S.createIssue(
        t,
        {
          title: v.title,
          area: v.area,
          priority: v.priority,
          description: v.description,
          steps: v.steps,
          expected: v.expected,
          actual: v.actual,
          externalRef: v.ref,
          milestone: v.milestone,
          status: v.status ?? "draft",
        },
        actor,
      );
      ({ issueId, number } = created);
      changed = created.created;
      output = {
        key: created.key,
        number,
        ...(changed ? {} : { existing: true }),
      };
    } else if (input.command === "move") {
      const issue = await S.findIssue(t, input.key);
      issueId = issue.id;
      number = issue.number;
      const moved = await S.moveIssue(t, issue, { status: v.status }, actor);
      changed = moved.changed;
      // A same-status move is a genuine no-op, including its optional comment.
      if (changed && S.text(v.comment))
        await S.addComment(t, { issueId, body: v.comment }, actor);
      output = { key: input.key, from: issue.status, to: v.status };
    } else {
      const added = await S.addComment(
        t,
        { number: input.key, body: v.body },
        actor,
      );
      ({ issueId, number } = added);
      output = { key: added.key, comment_id: added.commentId };
    }
    // recordChange is last, matching the HTTP path's lock ordering.
    if (changed)
      await recordChange(t, {
        entity: "issue",
        entityId: issueId,
        scopeKey: "issues",
        op: "upsert",
      });
    return { output, number };
  });
  // Re-publishing a replay also repairs an earlier lost post-commit notification.
  if (write) {
    await publish(db, "issues");
    await publish(db, `issue:${result.number}`);
  }
  return result.output;
}
