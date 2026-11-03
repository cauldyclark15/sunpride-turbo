# Controlled Cebu van-sales pilot

Tracker: SP-0122 (QSR-020), milestone 16 — Van POS pilot (Cebu).

## Status and purpose

Preparation only. The Cebu field pilot has NOT RUN. No participant, date, truck, customer transaction, physical stock count, cash handover, printed receipt or client sign-off is recorded by this document. The [blank results sheet](../qa/templates/CEBU_VAN_SALES_PILOT_RESULTS.csv) starts with every checkpoint `NOT_RUN`.

The owner question is: can one real van day account for every sale, item of stock and cash handover, without losing offline work or posting it twice? A software test, sample route, mock SAP response or local rehearsal does not answer that field question.

Recommended first scope (our proposal, not a Sunpride instruction): one Cebu truck, one named seller and assigned handheld, one agreed route with three to five consenting stores, and one complete selling day. Use existing authorized equipment; this plan does not authorize purchases, deployment, installation, data resets or real financial posting. Do not expand until the day's evidence is reconciled and signed.

## References and precedence

- [Van UAT scenarios and sign-off sheet](../qa/VAN_SALES_UAT_SCENARIOS.md): the business-scenario inventory. Reuse its scenario IDs; retain a completed copy with the run evidence.
- [Van operating guide](../guides/VAN_SALES_OPERATING_GUIDE.md): background training material. Its statements about phone-only uploads, absent office screens, fixed tolerances, receipt type and legacy commands must be checked against the exact accepted v2 release, not treated as current instructions.
- [Current v2 route operations](../spec/vanops.md): operational-version trips, lots, temperatures, containers, unload and independent settlement.
- [Later collection, fiscal and correction integration](../spec/finish-a.md): frozen documents, tender/credit controls, held pickups, receipt/cash corrections and SAP bridges.
- [Release and cutover](../spec/release-and-cutover.md): separate release, recovery, fiscal and SAP acceptance boundaries. Other lanes' example environments/ports are not this lane's configuration.
- [Delivery sequence, milestone 16](../delivery/SFA_DELIVERY_SEQUENCE.md#16--van-sales-pilot-cebu): completion requires both van UAT and the actual Cebu pilot.

This is our pilot design, not a statement of Sunpride's existing operations. If a UAT expectation or old guide conflicts with the accepted release or later client clarification, the delivery lead records the corrected expectation, evidence and client agreement before use. Do not waive a lost sale or unexplained stock/cash difference as an old-guide limitation.

## People and decisions needed from Sunpride

The following are requests for this controlled run, not claims that the client supplied them. Existing marked sample data and our defaults remain sufficient for a separate rehearsal; missing client data does not prevent that preparation. A real pilot still requires authorized people and a real operating window.

| Owner                                                            | Needed for the real run                                                                                                   | Record in the private run pack                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Sunpride pilot coordinator, nominated by Francis or his delegate | Confirm the pilot date/window, Cebu depot, route, truck, willing stores and named people; nominate the go/no-go authority | Run ID, Manila date/time, route/truck references, contact roster and authorized scope             |
| Sunpride sales supervisor                                        | Assign the seller and an independent supervisor; confirm who is available during the route                                | Names, roles, contact method and escalation backup                                                |
| Sunpride warehouse lead                                          | Provide the physical load, warehouse receiver and end-of-day count window                                                 | Signed opening load and lot/status quantities; signed receipt of leftovers/held goods             |
| Sunpride cashier/finance                                         | Name the cash receiver; authorize payment/credit methods, cash float handling and document use for this pilot             | Separate opening float, counted cash, remittance reference, permitted tenders and fiscal decision |
| Sunpride quality owner, if carrying temperature-controlled goods | Supply the approved readings/bands, interval, exception decision rights and disposition instructions                      | Effective policy references, reading record and independent quality decisions                     |
| Sunpride SAP/IT and finance, if real posting is in scope         | Confirm the certified interface/mappings and authorize the intended accounting/document effects                           | Environment identity, approval references and real SAP document readbacks                         |
| Delivery release owner                                           | Identify the accepted matching API/web/APK release and physical UAT evidence, arrange support and recovery                | Source/artifact hashes, configuration mode and existing acceptance reports                        |

Do not place passwords, session tokens, device keys, approval codes, full payment references or customer photos/signatures in this repository or in board comments. Keep the run pack in Sunpride's approved restricted evidence location; put only safe references on the board.

## Blank run cover sheet

Copy this section to the private run pack. Blank means unknown, never approved.

| Field                                                                                | Value |
| ------------------------------------------------------------------------------------ | ----- |
| Run ID; mode (`REHEARSAL_SAMPLE`, `SHADOW_NO_POSTING` or `LIVE_CEBU`)                |       |
| Manila service date; start/end window                                                |       |
| Coordinator; go/no-go authority; support contact                                     |       |
| Seller; independent supervisor; driver/helper                                        |       |
| Warehouse receiver; cashier; quality/SAP contacts as applicable                      |       |
| Depot; truck; route; agreed stores; opening load reference                           |       |
| Approved environment/origin; SAP mode (mock / QA / real)                             |       |
| API/web source SHA; installed APK version and SHA-256                                |       |
| Trip ID/number; operational version; assigned-device reference                       |       |
| Current price/UOM/lot/expiry, tender, fiscal, credit and authority policy references |       |
| Temperature/container/reload policies that apply                                     |       |
| UAT result pack; accepted defects/workarounds; backup/recovery evidence              |       |
| Restricted evidence location; observer and signers                                   |       |

A shadow run follows the route without creating real sales, money or stock postings and must use a segregated authorized test environment. It is not a substitute for a live pilot. Sample identities/prices and mock SAP must remain visibly marked and must never be used to issue a real customer document.

## Entry checklist — sign before departure

Each item requires an owner, time and evidence reference in the private pack. Until checked, the decision is NO GO.

- [ ] Coordinator confirms the run scope, participating people/stores, safety window and supervisor availability.
- [ ] Release owner identifies one compatible API/web/APK release, its migration/configuration state and relevant passing gates; no claim is inferred from the presence of test source files.
- [ ] Independent UAT is completed for that release, including physical offline/reopen/reconnect, scan and legible paper receipt checks. Use the full UAT inventory below, correct obsolete expectations and record defects, not presumed passes.
- [ ] No unresolved Critical/High defect affects money, stock, saved work, permissions, selling, printing or sync. A lower-severity workaround has a named owner and joint acceptance.
- [ ] The existing assigned handheld can sign in, download the intended current trip and applicable master/policy data, and has adequate battery and paper. Do not replace/uninstall a device with unsynced work.
- [ ] Warehouse and seller agree the physical opening load by product, lot, stock status and frozen UOM conversion. A discrepancy receives independent approval before departure; capacity is reviewed by a person.
- [ ] Finance authorizes the actual prices, tenders, cash-float treatment and document/fiscal use. Missing/stale credit, unknown tax or unavailable authorized document numbers remain blocked; no typed substitute bypasses them.
- [ ] Applicable temperature bands/readings, return/held-goods handling, container custody and variance policy are reviewed. Sample policy values are not called client policy.
- [ ] Release owner confirms backup/recovery and restricted evidence capture. Real SAP/fiscal use has the relevant human certification; otherwise the run stays explicitly segregated and non-production.
- [ ] Sunpride go/no-go authority and delivery lead sign the decision and record the limits; no automatic field start follows a green software test.

## Run sequence and evidence checkpoints

Copy the CSV once per run. Set its mode and release fields before execution. Allowed result values: `NOT_RUN`, `PASS`, `FAIL`, `BLOCKED`, `NOT_APPLICABLE`. A non-applicable case needs an explicit scope reason and reviewer; a blocked case is not a pass. Leave observed values blank until someone observes them.

| Checkpoint | Action and required evidence                                                                                                                                                                                                                                                               | Existing UAT coverage                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| PILOT-01   | At the depot, record identities/release, authorization and downloaded trip; verify today's route, current prices/UOMs, lots and required policies. Retain the signed entry decision.                                                                                                       | VUAT-SET-01, VUAT-SET-02                                                                                              |
| PILOT-02   | Warehouse and seller count the actual load by lot/status, scan piece/case where applicable, independently decide any real difference, record opening odometer and departure/temperature evidence.                                                                                          | VUAT-LOAD-01, VUAT-LOAD-02, VUAT-LOAD-03                                                                              |
| PILOT-03   | At agreed stores, record real arrival/departure and permitted sales with their issued document references, stock deductions and tender facts. Read the actual paper for legibility and frozen sale facts. Use only governed prices, benefits and approvals.                                | VUAT-SELL-01, VUAT-SELL-02, VUAT-SELL-03, VUAT-SELL-04, VUAT-SELL-05, VUAT-PRT-01, VUAT-STK-01, VUAT-STK-02           |
| PILOT-04   | During an agreed safe stop, record actual loss of usable network, an authorized offline capture, close/reopen without clearing data, and later reconnect. Read back the same operation/document identities once in the office; compare immutable facts and totals, not just a sync banner. | VUAT-SYNC-01, VUAT-SYNC-02                                                                                            |
| PILOT-05   | Observe actual printing/reprint and any genuine return, damage, void, held pickup or payment exception. Preserve original facts, batch, reason and independent approval/evidence. Do not invent customer returns, damage, shortages or voids to fill this sheet.                           | VUAT-PRT-02, VUAT-PRT-03, VUAT-PRT-04, VUAT-RET-01, VUAT-RET-02, VUAT-DMG-01, VUAT-DMG-02, VUAT-VOID-01, VUAT-VOID-02 |
| PILOT-06   | Before hand-in, seller and receiver physically count cash and all stock lots/statuses, held bags and containers; record closing odometer and applicable temperature readings. Preserve the expected, counted and variance facts independently.                                             | VUAT-CASH-01, VUAT-CASH-02, VUAT-SCNT-01                                                                              |
| PILOT-07   | Capture local completion, then upload the complete manifest and obtain office acknowledgements. The cashier separately receipts cash and warehouse separately receipts stock/custody. Review quality/variance cases and independently sign the correct immutable settlement version.       | VUAT-SYNC-04, VUAT-CLOSE-01, VUAT-CLOSE-02                                                                            |
| PILOT-08   | Compare each approved transaction/settlement with its office source, posting state and genuine SAP acknowledgement if authorized. Record phone-only/review/held/pending items explicitly and assign follow-up.                                                                             | VUAT-E2E-01, VUAT-E2E-02                                                                                              |
| PILOT-09   | Debrief seller, supervisor, warehouse and cashier; sign the evidence and continue/fix/repeat decision. Confirm incident handling and device authorization cases from the separate UAT pack, without disrupting an active real trip.                                                        | VUAT-SYNC-03                                                                                                          |

A rare or destructive negative case belongs in the prior segregated UAT/rehearsal, not in real customer business. Link that evidence and label its mode; do not count it as observed live. The two full-day UAT variants need their own recorded UAT evidence, not fictitious second trips on the pilot day. Record additional operational-version checks (temperature intervals, stops, held pickups, containers and any actual reload) in the same checkpoint's evidence; an approval/request alone never adds received stock.

## Reconciliation sheets

Keep one row per product/lot/status; never add unlike units into a single quantity. Freeze pack/base conversions from the run, not later master data. Money is PHP with exact centavos; preserve the observed source values, not estimated zeros.

### Stock and custody

| Product / lot / status / base unit | Opening truck | Load / received reload | Gross sold | Voided units restored | Accepted stock returns | Status transfers / approved adjustments | Expected before count | Physical count | Count variance | Warehouse received | Remaining truck | Evidence / reviewer |
| ---------------------------------- | ------------- | ---------------------- | ---------- | --------------------- | ---------------------- | --------------------------------------- | --------------------- | -------------- | -------------- | ------------------ | --------------- | ------------------- |
|                                    |               |                        |            |                       |                        |                                         |                       |                |                |                    |                 |                     |

Expected before count = opening truck + load + received reload − gross sold + voided units restored + accepted stock returns + signed status transfers/approved adjustments. For total physical goods, damage transfers between statuses, not out of the truck. Preserve the pre-count expectation even when an authorized adjustment is posted. Physical count − expected before count is the count variance. Reconcile warehouse receipt and remaining truck against the independently accepted count and later authorized movements; do not unload the original load quantity as though the sold goods were still present.

Held pickups are separate physical custody, not automatically owned/sellable stock or a cash refund. Record bag/capture ID, product/batch, counted quantity, warehouse custody decision, receiver and evidence separately. Record each container type's opening custody, issues, receipts, counted balance and warehouse receipt, including explicit zero counts. A reload request/dispatch is not a received reload.

### Cash and other tenders

| Cash sales | Cash collections | Cash refunds | Cash void refunds | Expected cash | Counted cash excluding separately recorded float | Count variance | Actually remitted | Receiver / receipt reference | Hand-in difference | Evidence |
| ---------- | ---------------- | ------------ | ----------------- | ------------- | ------------------------------------------------ | -------------- | ----------------- | ---------------------------- | ------------------ | -------- |
|            |                  |              |                   |               |                                                  |                |                   |                              |                    |          |

Expected cash = cash sales + cash collections − cash refunds − cash void refunds. For this sheet, cash sales means original cash sale amounts before voids, cash refunds excludes void refunds, and each compensating cash void is subtracted once. If a source export already excludes voided sales, retain that source basis and do not subtract the same void again. Count variance = counted cash − expected cash. Hand-in difference = actually remitted − counted cash. Record the opening/returned float separately with the cashier. A saved cash count is not proof of remittance.

Keep cheque, electronic tender and credit documents separate with amount, safe reference, office confirmation and unresolved status. Credit promises are not collected cash. An unknown amount is unknown, not zero. Corrections must use the authorized append-only office workflow and retain the original count/receipt/version.

### Document, sync and posting trace

For every sale/return/void/collection and final settlement retain: trip, captured document/operation ID, capture time, phone state, office acknowledgement/readback, corresponding canonical movement/payment reference, SAP mode, genuine provider document ID or explicit pending/refused state, reviewer and evidence reference. Compare document counts and centavo/base-unit totals on the handheld and office for the same trip; a reprint must not create another sale. Read every manifest item, including refused or held items, not only successful totals.

For an operational-version trip, distinguish local completion, pending sync, pending supervisor, approved/SAP pending and posted. Local completion is not warehouse receipt, cash receipt, office approval or SAP settlement. A mock acknowledgement stays SAMPLE and never satisfies live SAP acceptance. Legacy trips retain their own contract; do not force the old guide's close ordering onto an operational-version trip.

## Stop and recovery

Stop new pilot business immediately for a missing/duplicate sale, unexplained stock/cash change, lost data, unauthorized access/approval, wrong document/price/tax, unsafe quality condition, or inability to preserve records. Record time, last safe operation, observed facts and a safe evidence reference. Tell the supervisor and delivery support; finance/quality decides its own custody or financial actions.

1. Preserve the handheld, queued operations, original receipts and physical custody. Do not uninstall, clear data, reset, delete queue rows or swap accounts to force a retry.
2. Do not recapture a sale/payment just because its acknowledgement is uncertain. The office reconciles original identities first; supported retry retains the original identity and bytes.
3. Suspend a compromised/lost device through the authorized office process. Unsynced work may be phone-only; existing office records may also exist. Reconcile both before recovery or replacement.
4. Keep questionable/held goods separate under the quality/warehouse owner's direction; never mark them sellable to balance a sheet.
5. Use the existing authorized paper/continuity process only if Sunpride has approved it; label and reconcile it separately. No invented document numbers or assumed refunds.
6. The delivery release owner handles any application rollback under the release runbook. Never restore a database as if that reversed already accepted customer/SAP documents. This lane does not perform release or recovery on the live system.

## Exit, debrief and signatures

Recommend PASS only when the actual agreed route/day ran, the accepted-release UAT pack is complete, all pilot checkpoints have evidence or a justified scope exception, no Critical/High issue remains, every transaction/manifest item is accounted for, cash and stock/custody are reconciled, exceptions have independent decisions, and the correct office settlement version is approved. If real SAP was included, retain its genuine acknowledgements; otherwise state the SAP exclusion and never claim posting acceptance or national go-live.

| Signer                                               | Required confirmation                                                   | Name / date / evidence |
| ---------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------- |
| Seller                                               | Actual route, documents and saved/offline work reviewed                 |                        |
| Warehouse receiver                                   | Load, physical count, receipt, held goods and containers reconciled     |                        |
| Cashier/finance                                      | Cash physically received, tender status and differences recorded        |                        |
| Independent supervisor                               | Variances/quality decisions and settlement version reviewed             |                        |
| Delivery lead                                        | Exact release, UAT/field evidence and remaining software defects stated |                        |
| Sunpride pilot authority (Francis or named delegate) | Accept / fix and repeat / stop; scope and next authorized step          |                        |

Record planned versus actual stores, buying stores, elapsed selling time, sales before returns, returns/refunds separately, expected/counted/remitted cash, per-lot stock differences, pending sync/office/SAP items, battery/connectivity/printing observations and the seller's feedback. Leave unavailable measures unknown. File each real defect on the in-app board and add safe defect references to the result sheet.

SP-0122 stays incomplete until Sunpride's actual field run and signatures exist. Readiness documents, automated test logs and rehearsal sign-off alone are not pilot completion.
