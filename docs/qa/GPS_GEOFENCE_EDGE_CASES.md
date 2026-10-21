# GPS and geofence edge cases

Current source: `apps/api/src/domains/visits/location.js`, `commands.js`, `shared.js`, plus `domains/fieldsync/location.js` and integrity capture policy. Current tests: `apps/api/test/visits.test.js`, `fieldsync.test.js` and `spec-integrity.test.js`.

Verify fresh versus stale fix, approximate/denied permission, clock skew, mock-location report, invalid coordinates, historical pin version, outside-radius evidence, off-plan visit, late arrival and scope withdrawal. Preserve raw observation independently of certification and managerial exception decisions. No self-approval; a location fact is not automatically productive-call or per-diem evidence.

Run the isolated API suite with real SQL and record the candidate/log/count/exit. Physical capture, OEM permission/battery behavior and the whole offline route require the assigned real phone and separate evidence; neither a synthetic coordinate nor a test fixture is a real GPS fix. iOS delivery is paused.
