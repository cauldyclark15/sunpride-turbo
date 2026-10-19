import { tx } from "@sunpride/db/client";
import { writeAudit } from "./audit.js";
import {
  personAt,
  rootUnitId,
  scopeFilterForActor,
  topology,
} from "./scope.js";
import { dto, insert, ORGANIZATION } from "./model.js";

export const ORG_LOCK = 7343001;
/** @typedef {import('@sunpride/db/client').Db} Db */
/** @typedef {import('./model.js').Row} Row */
/** @param {Db} db */
export async function ensureRoot(db) {
  for (const [i, c] of ["NATIONAL", "REGION", "AREA", "TERRITORY"].entries())
    await db`insert into org_unit_types(organization_id,code,label,level,active) values ('sunpride',${c},${c[0] + c.slice(1).toLowerCase()},${i + 1},true) on conflict(organization_id,code) do nothing`;
  const [root] =
    await db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values ('sunpride','SUNPRIDE','Sunpride','NATIONAL','active',now()) on conflict(organization_id,code) do update set code=excluded.code returning id`;
  return /** @type {string} */ (root.id);
}

/** @param {Record<string,string|undefined>} env */
export function identityHooks(env) {
  const bootstrap = new Set(
    (env.BOOTSTRAP_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return {
    /** @param {Db} db @param {string} email */
    async isEmailInvited(db, email) {
      const rows =
        await db`select id from access_invitations where lower(email)=${email.trim().toLowerCase()} and status='pending' limit 1`;
      return bootstrap.has(email.trim().toLowerCase()) || rows.length > 0;
    },
    /** @param {Db} db @param {string} userId @returns {Promise<import('../../core/hooks.js').HookProfile|null>} */
    async loadProfile(db, userId) {
      return tx(db, async (t) => {
        await t`select pg_advisory_xact_lock(${ORG_LOCK})`;
        const [user] =
          await t`select id,email,disabled_at from users where id=${userId}`;
        if (!user || user.disabled_at) return null;
        const email = String(user.email).toLowerCase();
        let [person] =
          await t`select * from profiles where user_id=${userId} or lower(email)=${email} order by (user_id=${userId}) desc limit 1`;
        // Disabled is durable: merely revisiting /me must not restore access.
        if (
          person &&
          (person.status !== "active" ||
            person.deleted_at ||
            (person.user_id && person.user_id !== userId))
        )
          return null;
        const [invitation] =
          await t`select * from access_invitations where lower(email)=${email} order by invited_at desc,id desc limit 1`;
        if (!person) {
          const isBootstrap = bootstrap.has(email);
          if (!isBootstrap && invitation?.status !== "pending") return null;
          const role = isBootstrap
            ? "super_admin"
            : invitation.role === "super_admin"
              ? "viewer"
              : invitation.role;
          const orgUnitId = isBootstrap
            ? await ensureRoot(t)
            : (invitation.org_unit_id ?? null);
          person = await insert(t, "profiles", {
            user_id: userId,
            auth_subject: userId,
            email,
            name: invitation?.name || email,
            role,
            status: "active",
            org_unit_id: orgUnitId,
            position_id: invitation?.position_id ?? null,
            effective_from: new Date(),
          });
          await insert(t, "employee_assignments", {
            profile_id: person.id,
            org_unit_id: orgUnitId,
            role,
            position_id: person.position_id,
            effective_from: person.effective_from,
            actor_subject: userId,
            reason: "provisioned",
          });
          if (invitation)
            await t`update access_invitations set status='accepted',accepted_at=now(),profile_id=${person.id} where id=${invitation.id}`;
          await writeAudit(t, {
            subject: userId,
            action: "profile.provisioned",
            entityType: "profile",
            entityId: person.id,
            details: role,
          });
        } else {
          if (invitation?.status === "revoked") return null;
          if (!person.user_id) {
            await t`update profiles set user_id=${userId},auth_subject=${userId} where id=${person.id}`;
            person = { ...person, user_id: userId, auth_subject: userId };
          }
          if (
            bootstrap.has(email) &&
            person.role === "super_admin" &&
            !person.org_unit_id
          ) {
            const root = await ensureRoot(t);
            await t`update profiles set org_unit_id=${root},scope_epoch=scope_epoch+1 where id=${person.id}`;
            const assignments =
              await t`select id from employee_assignments where profile_id=${person.id}`;
            if (!assignments.length)
              await insert(t, "employee_assignments", {
                profile_id: person.id,
                org_unit_id: root,
                role: "super_admin",
                effective_from: new Date(),
                actor_subject: userId,
                reason: "bootstrap root assignment",
              });
            else
              await t`update employee_assignments set org_unit_id=${root} where profile_id=${person.id} and org_unit_id is null and effective_to is null`;
            person.org_unit_id = root;
          }
        }
        person = await personAt(t, person);
        const tree = await topology(t);
        const treeEpoch = new Bun.CryptoHasher("sha256")
          .update(
            JSON.stringify(
              tree
                .map((u) => [u.id, u.parent_id])
                .sort((a, b) => a[0].localeCompare(b[0])),
            ),
          )
          .digest("hex");
        return {
          id: person.id,
          userId,
          name: person.name,
          role: person.role,
          orgUnitId: person.org_unit_id,
          status: person.status,
          scopeEpoch: `${person.scope_epoch}:${treeEpoch}`,
        };
      });
    },
    /** @param {Db} db @param {import('../../core/context.js').Actor} actor @param {string} unitId */
    async unitInScope(db, actor, unitId) {
      const { unitIds } = await scopeFilterForActor(db, actor);
      return unitIds === null || unitIds.includes(unitId);
    },
    /** @param {Db} db @param {import('../../core/context.js').Actor} actor */
    async scopeUnitIds(db, actor) {
      const { unitIds } = await scopeFilterForActor(db, actor);
      if (unitIds !== null) return unitIds;
      /** @type {Row[]} */ const units =
        await db`select id from org_units where organization_id=${ORGANIZATION} and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now())`;
      return units.map((u) => u.id);
    },
    rootUnitId,
  };
}

/** @param {Db} db @param {string} userId */
export async function profileDto(db, userId) {
  const [person] = await db`select * from profiles where user_id=${userId}`;
  return person ? dto(await personAt(db, person)) : null;
}
