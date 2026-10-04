# Sales targets (CVX-017)

Backend: `packages/backend/convex/targets/` (`model.ts` rules, `sales.ts` endpoints), table `salesTargets`.

## What a target is

One number for one **subject**, **period** and **metric**, valid over an effective interval, with the
document it came from.

| Field      | Values                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| Subject    | `employee` (profile), `team`, `territory`                                                                           |
| Period     | `daily` (each selling day) or `monthly` (each Manila calendar month)                                                |
| Metric     | `sales_value` (PHP centavos), `calls`, `productive_calls` (counts)                                                  |
| Interval   | `effectiveFrom` / optional `effectiveTo`; daily bounds are Manila midnights, monthly bounds are Manila month starts |
| Provenance | `sourceRef` (required: memo, plan or email it came from), optional `notes`, `createdBy`                             |

Position standards (`positionStandards`: daily calls and productive-call % per job title, memo §2) stay
where they are. A `salesTargets` row is a person/team/territory-specific number, e.g. the monthly peso
target on the Daily Sales Report (memo Annex B: "today's sale vs target, MTD performance/target").

## Rules

- History is kept. Setting a target while another of the same key is in effect closes the old row at
  the new start (`salesTarget.superseded` audit). A target already scheduled later must be ended first.
- Changes are future-effective. Exception: the first target of a key may start at the current Manila
  day or month, so go-live needs no wait; once any target covers that period it cannot be rewritten.
- `end` shortens a target to a future period boundary. Ending a not-yet-started target at its own start
  cancels it: the row stays as a zero-length record (`salesTarget.cancelled`) and covers no instant.
- Access (`target.manage`: super admin, admin, manager) follows the subject's **current** unit:
  the employee's current assignment, the team's unit, or the territory's current owner. Nobody but
  super admin sets or ends their own target. Reading uses `report.read` in the same scope; sales may
  read only their own employee targets.
- Report code reads the number in force with `subjectTargetAt(ctx, subject, period, metric, instant)`
  after authorizing the subject.

## Open questions (for Sunpride)

- Which targets exist besides peso sales and call counts (volume in cases, per category such as
  Canned / Mixes / Frozen, new-product and program targets on the DSR)?
- Who sets them (CDM, sales admin, head office), and is a monthly target split into daily targets by
  selling days, or entered separately?
- Can a target be revised mid-month? Today a revision starts at the next month.
