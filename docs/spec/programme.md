# Spec lane PROGRAMME: governance and traceability

Covers F-025 (performance targets to sign, plus the traceability page), F-011 (census, operations side) and F-021 (fleet rollout, operations side). Lane documents:

- `docs/spec/nfr-baseline.md` — F-025 targets to sign, how each is measured, what is measured so far.
- `docs/spec/outlet-census-plan.md` — F-011 census crews, tool, 50 m rule, duplicates, 5–6 week timeline.
- `docs/spec/device-rollout.md` — F-021 device floor, printer, data, MDM, spares, charging.
- Client crosswalk workbook (outside the repo): `~/Downloads/Sunpride spec crosswalk.xlsx`.

## F-025 Programme page (traceability)

- Tables `spec_waves` and `spec_features` (migration `0480_spec_features.sql`). One row per spec feature (146: F-001…F-616 and F-R01…F-R08) with the client's columns, our status, "what we have now", "what we will do", our lane/when, and whether it is in the deferral pool D-10.
- Status values: `built`, `partly_built`, `changing_to_spec`, `not_built`, `needs_sunpride`, `conditional`; shown as Built / Partly built / Being changed to match your spec / Not built yet / Needs Sunpride / Conditional.
- Source of truth: `packages/db/seed/spec-features.json`, loaded by `seedProgramme(db)` in `packages/db/seed/programme.js` (CLI `DATABASE_URL=… bun packages/db/seed/programme-run.js`). Upsert by feature id; a repeat changes nothing; a changed row updates only that row. Status is updated by editing the JSON and rerunning the seed. The page is read-only.
- Statuses come from the 2026-10-20 gap analysis (HAVE→Built, PARTIAL→Partly built, CONTRAST→Being changed, MISSING→Not built yet, NON-SOFTWARE→Needs Sunpride, Track R→Conditional). As Wave A lanes land, the lead updates the JSON.
- Wave exit criteria and go/no-go owners are copied from the delivery-approach deck pages 18–32; Track R shows its gate to start (business case D-07).
- API: `GET /api/v1/programme/overview`, capability `admin.manage` (super admin and admin). Returns `{loaded, featureCount, totals, statusLabels, waves:[{code,name,months,goNoGoOwner,exitCriteria,counts,featureCount,mustCount,blocks:[{id,name,features:[…]}]}]}`. An empty table returns `loaded:false`, shown as "Needs setup", never as zero features.
- Web: Setup → Programme (`/programme`), administrators only. Calm read-only page: totals by status with the next action (features waiting on Sunpride), wave tabs, each wave's months, go/no-go owner, exit criteria and counts, then blocks and features with plain status, now/next and lane/when.
- Not a raw-ID screen in the usual sense: feature IDs are shown on purpose, because they are the client's own reference numbers.

## Needs Sunpride

- Sign the F-025 targets (`nfr-baseline.md`).
- Census lead, crews, pilot territory and outlet universe (`outlet-census-plan.md`).
- Device counts, MDM, network and procurement owner (`device-rollout.md`).
- The full list of client inputs is the `Needs Sunpride` sheet in the crosswalk workbook.
