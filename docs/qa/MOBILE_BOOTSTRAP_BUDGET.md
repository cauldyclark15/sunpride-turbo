# Native bootstrap budget and completeness

Current v2 implementation: `apps/api/src/core/sync.js` and `apps/api/src/domains/fieldsync/projections.js`. The old in-memory timing figures and service-specific transaction quotas are not measurements of the PostgreSQL runtime and are intentionally not retained as acceptance results.

## Source limits

The core exports separate bounded limits for ordinary operations, location operations, snapshot pages and delta pages. Working-set projection code must either page the entire authorized set or explicitly refuse overflow. A truncated prefix must never look complete. Stable snapshot generation, current assignment and scope fingerprints guard continuation.

## Required measurements

Use a migrated isolated lane database with realistic route/product/barcode history. Record actual page count, complete JSON bytes, gzip bytes if compression is actually active, per-page server latency, total download time and phone memory. Include late active barcodes after an inactive prefix, empty filtered pages, changed plan/reference data mid-page and withdrawn authorization. Never claim public compression or physical-phone performance from a fixture test.

Run the isolated API `test/fieldsync.test.js`, `test/sync.test.js` and `test/analytics-performance.test.js`, then the assigned physical-device proof when authorized. No timeout, assertion or threshold should be relaxed for a loaded host; record uptime and retry the unchanged timing test alone. iOS delivery is paused.
