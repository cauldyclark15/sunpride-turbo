# Call Sheet (Annex C)

Source: Sales Operations Standards memo, 20 Jan 2026, Annex C (`docs/requirements/SALES_OPS_STANDARDS_MEMO_2026-01-20.md`). Tracker: SP-0007 (SOP-008).

## What it is

One sheet per account (outlet) per month. The header carries Account Name, Address, Buyer Name, Contact #, Account In-charge, Receiving In-charge, Distributor Name, Schedule & Contact #, FOC and Pricing. The grid has one row per product (barcode, description, code, pricing) and, for each of weeks 1–4, Order, Beginning Inventory, Take, Delivered, Off-take and End Inventory.

## Who does what

1. The office sets up the account: web, Field → Call sheets, open the outlet, Account setup. Only roles with `outlet.manage` (super admin, admin, operations) can edit. Saving bumps the revision; a stale editor is refused.
2. Phones receive the sheet of every account in their planned visits with the day snapshot. An office edit forces the phone to refresh its snapshot.
3. During a checked-in visit the salesperson opens Call sheet, fills any of the six numbers per product and saves. It works offline: the capture is queued and sent after the check-in is acknowledged, like a visit note.
4. Anyone who can read the outlet sees the month grid on the web and can export CSV or print to PDF (A4 landscape).

## Rules

- Week of month: days 1–7 week 1, 8–14 week 2, 15–21 week 3, 22 to month end week 4 (Manila date of the visit). The server decides the week, never the phone.
- Several saves in the same week merge cell by cell: the latest value of each measure wins and a blank never erases an earlier number.
- Whole numbers 0–1,000,000 in the product's unit of measure. Nothing is calculated (Off-take is entered, not derived).
- A product removed from the sheet after the phone synced is still accepted from that phone and shows on the web as "not on sheet".
- Capturing a call sheet does not change productive-call scoring (SP-0011 rule is unchanged).

## Open with Sunpride (provisional until answered)

- The original Excel template (client call 2 Oct 2026, question 10) — column order and labels may change.
- Meaning of "Take" (stock take? pull-out?) and whether Off-take should be computed as Beginning + Delivered − End.
- Unit for quantities (cases or pieces) and whether a fifth week column is wanted for days 29–31.
- Whether a captured call sheet should count as inventory retrieval for the productive-call rule.
