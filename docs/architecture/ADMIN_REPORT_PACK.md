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

When a unit is picked, every figure (calls, OSA, programs, collections) counts only visits made in
that unit, even if the same person also worked elsewhere in the reader's area that day. Exports
fail closed: a report whose source rows hit a read cap (more than 80 people, more than 400 orders
for one person's UBA, more than 200 collection lines per page) shows a warning and its Export CSV
button is disabled until the reader narrows the unit or channel.

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

## Monthly pack — built on sample data (jc, 7 Oct 2026: do not wait for Sunpride)

Where: **Reports** → **Admin reports** → **Monthly admin reports**, below the daily reports.
Endpoint `analytics/admin_pack:month({ month: "YYYY-MM", orgUnitId? })`, same readers and scope
as the daily pack. Every report shows its data source and has an **Export CSV** (the acronyms
are defined at the top of each file). A report whose source hit a read cap (300 records of a
kind per month, 1,500 visits for programme use, 200 collections per account) says so and its
export is disabled.

Office inputs live in one table, `adminPackRecords` (`analytics/admin_pack_model.ts`), one row
per allocation / document / claim / balance, per unit and Manila month. Readers see rows of
units inside their selected scope.

**Sample data and the switch to real data.** `source: "sample"` rows are made up (codes
`SAMPLE-*`, names end in "(sample)"). As soon as one `source: "office"` row of a kind exists for a
month, every sample row of that kind and month is ignored everywhere. Seed/reset (lead, beta
deployment, from `packages/backend`):

```bash
bunx convex run analytics/admin_pack_sample:seed '{"month":"2026-10"}'   # each region gets a set; re-run is a no-op
bunx convex run analytics/admin_pack_sample:reset '{}'                   # removes sample rows only; repeat until isDone
```

The sample uses existing key-account customers (channel "Key Accounts"/"KA"/"Modern Trade") so
AR reckoning matches their field collections; with none, it invents `SAMPLE-KA-*` accounts.
Sample programmes are `SAMPLE-PA-01` … `SAMPLE-PA-04`: testers record these references on a
visit's promotion check to see utilization move.

## 2. Programs utilization vs allocation (Promo Advice)

- **Daily:** per program reference, visits that recorded it executed / not executed / not
  applicable (the visit promotion check, same source as the DSR program block).
- **Monthly:** per allocation: allocated stores and budget (Promo Advice) against the stores
  where the programme was recorded as executed that month inside the allocation's unit subtree
  (rejected late syncs excluded). Allocation used = stores executed ÷ allocated stores.
  Assumption: allocation is counted in stores; cases/pesos allocation is a later refinement.

## 3. Priorities (D.A. contract, Promo Advice, COA, SASR, BR template)

One row per document owed: type, title, account, owner, due date, status (pending, submitted,
approved, returned) and submitted date. Overdue = pending or returned after its due date.
Assumption: documents are tracked as a checklist with a due date per month; the files
themselves stay where they are filed today.

## 4. Claims Summary (ADP) and Account Receivables reckoning (KAS)

- **Daily collections:** every field collection recorded on the day's visits (rejected ones
  excluded) with customer, outlet, amount, method, reference and review status.
- **Claims Summary (monthly):** per distribution partner: claims, claimed, approved, paid, open
  (filed or validated) and rejected amounts, then the claim list. Types: display allowance,
  promo discount, bad order, rebate.
- **AR reckoning (monthly):** per key account: balance date, terms, aging (current, 1–30,
  31–60, 61–90, over 90), opening balance, recorded field collections in the reader's scope from
  the balance date to month end, collections pending review (not deducted) and remaining.
  Assumption: the balance is loaded once per month as of the 1st.

## What Sunpride's real data replaces

Nothing here blocks release. When Sunpride sends the inputs below, they are loaded as
`source: "office"` rows (an import screen is a follow-up) and the sample rows of that kind and
month disappear; their templates may adjust columns.

| Input                                                                | From                                | Replaces                |
| -------------------------------------------------------------------- | ----------------------------------- | ----------------------- |
| Promo Advice: allocation per programme (stores/cases/pesos) and code | Sales / trade marketing             | Sample allocations      |
| D.A. contract, COA, SASR, BR template: owner, frequency, templates   | Each senior manager via Sir Francis | Sample priorities       |
| ADP claims template and where claims are recorded today              | ADP / sales admin                   | Sample claims           |
| KAS receivable balances source and reckoning template                | Finance / sales admin               | Sample balances         |
| Admin report Excel templates; confirm Mandays and OSA meanings       | Sir Francis (call answer #10)       | Column layout, report 1 |
