# Role/scope authorization matrix test (QSR-006)

Tracker: SP-0022 / QSR-006, milestone 12 · Field sales pilot (Cebu). Acceptance: attempt cross-region, cross-team and privilege-escalation access on web, mobile and backend; every unauthorized read or write must fail server-side.

The decision baseline is `docs/architecture/RBAC_SCOPE_MATRIX.md` (ADR-005, ADR-009). The web app and both native field apps hold no authority of their own: every screen reads and writes through public Convex functions or the mobile HTTP gateway, so the server-side tests below are the authorization proof for all three clients. Hiding a web navigation item is presentation only (`apps/web/src/lib/module-access.ts`).

## How to run

```bash
cd packages/backend
bunx vitest run convex/acceptance/authorization_sweep.test.ts convex/lib/capabilities.matrix.test.ts
```

Both run inside `bun run test`; neither touches a deployment.

## 1. Capability matrix at five organizational levels

`packages/backend/convex/lib/capabilities.matrix.test.ts`

- Restates the documented role × capability grant table independently of `CAPABILITIES`; any grant added or removed in code without changing this table (and the RBAC doc) fails.
- For each of the 7 assignable roles placed at national, region, area, supervisor-unit and field-unit level, checks every capability (41) against: role only, own unit, a descendant, an ancestor and a sibling region. Grants hold downward only; ancestors and siblings are refused except for the read-only global `analyst`.
- Super admin holds everything everywhere; an active profile with no unit holds no scoped access; analyst and viewer hold only `*.read` capabilities.
- Reorg: moving an area under another region removes it from the old regional manager's reach and adds it to the new one immediately.

## 2. Whole-surface sweep of every public function

`packages/backend/convex/acceptance/authorization_sweep.test.ts`

The test discovers every public query and mutation at run time (267 today: 133 queries, 134 mutations), so a new endpoint is attacked automatically. Fixture:

- Two regions, NORTH and SOUTH. One generic row is generated for every unit-owned table from the schema itself, with every reference pointing at NORTH and every text field carrying a `LEAK·<table>.<field>` marker.
- Attackers: signed out; signed in without a Sunpride profile; an active manager with no unit; SOUTH admin, operations, manager, approver, sales and viewer; and the global analyst.
- Positive controls: NORTH callers of the same six roles call the same functions with the same arguments.
- Each function is called twice per caller (first and last option of every union, so a role/status/decision literal cannot mask a gate); every id argument names a NORTH row. 16 callers × 534 calls ≈ 8,500 calls per run.

Assertions:

1. Signed-out and unprovisioned callers are refused by every function except `domains/profiles:current` and `mobile/devices:mine`, which answer `null`.
2. No SOUTH or unassigned caller ever receives a NORTH marker or NORTH row id from a unit-owned table. National catalogue tables (products, UOM, inventory policies, positions and standards, visit activity rules) and the organization-wide issue tracker are excluded by design.
3. No SOUTH, unassigned or analyst caller completes any write against NORTH, except an explicit list of self-service writes: creating one's own profile, issuing a storage upload URL, filing a Talk Sheet in one's own unit, and admin issue-tracker edits (issues are organization-wide by design).
4. Positive control: at least 60 reads (71 today) return NORTH rows to a NORTH caller, and none of them returns NORTH rows to any SOUTH caller. Key reads (plans, outlets, territories, routes, inventory, call sheets, DSR, teams, targets, Work-With) are pinned so a fixture regression cannot turn the sweep into a no-op.

Mutation-testing the sweep: disabling the subtree check in `requireCapability` fails 12 of its 18 cases with a list of the leaking endpoints.

### What the sweep cannot reach, and where it is covered

Some writes reject the generic row on state before reaching the scope check (for example "Transfer is not awaiting approval"). For each, the scope gate was reviewed in code and has a dedicated test:

| Endpoint                                                    | Gate                                                | Test                                                    |
| ----------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| `inventory/transfers:ship/receive/approve`                  | Stored source and destination locations             | `inventory/transfers.scope.test.ts`                     |
| `inventory/receipts:reverse`                                | Stored receiving location                           | `inventory/receipts.scope.test.ts`                      |
| `inventory/adjustments:decide/reverse`                      | Every stored line location; no self-approval        | `inventory/adjustments.test.ts`                         |
| `inventory/counts:submit/approveAndPost`                    | Stored session location; reassignment rechecked     | `inventory/counts.test.ts`                              |
| `imports/mcp:commit`, `imports/{adjustments,counts}:commit` | Plan assignee unit; every row's location            | `imports/*.test.ts`                                     |
| `targets/sales:set`                                         | Subject's current unit; never one's own target      | `targets/sales.test.ts`                                 |
| `coverage/away:record/end`                                  | Self, own supervisor, or `admin.manage` on the unit | `coverage/plans.test.ts`                                |
| `inventory/pos:*` (van POS)                                 | Truck location's stored unit (fixed in this change) | `inventory/pos.test.ts` "van POS authorization"         |
| Mobile HTTP gateway (bootstrap, pull, push)                 | Convex JWT + bound device proof + person/day scope  | `mobile/device_auth`, `push`, `pull`, `bootstrap` tests |

## 3. Findings fixed in this change

- **Van POS had no organizational scope (real gap).** `inventory/pos:openRoute` accepted any active profile (including viewer and analyst) on any sellable truck; `postSale` then posted stock out of that truck. `voidSale` (admin/manager/approver) and `returnSale` reversed or returned sales in any region. All four now require the role (`sales`/`manager` to open and sell; the existing void/return roles) **and** the truck location's stored org unit in the caller's subtree, national scope for an unmapped truck, also on idempotent replays. A mid-route reassignment of the truck stops further sales.
- **Role changes now check the target's unit up front.** `domains/profiles:setRole` was already blocked cross-region by the assignment-history writer, but only after the role-grant check; it now refuses a person outside the admin's subtree (or an unassigned person, unless national) before anything else, matching `assignPersona`.

## 4. Residual notes (not failures)

- An active manager with no unit can still obtain a storage upload URL for enrolment photos and issues; attaching the file is scoped, so nothing is written to business data.
- Consequence of the POS fix for the frozen PWA van flow: a truck must be mapped to the seller's unit (`inventory/location_scope:assign`) before a non-national seller can open a route on it. ADR-004 moves van POS to the separate Android app.
- Live two-account checks on the DEV deployment and on handsets are not part of this test; the lead's post-merge QA covers them.
