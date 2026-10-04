# GPS and geofence edge cases (QSR-005, SP-0023)

Policy under test: `packages/backend/convex/visits/policy.ts` (`field-day-2026-10-v3`) and
`recordLocation` in `packages/backend/convex/visits/location.ts`. Client answer 13 (2 Oct 2026):
there is no distance limit. Location never blocks Start or End; a fix that is not clearly good is
recorded and held for supervisor review (`pending_review`). Only an impossible payload is refused.

Automated: `packages/backend/convex/visits/commands.test.ts`, describe
"GPS and geofence edge cases (QSR-005)" (convex-test, runs in `bun run test`).

| Case                     | Input                                                                      | Expected result                                      | Review   |
| ------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------- | -------- |
| Weak accuracy            | accuracy 50 m                                                              | `within_radius`                                      | verified |
| Weak accuracy            | accuracy 50.5 m, indoor cell fix 800 m                                     | `unreliable`                                         | pending  |
| Weak accuracy            | network provider at 30 m                                                   | `within_radius`                                      | verified |
| Weak accuracy            | unknown provider, mock signal                                              | `unreliable`                                         | pending  |
| Weak accuracy            | weak and far (400 m accuracy, 5 km away)                                   | `unreliable` (not `outside_radius`)                  | pending  |
| Mall / warehouse         | default 75 m pin, 120 m away                                               | `outside_radius`                                     | pending  |
| Mall / warehouse         | verified 250 m pin, 120 m away                                             | `within_radius`                                      | verified |
| Mall / warehouse         | verified 500 m pin, 480 m away                                             | `within_radius`                                      | verified |
| Mall / warehouse         | wider pin scheduled for later                                              | old radius until its effective time                  | —        |
| Mall / warehouse         | corrupt pin radius above 500 m                                             | `unavailable` (pin ignored)                          | pending  |
| Stale reading            | fix 60 s before Start                                                      | `within_radius`                                      | verified |
| Stale reading            | fix 61 s or 1 h before Start, or 61 s after                                | `unreliable`                                         | pending  |
| Denied permission        | no fix at Start and End                                                    | visit recorded, both `unavailable`, no coordinates   | pending  |
| Impossible fix           | latitude > 90, longitude > 180, negative/NaN accuracy, fractional fix time | refused `invalid_request`, nothing written           | —        |
| Outside-radius exception | reject by in-scope manager                                                 | evidence unchanged, visit kept, one decision event   | rejected |
| Outside-radius exception | other-region manager, salesperson, free-text reason, second decision       | refused                                              | —        |
| Outside-radius exception | decide a verified fix                                                      | refused `already_reviewed`                           | —        |
| Device time mismatch     | phone clock 90 s fast                                                      | `within_radius`                                      | verified |
| Device time mismatch     | phone clock 3 min fast                                                     | `unreliable`                                         | pending  |
| Device time mismatch     | phone clock 5 min slow                                                     | `within_radius` (indistinguishable from queued work) | verified |
| Device time mismatch     | fix and Start stamps 2 min apart                                           | `unreliable`                                         | pending  |
| Device time mismatch     | Start dated more than 24 h ahead                                           | refused `invalid_request`                            | —        |

## Behaviour changed by this issue

- Malls and warehouses: the verified outlet pin's own radius now applies (75 m default, up to
  500 m through the two-person pin verification, ADR-017). Previously every radius was clamped to
  75 m, so a reviewed wider radius had no effect and every mall visit went to review.
- Device clock drift: a fix stamped up to 2 minutes ahead of the server is no longer flagged;
  further ahead it is still flagged for review. Previously one second of drift flagged every fix.
- Policy version is now `field-day-2026-10-v3` (Android display mirror updated).

## Manual checks still needed on real phones (field pilot)

Software tests cannot reproduce real radios. During the Cebu pilot, a tester with a real phone
should record, per case, the accuracy and result shown in the supervisor trace:

1. Inside a large mall (e.g. SM City Cebu) far from the entrance, with a 250 m verified pin.
2. Inside a warehouse with a metal roof, with the default pin, then with a wider verified pin.
3. Location permission denied, then location services switched off (Android and iOS).
4. Airplane mode at Start, End delivered later the same day.
5. Phone clock set 5 minutes ahead manually.
