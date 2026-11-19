import { tx } from "@sunpride/db/client";
import { actorFor } from "../../core/context.js";
import { requireNationalScope } from "../../core/capabilities.js";
import { publicWebUrl, sendAuthMailResult } from "../../core/auth-email.js";
import { ApiError } from "../../core/errors.js";
import { uuid } from "./model.js";
import { writeAudit } from "./audit.js";

// Same download destinations as Setup > People > Share the Field app. The backup
// does not depend on Google Play tester membership; inviting here cannot grant that membership.
export const FIELD_PLAY_URL =
  "https://play.google.com/apps/internaltest/4701513704454726563";
export const FIELD_BACKUP_URL =
  "https://drive.google.com/drive/folders/181uAAjyMxw08WoDKSGaumrTPPZvQA282";

/** @param {{ email: string, name?: string|null, role: string }} person
 * @param {string} webUrl @param {boolean} hasLogin */
export function invitationMail(person, webUrl, hasLogin) {
  return {
    subject: "Your Sunpride invitation and app instructions",
    text: [
      `Hello${person.name ? ` ${person.name}` : ""},`,
      "",
      "Your administrator has added you to Sunpride.",
      `Use this email address: ${person.email}`,
      "",
      hasLogin
        ? `1. Sign in at ${webUrl}/login with your existing password. If you forgot it, choose Forgot password.`
        : `1. Open ${webUrl}/login, choose Create account, and use this email address with a password of at least 8 characters.`,
      ...(person.role === "sales" || person.role === "manager"
        ? [
            "",
            "2. On your Android phone, open the Field app link:",
            FIELD_PLAY_URL,
            "Use the same Gmail in Google Play, accept the invitation, then download the app.",
            "Google Play testing access is separate from your Sunpride account. If Google Play says you do not have access, use this backup:",
            FIELD_BACKUP_URL,
            "Download the app file and install it over the old app. Never uninstall first, so any work on the phone stays safe.",
            "",
            "3. Open Sunpride Field and sign in with the same email address and password. If your area or phone still needs approval, ask your administrator.",
          ]
        : [
            "",
            "2. Sign in on the website with the same email address and password.",
          ]),
      "",
      "If you were not expecting this invitation, contact your administrator.",
      "",
      "Sunpride Support",
    ].join("\n"),
  };
}

/** SP-0206: called only AFTER the invitation command commits. Serialize attempts
 * per invitation, not under the organization-wide lock. Replays do not send twice;
 * an office user can explicitly resend an old pending invitation after one minute.
 * @param {import('../../core/context.js').Ctx} c @param {string} invitationId
 * @param {boolean} [resend]
 */
export async function sendInvitation(c, invitationId, resend = false) {
  const id = uuid(invitationId);
  return tx(c.db, async (t) => {
    const actor = c.user ? await actorFor(t, c.user.id) : null;
    await requireNationalScope({ ...c, db: t, actor }, ["admin"]);
    const [invitation] =
      await t`select * from access_invitations where id=${id} for update`;
    if (!invitation)
      throw new ApiError("not_found", 404, "Invitation not found.");
    if (
      invitation.role === "super_admin" ||
      (invitation.role === "admin" && actor?.role !== "super_admin")
    )
      throw new ApiError("forbidden", 403, "You cannot send this invitation.");
    if (
      invitation.status === "revoked" ||
      (resend && invitation.status !== "pending")
    )
      throw new ApiError(
        "invitation_unavailable",
        422,
        "Only a waiting invitation can be sent again.",
      );
    if (!resend && invitation.email_state !== "not_sent")
      return { invitationId: id, emailState: invitation.email_state };
    if (
      resend &&
      invitation.email_attempted_at &&
      Date.now() - new Date(invitation.email_attempted_at).getTime() < 60_000
    )
      throw new ApiError(
        "rate_limited",
        429,
        "Please wait one minute before sending this invitation again.",
      );
    const [login] =
      await t`select id from users where email=${invitation.email} and disabled_at is null`;
    const emailState = await sendAuthMailResult(t, c.env, {
      to: invitation.email,
      kind: "invitation",
      ...invitationMail(invitation, publicWebUrl(c.env), !!login),
    });
    await t`update access_invitations set email_state=${emailState},email_attempted_at=now() where id=${id}`;
    await writeAudit(t, {
      subject: actor?.subject,
      action: resend ? "people.invitation.resend" : "people.invitation.email",
      entityType: "people",
      entityId: id,
      details: `Invitation email ${emailState}`,
    });
    return { invitationId: id, emailState };
  });
}
