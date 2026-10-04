# Mobile bootstrap size and duration (QSR-013)

Status: implemented and tested with convex-test. Production timings on DEV and on pilot phones in
Cebu are still to be measured (see "Still to measure").

## What a bootstrap carries

One salesperson's own signed visits for Manila today plus the next two days (`HORIZON_DAYS = 3`),
the outlets, linked customers and route behind those visits, open field tasks, the activity-form
rules, the photo types and one Annex C call sheet per visited account. There is no product catalog
and no prices (`productCatalog: []`, prices unavailable). Every page is rebuilt from the same signed
manifest, so a page never mixes two versions of the day.

## Representative territories

Client call of 2 Oct 2026, answer 1: Route Sales, PMOT, PMOT Extruck and pre-booking carry 30 calls
a day; KAS and Booking carry 5. With a three-day horizon that is at most 90 visits for a route
salesperson and 15 for KAS.

Measured by `packages/backend/convex/mobile/bootstrap_budget.test.ts` (in-memory convex-test, one
full download at the phone's default `limit: 100`; text is pseudo-random so gzip is not flattered):

| Territory                                                  | Visits | Pages | JSON total | Largest page | gzip total | Index ranges / page | convex-test time |
| ---------------------------------------------------------- | -----: | ----: | ---------: | -----------: | ---------: | ------------------: | ---------------: |
| KAS: 5 calls/day, 60-line sheets                           |     16 |     1 |     209 KB |       209 KB |      30 KB |                 353 |           ~20 ms |
| Route sales: 30 calls/day, 25-line sheets                  |     91 |     3 |     582 KB |       258 KB |     110 KB |                 863 |          ~120 ms |
| Route sales, every sheet full (100 lines, 200-char fields) |     91 |     9 |     2.1 MB |       257 KB |     425 KB |               1,163 |          ~720 ms |
| Bound: 199 visits, 600 distinct products                   |    199 |     — |          — |            — |          — |               2,411 |                — |

(The fixture always holds one extra visit without a call sheet, hence 16 and 91.)

The call sheets dominate the size. A visit row with its outlet and customer is about 0.5 KB; a full
100-line sheet is about 20 KB.

## Enforced bounds

All in `packages/backend/convex/mobile/budget.ts`.

| Bound                        | Value                                | Why                                                                                                                                                   |
| ---------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visits in the working set    | 200 (`MAX_WORKING_SET_VISITS`)       | More than twice the 90-visit route-sales maximum. Checked before any visit is projected.                                                              |
| Distinct call-sheet products | 600 (`MAX_WORKING_SET_PRODUCTS`)     | Each costs two Convex index ranges. With 200 visits the projection uses about 2,400 of the 4,096 ranges a Convex transaction allows.                  |
| Uncompressed bytes per page  | 256 KiB (`MAX_BOOTSTRAP_PAGE_BYTES`) | Pages are cut by entry count **and** bytes. A page then fits the phones' 20 s read timeout even uncompressed on a slow (about 200 kbit/s) connection. |
| Pages per snapshot           | 40 (`MAX_BOOTSTRAP_PAGES`)           | The iOS client stops after 50 pages and Android after 100.                                                                                            |
| Visits per day (existing)    | 500                                  | Unchanged index-scan guard.                                                                                                                           |

Exceeding a bound is an explicit failure, never a truncated day: the query throws
`working_set_too_large` and the gateway answers HTTP 413 with v1 code `invalid_request`,
`retryable: false` (the v1 error codes are frozen). The phone reports the download as failed and
keeps the snapshot it already has. The fix is in the office: split the plan or trim the account's call sheet. A delta pull
recomputes the same projection, so it fails the same way until the plan is fixed.

## Response strategy

- **Byte-bounded pages.** `limit` (1–100) is still honoured, but a page may hold fewer entries when
  the next entry would push it over 256 KiB. Clients already page until `nextPageCursor` is null, so
  this is compatible with the v1 clients. A single visit larger than the page budget is refused
  rather than sent oversized.
- **One call sheet per account per snapshot.** A sheet ships with the first visit to its outlet; a
  later horizon day at the same outlet does not repeat it. Both native clients merge sheets across
  pages and require each page's sheets to belong to that page's visits, which still holds.
- **gzip.** Bootstrap and pull responses of 1 KiB or more are gzipped when the request's
  `Accept-Encoding` allows gzip (OkHttp and URLSession send it and inflate transparently). The
  response carries `content-encoding: gzip` and `vary: accept-encoding`. If the Convex runtime has no
  `CompressionStream`, or compression fails, the same JSON goes out uncompressed. Pessimistic text
  compresses about 5–7×.
- **Fewer reads.** Each plan and each outlet (scope and pins) is read once per projection rather than
  once per visit.

## Startup experience

Estimated download for a full route-sales day, from the measured sizes:

| Connection         | Typical day (110 KB gzip) | Full sheets (425 KB gzip) | Uncompressed fallback, full sheets (2.1 MB) |
| ------------------ | ------------------------: | ------------------------: | ------------------------------------------: |
| 3G, about 1 Mbit/s |                 about 1 s |               about 3–4 s |                                  about 17 s |
| EDGE, ~200 kbit/s  |                 about 5 s |                about 17 s |                        about 85 s (9 pages) |

Plus one device challenge and one signed request per page. The phones keep yesterday's snapshot until
a complete new one is staged, so a slow or failed download never blanks the day already on the
phone (NFR: cached day visible within 3 s warm launch; first bootstrap is measured separately).

## Still to measure (needs DEV deploy and pilot phones)

1. After the lead deploys: `curl -sv --compressed` against `/mobile/v1/bootstrap` with a real
   signed request, and confirm `content-encoding: gzip` reaches the client. If the Convex runtime
   lacks `CompressionStream` the header is absent and bodies are uncompressed; record which.
2. Server time per page on DEV for a seeded route-sales day (Convex dashboard function logs for
   `mobile/bootstrap:snapshot`).
3. On one iOS and one Android pilot phone in Cebu, on the field network: time from starting
   a download to the route list, for a real route-sales and a real KAS assignment.
4. Real call sheet sizes once Sunpride sends the Annex C Excel template (number of lines per
   account, text lengths). Adjust `MAX_WORKING_SET_PRODUCTS` if their catalog per salesperson is
   larger than 600 SKUs.

## Follow-up

Coverage plan approval does not yet refuse a plan whose three-day window exceeds 200 visits for one
person; today the phone learns it at download time. Rejecting it at approval would give the office
an earlier message.
