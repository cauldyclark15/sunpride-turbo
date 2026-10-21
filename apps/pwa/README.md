# Retired field pilot

This React/Vite package now displays a retirement notice instead of opening the old field routes. Use the Android field/van apps for selling and the installable office app in `apps/web` for management.

The old IndexedDB database and its tests remain so existing unsent evidence is not silently erased. The notice does not sign in, create orders, upload old operations, or clear browser storage. Recovery requires supervised reconciliation before recapture. The retired routes were Today, new order, order queue, truck stock, catalog, sync, sign-in and registration.

No backend configuration is needed. `bun run typecheck`, `bun run test`, `bun run lint` and `bun run build` still verify this package. The active office service worker belongs to `apps/web` and is unchanged.
