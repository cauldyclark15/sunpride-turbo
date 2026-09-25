# ADR-004: Native Android field and POS platform; PWA retired

Status: accepted. The iOS clause is superseded by ADR-010 (native field apps on iOS and Android).

## Decision

- The field-sales PWA (`apps/pwa`) is cancelled. No further feature work is accepted there.
- Outsales POS is a native Android application installed on handheld devices with an attached printer. Receipt printing targets the handheld's integrated or attached printer.
- Field execution is Android-first. iOS is deferred until a business owner requires it; the iOS workstream stays unscoped until then.
- The web management app (`apps/web`) remains the only browser surface and stays the home of coverage planning, approvals, imports, administration, and analytics.
- Convex remains the sole operational authority (ADR-003). Native applications are clients, never systems of record, and reach Convex only through the mobile gateway.

## Consequences

- The tracker's `ARCH-024` and `QSR-023` change from "define retirement" to "remove `apps/pwa`" once the Android application reaches pilot acceptance. Until then the PWA is frozen, not deleted.
- The offline outbox, sequencing, and conflict policy in ADR-002 survives as the specification for the Android offline engine (`AND-005`–`AND-008`), not as reusable code.
- Printer work starts with the generic ESC/POS adapter (`VAN-015`) because the hardware is a handheld with an attached Bluetooth or integrated printer. The vendor/embedded adapter (`VAN-016`) waits on the hardware decision (`ARCH-022`).
- Contracts in `packages/integration-contracts` gain a Kotlin consumer (`SFD-011`); no Swift consumer is required while iOS is deferred.
- Existing PWA-only behaviour (IndexedDB projection, service worker caching) is not migrated. Field capability gaps that appear while the PWA is frozen are handled by the web app or by the Android application, not by reopening the PWA.
