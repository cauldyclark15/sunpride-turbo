# Cebu field-sales pilot run record

Tracker: SP-0014. Use with the [pilot runbook](README.md).

Template only. No pilot has been executed or accepted in this file. Copy to the
agreed restricted evidence location; do not commit completed client records,
customer details, raw GPS, device credentials or unredacted screenshots here.

## Session identity

| Field                                                                        | Recorded value                                                 |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Session reference                                                            | Not assigned                                                   |
| Overall result                                                               | Not started                                                    |
| Evidence mode                                                                | Not run — choose real field or sample rehearsal when scheduled |
| Cebu route and territory                                                     | Not supplied                                                   |
| Planned date / actual start and end (Asia/Manila)                            | Not supplied                                                   |
| Planned store count / ordered store-list evidence                            | Not supplied                                                   |
| Salesperson / own account reference                                          | Not supplied                                                   |
| Independent supervisor / own account reference                               | Not supplied                                                   |
| Sunpride sign-off owner / delegate                                           | Not supplied                                                   |
| Administrator / sales admin / order approver                                 | Not supplied                                                   |
| Delivery lead / support contacts                                             | Not supplied                                                   |
| Normal-business fallback and owner                                           | Not agreed                                                     |
| Restricted evidence location and access owner                                | Not assigned                                                   |
| Location/photo permission and store-access confirmation                      | Not recorded                                                   |
| Web origin / deployed web revision                                           | Not recorded                                                   |
| API origin / deployed API revision                                           | Not recorded                                                   |
| Installed APK version / build / SHA-256                                      | Not recorded                                                   |
| Device model / Android version / assigned registration reference             | Not recorded                                                   |
| Plan reference / approved version / service date / approver                  | Not recorded                                                   |
| Offline access expiry actually shown                                         | Not recorded                                                   |
| Data mode: sample or real, pricing source and commercial posting permissions | Not agreed                                                     |
| SAP boundary: mock, real test company or not tested                          | Not agreed                                                     |
| Battery / storage / battery-saver setting at start and finish                | Not measured                                                   |
| Network/SIM/Wi-Fi conditions and offline interval                            | Not observed                                                   |
| Safety contact and original network configuration restored                   | Not recorded                                                   |

## Entry decision

Copy the numbered entry checks from the runbook into the evidence pack. Give each
one its actual result, owner, time and evidence reference; nothing passes by default.

| Entry check                                                   | Result  | Owner / time / evidence or blocker |
| ------------------------------------------------------------- | ------- | ---------------------------------- |
| 1. People, route/date, contacts and decision owner            | Not run |                                    |
| 2. Exact candidate and scoped readiness/security/UAT evidence | Not run |                                    |
| 3. Candidate phone functions and current offline access       | Not run |                                    |
| 4. Signed plan, role/scope and independent approvals          | Not run |                                    |
| 5. Data/evidence permissions and business fallback            | Not run |                                    |
| 6. Order product/UOM/pricing context and posting boundaries   | Not run |                                    |
| 7. Baseline records and existing phone queue reconciled       | Not run |                                    |
| 8. Device, network restoration and safety contact             | Not run |                                    |
| 9. Current UAT results, defects and accepted exceptions       | Not run |                                    |
| 10. Both owners' explicit Go                                  | Not run |                                    |

Sunpride entry decision / name / timestamp: Not recorded.

Delivery entry decision / name / timestamp: Not recorded.

## Pilot checkpoints

Results: Not run, Pass, Fail or Blocked. Each executed row needs the actual tester,
Manila timestamp, evidence mode and evidence reference. Record omitted scope and
why; do not turn an unexecuted row into Pass. Attach the candidate's completed
[full UAT sheet](../SFA_UAT_SCENARIOS.md) separately; this smaller route checklist
does not replace it or accept historical expected results without checking them.

| Checkpoint                   | Required observation                                                                                               | UAT reference                                  | Result  | Tester / time / mode / evidence / defect |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------- | ---------------------------------------- |
| P01 Start-of-day comparison  | Phone and office show the same signed day's stores and order; baseline queues captured.                            | UAT-SET-01, UAT-MCP-02, UAT-VIS-01             | Not run |                                          |
| P02 Genuine online call      | Start, actual required activities and End persist; genuine order uses its separate send flow if included.          | UAT-FLD-01, UAT-FLD-02, UAT-FLD-03, UAT-ORD-01 | Not run |                                          |
| P03 Offline leg              | Two planned calls saved in order without connectivity; actual conditions and access expiry recorded.               | UAT-FLD-04, UAT-E2E-02                         | Not run |                                          |
| P04 Offline reopen           | Previously saved visits, activities, order intents and photos remain after normal app reopen.                      | UAT-FLD-04                                     | Not run |                                          |
| P05 Reconnect and reconcile  | Each saved operation reaches the office once; acknowledge/refusal/held/photo outcomes are explained.               | UAT-FLD-04                                     | Not run |                                          |
| P06 Repeat sync              | Repeated sync leaves the same business references and counts, with no extra visit/order/photo.                     | UAT-FLD-04, UAT-E2E-02                         | Not run |                                          |
| P07 Finish genuine route     | Every planned stop is accounted for; actual exceptions have an independent owner/decision.                         | UAT-FLD-02, UAT-SUP-03                         | Not run |                                          |
| P08 Order and SAP boundaries | Phone intent, office order/approval and SAP test document linked independently; untested boundaries stay explicit. | UAT-ORD-01, UAT-SAP-01                         | Not run |                                          |
| P09 Supervisor and closeout  | Reports reconcile with captured activities/orders; phone queue and evidence counts reconcile before close.         | UAT-SUP-01, UAT-SUP-04, UAT-E2E-01             | Not run |                                          |
| P10 Sign-off                 | Actual route results, limited coverage, defects and next action reviewed by Sunpride and delivery lead.            | Full UAT sign-off                              | Not run |                                          |

## Reconciliation

Use [VISIT_RECONCILIATION.csv](VISIT_RECONCILIATION.csv) for one row per planned
stop, including unvisited ones. Reference per-operation acknowledgements and all
activity/order/photo evidence from that row. Keep amounts with their currency,
unit and pricing source; an unavailable price is unknown, never assumed zero.

| Session measure                                                     | Baseline     | After first sync | After repeated sync | Explanation / exact evidence |
| ------------------------------------------------------------------- | ------------ | ---------------- | ------------------- | ---------------------------- |
| Signed planned stops and accounted-for results                      | Not recorded | Not recorded     | Not recorded        |                              |
| Session visits received by office                                   | Not recorded | Not recorded     | Not recorded        |                              |
| Saved session operations / accepted / refused / unacknowledged      | Not recorded | Not recorded     | Not recorded        |                              |
| Sent phone order intents / office orders / approved orders          | Not recorded | Not recorded     | Not recorded        |                              |
| SAP documents (mock and real test company separately)               | Not recorded | Not recorded     | Not recorded        |                              |
| Photos saved / attached / still local or under review               | Not recorded | Not recorded     | Not recorded        |                              |
| Phone pending / sending / review / held, including prior-scope work | Not recorded | Not recorded     | Not recorded        |                              |
| Missing records / unexplained duplicates                            | Not measured | Not measured     | Not measured        |                              |

Do not subtract whole-company totals and call the difference pilot evidence. Use
this session's exact plan, date, person and stable operation/order references.

## Incidents and unresolved work

| Time | Symptom and last good step | Affected records / evidence | Severity | Board defect link | Custodian / next action / due | Retest result |
| ---- | -------------------------- | --------------------------- | -------- | ----------------- | ----------------------------- | ------------- |
|      |                            |                             |          |                   |                               |               |

No incident rows does not mean no incidents were observed; the session has not run.
Preserve initial failures alongside retries. Do not recapture work until the
supervisor has reconciled what the office already received.

## Final decision

| Item                                                               | Result                                      |
| ------------------------------------------------------------------ | ------------------------------------------- |
| Actual field execution completed                                   | Not run                                     |
| Phone/office operations, orders and photos reconciled              | Not run                                     |
| Offline reopen/reconnect/repeat-sync evidence                      | Not run                                     |
| Current candidate UAT result and accepted-exception links          | Not recorded                                |
| Unresolved Critical/High defects                                   | Not assessed                                |
| Omitted cases / commercial or SAP boundaries / remaining proof     | Not assessed                                |
| Whole-day SIM-removed route, battery/data and wider fleet coverage | Not tested by this template                 |
| Overall decision: Pass / Fail / Blocked / Not started              | Not started                                 |
| Next action / owner / date                                         | Await Sunpride participants, route and date |
| Sunpride acceptance: name, decision, timestamp and evidence        | Not signed                                  |
| Delivery acceptance: name, decision, timestamp and evidence        | Not signed                                  |

A signed rehearsal remains a rehearsal. Neither an empty template nor a
field-only result completes SAP-inclusive UAT or authorizes wider rollout.
