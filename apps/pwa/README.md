# Sunpride Field PWA

> **Frozen.** The field PWA is cancelled (ADR-004). No feature work is accepted here; native Android field and van-sales applications replace it. This app stays in the repository as the reference implementation of the offline outbox, sequencing, and conflict policy (ADR-002) until the Android application reaches pilot acceptance, after which it is removed (`QSR-023`).

React + Vite + TypeScript field application with Better Auth, Convex realtime data, Dexie IndexedDB persistence, a transactional outbox, explicit synchronization/conflict states, and a generated service worker.

Run from the repository root with `bun run dev:pwa`. Production output is `dist/`.
