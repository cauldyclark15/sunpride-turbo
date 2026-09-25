# ADR-009: Personas, access roles, and positions

Status: accepted. Roles are a permission set; Sunpride's job titles are data. Superseded only by
a later ADR that changes the role list itself.

## Decision

- **Three axes, never one merged role.** A persona is the product of (1) an **app role** — a
  code-owned permission set, (2) a **position** — the client's job title as a row, and (3) an
  **organizational scope** — the `orgUnits` subtree (ADR-005). A client title never becomes a
  `v.literal`.
- **The role list is eight values:** `super_admin`, `admin`, `operations`, `manager`, `approver`,
  `sales`, `analyst`, `viewer`. `operations` and `analyst` are new; `manager` keeps its literal
  (relabelled "Sales manager" in the UI) so no migration is needed and existing `requireRole` call
  sites keep working. A rename to `sales_manager` is a later, separate migration.
- **Positions are data.** `positions` holds `code`, `label`, `category`, `active`; the seed covers
  the titles named in the client's 2026-01-20 Sales Operations Standards memo. `RDS`, `DSP` and
  `ADP_PERSONNEL` are seeded provisionally because the memo names them without expanding the
  acronyms.
- **Standards attach to positions, effective-dated.** `positionStandards` carries
  `dailyCallsTarget`, `productiveCallTargetPct`, `workWithWeeklyMin`, `workWithMonthlyMin` and a
  `sourceRef` naming the memo section. A revised memo adds a row with a later `effectiveFrom`; it
  never overwrites history. Values come from the client document, never from our judgement.
- **Endpoints ask for capabilities, not roles or titles.** `requireCapability(ctx, "mcp.approve",
targetUnitId?)` resolves the role from the profile, checks the capability table in
  `convex/lib/capabilities.ts`, and then enforces organizational scope for the target unit. Adding
  a client title changes `positions`, never an endpoint.
- **`analyst` is the only role that reads across the whole organization** — Finance and Treasury are
  CC'd on national claims and AR reckoning. Cross-scope access is paired with read-only
  capabilities (`*.read` only); `capabilities.test.ts` asserts that invariant. `viewer` stays
  inside its own subtree.
- **The person and the login are different questions.** `profiles.employmentType`
  (`sfi_employee` | `adp_personnel` | `third_party`) records how someone relates to Sunpride before
  they hold a login: ADP personnel are supervised (memo §III) but are a third party, so they are
  modelled without a user account until the client says otherwise.
- **Channel scope is an attribute, not a role.** `profiles.channelScope` (`KA` | `GT` | `PMOT`)
  because the memo runs Key Accounts and General Trade under one CDM title.

## Consequences

- A new client title is an insert into `positions` plus an optional standards row — no deploy.
- Provisioning a person is role + position + unit; the admin workspace exposes all three, and
  `assignPersona` refuses to move anyone outside the caller's own subtree.
- The memo's numbers can be corrected by an administrator without a release, and every metric that
  compares calls against target reads them from `positionStandards` rather than a constant.
- Teams (`CVX-004`), work-with records, deliverables and weekly routines are **not** covered here;
  they follow in the coverage/MCP slice and must read positions, not role literals.
- The `visits`/`salesAssignments` tables remain keyed by raw `authSubject` with no position or
  scope. They are re-homed when the MCP domain lands — this ADR does not extend them.
