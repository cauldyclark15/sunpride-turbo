# Coverage v2 (L02)

Owner question: who has not committed to this month's coverage, who is late, what needs my approval, and did the committed calls happen?

## HTTP

All paths below are beneath `/api/v1/coverage`. Reads require `mcp.read`; every plan read checks both the stored plan unit and the assignee's current effective unit. Sales can read only their own plans. Every referenced store is re-authorized through its current persisted assignment/territory owner, including signed historical exports.

GET `/summary?month=YYYY-MM` returns:

- `{month,deadlines,asOf,counts:{not_started,draft,submitted,approved,active},lateCount,awaitingMine,target,ready,priorReady,priorMonth,trend,rows}`.
- A row is `{profileId,name,orgUnitId,planId?,version?,planStatus?,status,state,submittedLate,approvedLate,awaitsMyApproval,approvalPlanId?,action:{label,planId?,profileId}}`.
- People with effective non-support positions and planning permission, plus salespeople, need an MCP. Inactive and unassigned people are excluded; the UI identifies an empty team as missing setup, not zero coverage.
- Counts are people, not versions. An active/approved version remains the readiness status while a draft/submitted successor is in progress; `action` opens the pending work. Original-plan deadlines do not classify mid-month revisions as late.
- `trend` is four months of approved people under current scope, with today's team size as a clearly labelled comparison target. It is not a historical-headcount claim.

Other GET paths:

- `plans/list`: `{assigneeProfileId,localMonth}` → plan array.
- `plans/detail`: `{planId}` → `{plan,outlets,slots,assignments,warnings,review}`.
- `discovery/list`: `{localMonth,status?,paginationOpts}` → page of `{planId,assigneeProfileId,assigneeName,localMonth,version,status}`.
- `discovery/attribution`: `{planId}` → preparer/submitter/approver names, latest return reason, event-name dictionary.
- `calendar/status`: `{localMonth,paginationOpts}` → deadline-person page plus deadlines.
- `calendar/approvalView`: `{planId}` → direct supervisor, absence, backup manager, viewer capacity/refusal and deadline information. Routing uses server time; a caller-supplied `asOf` cannot authorize a historical backup.
- `activation/plannedForMonth`: `{assigneeProfileId,localMonth}` → generated visits, including replacement/cancellation provenance.
- `routines/listForPosition`: `{planId}` → `{templates,warning}` at `max(plan.effectiveFrom,now)`.
- `away/list`: `{profileId}` → current/upcoming away periods.
- `history/list`: `{planId,paginationOpts}` → append-only audit page.
- `review`: `{planId}` → `{daily:[{date,calls,target|null}],frequencyGaps:[{outletId,name,expected,planned}],routes:[{code,stores}],standardSource|null,planned,visited,productive}`. Productive means the execution writer's governed `verified` value, never a completed checkout shortcut.
- `views/filterOptions`, `views/calendar`, `views/byRoute`, `views/workload`, `map/forPlan`, `exceptions/forPlan`, `exports/schedule` preserve the existing coverage panel DTOs. Calendar/map/export filters are `{territoryId?,routeId?,visitStatus?}`. Workload accepts `localMonth` and optional selected `planId`; route/map projections include eligible uncovered stores. Signed calendars/exports use frozen names and slot facts.
- `permissions`, `profile`, `people`, and `lookup/{territories,routes,route,outlets,outlet,roster}` are scoped read-only projections for the retained planner UI. They never write ORG tables. `people` does not grant broad HR access; it is a coverage roster.

Structured GET arguments are passed as URL-encoded JSON in `input`; scalar GET arguments (in particular `month` on summary and `planId` on detail) also work directly. A page is `{page,isDone,continueCursor}`; arguments use `{paginationOpts:{numItems:1..100,cursor:null|canonicalOffset}}`. Plan/outlet/slot projections fail explicitly above 500 rather than silently truncating. Export clients use 20-row pages and a 500-row bound, compare the entire header including `contentRevision`, and only create a file/print view after all pages succeed.

POST commands, with `idempotencyKey` required on every body:

| Path                    | Body in addition to idempotencyKey                                                                                                                                                                         | Permission                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `plans/create`          | `{assigneeProfileId,localMonth}`                                                                                                                                                                           | mcp.plan                                                                         |
| `plans/createRevision`  | `{planId,effectiveFromDate,reason}`                                                                                                                                                                        | mcp.plan                                                                         |
| `plans/saveOutlets`     | `{planId,outlets:[{outletId,territoryId,routeId?,frequency,anchorLocalDate?,weekOrdinal?,preferredWeekdays,customLocalDates,sequence?,priority,expectedDurationMinutes,requiredObjectives,visitWindow?}]}` | mcp.plan                                                                         |
| `plans/saveSlots`       | `{planId,slots:[{slotKey,serviceDate,kind,outletId?,routeId?,activityKind?,namedTruckRef?,requiredObjectives,intents,sequence,expectedDurationMinutes}]}`                                                  | mcp.plan                                                                         |
| `plans/setAssignment`   | `{planId,effectiveFrom,effectiveTo,reason}` (epoch-ms Manila midnights, end exclusive)                                                                                                                     | mcp.plan                                                                         |
| `plans/submit`          | `{planId}`                                                                                                                                                                                                 | mcp.plan                                                                         |
| `plans/returnPlan`      | `{planId,reason}`                                                                                                                                                                                          | mcp.approve + routed independent reviewer                                        |
| `plans/approve`         | `{planId}`                                                                                                                                                                                                 | mcp.approve + routed independent reviewer                                        |
| `activation/activate`   | `{planId}` → `{count,visitIds}`                                                                                                                                                                            | mcp.approve                                                                      |
| `routines/applyToDraft` | `{planId}` → `{created,warning}`                                                                                                                                                                           | mcp.plan                                                                         |
| `away/record`           | `{profileId,fromDate,toDate,reason}` (inclusive date labels)                                                                                                                                               | self or supervisor's recorded manager with mcp.approve; super admin also allowed |
| `away/end`              | `{awayId}`                                                                                                                                                                                                 | same as record                                                                   |

Plan commands return a camel-case plan DTO with `_id` as a plain UUID string. Dates are `YYYY-MM-DD`; instants are epoch-ms. Existing export names/props remain compatible. The API itself has no Convex dependency. Current persisted profile status/role/unit are checked inside the transaction before receipt replay. Identical key/content returns the original response; changed content is 409. All business changes, audit rows and receipt commit atomically.

## Approval, dates and immutable evidence

- Today's plan begins at Manila midnight, but live employee/outlet/routine lookups use `max(effectiveFrom,now)`. Approval checks each service-date midnight independently. A person hired at noon cannot be approved for that morning; the dated refusal rolls back all snapshots/audits/receipts.
- Independent means different from assignee, preparer and submitter. Direct supervisor approves; while absent/inactive, their recorded manager substitutes. Without a recorded manager, fallback approval requires scope above the supervisor's unit.
- Submit in the last seven days of the prior month; approval is due by the end of day seven. Earlier submissions are accepted, late submissions/approvals remain visible rather than preventing remediation.
- Approval freezes the complete plan header, primary assignment, outlet cadence and every slot (including defaults, objectives, intents, duration, named truck and resolved employee/outlet/route/customer references). `signed_content` is canonicalized and SHA-256 hashed. `approvalSignature` is `planId:version:actorSubject:approvedAt:contentHash`.
- Activation and signed reads verify this payload/hash/signature and use signed slot facts, never changed master names. Signature metadata is displayed only as version plus hash prefix.
- Position routines are read from the seeded tables; no weekly routine or call target is invented if setup is missing. DS Work-With still requires a named truck. Frequency-gap counts are advisory plan-review estimates; custom dates outside the plan block approval.

## ORG lock seam (must be integrated by ORG)

`import { assertNotLocked } from '../coverage/lock.js'`

`await assertNotLocked(tx, {outletIds?:string[],routeIds?:string[],from:number|Date,to?:number|Date|null})`

Call it inside the SAME transaction before editing outlet assignments, route membership/territory/salesperson state or other route ownership facts. Pass all affected source and destination references, including pending replacements. `to:null` means unbounded; intervals are `[from,to)`. It protects the entire approved/active interval, and the historical active portion of superseded plans, through both roster and slot references. It throws 409 `coverage_locked`. Approval and this seam acquire the same `coverage:master-lock` transaction advisory lock, so a master edit cannot race approval. This lane does not edit ORG writers; until the ORG lane calls this seam, those writers are not protected by this branch alone.

## Activation, analytics and sync seams

- `install(router,ctx)` registers topic `coverage` for `mcp.read`, scheduler `every(60000,'coverage.activation',...)`, and durable handler `coverage.activation`.
- Each tick handles at most 20 due plans, one transaction each. Failed plans are placed on the durable retry worker so siblings can proceed. Generation keys and a unique slot index prevent duplicates. Retrying later returns persisted visits in signed slot order, including already elapsed generated visits.
- Successors atomically replace/cancel future predecessor visits and mark the predecessor superseded; existing execution refuses replacement and rolls the whole transaction back.
- Changes publish `coverage` after commit and record scoped `coverage_plans` / `planned_visits` changes. Coverage records no execution/master writes.
- Activation/replacement queues one coalesced `coverage.refresh` job per assignee/date. Its post-commit worker calls ANALYTICS' `enqueueRefresh(ctx,{kind:'visit',date,unitId})`. ANALYTICS' placeholder is deliberately untouched; integration supplies the real seam. A missing seam leaves the durable refresh job retrying, not a fabricated rollup.
- No native coverage-authoring op or projection is registered. FIELDSYNC owns `field.bundle` and consumes the canonical `planned_visits` table/change log. No existing native op string was reassigned.

## Web mount and integration boundaries

`SalesForcePanels` remains the export of `coverage-workspace.tsx`, mounted by the existing Sales Force workspace. Summary is first/default. One click opens the pending approval or selects the person's draft/version. Planner, review, deadlines/away, history, visits, calendar, route, map, workload, exceptions and CSV/print use `coverage-data.ts` over the new `useApi/useLive/useMutate` layer and explicit `coverage-model.ts` HTTP DTOs. No owned production coverage component imports Convex or backend-derived types.

Setup's ORG editors and the standalone position-standards editor are other lanes' existing mounts, not rewritten here. The legacy shell portion of the workspace integration test keeps its old mock solely to exercise that unowned shell; coverage hooks have a separate new-layer mock. These boundaries need the corresponding lanes at integration. No root codegen, Convex CLI, deployment, phone, reserved-port server or shared database was touched.
