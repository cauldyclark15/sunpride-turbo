# Convex domain modules (CVX-002)

## Boundary and delivery sequence

New SFA domains live in their own folders directly under `packages/backend/convex/`, as `imports/` and `sfa/` do today. Do not add functions to the general `domains/salesForce.ts` file or create another catch-all `salesForce/` folder. Split public functions, internal functions, and helpers within the owning folder as needed; Convex's file-based API makes `convex/visits/queries.ts` export `list` as `api.visits.queries.list`. Preserve existing API references until callers are migrated and tested. Existing `domains/*.ts` modules are not moved merely for consistency.

| Folder(s)                   | First delivery group and responsibility                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org/`, `people/`, `teams/` | 03 — org hierarchy, employees/positions, team assignment and access                                                                                                 |
| `territories/`, `outlets/`  | 04 — territories/routes/beats and outlet operational profiles; customer accounting master follows in 11                                                             |
| `coverage/`                 | 05 — MCP, assignments and planned-visit generation; views/tools follow in 06                                                                                        |
| `visits/`, `mobile/`        | 07 — visit execution/activity/evidence and device/bootstrap/delta/push sync; planned visits originate in 05                                                         |
| `orders/`                   | 09 — offline field-order capture contract; SAP posting/reconciliation follows in 11. Migrate the existing `domains/orders.ts` API deliberately, not by renaming it. |
| `deliverables/`             | 10 — supervision, coaching forms, DAR/ROAR, DSR and per-diem outputs                                                                                                |
| `vanSales/`                 | 13 — vehicles, trips, loads and truck-stock authority; checkout follows in 14 and close/SAP in 15                                                                   |
| `analytics/`                | 17 — rollups, dashboards, merchandising and suggested orders                                                                                                        |

Follow [the delivery sequence](../../../docs/delivery/SFA_DELIVERY_SEQUENCE.md) for issue-level ordering; the folder is created when its first backend function lands, not as an empty placeholder. Keep organizational hierarchy as data, not level-name literals (ADR-005); positions are data distinct from app roles and org scope (ADR-009).

## Files, gates and tests

- Convex module filenames use only letters, digits, underscores and periods: `test_helpers.ts`, never `test-helpers.ts`. Keep `*.test.ts` beside the module under `convex/`; deployed files must never import test files, `convex-test`, or helpers that import test setup. Non-test files are bundled on deploy.
- Declare `args` and `returns` validators for each public query/mutation/action (and `args` for internal functions). Use `schema.doc("tableName")` from `convex/schema.ts` when returning or accepting a whole document instead of hand-copying its fields; use `paginationResultValidator` for paginated results.
- Gate every new public endpoint server-side: use `requireCapability(ctx, capability, targetUnitId?)` for SFA permission plus scope, `requireScopedRole(ctx, allowed, targetUnitId)` where role-based authorization is appropriate, or `requireNationalScope(ctx, allowed)` for national data. Never rely on a client-selected unit to widen access; omitting `targetUnitId` from `requireScopedRole` checks only the role, not scope. Retain legacy gates until their domains are modified.
- Colocate behavior/authorization tests as `*.test.ts`, using `convexTest(schema, modules)` with the module map from `convex/test.setup.ts`; test allowed and denied roles, out-of-subtree access, and API compatibility. See `imports/*.test.ts` and `sfa/setup.test.ts`.

## Legacy retirement

`domains/salesForce.ts` is frozen at its sole legacy `myVisits` query over `visits`. Do not extend it. Delete it only when `visits/` replaces `api.domains.salesForce.myVisits`, migrates its callers, and verifies the replacement behavior (including authorization and ordering). Current callers in `apps/pwa` and `apps/web`: **none found** (`api.domains.salesForce`, `salesForce`, and `myVisits` searches). Recheck those two apps before deletion; their absence alone does not establish that other consumers are absent.
