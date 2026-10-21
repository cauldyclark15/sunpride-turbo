# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

One product with surfaces on two platforms: the office website (`apps/web`) and its installable phone version (`apps/pwa`) are `web`; the field sales app (`apps/field-android`) and the van POS (`apps/van-sales-android`) are native `android`. iPhone (`apps/field-ios`) is paused. Design each surface in its own platform's language.

## Users

- **Owner and sales managers** (office website, desktop and phone): check sales against target, which areas and people are behind, stores buying or gone quiet, stock, cash and collections, and the exceptions that need a decision today.
- **Supervisors**: plan routes, ride along with agents (Work-With), approve new stores and exceptions.
- **Field agents, pre-sellers and merchandisers** (Android sales app on cheap phones; the Redmi A7 Pro is the reference device): run a planned day of store visits, often with weak or no signal.
- **Van sellers** (Senraise H10P handheld POS with printer and scanner): load the truck, sell and collect on the route, handle returns, count cash and close the trip. The same device can be set to run as a **retail store till** (shift open/close, scan-sell, X/Z reports).
- **Office roles**: approvers, operations, analysts and viewers.
- **Distributors and partners**: their own portal for ordering, secondary sales and claims.

## Product Purpose

The Sunpride sales system runs Sunpride Foods' route-to-market: field visits, orders, van selling, collections, trade promotions, distributors and modern trade, with an owner cockpit on top. Success means every sale, visit and peso is captured on the device in the field (even offline), reaches the office the same day, and lets the owner see and act on what is behind.

## Positioning

One call-flow engine for every channel: new channels (pre-sell, merchandising, distributor reps, retail store) are configurations of the same visit flow and the same van app, never separate apps. Local-first phones sync to the office, and SAP stays the system of record.

## Operating Context

- Client: Sunpride Foods, a Philippine meat processor. Contact Loren; Sir Francis on the business side.
- Scope authority: the client's Phase 1 spec (146 features, waves W0–W6 plus Track R; the Excel mapping is the primary reference). The spec wins where it contrasts with what we built; our extras (live map, owner cockpit, Decide queue, phone version of the office site) stay as bonus features.
- Field reality: Cebu routes, cheap Android phones, battery saver, weak signal; offline must be proven on a real route with the SIM removed.
- SAP is the system of record for pricing, credit, inventory value and posting; a stand-in SAP is used until Sunpride gives test access.
- Hosted at sunpride.cauldnclark.com; guides at docs.cauldnclark.com.

## Capabilities and Constraints

- Postgres with pgvector, a Bun API, SQLite on the phones with sync, a Next.js office site.
- Money in ₱, quantities in cases plus pieces. No raw IDs on screen.
- Every cockpit number shows target, prior period, trend, drill-down and next action; exceptions first; Excel export.
- Sign-in is by typed password; biometrics are optional, never required.
- Unused features are hidden, not deleted.
- **Undecided, waiting on Sunpride:** SAP test access, BIR permit and invoice series, must-stock lists, outlet classes, payment types, cold-chain ranges, cash tolerances, sign-in provider, device plan, real targets. Until then screens use clearly marked sample values.

## Brand Commitments

- Name: Sunpride. Website: https://www.sunpride.net. Logo: https://api.heroui.pro/api/theme-assets/22fb8e47-c685-4491-92bb-69a6d6b671ea/4347d2ab-1e90-44c9-b00d-e4043fd32b7f.jpg
- Voice: clear, confident, warm and practical. Plain language, sentence case, short action labels, reassuring confirmations. Professional without sounding bureaucratic or technical.
- Existing design record: `packages/ui/docs/DESIGN.md` (HeroUI-based `@sunpride/ui`).

## Evidence on Hand

- Client spec: the Phase 1 delivery-approach PDF and the feature mapping workbook (146 features).
- Demo data is synthetic (a small sample company, marked "Sample") and is deleted before Sunpride's own testing. There are no real customers, testimonials or figures yet; never present sample numbers as Sunpride's.

## Product Principles

- The field comes first: a visit, sale or count must never be lost, and offline, syncing, synced and failed states are always unmistakable.
- Owners act, they don't browse: lead with what is behind and what to do next.
- One engine, many channels: extend the call flow by configuration, never fork an app.
- The client's spec is the scope; bonus features stay, but never at the spec's expense.
- Built for cheap phones and one hand: fast, light and readable in sunlight.

## Accessibility & Inclusion

WCAG AA contrast; never rely on colour alone for status; keyboard-accessible office screens; large touch targets and one-handed use on the phones.
