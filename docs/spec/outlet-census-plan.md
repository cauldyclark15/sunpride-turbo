# Outlet census field plan (F-011, operations side)

Status: **our recommended plan.** The census is a physical field exercise that Sunpride runs with survey crews; our part is the tool, the rules and the daily review. Deck p.13 and p.18 put the census on the critical path: five to six weeks, only with three or four survey crews working in parallel. Deck p.16 recommends running it on a survey tool rather than waiting for the full offline selling app; our census mode is that tool.

Wave 0 exit criterion 1 (deck p.18): **outlet master deduplicated and 98% geocoded within 50 m in the pilot territory.**

## F-011.1 What each outlet record must carry

From the spec (F-011): name, address, GPS to under 50 m, storefront photo, owner contact, channel, estimated class. We also record, automatically: GPS accuracy, time of the fix, who captured it, and the phone used. These are what let the office trust the pin.

| Field                    | How it is captured                                                                   | Rule                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Outlet name              | Typed                                                                                | Required. As shown on the signboard; "No sign" plus the owner's name if none. |
| Address                  | Typed, with barangay and city picked from a list                                     | Required. Street or landmark.                                                 |
| GPS pin                  | Taken by the phone at the storefront                                                 | Required. Accuracy 50 m or better (see F-011.3).                              |
| Storefront photo         | Camera, inside the app only                                                          | Required. Whole front, signboard visible. Gallery photos are not accepted.    |
| Owner or manager contact | Name and mobile number                                                               | Required where the owner agrees; "Declined" is a valid answer.                |
| Channel and sub-channel  | Picked from the controlled list (F-013)                                              | Required.                                                                     |
| Estimated class          | Picked A, B, C or D, from a few simple questions (shelf size, chiller, foot traffic) | Required. Final class is set later by the class rules (F-014).                |
| Currently buys Sunpride? | Yes / No / Not sure                                                                  | Optional, helps coverage planning.                                            |

## F-011.2 The tool: census mode in the field app

- A census mode inside the Sunpride Field Android app, built in Wave A by the Masters lane. Survey crews sign in with census-only accounts: they can capture outlets, nothing else.
- Works fully offline. Each crew member's day is one batch; it syncs whenever there is signal.
- The office sees each day's batches on the web, with pins on a map, photos, and a review queue for warnings (weak GPS, likely duplicates, missing fields).
- Census records do not become selling outlets until the office approves them. Approval creates the outlet in the one outlet master (F-012).

## F-011.3 The 50 m rule

- The phone shows the current GPS accuracy while the crew member stands at the storefront. **Save is allowed only when accuracy is 50 m or better.**
- If accuracy stays worse than 50 m for two minutes: step outside any building or covered market, wait, try again. If still above 50 m, save with the reason "Weak GPS here"; the record goes to the review queue and does not count toward the 98%.
- Fixes from fake-GPS apps are refused (F-024).
- Pins older than 60 seconds are not used; the phone takes a fresh fix for each outlet.
- **Back-check:** each supervisor revisits a random 5% of each crew's outlets in the same week. A census pin more than 50 m from the back-check pin fails; a crew with more than 2% failures redoes that day's area.

## F-011.4 Duplicates

- **On the phone:** when a crew member starts a new outlet within 30 m of one already captured (by anyone, once synced) or already in the master, the app shows it and asks "Same outlet?" before creating a new one.
- **In the office:** every night the system lists likely duplicates: pins within 50 m with similar names, or the same mobile number. Each pair is reviewed and either merged (one survivor keeps its history) or marked as different. Nothing uncertain is merged automatically (F-012).
- Existing outlets from Sunpride's current lists and SAP customers are loaded first (F-022), so the census confirms or corrects them rather than creating second copies.
- The pilot territory passes when no likely-duplicate pair is left unreviewed.

## F-011.5 Crews and capacity

Recommended crew: **one supervisor and three enumerators**, each with a floor phone (F-021) and a power bank. Three or four crews in parallel, as the deck asks.

Planning numbers (ours, to be confirmed in week 1): an enumerator captures about **35 outlets a day** in dense urban areas and **20 a day** in rural areas, over 5.5 working days a week.

| Crews | Enumerators | Urban outlets per week | Over 5 field weeks |
| ----- | ----------- | ---------------------- | ------------------ |
| 3     | 9           | about 1,700            | about 8,700        |
| 4     | 12          | about 2,300            | about 11,500       |

Sunpride has not given us the expected outlet universe. If it is larger than the four-crew figure, add crews rather than weeks: the deck notes this is the one census constraint money can shorten.

## F-011.6 Timeline: 5 to 6 weeks

| Week                       | What happens                                                                                                                                                                   | Done when                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 0 (prep, before the clock) | Split each territory into blocks on a map, one block per enumerator-day. Hire and train crews (half a day, including the 50 m rule). Enrol phones. Load existing outlet lists. | Every block assigned; every crew member has done a practice capture. |
| 1                          | Pilot territory with all crews. Measure real outlets per day, accuracy failures and duplicate rate; adjust the block plan.                                                     | Pilot territory fully covered.                                       |
| 2 to 5                     | Remaining territories, crews in parallel. Office reviews each day's batches the next morning. Back-checks every week.                                                          | Each territory 98% within 50 m and duplicates reviewed.              |
| 6                          | Mop-up of missed or closed-on-the-day outlets, final back-check, close the duplicate queue, sign-off.                                                                          | Wave 0 exit criterion 1 met in the pilot territory and reported.     |

## F-011.7 Daily report to the census lead

Outlets captured today and to date, by crew and territory, against the block plan; share within 50 m; outlets waiting for review; duplicate pairs open; back-check failures. This comes from the census review screen; no spreadsheet.

## Needs Sunpride

- A census lead on Sunpride's side, the pilot territory, and the survey crews (own staff or an agency).
- Expected outlet universe per territory, if known, and any existing outlet lists to load first.
- Confirmation of the channel list (F-013) and the simple class questions (F-014) before crews are trained.
- Consent wording for owner contact details and storefront photos.
