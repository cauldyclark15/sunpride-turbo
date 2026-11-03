# SP-0142 carried-day record

Evidence status: **NOT RUN**. This is a blank template, not measured evidence. Copy it outside the repository before filling it with private artifacts. Follow the [carried-day procedure](../REDMI_CARRIED_DAY.md).

## People, candidate and conditions

| Field                                                                | Actual value / private evidence reference |
| -------------------------------------------------------------------- | ----------------------------------------- |
| Carrier, device operator, office reviewer                            |                                           |
| Date, timezone, planned start/end                                    |                                           |
| Device model / private serial reference                              |                                           |
| Android version / build fingerprint reference                        |                                           |
| Release source commit, package, version                              |                                           |
| APK path / SHA-256 / shrunk release confirmed                        |                                           |
| API origin / matching server revision                                |                                           |
| Account type (sample or real) / private profile and device reference |                                           |
| Shared-device reservation owner and duration                         |                                           |
| Route/workload, mobile carrier, signal conditions                    |                                           |
| System Battery Saver (start/end)                                     |                                           |
| Xiaomi per-app restriction (start/end)                               |                                           |
| Autostart / background-location permission / consent                 |                                           |
| Bootstrap completion time / separate download evidence               |                                           |
| Start/end physical unplug verification                               |                                           |
| Android counter windows / UID at start and end                       |                                           |
| Raw evidence folder (restricted access)                              |                                           |

## Battery curve

Add one observed row every 15 minutes, including the start and end. Keep actual timestamps with UTC offsets and scheduled elapsed minutes separately. Mark a missing observation MISSING; do not interpolate. Record screen wakes caused by measurement. Add rows as collected; the empty row below is not a reading.

| Scheduled elapsed minutes | Actual timestamp | Battery % | Charging? | Saver / screen state | Moving / still / signal | Raw evidence / measurement overhead |
| ------------------------- | ---------------- | --------- | --------- | -------------------- | ----------------------- | ----------------------------------- |
|                           |                  |           |           |                      |                         |                                     |

## Network counters

Record cumulative counters, not an app payload estimate. Preserve the Android display units, accounting window and raw screenshot/export for each reading. Record foreground/background separately when available. Additional rows can identify a photo or reconnect interval; do not silently reset the baseline.

| Time / start or end | App UID | Window | Transport | Foreground/background/total | Received value + unit | Sent value + unit | Raw evidence |
| ------------------- | ------- | ------ | --------- | --------------------------- | --------------------- | ----------------- | ------------ |
|                     |         |        |           |                             |                       |                   |              |

## Work and interventions

| Start / end with timezone | Activity or event | Screen off / on | Signal / Wi-Fi | Photos / visits / other work | Charging, error or settings change | Evidence |
| ------------------------- | ----------------- | --------------- | -------------- | ---------------------------- | ---------------------------------- | -------- |
|                           |                   |                 |                |                              |                                    |          |

| Work reconciliation                                                 | Actual count / evidence |
| ------------------------------------------------------------------- | ----------------------- |
| Visits started / ended / office accepted                            |                         |
| Activities saved / accepted                                         |                         |
| Photos captured / acknowledged / actual uploaded bytes if available |                         |
| Other workload performed (including orders)                         |                         |
| Pending / rejected / review / held at end                           |                         |
| Remaining work after normal sync                                    |                         |
| First Start day / End day timestamps                                |                         |
| Post-End day observation window                                     |                         |

## Energy attribution

| Raw measure                                           | Actual value / unit / source and accounting window |
| ----------------------------------------------------- | -------------------------------------------------- |
| Start / final phone battery level                     |                                                    |
| Android attributed app energy (mAh if available)      |                                                    |
| Android full capacity used by the energy model (mAh)  |                                                    |
| Android app share of consumed power (%)               |                                                    |
| Screen-on duration and collection overhead            |                                                    |
| Unavailable attribution or changed battery accounting |                                                    |

Keep the model estimate separate from the real battery-level curve. Never treat app share of consumed power as share of full capacity.

## Location review

| Evidence or result                                                           | Actual value / private artifact reference |
| ---------------------------------------------------------------------------- | ----------------------------------------- |
| Correct profile, assigned device and Manila service date reconciled          |                                           |
| Scoped trail response / `truncated` value                                    |                                           |
| Raw assigned-device rows with `recorded_at` and `received_at` (if available) |                                           |
| Number of fixes / first and last recorded fix                                |                                           |
| Leading and trailing capture gaps to work-day boundaries                     |                                           |
| Largest capture gap overall / moving / still / screen-off                    |                                           |
| Receipt lag summary (NOT MEASURED if receipt times unavailable)              |                                           |
| Mock flags / accuracy issues                                                 |                                           |
| Missing or rejected pings / retained queue                                   |                                           |
| Screen-off and weak/no-signal intervals matched to trace                     |                                           |
| New fixes after End day, final stop marker, late delivery distinguished      |                                           |
| Xiaomi restricted-app behavior tested, or explicitly not tested              |                                           |

For each material gap, retain its start/end times, duration, movement/screen/signal state, raw evidence and explanation. No unexplained gap is a passing continuity result.

## Calculated results and verdict

Use a script or spreadsheet on actual inputs. Save its formulas and output. Start every row as NOT MEASURED and change only when evidence supports it. These targets are proposed, not client-signed; a single day covers only its recorded workload and settings.

| Measure                    | Formula / proposed target                                                 | Actual result + evidence | PASS / FAIL / NOT MEASURED |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------ | -------------------------- |
| Duration and endurance     | Actual 10-hour shift, start 100%, end at least 30%, no charging           |                          | NOT MEASURED               |
| Total phone drain          | Start % minus end % (percentage points)                                   |                          | NOT MEASURED               |
| App full-capacity estimate | App mAh / model capacity mAh × 100; under 15%; interpretation labelled    |                          | NOT MEASURED               |
| Mobile data                | End received+sent minus start received+sent; bytes / 1,000,000 MB         |                          | NOT MEASURED               |
| Wi-Fi data                 | Same calculation, separately reported                                     |                          | NOT MEASURED               |
| No-photo workload budget   | Under 25 MB; only if this workload/attribution was actually measured      |                          | NOT MEASURED               |
| Photo workload budget      | Under 75 MB; only if photos were actually part of the workload            |                          | NOT MEASURED               |
| Location continuity        | Capture gaps, delivery lag and every material gap explained               |                          | NOT MEASURED               |
| End-day stop               | No new moving/still fixes in the recorded post-End day observation window |                          | NOT MEASURED               |
| Delivered work             | Accepted work reconciles; unresolved queues reported, not discarded       |                          | NOT MEASURED               |

Reviewer and review date:

Overall verdict (NOT RUN / PARTIAL / PASS / FAIL): **NOT RUN**

Limitations, interruptions, missing observations and follow-up:

Redacted board summary and safe artifact references (never tokens, passwords, coordinates or private routes):
