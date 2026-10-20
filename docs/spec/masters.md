# MASTERS — BB-02/03/04/05

## F-008 — Field reporting and trial access

Positions, effective employee assignments and effective organizational parent edges represent rep → supervisor → area manager → regional manager → national. Area and regional manager are positions, not new permission roles: both retain the manager role and their own organizational scope. The marked sample includes two trial accounts for each position. Credentials remain in the existing mode-0600 trial-account record; never copy them into a document or source control.

The hierarchy bootstrap is one-shot and sample-owned. It preserves later office edits and assignment history. Inserting Area requires a strictly ordered example type rank; the bootstrap refuses to alter a territory type referenced by non-sample units rather than adopting client data. Existing account passwords and activity are preserved.

## F-009/F-010 — Geography and beats

`master_definitions` identifies a master and `master_versions` retains its effective revisions. Geography is region → area → territory → zone with validated closed WGS84 polygons, containment and parent references. The office map editor uses Google Maps polygons when configured and a Leaflet/OpenStreetMap path without a paid map prerequisite. Beat revisions hold weekdays, cycle, rep or van assignment, start/end coordinates, expected outlet count and distance. A beat references the existing operational route; it is not another route or selling engine.

Every edit supplies the prior revision and a reason. Stored versions and decisions are append-only; closing an effective interval is permitted, changing prior content is not. Historical reads still require the viewer's current scope.

## F-011/F-012 — Census, review and survivors

The field app captures a standalone census without starting a selling call. It caches authorized batch/taxonomy setup and queues one immutable signed operation in the existing encrypted SQLite outbox. Setup requests are single-flight and durably invalidate the prior answer before HTTP; a refusal cannot revive old data even if later writes fail. Offline restoration preserves the original authorization time, verified snapshot generation and existing non-bearer session fingerprint. Held/expired partitions, session or scope changes and old responses cannot renew the cache. Census and catalogue views remount on the authorization epoch. The operation includes name/address, owner contact, batch, channel/sub-channel, estimated class, GPS accuracy/provider/time/mock signal and a bounded JPEG. Recording requires a current authorized lease, a fresh non-mock fix strictly below 50 m and a photo at most 160 KiB. The existing location provider has a bounded high-accuracy census acquisition mode; ordinary visit acquisition is unchanged. The server decodes the JPEG with pixel/memory limits and reauthorizes both person and field device in the transaction.

Capture does not create an outlet. Office review accepts a new outlet, links an existing survivor or rejects the capture; batch coverage retains its explicit denominator. The estimated class stays survey evidence, not an approved F-014 assessment. A new outlet must be scored separately. Photos have scoped, non-cacheable reads.

Duplicate review combines verified-pin proximity with name/contact similarity. Merge creates an immutable survivor alias and audit, marks the duplicate inactive and does not rewrite original visit, order or financial references. `canonicalOutletId` resolves aliases with cycle/overflow checks. Existing signed historical snapshots remain authoritative.

## F-013/F-014 — One taxonomy and potential-based class

Channel/sub-channel identities are shared by census, outlet setup, MSL and import staging. Source strings remain provenance. The compatibility trigger maps legacy-only writes through the dictionary; it preserves explicit canonical identities supplied by governed imports. Known pre-existing keys have a national preview/confirm cutover with stale-preview protection, replay receipts and an audit. Unknown keys and partial conflicting assignments require individual web review; the cutover never guesses them or overwrites an existing governed decision. Accounting-customer channel mapping does not change credit, territory or money.

`currentOutletTaxonomy` is the current-read bridge for CALLFLOW/SAP consumers. It returns canonical identity/version pairs or `needs_review`, not an invented classification. Integrators should use it instead of interpreting legacy strings. It deliberately does not restate historical signed snapshots.

Potential class uses transactions per day, average basket in centavos, trading days per month and capture-rate percentage. Actual sales are not inputs. Effective policy bands, the scoring inputs, derived/assigned class, actor, reason and override explanation are retained. Legacy sample class labels are not represented as previously completed assessments; new decisions go through the governed scorer.

## F-017/F-305 — MSL and accounts

MSL framework profiles select channel, optional sub-channel, class and governed product identities. `readMslFramework` supplies stable identities and effective revision IDs to AVAILABILITY; assignment, availability checks and scoring remain owned by that lane.

Chain → banner → branch uses the same versioned master authority. Branches reference the outlet and existing accounting customer/SAP key; they do not create a second accounting or customer-finance system. Scope and parent/reference checks precede writes and replay.

## F-022 — Reviewed migration staging

The existing Imports workspace and run machinery support customers, outlet universe, route master and open AR. Staging retains source row, legacy/SAP identifiers, validations, reviewed mappings and immutable commit receipts. Duplicate existing codes require mapping to the existing identity, not duplicate creation. Original source identifiers are preserved. The office queue permits mapping and acceptance before commit.

Open AR is staged source-replica data for SAP integration, not a payment, collection, credit certification or local accounting posting. Product/pricing/credit/inventory-value authority remains SAP. No live database is reset by this feature.

## F-616 — Shared offline catalogue

Both existing Android apps source-include `packages/native-catalogue`. The same read-only search, barcode resolver, camera decoder, details and image cache are used in field and van; the H10P scanner feeds that resolver. Lookup never adds a sale, order, price or stock movement. Duplicate barcode matches require selection rather than silently choosing a product.

Catalogue content includes descriptions, ingredients, allergens, storage, shelf life, case specifications and governed UOM pack conversions. Product content has effective immutable revisions separate from pricing and stock. Sample content is explicit; SAP-owned content cannot be overwritten in the office editor. Uploaded images are normalized to bounded JPEGs and bound to uploader/product; each revision retains its own image identity. Historical image reads do not silently switch to a later photo.

The authenticated same-origin downloader refuses redirects, oversized bytes and digest mismatches, and refreshes authorization once. The content-addressed, no-backup cache is bounded to 8 MiB and 40 images, at most 512 KiB each. Bundled sample artwork permits first-use offline demonstration without a download. Source metadata is retained in encrypted bootstrap JSON; field manifest fences include catalogue revisions. The existing strict van wire validator still validates its original fields, with the optional catalogue extension decoded separately. Van clients explicitly request `catalogue: true` in the existing signed `van.bundle` projection parameters; default requests retain the exact legacy product keys, so an older strict APK is not broken by enabling the new server.

## F-008/F-009/F-010/F-011/F-013/F-014/F-017/F-305/F-616 — Needs Sunpride

All example positions, geography boundaries, beat estimates, census targets, taxonomy details, potential thresholds, MSL sets, account hierarchies and food-label content are invented editable beta data, not observations of Sunpride operations. Sample rows use the existing `sample_data_rows` manifest. Confirm reporting incumbents/scopes, actual boundaries and beats, census universe totals, taxonomy aliases, potential inputs/bands, required MSLs, SAP customer links, product artwork and verified food-label/pack specifications. None is a prerequisite for exercising the shipped sample workflow.

## F-011/F-013/F-014/F-017/F-022/F-305/F-616 — Integration seams

- CALLFLOW: use canonical taxonomy/survivor resolution and add the census/catalogue entry points to configurations where appropriate; do not fork a selling flow. Consume an approved potential decision, not a census class estimate.
- AVAILABILITY: consume the effective MSL framework identities and revision IDs; assignment is not implemented here.
- SAP: populate source-owned catalogue content/replicas and branch/customer mappings, and consume reviewed open-AR staging. Do not replace price, credit or posting authority with sample catalogue fields.
- Lead: reconcile the domain registry, seed entry points, bootstrap optional fields, source-set additions and admin/import tabs; apply migrations 0420–0427 before enabling the screens. Legacy report channel filters retain source-cohort meaning until their consumers adopt the canonical bridge.
- Release: signed beta builds are candidates; deploy the matching API/schema before publishing a native build. Physical DEV proof is not an R8 release-workflow or full-day battery/SIM-removal proof.

## F-011/F-616 — iOS parity later

iOS is unchanged and paused. Later work needs census setup/capture/review outbox parity, the optional catalogue bootstrap fields, read-only search/scan/details, authenticated bounded image caching and the same effective/scope/lease rules. Do not infer parity from the Android or API gates.
