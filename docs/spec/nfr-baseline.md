# Performance and reliability targets to sign (F-025)

Status: **proposed by us, for Sunpride IT and Commercial to sign in Wave 0.** Deck p.34 makes these signed targets the acceptance basis for every wave. Nothing here is signed yet.

This replaces the provisional engineering draft in `docs/architecture/NON_FUNCTIONAL_REQUIREMENTS.md` as the document to sign. That draft keeps its sizing assumptions (800 mobile users, about 19,000 calls a day) until Sunpride gives real headcount; it still names the old backend and a 24-hour offline model, so where the two differ, this page wins.

How to read each row: **target** is what we ask you to sign, **how we measure** is the test we run before each wave gate, **measured so far** is what we have actually seen on the reference phones. "Not measured yet" means exactly that.

Reference devices used for every measurement below:

- Field app: Xiaomi Redmi A7 Pro, Android 16, 4 GB RAM, 720 × 1600 screen, three-button navigation. This is the floor phone (see F-021 device rollout plan).
- Van POS: Senraise H10P handheld with built-in printer and scanner.
- Release builds only (shrunk and optimised, as shipped), never debug builds.

## F-025.1 Sync time (sync SLA)

|                 |                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Target          | With any mobile signal, a saved sale, visit or collection reaches the office within **5 minutes for 95%** of records and **30 minutes for 99%**. The phone starts a retry within 60 seconds of signal returning while the app is open. A full day's backlog (one 12-hour route) clears within **15 minutes** of reconnecting on 4G. No record is ever posted twice; a record the office refuses shows on the phone for review. |
| How we measure  | Server receipt time minus phone save time for every record during the pilot, reported weekly as 95th and 99th percentile by region. Backlog test: one full offline route, then reconnect and time until the last record is acknowledged. Duplicate check: replay the same day twice and compare counts.                                                                                                                        |
| Measured so far | Duplicate-free replay is proven: an offline van credit sale, app killed and reopened while queued, produced exactly one server sale; an offline field visit with relaunch produced one delivery and no duplicate visit. A routine sync cycle on the Redmi uses about 15 KB. End-to-end percentiles are not measured yet; they need pilot traffic.                                                                              |

## F-025.2 Full 12-hour offline route

|                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Target          | With the SIM removed for a full 12-hour route, the van seller can **load, sell, print, collect, take returns, count and close the day** on the phone, then sync with **no manual fix and no duplicate**. The field rep can run the whole day's calls offline. A phone keeps selling for at least **14 hours** after its last sync (12 hours plus margin); after **24 hours** without sync it stops new sales and keeps everything already saved. |
| How we measure  | Deck p.34 rule: a real route with the SIM physically removed, not office Wi-Fi. Run once on the Redmi (field) and once on the H10P (van) before the Wave 0 gate, and again on the Wave 1 pilot depot. Pass = every document of the day is in the office after one sync, with matching totals, and nobody re-keyed anything.                                                                                                                      |
| Measured so far | Offline sale, offline credit, offline cash count with relaunch, and later clean sync are proven on the H10P against a real server. **Not yet proven:** a full 12-hour SIM-out route. Closing the van day still needs a connection today; that is being changed in Wave A (F-123), and the real-route test runs after it lands.                                                                                                                   |

## F-025.3 Device floor

|                 |                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target          | Field phone no weaker than the **Redmi A7 Pro class**: 4 GB RAM, 64 GB storage, 4G, GPS, rear camera with autofocus, battery 5,000 mAh or more. Van: a rugged Android handheld with built-in 58 mm printer and scanner (the H10P class). On the floor phone: app usable from a cold start in **under 2.5 seconds**, from warm in **under 1 second**, scrolling with **under 1% janky frames**, memory in normal work **under 150 MB**. |
| How we measure  | Five cold and five warm launches, median and worst; 16 swipes per list with Android frame statistics; memory after normal scrolling. Repeated on each release candidate.                                                                                                                                                                                                                                                               |
| Measured so far | Redmi, final field beta: usable Today cold median **1.65 s** (worst 1.67 s), warm median **0.44 s** (worst 0.48 s); Today scroll jank **0.09%**, customer list **0.00%**; memory **83–86 MiB** in normal work; app size 15.8 MB. H10P, van beta: first screen cold median **0.51 s**; product list jank **5.6%** on 40 products (above the 1% target, to be improved); 500-product catalogue search index built in **94 ms**.          |

## F-025.4 Battery per shift

|                 |                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target          | From a full charge, the field phone ends a **10-hour shift with at least 30%** left with normal use, including location sharing at the production rate (a point every few minutes while working, none after work hours). The app's own share of the battery stays **under 15% per shift**. Van handheld: a full shift on its own battery, with in-truck charging as a backup (see F-021). |
| How we measure  | Full-day test on the floor phone with Battery Saver on and screen-off periods, battery level logged every 15 minutes; Android battery statistics for the app's share. Repeat on the H10P with printing.                                                                                                                                                                                   |
| Measured so far | Only background delivery under Battery Saver is proven: 20 minutes screen-off on the Redmi, location points reached the server on the normal schedule, no rejects. Physical battery drain over a shift is **not measured yet**.                                                                                                                                                           |

## F-025.5 Mobile data per shift

|                 |                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Target          | Field rep: **under 25 MB per shift without photos**, and **under 75 MB with photos** (photos compressed to about 250 KB each). Van: **under 25 MB per shift**. A **3 GB monthly** data plan covers one user with a wide margin. The first sign-in download on a new phone is outside the daily budget and is done on Wi-Fi where possible. |
| How we measure  | Android per-app data counters, read at the start and end of the full-day tests, reported separately for photos and the first download.                                                                                                                                                                                                     |
| Measured so far | One routine sync cycle on the Redmi: **about 15 KB** (median of three). A full shift total and photo upload size are **not measured yet**.                                                                                                                                                                                                 |

## F-025.6 Availability

|                 |                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Target          | Office app and phone sync service available **99.9% per month** in production, excluding announced maintenance, which happens outside 6 am–10 pm Manila time. When the server or SAP is down, phones keep working offline within the limits in F-025.2, and SAP postings wait in a queue without loss: **99% posted within 30 minutes** once SAP is healthy again. |
| How we measure  | An outside check every minute that signs in and reads a real page; monthly uptime report. SAP queue age shown on the integration screen (F-005).                                                                                                                                                                                                                   |
| Measured so far | Not measured. Today's pilot site runs on a single machine behind a secure tunnel; it is fine for testing, not for a 99.9% promise. Production hosting is part of the cutover playbook (F-023).                                                                                                                                                                     |

## F-025.7 Print time

|                 |                                                                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Target          | The sale is saved on the handheld **before** printing, in **under 2 seconds**. From tapping Print to paper moving: **under 3 seconds** for 95% of receipts on the built-in printer, **under 5 seconds** on a Bluetooth printer. A failed print never creates a second sale; reprints are marked as reprints. |
| How we measure  | Timestamps in the app for save, print request and printer confirmation, on 50 receipts per printer model, with paper loaded.                                                                                                                                                                                 |
| Measured so far | Saving before printing and reprint tracking are built and tested. Print time is **not measured yet**: the H10P had no paper during testing, and we print at most one test receipt per change.                                                                                                                |

## F-025.8 Supported Android versions

|                 |                                                                                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target          | Both apps run on **Android 10 and later** (the apps are built for it today), and we **officially support Android 12 to 16** for the rollout fleet, on phones receiving security updates. Each new Android version is supported within 90 days of release. |
| How we measure  | Full test suite on the reference phones at every release; one extra phone per supported major version during the pilot.                                                                                                                                   |
| Measured so far | Field app fully tested on Android 16 (Redmi): 405 unit tests and the on-phone suite pass. Van app: 324 unit tests and 147 on-device tests pass on the H10P. Older versions are built for but not yet tested on a real phone.                              |

## Sign-off

| Signs for Sunpride | Role                  | Date |
| ------------------ | --------------------- | ---- |
|                    | IT (CIO)              |      |
|                    | Commercial (VP Sales) |      |

## Needs Sunpride

- Sign the eight targets above, or tell us which number to change.
- Real headcount by role and region, number of vans, and the pilot depot, so the sizing in the older draft can be replaced with real numbers.
- Approved maintenance window and who is called when the service is down.
