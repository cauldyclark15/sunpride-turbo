# ADR-020: Company-device registration, replacement and revocation

Status: accepted (2026-09-25, JC lead) — provisional items marked inline

## Context

ADR-010 makes native iOS/Android field and Android van POS clients of the Convex mobile gateway. The blueprint recommends registration, device binding and OS secure credential storage (§§39–40), plus scope enforcement, revocation and audit (§79). ADR-003 permits only a single active device for a rolling-truck route; an offline device cannot receive instant server revocation.

## Decision

Only Sunpride-authorized, managed company devices may receive production mobile credentials or offline data. **Recommended minimum, provisional pending client device fleet confirmation:** iOS/iPadOS 17+ for field apps; Android 12 (API 31)+ for field and van POS, with Google security updates available and hardware-backed Android Keystore preferred. Pilot must test the actual fleet, printer SDK and OS support before procurement. Block rooted/jailbroken or unsupported devices from new registration and refresh; MDM enrollment and enforced full-disk encryption/screen lock are pilot prerequisites.

An administrator registers an inventory-tagged device to one employee and allowed app (`IOS`, `ANDROID`, `VAN_ANDROID`); capture model, OS/app versions, organizational scope, public key/attestation where available, registered/last-seen timestamps, and status `ACTIVE`, `SUSPENDED` or `REVOKED`. An employee signs in online through the existing invitation/identity authority; the server binds a fresh device-generated non-exportable key to that account, validates role/capabilities and org scope (ADR-005, ADR-009), and issues short-lived, device-bound credentials. A device ID is not authorization by itself. Bootstrap and every push/pull recheck user, device status, scope, assigned route, and credential binding server-side. Never embed SAP credentials or long-lived shared secrets in the app. Blueprint §§35–40, 79.

Store refresh credentials/key references in iOS Keychain (`ThisDeviceOnly`, after first unlock) or Android hardware-backed Keystore with encrypted app storage; keep access tokens in memory, rotate refresh tokens and invalidate their family on compromise. Encrypt local database and queued evidence with a per-install key protected by the platform secure store; exclude credentials and operational cache from cloud backup. MDM-managed wipe is preferred; application wipe is best effort only. Do not log tokens or sensitive pricing.

**Offline authorization:** after an online check, keep a signed, scope- and device-bound 24-hour offline lease (engineering default, provisional pending client security approval). The app can unlock cached work until the earlier of lease expiry or ADR-019's cache expiry. Server still revalidates every upload; an offline stolen device cannot be instantly disabled by remote action. Require reauthentication online after lease expiry, employment/assignment changes or suspicious device state. A clock rollback cannot extend the lease: compare wall clock with persisted monotonic elapsed time and fail closed if integrity cannot be established.

**Replacement:** on a working device, first sync and reconcile all outbox entries and POS route/cash/stock; close the route online, revoke old binding, register and bootstrap the replacement, then assign/open the replacement route. Never copy its local database, tokens or sequence counter. If an old device is broken but recoverable, quarantine it, recover and upload its signed outbox under supervised one-time recovery authorization before revocation; do not bypass idempotency or route ordering. A route cannot be active on both devices or transfer an unsynced sequence silently (ADR-003).

**Loss/theft or employee departure:** immediately suspend identity/device in admin console, revoke refresh tokens and device key binding, flag route as frozen, alert supervisor/security, ask MDM to lock/wipe and record an incident. This blocks all server reads and uploads from that device; on next app contact, purge local tokens/cache after preserving only a supervised recovery path if physically controlled. MDM wipe may never arrive while offline. Reconcilers compare server-acknowledged sales, cash, receipt numbers and physical truck stock against paper/crew records; supervisor opens a replacement route only after resolving or explicitly documenting the missing sequence. Unsynced records on an unrecovered lost device are **not** present in Convex and cannot be assumed recovered; use independently evidenced, idempotent supervisor reconstruction/stock-count adjustment, not replay fiction. Local data on a returned device may be extracted under custody before wiping; don't delete the only copy of disputed unsynced evidence.

## Consequences

- Add device registry, enrollment approval, device-key verification, lease enforcement, scoped bootstrap, session rotation, revoke/suspend UI, audit and MDM incident runbook (`CVX-018`–`CVX-021` and platform workstreams). The current POS `deviceId`/route assignment alone is not a registered-device trust boundary.
- Test stolen/offline behavior, expired lease and clock rollback, token replay, replacement with pending outbox, rejected old-device push, and route sequence recovery. Audit enrollment, assignment, suspension, revocation, wipe request and recovery decisions (blueprint §50).

## Open questions

- Sunpride must confirm managed-device ownership, actual iOS/Android/printer fleet and MDM, minimum patch policy, security owner, offline lease duration, and legal incident/data-retention handling. These are new questions beyond Client questions 1–12.
