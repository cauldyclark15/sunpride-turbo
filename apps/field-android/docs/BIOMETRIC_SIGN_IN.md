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
- **Next launch.** The system prompt opens the app (Android 11+ also accepts the phone's PIN/pattern).
  Cancel goes to the password screen, which keeps a "Use fingerprint or face" button. Opening works offline:
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

| Piece                                                | Role                                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth/BiometricSession.kt` `LockableSessionVault`    | The app's session vault. Reads the unlocked session from process memory first, else the ordinary Keystore copy (feature off).                                                               |
| `auth/AndroidBiometricCrypto.kt` `BiometricKeystore` | AES-256-GCM Keystore key: `setUserAuthenticationRequired(true)`, `setInvalidatedByBiometricEnrollment(true)`, per-use auth (Android 11+: strong biometric or screen lock).                  |
| `AndroidBiometricCrypto`                             | AndroidX `BiometricPrompt` with a `CryptoObject`; the cipher only works inside the authenticated prompt. Android 10 (minSdk 29) offers strong biometric only, with a "Use password" button. |
| `PrefsSealedTokenStore`                              | IV + ciphertext of the session token (`field_biometric_session` prefs; backups and device transfer are excluded).                                                                           |
| `ui/BiometricGate.kt`                                | Launch gate + settings state machine (OPEN / LOCKED / PASSWORD, offer, enable, disable, invalidated).                                                                                       |
| `FieldApp(biometrics = …)`                           | Starts `FieldController` only after the gate opens; lock screen, offer dialog, Account switch.                                                                                              |

The password is never stored. With the feature on, the Better Auth session token exists on disk only
under the biometric key; after the prompt it lives in this process's memory and is exchanged for the
short-lived Convex JWT exactly as before.

Unchanged on purpose: device registration, held-outbox and purge rules, the local encrypted database (its own
key), and the server. Background sync workers share the same in-process vault, so they keep sending while
the app is unlocked; after Android kills the app they see no session and do nothing (they never wipe or hold
data for it) until the person opens the app again, which schedules them.

## Tests

- JVM: `app/src/test/.../auth/BiometricSignInTest.kt` (state machine and vault).
- Phone (`~/.hermes/scripts/sunpride-android-phone-test.sh <worktree>`):
  `BiometricSignInUiTest` (the real `FieldApp` with the prompt seam: eye toggle and re-hide on leaving,
  offer → on → Account off, Not now, locked launch → Today, cancel → password → retry, prompt stuck →
  password, invalidated message) and `BiometricKeystoreTest` (the real key refuses without the prompt; the
  real system prompt appears, is captured to
  `/sdcard/Android/data/com.sunpride.field.dev/files/biometric-prompt.png`, and the test cancels it).
- Not automated: a real finger on the sensor. Check by hand: sign in, Turn on, close the app from
  Recents, open it, touch the sensor → Today.
