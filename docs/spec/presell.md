# PRESELL: pre-sell, dispatch and electronic proof of delivery

## F-301 — order today for a defined delivery day

This extends the existing field order draft, immutable visit activity and commercial order writer. It is a `pre_sell` channel profile of CALLFLOW, not a new app, visit engine or price authority. The sample channel key is `gt_presell`; the existing office Call flows editor owns channel bindings and step publication.

Requested delivery dates are captured offline with the order and validated against an effective-dated Manila cut-off/lead/horizon policy using capture time, not upload time. Commercial capture freezes the policy. Confirmation is an independently authorized office action after the existing source order is approved or posted. Requested and confirmed dates remain separate. The confirmed date must be on/after the request and within its frozen SLA. An immutable handoff cannot be silently rescheduled under the same order identity.

## F-302 — handoff, not another order or ledger

Confirmation writes a durable `delivery_handoffs` outbox in the same transaction as the confirmed promise. Its snapshot includes the existing canonical order lines, exact base-unit conversions, requested/confirmed days and policy. Retry is idempotent; the worker locks the outbox, rechecks source-order state and creates exactly one drop with its line allocation. A source order that has been voided cannot be released. Unassigned handoffs may be cancelled without deleting or changing the original order. Source order access is rechecked before office replay and detail/manifest reads.

`SEAM(SAP)`: the local handoff adapter acknowledges a stable `MOCK-DELIVERY-…` upstream reference with `source=mock_sap`. It is a logistics acknowledgement, not an SAP financial posting, credit check, valuation or stock movement. No local balances, ledger entries or credit exposure are rewritten by this lane. The SAP lane must replace the adapter with its mock-service/real configuration contract at integration. Failed outboxes remain visible for explicit retry.

## F-303 — dispatch and the configured driver step

Dispatch is inside the existing Vans & cash workspace, under Pre-sell dispatch. It answers which deliveries need action: target/prior weekday/eight-day trend, unconfirmed/failed/door-variance exceptions, truck/driver assignment, complete drop reordering and a printable driver manifest. Scheduling requires the existing trip's scope and confirmed day. Released runs freeze assignment and sequence.

The existing van POS downloads `deliveryDrops` additively in its v2 bundle, stores them with the existing encrypted trip snapshot and adds `delivery.confirm` / `delivery.timing` to its existing outbox. Frozen v1 schemas are unchanged. Driver delivery is the `driver_delivery` CALLFLOW profile: check-in → delivery confirmation → check-out. The authoritative proof writer calls the existing shared engine's `advance`; arbitrary `call.step` cannot mark delivery complete. Existing no-order semantics are retained: a delivery-only call uses the explicit controlled reason “Delivery only — no new sale at the door”; it never invents a new van sale.

A proof requires every allocated line, receiver name, bounded normalized signature points, a device/trip/subject-bound uploaded JPEG, capture time and reliable in-radius geo fix. The native adapter burns outlet, person, Manila timestamp and coordinates into final-size JPEG pixels before hashing/private storage. The existing photo transport uploads those exact bytes before sending the proof. Proofs are immutable, one per drop, with exact replay and single-use photo linkage. Completing a delivery does not automatically fulfill or rewrite the source order; SAP must acknowledge financial effects separately.

`SEAM(INTEGRITY)`: the server binds structured watermark facts to the uploaded digest and device/trip/actor, while the native encoder renders the pixels. It does not independently recognize text in a JPEG, attest OS integrity or certify physical presence. No sample-coordinate test is a physical-route attestation.

## F-304 — door variance

Accepted + short + rejected + damaged base pieces must equal each frozen allocated line exactly. Negative/fractional/overflow/duplicate/missing lines fail closed. A controlled, policy-snapshotted reason is required for every variance; note and delivered batch can be retained. Signature, photo and geo evidence are shared with the immutable proof, rather than detached free-text exceptions. Original order lines, prices and payments remain unchanged. Durable compensation requests are marked `pending` then `mock_acknowledged`; neither status means an actual SAP credit memo or canonical inventory posting.

## F-308 — appointments and receiving slots

Dispatch creates dated store receiving slots with capacity and reference, books/reschedules an unstarted drop under a slot lock, and freezes its arrival window. Concurrent bookings cannot overfill capacity. Existing bookings retain their history. Driver arrival/unloading/departure times are ordered captured facts in the same offline outbox; arrival outside the window requires a reason. No office inference substitutes for a driver's actual event.

## F-612 — notification outbox and dev sink

An explicit consenting SMS/email recipient plus future ETA on the confirmed day creates a durable notification outbox. The idempotent mock adapter writes one dev-sink message per notification and never calls an external service. Dispatch exposes message state/attempts; `/api/v1/presell/sink` is restricted by integration permission AND each source order's current scope. Provider credentials, consent storage/preferences and real delivery receipts must be wired by the integration owner before enabling real sends.

## F-301 F-303 F-304 — Needs Sunpride

All values are our editable, clearly sample-marked defaults: `gt_presell` channel, 14:00 Manila cut-off, one-day minimum lead, 30-day request horizon, up to two days after the requested day for confirmation, 98% ePOD target; reasons for short load, buyer rejection and door damage. Sunpride confirms receiving-capacity policies, actual delivery SLAs, signature/refusal procedure, approved SAP interfaces and message consent/provider. Missing inputs are not a software blocker. Policies publish prospectively from the dispatch editor; captured promises keep their old policy.

## F-301 F-303 — iOS parity later

iOS remains paused and untouched. Later add delivery-date draft/activity capture, the cached cutoff policy, dispatch-status reading and the same shared-engine channel semantics. No iOS parity is claimed.

## F-301 F-302 F-303 F-304 F-308 F-612 — integration and proof boundaries

Apply additive migration 0530, run the additive `ensurePresellSamples` seed and bind selected sample stores to the sample channel through the existing master/channel controls. Do not reset the showcase. The lane API is port 4560 with `SP_LANE=spresell`; no showcase/tunnel is restarted. Gates, exact screenshots, phone limitations and remaining work are recorded in the external PRESELL report. Unit/API tests are not proof of a SIM-removed route, real SAP posting, paid SMS/email delivery, fiscal accreditation or production 98% performance. Bonus features and existing financial/stock writers remain.
