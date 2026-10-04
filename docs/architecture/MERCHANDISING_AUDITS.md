# Merchandising audits (CVX-030)

Backend: `packages/backend/convex/merchandising/`. Tables in `convex/schema.ts`.

## What is stored

| Table                           | One row per                              | Notes                                                                                                                                                                                                                                                                    |
| ------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `outletAssortments`             | required-assortment version of an outlet | Effective-dated, prospective only (`assortments.set`, `outlet.manage`). A new version closes the one it replaces; a version already scheduled at or after the new start is never overwritten. An empty list ends the requirement.                                        |
| `merchandisingAudits`           | visit                                    | Immutable. Server-computed summary against the assortment in effect when the audit reached the server: required count, required available (available or low stock), required out of stock, required products not recorded. Links general audit photos.                   |
| `merchandisingAvailability`     | product checked                          | `available`, `low_stock`, `out_of_stock`, `not_carried` (blueprint §16), optional facings, `required` flag.                                                                                                                                                              |
| `merchandisingComplianceChecks` | check                                    | `display`, `price_tag`, `promotion` (program reference required), `freezer_placement`, `shelf_share` (whole percent), `product_freshness`; finding `compliant`, `non_compliant`, `not_present`, `not_applicable`. Negative findings are recorded, not omitted (ADR-016). |
| `competitorObservations`        | observation                              | Brand, kind (`price` needs a price; price is integer minor units with an ISO currency), category, note.                                                                                                                                                                  |

Every row can link visit photos (`fieldEvidenceFiles`). A linked photo must belong to the same
visit and person and must not be rejected. Photos are uploaded first through
`visits/evidence:generateUploadUrl` + `attach` (photo type `shelf_display`, `price_tag`,
`promotion`...), then referenced here.

## Functions

- `merchandising/audits:record` — the visit's assignee during an open call (`checked-in` or
  `in-progress`), `visit.record`. Idempotent on `clientAuditId` (UUID): an identical retry returns
  the original; different content under the same ID, or a second audit for the visit, is a
  `conflict`. Moves the visit to `in-progress`, flags late work like other visit writes, and appends
  a `merchandising.audit_recorded` execution event.
- `merchandising/audits:forVisit` — full audit for a visit (`visit.read`, visit scope rules; a
  salesperson sees only their own visits). Actor tokens are never returned.
- `merchandising/audits:forUnitDay` — paginated audit summaries (with on-shelf availability %) of
  one org unit and Manila day for supervisors and analytics; not for the sales role.
- `merchandising/assortments:set` / `current`.

Indexes support the analytics questions in blueprint §16 ("which SKUs are missing from which
stores"): availability by product + day and by org unit + day; compliance by org unit + kind + day;
competitor observations by org unit + day.

## Open (provisional until Sunpride confirms)

- The audit form itself: status codes, compliance kinds and competitor fields are ours, from memo
  §2, the 2 Oct 2026 call (merchandising, share-of-shelf and OSA count as productive work) and the
  blueprint. Sunpride's own merchandising checklist would replace them.
- Whether an audit should also count as the `merchandising` activity form for AND-013 required
  activities and productive-call evaluation. Today it does not; the phone still records the
  `merchandising` visit activity separately.
- Correcting a submitted audit: none (one immutable audit per visit).
- Native apps do not call these functions yet; the phone screens are a separate issue.
