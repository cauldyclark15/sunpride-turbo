import { ApiError } from "../../core/errors.js";
import { ORG_LOCK } from "./identity.js";

/** Resolve every People row, including invitations without a login. The caller owns the transaction.
 * @param {any} t @param {{ userId?: string, profileId?: string, invitationId?: string }} target
 * @param {string} subject
 */
export async function passwordResetTarget(t, target, subject) {
  // Serialize linking/provisioning with first sign-in and other People changes.
  await t`select pg_advisory_xact_lock(${ORG_LOCK})`;
  const missing = () =>
    new ApiError("not_found", 404, "This person was not found.");
  let invitation;
  let person;
  if (target.invitationId) {
    [invitation] =
      await t`select * from access_invitations where id=${target.invitationId} for update`;
    if (!invitation) throw missing();
    [person] =
      await t`select * from profiles where id=${invitation.profile_id} or lower(email)=lower(${invitation.email}) limit 1 for update`;
  } else if (target.profileId) {
    [person] =
      await t`select * from profiles where id=${target.profileId} for update`;
    if (!person) throw missing();
  } else {
    [person] =
      await t`select * from profiles where user_id=${target.userId} for update`;
  }
  if (person?.deleted_at) throw missing();
  if (!person && invitation) {
    // A revoked invitation remains disabled; issuing credentials never restores access.
    [person] =
      await t`insert into profiles(name,email,role,status,org_unit_id,position_id,effective_from)
      values (${invitation.name || invitation.email},${invitation.email},${invitation.role},
        ${invitation.status === "revoked" ? "disabled" : "active"},${invitation.org_unit_id},${invitation.position_id},now()) returning *`;
    await t`insert into employee_assignments(profile_id,org_unit_id,role,position_id,effective_from,actor_subject,reason)
      values (${person.id},${person.org_unit_id},${person.role},${person.position_id},${person.effective_from},${subject},'Password reset account setup')`;
  }
  const linkedUserId = person?.user_id ?? target.userId;
  let user;
  if (linkedUserId) {
    [user] =
      await t`select id,email,disabled_at from users where id=${linkedUserId} for update`;
  } else if (person) {
    // A concurrent sign-up may already have created the user. Reuse it, never a second identity.
    await t`insert into users(email,password_hash,disabled_at)
      values (${String(person.email).trim().toLowerCase()},'!password-reset-pending',${person.status === "disabled" ? new Date() : null})
      on conflict(email) do nothing`;
    [user] =
      await t`select id,email,disabled_at from users where email=${String(person.email).trim().toLowerCase()} for update`;
  }
  if (!user) throw missing();
  if (person && !person.user_id) {
    const [other] =
      await t`select id from profiles where user_id=${user.id} and id<>${person.id}`;
    if (other) throw missing();
    await t`update profiles set user_id=${user.id},auth_subject=${user.id} where id=${person.id}`;
    await t`update access_invitations set status='accepted',accepted_at=now(),profile_id=${person.id}
      where lower(email)=lower(${person.email}) and status='pending'`;
    await t`update profiles p set supervisor_subject=${user.id}
      from employee_assignments a
      where a.profile_id=p.id and a.supervisor_id=${person.id} and a.deleted_at is null
        and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())
        and p.supervisor_subject is distinct from ${user.id}`;
    await t`insert into audit_logs(subject,action,entity_type,entity_id,details)
      values (${subject},'auth.login_created_by_admin','profile',${person.id},'Password reset account setup')`;
  }
  return {
    ...user,
    orgUnitId: person?.org_unit_id ?? null,
    accessDisabled: Boolean(user.disabled_at || person?.status === "disabled"),
  };
}
