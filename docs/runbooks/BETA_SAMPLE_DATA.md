# Sample company data on v2

All invented data is explicitly marked through `sample_data_rows`; it is not Sunpride product, price or operational truth. `packages/db/seed/run.js` adds idempotent rows to a migrated PostgreSQL database. `daily.js` advances demo days; optional spec/SAP helpers extend the same company rather than creating a second domain engine.

Supply `DATABASE_URL` privately and run `bun packages/db/seed/run.js`. Options are defined in that file, including `--spec` and `--sap`. The sample password is read privately by seed code; never print it or embed it in docs. Trial-account generation has its own protected record and must not rotate unrelated tester credentials.

Never reset the shared showcase. A reset is an explicit sample-only operation in an isolated database, with dependency and referential-integrity checks. It is not a migration or a safe way to repair live stock. Old board exports are not a default seed source; existing board facts stay in PostgreSQL.

For source/SQL verification run `packages/db` tests and the relevant API seed/integration tests with `SP_LANE=<lane>`. A populated demo is not proof of real SAP, physical-phone or client acceptance. See [release and cutover](../spec/release-and-cutover.md).
