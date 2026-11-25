# Office phone controls (SP-0249)

## Where to go

Admins and Operations can open Setup > Phones, find a phone and choose View phone.
Admins can also open Phone controls or Sign out all phones from a person's row in Setup > People.
The phone panel also offers Sign out all phones, so Operations do not need access to other people settings.

The panel shows the person, app, model, app version, last check-in, sign-in status,
unsent count and registration state. Counts describe the phone's last report, not a live inspection.
Older apps may show Not reported yet rather than an invented zero.

## What each control does

- Sign out phone: stops the current sign-in. The app returns to Sign in when it next checks.
  Encrypted unsent work stays on the phone. The same person must sign in and verify the same phone
  and assignment again before eligible work can send. Work held for review is not silently resubmitted.
- Refresh phone: downloads the authorized settings and lists again without signing out.
- Send unsent work now: retries sending eligible waiting work. Items refused or held for review
  still need attention; Done means the retry request was carried out, not that every item was accepted.
- Register / Replace phone: accepts a waiting phone and turns off older phones for the same person
  and app. The other app is not removed. Nothing on the old phone is erased.
- Remove phone: turns off that registration. This is not ordinary sign-out, and signing in again
  does not undo removal. Keep the old phone and reconcile any unsent work before recapturing it.
- Auto-accept: accepts this person's next new phone without a separate office approval and replaces
  their older phone for that app. Turning it off does not remove phones already accepted.
  The existing rule that the system owner's phones are always accepted remains in effect.
- Ask to update: shows Please update the app. Field uses its Google Play download route;
  Van opens its existing signed-update controls. Neither control installs silently or erases work.
- Sign out all phones: ends this person's phone sign-ins, including waiting phones, but not website sign-ins.

Every action asks for confirmation and records who requested it. Phone actions show Waiting for the phone
until confirmed, then Done at the confirmation time. The request-sent notice is not a completion;
read the individual Phone requests history entry for its current state. Office registration and preference changes are recorded
when saved. Do not treat an offline phone or a disconnected phone as having completed a request.

## Connection and app state

Updated Android apps use an independent foreground service for office requests, starting after a visible
launch/sign-in (or Field biometric unlock). It checks immediately and every minute when Android lets it
run, including when the sales screen is in the background or its activity is destroyed. It does not depend
on unsent items, a started work day, an active trip or location permission. Reconnecting also wakes a check;
Check again, registration checks and ordinary sync retain their own immediate command checks.

The phone shows **Phone controls running** with an ongoing, quiet notification. Tapping it opens the app.
The service shares the same process-owned backend/repository as the visible app, so a background sign-out
or update request is reflected on screen without another command poll. Signing out stops ordinary checks;
an unconfirmed terminal receipt keeps only its restricted acknowledgement retry alive. No saved work is
erased. Ordinary upload retry scheduling remains separate.

This is the owner-selected background-support behavior, not a promise to bypass Android restrictions:
- No signal leaves the office request waiting. Battery saver/Doze, OEM process suspension, force-stop or
  Android's Stop control can delay/prevent checks. A failed or slow request is retried, never marked Done
  merely because a service started. A long refresh can take longer than a minute to finish.
- Reopen the app after force-stop, restart or an OS-refused service start. A sticky restart is requested
  after ordinary process reclamation, but Android decides whether/when it happens.
- A biometric-sealed Field session is not unlocked in the background after process death. Open the app
  and unlock or sign in; no alternate plaintext/background sign-in credential is created.
- Android notification permission/channel settings control where the ongoing notice appears. When
  notifications are denied, Android can still list the service in its active-app controls.

The service declares `specialUse` with an explicit office-control subtype, not location or `dataSync`.
It adds no exact alarms, wake locks, boot receiver, location grant or battery exemption. The publisher must
include the special-use explanation in the Google Play foreground-service declaration when distributing
a new Field build; these lane checks do not establish Play approval or installed-device behavior.

References:
- https://developer.android.com/develop/background-work/services/fgs/service-types#special-use
- https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
- https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping

Older installed apps need the new Android build for refresh, resend, update prompts and completion reporting.
Their existing authentication checks still refuse a sign-in ended by the office.

iPhone Field work is on hold. Retained source is not evidence of an installed or verified iPhone feature.

## Small acceptance check after publication

Use an owned sample person with one Field phone and one Van phone, not a client's working phone.
This checklist is preparation, not a claim that a physical phone has been tested.

1. Compare the displayed model, version and unsent count with each app. Disconnect one phone.
2. Request Refresh and Send unsent work now. Confirm the disconnected phone stays Waiting.
   Reconnect and use Check again; verify the lists update and eligible queued work is retried.
3. Queue one unsent item, then Sign out phone. Confirm Sign in appears and the item survives.
   Sign in as the same person, verify registration and confirm eligible work can send.
4. Ask to update and check the prompt and download route in both apps.
5. Register a replacement for one app. Verify the old phone is refused but the other app still works.
6. Toggle auto-accept on, sign in on a new owned test installation, then turn it off and check that
   a subsequent new installation waits. Do not reset an owner's real installation for this check.
7. Use Sign out all phones. Both phone sessions must end; the person's website sign-in must remain.
8. Compare the office actor and completion times in each phone's history.
9. Leave each signed-in app with no waiting uploads, then put it in the background. Verify the ongoing
   Phone controls running notice and ask for an update from the office without reopening the sales screen.
   Record request/check-in/completion times and confirm the prompt appears on return. Repeat with sign-out
   and one retained unsent item; sign back in as the same person and reconcile that item.
10. In an authorized installed-app lifecycle test, destroy/recreate just the activity, not the process or
    service. Confirm checks continue and the reopened screen reflects the completed action. Run a separate
    ordinary process-reclamation/sticky-restart check; do not confuse it with force-stop.
11. Check signal loss/reconnect, battery saver/Doze and Android Stop/force-stop separately. Stopped or
    suspended checks must stay Waiting, never acquire a made-up Done time. Reopen to resume. Verify a
    cold biometric-protected Field session waits for its normal unlock rather than bypassing it.

## Implementation and lane verification notes

The command channel accepts only the exact person/app/key of the session. Ended sessions can only
collect or acknowledge terminal requests explicitly assigned to them; they cannot recover business access.
Android stores unconfirmed terminal receipts in a separate Keystore-encrypted vault, retries after restart
or a lost acknowledgement, and never applies an old receipt to a newer sign-in. A completion retry cannot
replace the last known unsent count with zero after the local partition is detached.

Migration: packages/db/migrations/0851_phone_commands.sql. Local PostgreSQL tests can use
SP_TEST_TEMPLATE_DB=sunpride_lane_sp249 after the owner has prepared extensions in this lane database;
the harness rejects other database names and still creates and removes only its disposable lane databases.

## Releasable scope and held work

The inherited WIP commit on this branch contains four `apps/field-ios` changes. They are held work, not
part of the web/Android delivery. The lane's instruction to preserve existing commits and not edit iOS
means that replaying the entire branch is not a safe handoff. Do not remove or re-apply those changes
without the integration owner's explicit direction.

A review-only patch may be prepared from the recorded base to the lane tip with `apps/field-ios/**`
excluded. Verify it against that exact base in a separate Git index, check that all non-iOS source matches
the tested tip and that the four held paths still match the base, and record both revisions and the patch
checksum. This does not change the lane branch, publish anything or complete background acceptance.
The integration owner must choose that filtered handoff or explicitly authorize stripping the held changes
from the branch before replaying it. Never treat the original commit range as equivalent to the filtered patch.

Publication and physical checks are not performed by this lane. The earlier local signed-in sample-browser
check, if referenced in a handoff, used a simulated phone and is not production or installed-phone proof.
