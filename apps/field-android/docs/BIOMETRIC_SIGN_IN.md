# Fingerprint/face sign-in and show/hide password (SP-0128)

Android field app only (`apps/field-android`).

## What the person sees

- **Password eye.** The password field has an eye button: hidden by default, tap to show, tap again to
  hide. Its accessible label reads "Show password" / "Hide password". The password is held only while the
  Sign in screen is on screen: it is never logged or saved, it hides again when the app goes to the
  background, and it is cleared and hidden after Sign in or when the screen is left.
- **Offer.** After a normal email + password sign-in, on a phone with a strong fingerprint/face enrolled,
  the app asks once: "Use fingerprint or face to sign in next time?" (Turn on / Not now). Turn on shows the
  system prompt once.
- **Next launch.** The system prompt opens the app with a fingerprint or face only (no phone PIN/pattern;
  its "Use password" button is the way out). Cancel or Use password goes to the password screen, which keeps a "Use fingerprint or face" button. Opening works offline:
  the saved day, customers and unsent work are on the phone; anything that talks to the server still needs
  the session to be valid.
- **Changed fingerprints.** If a fingerprint or face is added (or all removed), Android destroys the key. The
  app says "Fingerprints or face on this phone changed. Sign in with your password, then turn fingerprint
  sign-in on again in Account." and shows the password screen.
- **Too many tries.** "Too many tries. Sign in with your password." The fingerprint sign-in stays on.
- **Account → Sign-in.** A switch turns it on or off. Off moves the session back to the ordinary store with
  no prompt; on asks for the prompt once.
- **Sign out** deletes the session, the sealed copy and the biometric key.

## How it works

| Piece                                                | Role                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth/BiometricSession.kt` `LockableSessionVault`    | The app's session vault. Reads the unlocked session from process memory first, else the ordinary Keystore copy (feature off).                                                                                                              |
| `auth/AndroidBiometricCrypto.kt` `BiometricKeystore` | AES-256-GCM Keystore key: `setUserAuthenticationRequired(true)`, `setInvalidatedByBiometricEnrollment(true)`, per-use auth, strong biometric only (alias `-v2`; the first build's `-v1` key, which also took the screen lock, is deleted). |
| `AndroidBiometricCrypto`                             | AndroidX `BiometricPrompt` with a `CryptoObject`; the cipher only works inside the authenticated prompt. Strong biometric only on every Android version, with a "Use password" button.                                                     |
| `PrefsSealedTokenStore`                              | IV + ciphertext of the session token (`field_biometric_session` prefs; backups and device transfer are excluded).                                                                                                                          |
| `ui/BiometricGate.kt`                                | Launch gate + settings state machine (OPEN / LOCKED / PASSWORD, offer, enable, disable, invalidated).                                                                                                                                      |
| `FieldApp(biometrics = …)`                           | Starts `FieldController` only after the gate opens; lock screen, offer dialog, Account switch.                                                                                                                                             |

Why no screen-lock fallback: Android exempts keys that also accept the screen lock (`AUTH_DEVICE_CREDENTIAL`)
from `setInvalidatedByBiometricEnrollment`, so such a key would survive a newly added fingerprint. A
biometric-only key is destroyed by Android on any enrollment change; the fallback is the password.
A phone that still has a session sealed by the old `-v1` key gets the "changed" message and the password
screen once, then turns the feature on again.

The password is never stored. With the feature on, the Better Auth session token exists on disk only
under the biometric key; after the prompt it lives in this process's memory and is exchanged for the
short-lived Convex JWT exactly as before.

Late prompts and storage failures (release check):

- Every change to the stored session (password sign-in, sign-out, a dead session wiped by a background
  worker, turning the feature on or off) bumps a process-wide session epoch. A prompt that started before
  the change cannot unlock or seal anything when it finishes: a late unlock never restores the old account
  after sign-out or over a new password sign-in, and a late "turn on" never seals the previous account
  (nor deletes the newer session's key). The gate also retires its pending prompt on sign-in, sign-out and
  turning the feature off.
- While a sealed session exists, the ordinary copy is never read, even if removing it failed: a leftover
  copy cannot reopen the app without the prompt after a restart.
- Session and sealed-copy writes/removals check the storage commit and fail loudly instead of passing
  silently. Turning on writes and verifies the sealed copy before removing the ordinary one; turning off
  saves and verifies the ordinary copy before removing the sealed one.
- The sealed store is only emptied after the ordinary copy is verifiably gone. On sign-out, a changed-
  fingerprints fallback, or turning the feature off while still locked, the ordinary copy is removed first;
  if that removal fails, a durable "signed out" marker is written in the sealed store instead, so the kept
  copy is never read again (the app opens on the sign-in screen, never the old account, even after a
  restart). A password sign-in saves the new session first and only then removes the old sealed session or
  marker; if that removal fails, the new copy is rolled back and the sign-in fails with a clear message.

Unchanged on purpose: device registration, held-outbox and purge rules, the local encrypted database (its own
key), and the server. Background sync workers share the same in-process vault, so they keep sending while
the app is unlocked; after Android kills the app they see no session and do nothing (they never wipe or hold
data for it) until the person opens the app again, which schedules them.

## Tests

- JVM: `app/src/test/.../auth/BiometricSignInTest.kt` (state machine and vault, including late
  unlock/enable after sign-in, sign-out and a worker wipe, and failed storage removals),
  `BiometricReviewCounterexamples` (the release check's four probes, verbatim),
  `independent/review/IndependentBiometricPersistenceTest` (the second release check's 12 probes, verbatim:
  production vault/gate/AuthClient over preference files that refuse writes while old data stays readable)
  and `BiometricKeyConfigTest`
  (key and prompt accept strong biometric only, never the screen lock).
- Phone (`~/.hermes/scripts/sunpride-android-phone-test.sh <worktree>`):
  `BiometricSignInUiTest` (the real `FieldApp` with the prompt seam: eye toggle and re-hide on leaving,
  offer → on → Account off, Not now, locked launch → Today, cancel → password → retry, prompt stuck →
  password, invalidated message) and `BiometricKeystoreTest` (the real key's `KeyInfo`: auth required, enrollment-invalidated, auth type strong
  biometric only, per-use; the retired screen-lock key is removed; the real key refuses without the prompt; the
  real system prompt appears, is captured to
  `/sdcard/Android/data/com.sunpride.field.dev/files/biometric-prompt.png`, and the test cancels it).
- Not automated: a real finger on the sensor. Check by hand: sign in, Turn on, close the app from
  Recents, open it, touch the sensor → Today.
