# Live map (SP-0135)

Field → **Live map** shows where field agents and van-sales trucks are right now, and one
person's route for a day. It updates in real time (Convex subscriptions); nobody refreshes
the page.

## What it shows

- **Markers**: a round badge with initials for a field agent, a square truck badge for a van.
  Colour = status, worked out from the age of the last position:
  - **Moving** (green): last position under 3 minutes old and moving (speed ≥ 3.6 km/h or the
    phone said it is moving).
  - **Idle** (blue): under 3 minutes old and standing still, or 3–10 minutes old.
  - **Stale** (amber): 10–30 minutes old.
  - **Offline** (grey): over 30 minutes old, or the person ended their day / the trip ended.
  - Positions older than 24 hours are not shown at all.
- **Stores**: small white squares at verified store pins in your scope (shown from zoom 11).
- **Clusters**: when zoomed out, markers close together become one dark badge with a count;
  click it to zoom in.
- **Side list**: everyone on the map with last seen, speed, battery, GPS accuracy, the store
  they are calling on, and a "Mock location" warning if the phone reported a fake location.
- **Day trail**: pick a person (list row or marker) to draw their day as a line, with their
  store check-ins numbered in order and their times. Pick another day with the date field.
  The map zooms to the trail; with no trail it zooms to everyone shown.
- **Filters**: area (org unit), team, agents / trucks, status, and a name or plate search.

## Who sees what

Capability `location.read` (see `docs/architecture/RBAC_SCOPE_MATRIX.md`):

| Role                       | Sees                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| super admin, analyst       | everyone (analyst read-only)                                                              |
| admin, operations, manager | people whose **current** unit is in their scope; trucks whose trip unit is in their scope |
| sales                      | only themselves                                                                           |
| approver, viewer           | no access (tab hidden)                                                                    |

The server enforces this; hiding the tab is only convenience.

## Map provider

- `NEXT_PUBLIC_GOOGLE_MAPS_KEY` set → Google Maps JavaScript API (loaded with the
  official `@googlemaps/js-api-loader`). Use a **browser key restricted to the site's HTTP
  referrers and to the Maps JavaScript API; it is public by design (it is in the page).
  (The issue suggested `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`; the repository secret audit
  treats any `*_API_KEY` build variable as a server secret and fails the build, so the
  public browser key is named `…_MAPS_KEY`.)
- `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` (optional): a Google Cloud map ID. Without it Google's
  `DEMO_MAP_ID` is used (needed for the marker style).
- Key empty, or Google fails to load → the OpenStreetMap map (Leaflet) is used instead, so
  development, tests and the beta work without a key.

Both are build-time variables (rebuild the web app after changing them).

## Where the positions come from

The phones send batches of positions to the backend:

- Field apps: `POST /mobile/v1/location` (type `location.request`).
- Van POS: `POST /van/v1/location` (type `van.location.request`, every position carries the trip).
- Contract: `packages/domain-contracts/schemas/{mobile,van}-v1.schema.json`, fixtures
  `fixtures/{mobile,van}-v1/location-*.json`.

Rules (our defaults, `packages/backend/convex/location/model.ts`):

- Tracking only during work. Field: from the day's first check-in or Start day until End day
  or sign-out, and never after the 10 PM Manila close (the server refuses positions recorded
  between 10 PM and 5 AM). Van: only while the trip is active (server checks the trip).
- Cadence on the phone: every ~60 s or 50 m while moving, every 5 minutes when still.
  Offline positions wait in the phone's encrypted outbox and upload in batches of up to 100.
- Each position: latitude/longitude, accuracy, speed, heading, battery %, mock-location
  flag, device time; the server adds its own receive time.
- Same request signing as sync; the device, person and scope are re-checked in the writing
  transaction (a suspended or moved phone is refused).
- Idempotent per phone and position ID (`duplicate` = already stored). At most one position
  per person every 10 seconds (`too_frequent`); older than 7 days is `too_old`.
- Kept 90 days; a daily job (03:40 Manila) deletes older positions.

The phone side (consent screen, "Location sharing on" indicator, background location) is
separate app work; this issue ships the backend, contract and web map.

## Sample data (beta)

Until real phones send positions, the beta can show made-up trails for the sample sales
tester (Rhea Santos, field app) and the van tester's truck (SMP-TRK-01) around their Cebu
routes. They are marked sample and the map says so.

```bash
cd packages/backend
bunx convex run beta/sample_live_map:seed '{}'    # today's trails (replaces earlier sample)
bunx convex run beta/sample_live_map:clear '{}'   # remove; repeat until isDone
```

Only testers who have signed up get a trail. Clear the live-map sample before running
`beta/sample:reset`.
