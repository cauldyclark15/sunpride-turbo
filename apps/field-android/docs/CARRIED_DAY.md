# One carried work day on the Redmi (SP-0142, AND-PERF-002)

SP-0140 measured start-up, memory, scrolling and a bounded asleep-phone location run. The full-day
figures below need the reference phone (Xiaomi Redmi A7 Pro, `HD611L161114`) **carried through a
real work day by a person**. Nothing here can be simulated at a desk; this page is the checklist
and the place to write the result.

Pass mark (from the issue): app battery share, mobile data, and **no location gap longer than the
cadence** (1 min while moving, 5 min while still) from Start day to End day.

## Before the day (evening before or morning, on the Mac)

1. Charge the Redmi to 100 %.
2. Install the release build: the `perf` build (`com.sunpride.field.dev.perf`, SP-0140) or the beta
   APK (`com.sunpride.field.beta`). Not a debug build: debug is slower and heavier.
3. Sign in with a sample field account (beta sample data, SP-0129).
4. Battery guide (opens after Start day, or from Today's "Keep sharing on all day" card):
   app battery saver → **No restrictions**; Security → **Autostart** on.
5. Turn the phone's **battery saver on** (the cheap-phone worst case) and note it below.
6. Leave Wi-Fi as the person normally would and note it (the data split shows both anyway).

## Start of the day (phone on the USB cable for one command only)

```bash
PKG=com.sunpride.field.dev.perf apps/field-android/scripts/measure-day.sh start
```

Unplug, open the app, press **Start day**. (`measure-day.sh` ships with SP-0140; use
`PKG=com.sunpride.field.beta` for the beta APK.)

## During the day

Carry the phone as a sales rep would: travel between stores, do a few check-ins/visits, leave it
in a pocket or bag between stops, let the screen sleep. Do not plug it in. Note roughly when you
were travelling and when you were inside stores; it helps explain any gap.

## End of the day (before charging)

1. Press **End day** in the app.
2. Plug in and run, before the phone starts charging for long:

   ```bash
   PKG=com.sunpride.field.dev.perf apps/field-android/scripts/measure-day.sh stop
   ```

   It prints the app's battery share (mAh, Android's estimate) next to the phone's total, and the
   app's data split into background/on-screen and Wi-Fi/mobile.

3. Read the location trail for gaps. From `packages/backend`, against the deployment the phone
   used (read-only; this does not push anything):

   ```bash
   bunx convex data locationPings --format jsonLines --order desc --limit 5000 > "$TMPDIR/day.jsonl"
   cd ../.. && bun scripts/location-trail-gaps.ts "$TMPDIR/day.jsonl" \
     --profile <profileId of the sample account> --date <YYYY-MM-DD Manila>
   ```

   (The `location/queries:trail` result the web live map loads works too:
   `bun scripts/location-trail-gaps.ts trail.json`.) It prints PASS/FAIL, each shift from Start
   day to End day in Manila time, the battery level the pings carried, the largest gap and every
   gap over the cadence with whether the phone was moving or still across it. Exit 0 = no gap.

   A gap is judged against the moving cadence when the phone travelled across it (closing ping
   "moving", walking speed at either end, or 50 m+ displacement beyond the fixes' accuracy),
   otherwise against the still cadence. One minute of grace is allowed on each, because the app
   decides moving/still only when a balanced-power fix arrives (about once a minute). Time between
   End day and the next Start day is off duty and never counts.

## Result

Copy the printed lines here (and into `PERFORMANCE.md` once SP-0140 is merged).

| Field                                  | Value |
| -------------------------------------- | ----- |
| Date (Manila), who carried it          |       |
| Build (package, version)               |       |
| Battery saver / Wi-Fi                  |       |
| Start day → End day (Manila)           |       |
| Battery 100 % → end %                  |       |
| App battery use (mAh, share of total)  |       |
| App data: mobile (background / screen) |       |
| App data: Wi-Fi (background / screen)  |       |
| Pings (moving / still)                 |       |
| Largest location gap (moving/still)    |       |
| Gaps over the cadence                  |       |
| Verdict                                |       |

If a gap shows up, note what the phone was doing then (pocket, inside a mall, no signal, screen
off for long) and file it against the field app with the trail-gaps output attached.
