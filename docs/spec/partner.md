# Partner access and agency evidence

## F-322 Shared identity and isolation

The canonical DISTRIBUTOR identity tables are `distributors` and `distributor_users`, not `partner_organisations`. An agency is `distributors.partner_kind = agency`; memberships, effective intervals and exclusivity are shared. No second partner identity, outlet universe, commercial ledger or app is created. Migration 0550 contains IF NOT EXISTS compatibility definitions for those two existing tables because this lane starts from CALLFLOW, without DISTRIBUTOR. When integrated, 0500 and 0506 run first; the compatibility clauses then do nothing. The lead must retain the distributor role constraints when resolving the merged migration history and filter distributor-only accreditation/catalog workflows by partner_kind.

Portal accounts have role `agency` and no employee capabilities. Field staff retain the existing sales execution adapter plus a mandatory partner membership and explicit current shared-outlet grants. Employment type alone never grants access. A historical membership is a durable external-account marker: after expiry or revocation a sales-role login cannot fall back to internal employee access.

The HTTP facade denies partner requests outside explicitly supported route families, including future domain endpoints. Domain reads, writes, frozen exports and media independently reauthorize. Sync operations check effective membership, capture-time membership, store assignment and ownership before replay, inside the operation transaction. Commercial capture is disabled for agency staff. A field bundle contains only own planned/current assigned outlets and catalog; it withholds credit/account history, orders, partner-unowned depot inventory and buyer contact/pricing notes. Unit-wide deltas are refused with a rebootstrap instruction, not leaked as foreign tombstone IDs. Snapshot leases stop at membership/assignment expiry; membership and outlet grants enter the scope fingerprint.

WebSocket subscriptions are partner-exact. Session and grants are rechecked on invalidation delivery, not merely at subscribe. Media upload capabilities are rechecked against current ownership before and after streaming. Portal evidence media is read through the same staff/call boundary.

## F-319 Agency portal and billing evidence

Owner question: which agency staff attended and completed compliant work, what needs correction, and which days have system evidence supporting billing?

The portal uses the existing web application and shows its own staff, call attendance/completion, missing or noncompliant activities, location/late-sync/call exceptions and evidence-backed day lines. Agency-reported spreadsheets are not billing authority. Raw coordinates and employee commercial data are not exposed.

Attendance requires accepted check-in location evidence; compliant work additionally requires completed checkout, accepted checkout location, the full governed required activity set, the contract minimum dwell, no pending/rejected late evidence, and independent approval of any configured-call exception. A completed note-only call cannot satisfy a required merchandising activity. All supported 500 activities are examined, rather than a first-50 prefix. Bounds are explicit: 200 current staff, 31 days, 6,200 calls/planned stops and 500 activities per visit; overflow refuses the result.

A versioned effective contract supplies an integer-centavo day rate, minimum compliant calls and required activities. Web controls publish future contract/store-access changes in explicit Manila time and show their retained version dates. Daily billing uses the actual call's governing contract rather than midnight; mixed-version days are conservatively held for review. Generated billing packages freeze the staff/day evidence and its content hash. Identical retries return the same package. Another authorized office person signs the exact still-current hash; source changes invalidate approval, and overlapping approved periods are refused. Lines, packages and decisions are append-only. Exports reauthorize current staff/outlet membership and preserve the exact frozen facts. This is operational billing support, not a payroll or SAP payment ledger; no money is posted.

## F-319 F-322 Existing call-flow configuration

Agency staff use CALLFLOW's existing field_selling profile, definition snapshot, location policy, ordered adapter journal and outbox. Their intents are execution-only (merchandise/audit/promotion/complaint/follow-up); no parallel call writer exists. The MERCH lane supplies richer forms and merchandiser-specific definitions through the same shared engine. Existing calls and their evidence remain canonical.

## F-319 F-322 Sample data and Needs Sunpride

The additive seed creates one clearly marked fictional Cebu merchandising agency, a portal coordinator and two dedicated merchandisers. It reuses six existing sample outlets and adds 14 days of marked execution facts, including compliant and needs-action examples. These historical rows are fictional system-shaped fixtures, not proof of phone attendance. Daily advance adds missing dated examples without resetting data or overwriting office changes.

The invented editable policy is ₱650 per qualified day, one compliant call, 180 seconds dwell, required merchandising and a 100% minimum on recorded retail component scores. The minimum retail score is a versioned office-editable billing-contract field; it does not redefine MERCH's own workflow pass/fail policy. This is not Sunpride's commercial policy or permission to pay. Sunpride should confirm staff rosters, rates, day eligibility, required forms, review owners and retention. Missing answers do not block sample operation. Sample passwords are generated and stored only in a mode-0600 agency-portal-logins.json record, partitioned by database; never printed or committed.

## F-319 F-322 Seams and iOS parity later

SEAM(DISTRIBUTOR): shared tables and grants, distributor-kind filters at integration; native distributor selling remains its owner lane's shared-engine adapter, never employee access.

SEAM(ORG): field invitations add an ordinary assignment-history record for a dedicated new third-party profile; retain the identity owner's audit/epoch conventions at integration.

SEAM(MERCH): `partners/retail-seam.js` reads the canonical `retail_execution_audits` and `retail_action_cases` from MERCH migration 0540, bound to the already-authorized visit, staff and shared store. Pending incidents/follow-ups and incomplete retail audits hold qualification. Missing tables are explicitly shown as an unavailable incident feed, never zero incidents. Only clearly marked sample contracts can build evidence without that feed; ordinary agency billing refuses until integration. The fixture-backed seam is not a claim that MERCH is merged or deployed. Add MERCH's exact native op/HTTP adapter names to the partner facade only after reviewing their own visit/actor authorization; never open the full employee namespace.

## F-319 F-322 Additive migrations

0550 extends the shared distributor identity with agency kind, scoped shared-store assignments, effective contracts, immutable billing lines/packages/decisions and request/audit journals. 0551 protects contract content as an immutable version while allowing its effective end to close; it reuses CALLFLOW's version guard. 0552 retains cancelled future store grants as empty audited intervals, preventing a withdrawn grant from silently reactivating. 0553 stores the versioned minimum retail billing score; exports freeze the full governing contract policy with each call. Apply 0410–0413 first, then DISTRIBUTOR 0500–0507 when integrated, then 0550–0553. A disposable standalone lane database that already ran the compatibility definitions must not be reused as an integration database for 0500; use a fresh integration database or the existing target where 0500 has not been shadowed.

No iOS source changed. Later, prove the same partner-specific bootstrap, bounded lease, revocation/hold behavior and execution-only call configuration on iOS when that platform resumes.

## F-319 F-322 Bonus features

Internal owner cockpits, map, issue board, biometrics, ordinary PWA offline behavior and trial accounts remain. Partner portal data is online-only and excluded from the employee service-worker fallback cache.
