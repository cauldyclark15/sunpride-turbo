# Admin report pack (SOP-012)

The memo of 20 January 2026 (§V "Reports and Deliverables") lists four ADMIN reports beyond the
MCP and the Daily Sales Report. This page records what each one means, where it lives in the web
app, and what Sunpride still has to provide. Client call answers of 2 October 2026 win over the
memo (`docs/requirements/SALES_OPS_STANDARDS_MEMO_2026-01-20.md`).

Where: **Reports** (`/analytics`) → **Admin reports**, below the daily execution dashboard. Same
readers and scope as that dashboard: supervision readers (`people.read` + `visit.read`) who also
hold `report.read`, limited to their organizational scope. Field `sales` do not see it.
Endpoint: `analytics/admin_reports:day` (paged, 10 people per page; the web adds the pages).
Every report has an **Export CSV** button (UTF-8 with BOM, spreadsheet formula guard).

## Terms (Sir Francis's email, 30 Sep 2026)

| Short form | Meaning                          |
| ---------- | -------------------------------- |
| PC         | Productive Call                  |
| UBA        | Unique Buying Account            |
| OSA        | On Shelf Availability            |
| COA        | Calendar of Activity             |
| SASR       | Sales Activation Support Request |
| BR         | Business Review Template         |
| D.A.       | Display Allowance                |
| ADP        | Area Distribution Partner        |
| KAS        | Key Account Specialist           |

Mandays is not an acronym; we use its usual meaning (one person working one day).

## 1. Daily Productive Calls, UBA, OSA, Mandays — built

One row per field person for a Manila service date, plus scope totals.

- **Calls / productive calls:** the same per-visit rule as the DAR/ROAR, DSR and daily execution
  dashboard (`sfa/productive_call.ts`, call answer #2): a call is a closed route-plan visit; it is
  productive when any one listed activity was recorded (truck sellers need more than
  merchandising unless they marked "no sales due to inventory"). Target = the position standard
  on a selling day.
- **UBA:** distinct customer codes with a positive counted sale written that day (drafts, rejected
  and voided orders never count; a return is not a buying account). The scope total counts a
  customer once even if two salespeople sold to it.
- **OSA:** from the day's merchandising audits: required SKUs found on shelf ÷ required SKUs
  checked, against each outlet's required assortment (`merchandising/`). No audit → no OSA.
- **Mandays:** a person who checked in at least once that day counts one manday.

Totals sum the parts and then divide; they never average people's percentages.

## 2. Programs utilization vs allocation (Promo Advice) — utilization built, allocation awaited

Per program reference: how many visits recorded the program as executed, not executed, or not
applicable (the promotion check recorded at the visit, the same source as the DSR program block).
Utilization = executed ÷ (executed + not executed). **Allocation** is shown as "Awaiting": the
system has no Promo Advice data.

## 3. Priorities (D.A. contract, Promo Advice, COA, SASR, BR template) — awaited

These are documents, not field records. We have no template or filing rule for any of them.

## 4. Claims Summary (ADP) and Account Receivables Reckoning (KAS) — collections built

- **Collections** (built): every field collection recorded on the day's visits (rejected ones
  excluded) with customer, outlet, amount, method, reference and review status. This is the field
  side of an AR reckoning.
- **AR balances** (awaited): open receivables per account are not in the system (they live in SAP
  or the office ledger). Reckoning needs that source.
- **Claims Summary (ADP)** (awaited): no claims are recorded in the system today.

## What Sunpride must provide

| Needed                                                                                                                                  | From                                            | Unblocks                      |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------- |
| Promo Advice: each program's allocation (to which accounts/areas, in what unit — stores, cases or pesos) and its program reference code | Sales / trade marketing                         | Allocation column in report 2 |
| Templates and owner/frequency for D.A. contract, COA, SASR, BR template                                                                 | Each senior manager via Sir Francis             | Report 3                      |
| ADP claims template and where claims are recorded today                                                                                 | ADP / sales admin                               | Claims Summary                |
| Source of receivable balances for KAS accounts and the reckoning template                                                               | Finance / sales admin                           | AR balances                   |
| The admin report templates (Excel) so columns match what admins use                                                                     | Sir Francis (already promised, call answer #10) | Column layout of all four     |
| Confirm the meaning of Mandays (one person checked in for a day) and OSA (required assortment basis)                                    | Sir Francis                                     | Report 1 definitions          |
