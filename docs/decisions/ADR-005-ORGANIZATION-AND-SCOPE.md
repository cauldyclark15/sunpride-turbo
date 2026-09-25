# ADR-005: Organization units, employees, and organizational scope

Status: accepted. The seeded level names and the profile-as-employee shortcut are recommended defaults; a superseding ADR replaces them if Sunpride's real hierarchy differs.

## Decision

- Organizational structure is **data, not code**. `orgUnitTypes` holds the levels (`code`, `label`, `level`, `active`) and `orgUnits` holds the actual units (`code`, `name`, `typeCode`, `parentId`, `effectiveFrom`, `effectiveTo`, `status`). No level name such as Region, Area, or Territory is ever written into application code. Deployment seeds the four levels National → Region → Area → Territory and one root unit; Sunpride may rename or add levels without a release.
- **One tenant.** `SUNPRIDE_ORGANIZATION_ID = "sunpride"` remains the only organization identifier. The tracker's `ARCH-009` problem is a configurable hierarchy, not multi-tenancy; multi-company remains deferred.
- **The profile is the employee record.** `profiles` gains optional `orgUnitId`, `employeeCode`, `supervisorSubject`, and `effectiveFrom`. A separate `employees` table is introduced only when HR or payroll data appears, at which point `CVX-004` splits it.
- **Scope is enforced server-side and never widened by client input.** `requireScopedRole` derives the identity and profile from `ctx.auth`, resolves the profile's unit and its descendants through `orgUnits.parentId`, and refuses any target outside that subtree. A client-supplied unit, role, or territory can never grant access (`CVX-023`, `QSR-006`).
- **Existing gates are untouched.** The flat `requireRole` checks stay in place; new endpoints use `requireScopedRole`. Endpoints migrate when their domain is next modified, so this ADR introduces no behavioural change to current inventory, order, or admin functions.

## Consequences

- Assignment conflicts must be validated on effective dates: one employee holds one org unit and one supervisor at a time, with history preserved rather than overwritten (`CVX-004`).
- Teams (`CVX-004`), territory polygons (`CVX-005`), and location-scoped inventory access are explicitly **not** covered here; scope currently governs master data, imports, and new SFA endpoints only.
- Every new query that returns scoped data must filter by the caller's subtree; returning national data to a scoped user is a defect, not a configuration choice.
- Provisioning assigns the national root only to the bootstrap super admin; other invited roles have no unit until an administrator explicitly assigns one, and scoped access refuses them until then.
- Imports of national product and opening-stock data require national scope (super admin or an active root-scoped importer), not a caller-selected target unit; import history follows the same boundary.
