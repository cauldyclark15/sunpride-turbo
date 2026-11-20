# Customer visit requirements (SP-0223)

Source: 20 November 2026 client review, 16:35–17:48. The office / Sales Head sets the customer's requirement; the example is four required visits in a month. Monthly coverage-plan shortfall warnings are a separate card.

## Office use

- Customers > open a customer > Required visits > choose a frequency > Save visit frequency.
- Customers > tick customers > Set visit frequency > choose a frequency > Save visit frequency. Changes apply to the selected customers together; an inaccessible or inactive customer refuses the whole group.
- Customers > Upload customers > download the current template. The appended Visit frequency column accepts Weekly, Every 2 weeks, Monthly, or a number such as `4 times a month` (whole numbers 1–31). Existing client columns and their order are unchanged. Older files without the added column remain accepted. Blank frequency cells preserve an existing customer's requirement.
- Admin, operations and super-admin office users, and managers (Sales Head), can set the requirement within their existing customer scope. Sales and read-only users cannot change it. Managers do not gain general customer editing rights.
- An unset requirement is shown as Not set, never filled with an invented default. Add a new customer first, then set its visit frequency on its customer screen (or include it in the upload).

## Storage and contract

`outlets` is the customer authority. Migration `0835_customer_visit_frequency.sql` adds nullable `visit_frequency_per_month`; it does not rewrite old customers.

| Choice          |  visit_frequency_days | visit_frequency_per_month |
| --------------- | --------------------: | ------------------------: |
| Weekly          |                     7 |                      NULL |
| Every 2 weeks   |                    14 |                      NULL |
| Monthly         |                    30 |                      NULL |
| N times a month | max(1, floor(30 / N)) |                         N |

The days column remains a compatibility interval for existing cycle/dormancy readers. It is NOT the authority for an exact monthly target. Four times a month and Weekly both project to seven days but remain distinct because the former retains the exact count. The database checks the count range and projection together. Legacy day intervals remain readable, without rounding or rewriting them.

The customer list and detail return `visitFrequency` (plain label), `visitFrequencyDays`, and `visitFrequencyPerMonth`. Monthly shows one visit per month, an exact count shows N visits/month, weekly shows 4–5 visits/month, and every two weeks shows 2–3 visits/month. Calendar cadences are deliberately not represented as fixed four/two monthly counts; any future plan calculation must account for the calendar rather than treating the display range as an exact target.

`POST /api/v1/customers/visit-frequency` takes `{ customerIds: [...], visitFrequency: "4 times a month" }`, with 1–100 distinct customer IDs. It rechecks the persisted actor and every customer's current scope in one transaction, records before/after audit entries, then publishes customer-reference changes. Setting one customer uses this same path. Canonical customer create/update and upload accept optional `customer.visitFrequency` through the same writer. Omitting it preserves the current requirement; native field capture never changes this office-owned setting. Legacy explicit day edits switch back to a day cadence and clear the exact monthly marker; other legacy edits preserve it. The old day-count web input now links to the customer frequency editor so unrelated edits cannot accidentally change the requirement.

## Proof boundary

Regression checks use disposable lane-scoped PostgreSQL databases, real authenticated HTTP requests and a small invented customer fixture, plus real workbook read/write and React render/callback tests. These are not a live-site or client acceptance proof. No phone or monthly-plan work is included.
