# Fixtures

Real responses captured on 2026-11-08 from a lane API (`sunpride_lane_office`, the seeded sample company)
through the office app's own bearer (`app: "office-ios"`), as `manager@`, `viewer@` or `admin@`
(`/api/me` only). Nothing is hand-written. `signin.json` is the real sign-in response with the two token
values replaced by placeholders of the same shape (`sps_…`, `spa_…`). Error fixtures are the server's real
refusals (wrong password, a reject without a reason).

Some lists are empty on the lane (transfers, till days, Z readings, receipts, issues, store gathering); their
fixtures prove the envelope decodes, and their row models follow the web's TypeScript types.
