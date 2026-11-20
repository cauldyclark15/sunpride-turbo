# People invitation email (SP-0206)

## Office check

1. In Setup > People > Add person, enter the person's correct email, role, position and branch, then Save.
2. The result distinguishes email acceptance, a failed send, and email sending being turned off. The person's access invitation is saved even if sending fails.
3. For a person added earlier, open Setup > People > Invited, find the correct email and choose Resend email. Wait one minute between attempts. Resend does not change their email, role or branch, and is available only while the invitation is waiting.
4. Ask the person to check Inbox and Spam. New users follow Create account on the website and choose their own password; existing users sign in with their existing password.
5. Salespeople and sales managers also receive the same Google Play and backup Drive links shown under Share the Field app. Google Play tester membership is separate from Sunpride access. The backup instructions say to install over the old app, never uninstall it first.

A provider accepting an email is not proof of inbox delivery or a successful phone installation. Resend cannot grant Google Play tester membership. Do not delete/re-add a person just to send the same instructions again.

## Integration requirements

- Apply `0834_people_invitation_email.sql` with the documented database migrator before starting the changed API. This is additive; existing invitations default to `not_sent`. Applying it sends no email.
- The API uses the existing sign-in email configuration: `AUTH_EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, optional `AUTH_EMAIL_FROM`, and `PUBLIC_WEB_URL`. The tracked Kubernetes manifest already declares the provider, sender and public site. No notification-alert configuration is enabled by this change.
- Local checks use `AUTH_EMAIL_PROVIDER=dev_sink` or the test sender. Local preview is never displayed as a real send. No credential values belong in reports or commands saved to files.
- `people/invite` now returns `{ invitationId, emailState }`; the internal invitation writer and stored command receipt still retain the invitation ID. The new `people/resend-invitation` returns the same delivery shape.
- Invitations send only after the access transaction commits. Email attempts are serialized per invitation, not under the organization-wide lock. Request-key replays do not email twice. Explicit resends are limited to once per minute and recheck national administrator access and protected roles.
- Sender failures are recorded without recording the email body. Old pending invitations need an explicit Resend email; there is no bulk or automatic historical mailout.

## Verification boundary

The lane regression exercises real HTTP handlers and disposable PostgreSQL databases, but captures the email transport. It covers a corrected email, registration and invitation acceptance, request replay, failure/retry, simultaneous resends, older invitations, permission refusals, and local/missing-provider configuration. It does not contact Rogie, verify his inbox, change his live record or Google Play access, or install an app on a phone.
