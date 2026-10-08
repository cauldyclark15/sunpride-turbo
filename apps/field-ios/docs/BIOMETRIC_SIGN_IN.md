# Face ID / Touch ID sign-in (SP-0133)

iOS field app only (`apps/field-ios`). Mirrors the Android fingerprint/face sign-in (SP-0128,
`apps/field-android/docs/BIOMETRIC_SIGN_IN.md`); Android is unchanged.

## What the person sees

- **Offer.** After a normal email + password sign-in, on a phone with Face ID (or Touch ID) set up, the
  app asks: "Use Face ID to sign in next time?" (Not now / Turn on). Turn on shows the system Face ID
  prompt once. The first time, iOS also asks permission using `NSFaceIDUsageDescription`.
- **Next launch.** The app opens on "Unlock with Face ID to open today's work." and shows the system prompt
  straight away. The prompt has no passcode fallback; its "Use password" button (and the screen's own
  "Use password") is the way out. Cancel goes to the password screen, which keeps a "Use Face ID" button.
  Opening works offline: the saved day, customers and unsent work are on the phone; anything that talks to
  the server still needs the session to be valid.
- **Changed Face ID.** If a face or finger is added (or Face ID is turned off), iOS makes the protected
  item unreadable. The app says "Face ID on this phone changed. Sign in with your password, then turn
  Face ID sign-in on again in Account." and shows the password screen.
- **Too many tries.** "Too many tries. Sign in with your password." Face ID sign-in stays on.
- **Account → Sign-in.** A switch turns it on or off. Off moves the session back to the ordinary Keychain
  item with no prompt; on asks for the prompt once. Shown only when Face ID / Touch ID is set up (or the
  feature is already on).
- **Sign out** deletes the session, the protected item and its lock record. So does a session the server
  refuses (401/403 on the Convex token exchange).

## How it works

| Piece                                                | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Auth/BiometricSession.swift` `LockableSessionStore` | The app's `SecretStore`. Every account passes through except the Better Auth session: it reads the unlocked in-memory session first; while the lock record `auth.session.lock` exists the ordinary copy is never read.                                                                                                                                                                                                                                                                     |
| `Auth/KeychainBiometricCrypto.swift`                 | `LAContext` prompt (`.deviceOwnerAuthenticationWithBiometrics`, empty fallback title, cancel = "Use password") and the Keychain item `auth.betterAuthSession.biometric` with `SecAccessControl(.biometryCurrentSet)` + `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, never synchronized. The evaluated context is passed as `kSecUseAuthenticationContext`, so there is one prompt. The domain-state hash saved at turn-on is compared at unlock to report a changed enrollment plainly. |
| `App/BiometricGate.swift`                            | Launch gate + settings state machine (open / locked / password, offer, enable, disable, invalidated).                                                                                                                                                                                                                                                                                                                                                                                      |
| `AppModel.launch(interactive:)`                      | Opens a locked session with the prompt before the normal launch. The background refresh calls it with `interactive: false`: it never prompts and does nothing while locked. When the app comes to the foreground still locked, it prompts then.                                                                                                                                                                                                                                            |

Why `.biometryCurrentSet` and no passcode fallback: the Android release check rejected a key that also
accepts the screen lock, because such a key survives a newly enrolled fingerprint. `.biometryCurrentSet`
items become unreadable when the enrolled set changes; the fallback is the password.

The password is never stored. With the feature on, the Better Auth session token is on disk only in the
biometry-protected item; after the prompt it lives in this process's memory and is exchanged for the
short-lived Convex JWT exactly as before.

Late prompts and storage failures (same rules as Android's release checks):

- Every change to the stored session (password sign-in, sign-out, a refused session, on/off) bumps a
  process-wide session epoch, and the gate retires its pending prompt on sign-in, sign-out and turn-off. A
  prompt that started before the change cannot unlock or seal anything: a late unlock never restores the old
  account after sign-out or another sign-in, and a late "turn on" never writes the previous account's token.
- While the lock record exists the ordinary copy is never read, even if removing it failed.
- Turning on writes the protected item, then writes and verifies the lock record, then removes the ordinary
  copy. Turning off saves and verifies the ordinary copy before removing the lock record.
- On sign-out, a changed enrollment or turning off while locked, the ordinary copy is removed first; if that
  fails, a durable "signed-out" lock record is written instead so the kept copy is never read again. A
  password sign-in saves the new session first and then removes the lock record; if that removal fails the
  new copy is rolled back and sign-in reports a storage error.
- An unreadable lock record counts as locked (fail closed).

Unchanged on purpose: device registration, held-outbox and purge rules, the encrypted local database (its
own Keychain key), and the server.

## Tests

- Unit (`FieldIOSTests/BiometricSignInTests.swift`): offer and password never stored; turn on → relaunch
  locked → prompt → JWT exchange with the opened session; cancel → password → retry; changed enrollment
  (from the item and from the prompt); lockout and failure; background launch never prompts; toggle off
  (unlocked and locked); sign-out and a 401-refused session clear everything; late unlock after another
  sign-in and after sign-out; late success for the same session after "Use password"; late turn-on after
  another sign-in; turn-on write/lock failures; sign-out whose ordinary removal fails; password sign-in whose
  lock removal fails; unreadable lock record; LAError mapping; AppModel wiring.
- Device (`BiometricKeychainDeviceTests`, skipped on the simulator): the real item's protection class is
  `WhenUnlockedThisDeviceOnly`, it carries access control, is not synchronized, and cannot be read without
  the prompt (`errSecInteractionNotAllowed`).
- UI (`testFaceIDOfferLockCancelChangedAndAccountToggle`, light and dark, DEBUG stub prompt
  `FIELD_STUB_BIOMETRIC=available|slow|cancel|changed`): offer → on → Account switch on, locked screen
  (buttons inside the safe area) → Today, cancel → password with "Use Face ID", changed → message, password
  sign-in → on → switch off → next launch opens without a prompt. `testRealFaceIDPromptOnPhone`
  (`FIELD_STUB_BIOMETRIC=real`) shows the real system prompt on the iPhone and captures it.
- Not automated: a real face. Check by hand: sign in, Turn on, close the app from the app switcher, open
  it, look at the phone → Today. Add a face in Settings (Alternate Appearance) → the app asks for the
  password.
