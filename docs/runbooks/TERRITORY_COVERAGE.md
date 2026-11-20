# Territory coverage (SP-0222)

This describes the implemented office workflow, not a claim that it is already available on the public site.

## Office workflow

- Setup > Territories > Add territory: keep the owning unit and effective date, then choose a Territory type.
- Location: search the loaded Philippine city/municipality or barangay list. Add the required places and save. The territory detail shows the chosen places and a paged list of its active stores.
- Customer group: first use Setup > Customer groups to add a chain/key-account group, choose Manage stores, uncheck “Only stores already in…” to find additional stores, select them, and link them. Choose that group when adding or editing the territory.
- Group names and links are maintained by a national administrator, like other company-wide master data. A regional administrator can change coverage within their authorized owning-unit/store scope, but cannot take a store from another branch.
- Setup > Setup health > Stores without a place or customer group opens the affected stores. Use the customer link to complete a location, or link the store to a group there.
- Existing manual store assignments are still made in Setup > Assignments. Coverage does not automatically assign a route or a salesperson; those existing office rules remain in force.

## Coverage rules

1. An explicit manual store assignment wins over automatic coverage, including when its location or group changes.
2. A covered customer group wins over geographic coverage. This is the software default for the overlap case: a key-account store stays with its key-account territory instead of being claimed by a city territory.
3. An explicitly covered barangay wins over a whole-city/municipality entry. Other barangays remain in the city territory.
4. The same city, barangay or customer group cannot be selected for two territories with overlapping effective intervals. The refusal names the other territory. A city and a barangay within it may deliberately be covered by different territories.
5. Territory starts and ends bound automatic membership; a bounded barangay or group exception falls back to the applicable remaining rule when it ends.
6. Location and Customer group are both available for Food Service. No unresolved client choice is hard-coded.
7. The upgrade gives every existing territory Location with no selected places. Existing assignments are preserved as manual; no historical places are invented.
8. Stores with neither a municipality/barangay code nor a chain-group link are flagged even when they have a manual territory.

The new chain/key-account master is separate from SAP’s existing Customer Group, Customer Grp 1 and Customer Grp 2 classification fields. No existing classification is reinterpreted as a chain membership.

## Implementation and boundaries

`0835_territory_coverage.sql` adds `territories.territory_type`, `customer_groups`, `outlets.customer_group_id`, `territory_coverage` and `outlet_assignments.assignment_source` (existing rows default to `manual`). Automatic membership is persisted through `outlet_assignments`, not a UI-only calculation, so existing rosters, current-owner authorization, planning readers and sync invalidation use the same membership. Canonical customer location changes and group-link changes refresh membership transactionally. Automatic refresh preserves past intervals, respects future manual overrides, and does not rewrite unchanged assignments.

Territory/group writes retain the serialized ORG command, authorization, audit and sync-change path. Coverage edits check affected stores and approved-plan locks. Geography choices are searched and paged from the existing `ph_municipalities` / `ph_barangays` data; names are not free-text territory boundaries.

Report filters by territory type/customer group are intentionally deferred by the issue. No native application changes, device installation, or public rollout is included in this work.

## Proof

The issue-specific API suite uses synthetic stores and the actual loaded PH geography against disposable, migrated PostgreSQL test databases. It covers membership, priority, manual/future overrides, concurrent duplicate refusal, rule removal, source ownership, upgrade preservation and health-list reconciliation. Web tests cover form payloads, type-specific choices, store drill links and master access. Browser evidence in the lane report uses an isolated lane instance and clearly labelled sample records; it is not production/client acceptance.
