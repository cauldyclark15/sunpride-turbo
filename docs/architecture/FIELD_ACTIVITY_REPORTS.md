# Field activity reports: DAR and ROAR (SOP-009)

Source: memo 2026-01-20, "Reports" table (`docs/requirements/SALES_OPS_STANDARDS_MEMO_2026-01-20.md`):

| Report                       | Who (memo)    | Required output (memo)          |
| ---------------------------- | ------------- | ------------------------------- |
| DAR — Daily Activity Report  | SCDM, CDM, DS | Viber and Hard Copy with folder |
| ROAR — Route Activity Report | RDS           | Hard Copy with Folder           |

The system generates both reports from the day's field records, so nobody writes them by hand. The
filer adds remarks and presses Submit; that replaces the Viber message and the hard copy. Supervisors
see who filed, who filed late and who did not, per person per day. The report can still be printed
(Print / Save PDF) for the folder.

## Who files what

The person's current position decides (`convex/field_reports/model.ts`):

- **DAR**: SCDM, CDM — Key Accounts, CDM — Gen Trade, DS (memo), plus Sr CDS and CDS (our decision:
  supervisory positions that run Work-With and have no other daily report).
- **ROAR**: RDS (memo), plus Route Sales, PMOT, PMOT Extruck and Public Market Stalls (our decision:
  the acceptance criterion says "route sellers", and the 2026-09-30 email groups these as Route Sales
  with the same 30-call standard).
- Everyone else (KAS, Booking, DSP, ADP personnel, office roles) files neither.

## What the report contains

Generated live from records the field apps already send:

- Planned stops from the signed MCP (`plannedVisits.approvedSnapshot`) in route order, then unplanned
  calls in check-in order; stops never visited are listed as "Not visited".
- Per stop: check-in/out, call time, what was done (order, merchandising, price check, inventory,
  promo, call sheet, collections), visit notes and reason code, and the call result under the
  client's productive-call rule (`sfa/productive_call.ts`, call 2026-10-02).
- Day figures: calls, productive calls and %, against the position's daily standard when one exists
  (`positionStandards`); planned done, not visited, unplanned, first check-in to last check-out.
- ROAR: per-route call figures when the day spans more than one route.
- DAR: the Work-With sessions the filer ran that day (trainee, objective, mode, MCP stops done,
  status).

## Submission and completeness

- `field_reports/reports:submit` files the caller's own report with remarks (≤ 2000 characters).
  Each submission is a new kept revision (`fieldDayReports`, append-only) with the day's figures
  frozen, so a later sync never changes what was filed; at most 20 revisions per day.
- Due by **10 PM Manila** on the service date (client answer 14, 2 Oct 2026, the field-day close).
  The FIRST revision's server time decides on time vs late; corrections do not reset it.
- A report may be filed for today and up to 7 days back (provisional), never ahead.
- Completeness per person-day: Submitted, Late, Due (until 10 PM), Missing (selling day closed with
  nothing filed), Off day (not a selling day per the position standard; Mon–Sat by default).

## Access

- Filing: `visit.record` (super admin, manager, sales) and a DAR/ROAR position.
- Reading another person's report and the completeness grid: `people.read` + `visit.read`, limited
  to the caller's organizational scope (same rule as Supervision). Field sales read only their own.
- Web: Field → DAR / ROAR (`/activity-reports`): "My DAR/ROAR" for filers, "Team submissions" (week
  grid; click a cell to open that person's report) for supervisors.

## Open points for Sunpride

1. Confirm the DAR list (memo: SCDM, CDM, DS) — should Sr CDS and CDS file a DAR too?
2. Confirm the ROAR list (memo: RDS) — do Route Sales, PMOT, PMOT Extruck and pre-booking file a ROAR?
3. Send a sample or blank DAR and ROAR form if they have fields beyond what is generated here.
4. How many days back may a report still be filed or corrected (we use 7)?
5. Should a supervisor acknowledge each DAR/ROAR (signature on the hard copy)? Not built yet.
