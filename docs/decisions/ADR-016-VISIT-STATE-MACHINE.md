# ADR-016: Visit state machine, intent, and reason codes

Status: accepted (2026-09-25, JC lead) — provisional items marked inline

## Context

The client requires channel-specific productive calls, planned MCP coverage and supporting reports (Sales Operations Standards memo §§2–3, 6, Annexes A–C). The blueprint proposes an explicit lifecycle, reason codes and structured activities (`docs/architecture/SFA_PLATFORM_BLUEPRINT.md` §§9, 12–13). ADR-015 governs the MCP lifecycle separately; this ADR governs each outlet visit, not its plan approval.

## Decision

A visit is one outlet attempt by one person on one local service date, linked to its MCP version/slot when planned (ADR-015); off-plan visits carry `unplanned` and never silently amend the MCP. **Provisional — pending Client question 5:** off-plan calls are not per-diem eligible absent a separately approved policy exception (memo §3). An actual call needs completed outlet contact with verified check-in/out or approved location exception, not mere arrival. **Provisional — pending Client question 2:** count at most one actual/productive call per person/outlet/day; preserve repeats for audit. The glossary's order-only example does not supersede memo §2; separate planned coverage from actual-call productivity.

| From                        | Trigger / actor                                                                      | To            | Offline behavior                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| —                           | Approved MCP slot materialized by server; or authorized rep creates off-plan attempt | `planned`     | Approved plan cached; off-plan creation queued, marked unplanned.                                                                  |
| `planned`                   | Rep records arrival at outlet                                                        | `arrived`     | Queued with device time; no call counted yet.                                                                                      |
| `arrived`                   | Rep checks in with location evidence (ADR-017)                                       | `checked-in`  | Provisional until server validation; cannot certify actual call offline.                                                           |
| `checked-in`                | Rep starts first structured activity                                                 | `in-progress` | Activity commands queued; original event times kept.                                                                               |
| `checked-in`, `in-progress` | Rep checks out, recording outcome/evidence                                           | `checked-out` | Queued; outcome not certified offline.                                                                                             |
| `checked-out`               | Server validates sequence, evidence, required records and exception approvals        | `completed`   | Server-only on sync; rejected commands remain visible for repair.                                                                  |
| `planned`, `arrived`        | Rep skips before contact, with reason                                                | `skipped`     | Provisional; queued for server review.                                                                                             |
| `planned`, `arrived`        | Rep requests new date with reason; manager authorizes revised plan under ADR-015     | `rescheduled` | Request queued; original slot stays pending until approved; create linked successor, never overwrite history.                      |
| `planned`, `arrived`        | Server closes unvisited date after sync grace                                        | `missed`      | Server-only after 48-hour engineering grace from local day end; late evidence triggers audited correction, not silent replacement. |

Terminal states are immutable; corrections are linked, append-only supervisor dispositions. A checked-in contact without business outcome checks out as **nonproductive**, never skipped. Transitions carry idempotent command ID, device/server times and actor; server validates order and scope (ADR-002, ADR-010). **Provisional — pending Client question 2:** the 48-hour grace and late-evidence correction are engineering defaults.

Intent is a nonempty set of `sell`, `collect`, `merchandise`, `audit`, `deliver`, `promotion`, `complaint`, `follow-up`: one or several together. Evidence maps respectively to PO/order or offtake/sales, collection, display/price-tag fix, inventory/ICO/price check, delivery confirmation, program execution/validation, issue, and linked prior action. `relationship_visit` in blueprint §12 is represented by linked `follow-up` (blueprint §§12–13). Intent is not productivity and combined intent waives no channel standard.

For a productive call, evaluate the **entire channel checklist** on a completed, actual visit: Chain Stores with PO Releasing require PO retrieval, ICO intervention, merchandising fixes, price execution, collection **and** promo execution; stores without PO retrieval require offtake and inventory/ICO fixes, merchandising fixes, price execution **and** promo validation; PMOT requires sales generation (volume/distribution), display/price tagging, price compliance, collection **and** program execution (memo §2). Record each item as linked structured activity/evidence, including a negative finding; missing proof or `not applicable` does not auto-pass. Never substitute an order alone for the checklist. **Provisional — pending Client question 2:** qualification is per visit and all listed items must be met; client must confirm whether criteria may aggregate across a day and how genuinely inapplicable items are treated. ICO enumerations remain **Provisional — pending Client question 3** (memo §9). Keep effective-dated channel rules and the checklist version used for each determination; memo currency is pending Client question 12.

Governed reason codes (stable code, label, category, effective dates, owner approval, deprecated-not-deleted) apply by outcome: `store_closed`, `owner_unavailable`, `customer_request` (closure/contact); `route_change`, `weather`, `vehicle_issue` (travel); `no_contact_unreported` (system missed only); `other` (mandatory note). Skipped/rescheduled require a rep-selected reason and note/evidence where relevant; missed gets system reason, then supervisor annotation if known. Geofence exception codes are distinct: `gps_unavailable`, `poor_accuracy`, `out_of_radius`, `outlet_pin_wrong`, `access_restricted`, `mock_location_suspected`; a reason is never itself approval (ADR-017). The initial closure/travel catalog adapts blueprint §9, while exception codes operationalize §§10–11; these are **Provisional — pending client confirmation**, not client-mandated vocabulary.

## Consequences

- Extend `packages/backend/convex/schema.ts` `visits` beyond `planned/completed/cancelled`: link outlet/MCP version, intents, statuses, event/audit log, evidence, activity records and correction records; migrate legacy `cancelled` explicitly rather than silently mapping it. Existing `salesForce.ts` readers need migration.
- Enforce `visit.record` and `visit.read` capabilities plus ADR-005 unit scope on new commands; manager exception decisions need their own scoped capability, not a title check (`packages/backend/convex/lib/capabilities.ts`).
- Reports/DSR and Call Sheet joins must use linked evidence, channel and rule version (memo §6, Annexes B–C); separate actual, productive, missed, skipped and off-plan counts.

## Open questions

Client questions 2, 3, 5 and 12 remain unanswered. Also confirm the reason-code owner and whether chain-store checklist items may be inapplicable; until then the conservative checklist applies.
