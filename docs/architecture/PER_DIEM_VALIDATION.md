# Per-diem validation (SOP-004)

Memo §II: per diem is checked against the approved MCP; only calls and activities in the MCP,
backed by the required reports, count. Call answers of 2 Oct 2026: the rate is set per position
outside the system, all sales personnel claim, supervisors or managers validate.

Where: web Supervision → Per diem. Backend `packages/backend/convex/supervision/per_diem.ts`
(rules in `per_diem_model.ts`, rule version `sop-004/2026-10-04`).

## What counts

A call counts when all hold:

1. It is linked to a planned stop of the person's approved MCP (plan approved, active or
   superseded) for that day, and the stop was not cancelled or replaced.
2. The call is finished (checked out or completed).
3. A check-in location was recorded (or a supervisor approved the exception) and no supervisor
   rejected the location. There is no fixed distance: an off-pin fix that nobody reviewed is
   shown as a note, not blocked.
4. It was not sent after the 10 PM close, or the late update was accepted.
5. A call report was recorded (at least one activity), and for an Annex C account the call sheet
   was filled.

Calls still open, missing a location, or waiting for a late review are **held**: they count once
reviewed. Everything else **does not count** and is listed with the reason. Planned stops on a
closed day with no call are listed as not visited.

A day counts when it has at least one valid call and nothing held (provisional).

## Decisions

Holders of `mcp.approve` for the person's unit (manager, super admin) validate or return a claim
period (whole month, 1–15 or 16–end). Validation needs every held call decided first; a return
needs a note. The decision stores the counts, the valid dates and a hash of what was shown; if
the calls change afterwards the decision is marked "calls changed since" and the supervisor can
decide again. Decisions are append-only (`perDiemValidations`), with an audit log row. No
self-approval.

## Open questions (client)

- Can a call outside the approved plan ever be paid, and what proof closes it? (Today: never.)
- Does one valid call earn the day, or is there a minimum per position?
- Claim period: monthly or semi-monthly? Both are offered.
- MCP activities that are not outlet calls (office, training) have no execution record yet, so
  they are not counted.
- The Daily Activity Report (SOP-009) is not built yet; once it is, it joins the required
  reports.
