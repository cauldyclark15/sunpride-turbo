/** F-201/F-202/F-208/F-224 additive row contracts (0450/0451).
 * Like the other DB row contracts, keys are camelCase SQL-column names;
 * timestamps are Date, and wire DTOs remain a separate boundary.
 * @typedef {{id:string,organizationId:string,orgUnitId:string,classKey:string,label:string,
 * intervalWeeks:1|2|4,serviceMinutes:number,objectives:string[],effectiveFrom:Date,
 * effectiveTo:Date|null,sourceRef:string,createdBy:string,createdAt:Date,updatedAt:Date}} OutletClassVisitPolicy
 *
 * @typedef {{outletId:string,weekday?:number,phaseWeek?:number}} PjpBeatStop
 * @typedef {{id:string,organizationId:string,orgUnitId:string,assigneeProfileId:string,
 * name:string,version:number,anchorDate:Date,effectiveFrom:Date,effectiveTo:Date,
 * capacityMinutes:number,travelMinutes:number,sellingWeekdays:number[],stops:PjpBeatStop[],
 * createdBy:string,createdAt:Date,updatedAt:Date}} PjpTemplate
 *
 * @typedef {{id:string,templateId:string,localMonth:string,inputHash:string,
 * result:Record<string,unknown>,createdBy:string,createdAt:Date,updatedAt:Date}} PjpSimulation
 * @typedef {{id:string,templateId:string,simulationId:string,planId:string,
 * createdAt:Date,updatedAt:Date}} PjpPublication
 * @typedef {{id:string,orgUnitId:string,actorId:string,kind:string,entityId:string,
 * detail:Record<string,unknown>,createdAt:Date,updatedAt:Date}} PjpEvent
 *
 * @typedef {{id:string,organizationId:string,definitionKey:string,version:number,
 * orgUnitId:string,positionId:string|null,channelKey:string|null,label:string,
 * definition:Record<string,unknown>,contentHash:string,status:'draft'|'published',
 * effectiveFrom:Date,effectiveTo:Date|null,replacesPolicyId:string|null,sourceRef:string,
 * preparedBy:string,approvedBy:string|null,approvedAt:Date|null,createdAt:Date,updatedAt:Date}} ProductivePolicy
 * @typedef {{id:string,actorId:string,requestKey:string,requestHash:string,
 * result:Record<string,unknown>,createdAt:Date,updatedAt:Date}} ProductivePolicyCommand
 * @typedef {{id:string,policyId:string,actorId:string,kind:string,
 * detail:Record<string,unknown>,createdAt:Date,updatedAt:Date}} ProductivePolicyEvent
 * @typedef {import('./visits.js').VisitExecutionRow & {productivePolicySnapshot:Record<string,unknown>|null}} ProductiveVisitExecutionRow
 */
/** F-209/F-222 additive row contracts (0452). JSON snapshots retain captured provenance.
 * @typedef {{id:string,orgUnitId:string,version:number,label:string,sourceRef:string,
 * configuration:Record<string,unknown>,contentHash:string,effectiveFrom:Date,effectiveTo:Date|null,
 * createdBy:string,createdAt:Date,updatedAt:Date}} WorkforceFormPolicy
 * @typedef {{id:string,profileId:string,orgUnitId:string,serviceDate:Date,
 * clockInRequestId:string,clockInAt:Date,clockInDeviceId:string,clockInSnapshot:Record<string,unknown>,
 * photoFileId:string,clockOutRequestId:string|null,clockOutAt:Date|null,clockOutDeviceId:string|null,
 * clockOutSnapshot:Record<string,unknown>|null,reviewFlags:string[],createdAt:Date,updatedAt:Date}} AttendanceSession
 * @typedef {{id:string,profileId:string,orgUnitId:string,serviceDate:Date,
 * kind:'correction'|'absence'|'leave',proposedStart:Date|null,proposedEnd:Date|null,reason:string,sourceRef:string,
 * clientKey:string,requestHash:string,externalIdentity:string|null,replacesId:string|null,
 * status:'pending'|'approved'|'rejected',preparedBy:string,approvedBy:string|null,approvedAt:Date|null,
 * decisionReason:string|null,createdAt:Date,updatedAt:Date}} AttendanceAdjustment
 * @typedef {{id:string,profileId:string,orgUnitId:string,kind:string,entityId:string,
 * actorId:string,deviceId:string|null,detail:Record<string,unknown>,createdAt:Date,updatedAt:Date}} WorkforceEvent
 */
/** F-210 additive row contracts (0453). Cases carry the policy version/hash and cycle source used.
 * @typedef {{id:string,orgUnitId:string,version:number,label:string,sourceRef:string,
 * missedCycles:number,fallbackCycleDays:number,contentHash:string,effectiveFrom:Date,effectiveTo:Date|null,
 * createdBy:string,createdAt:Date,updatedAt:Date}} DormancyPolicy
 * @typedef {{id:string,outletId:string,orgUnitId:string,policyId:string,policyVersion:number,policyHash:string,
 * cycleDays:number,cycleSource:'class_frequency'|'outlet_cadence'|'policy_fallback',thresholdCycles:number,
 * missedCycles:number,lastPurchaseOn:Date,detectedOn:Date,status:'open'|'recovered'|'closed',
 * recoveredOn:Date|null,recoveryPurchaseOn:Date|null,closedReason:string|null,closedBy:string|null,
 * closedAt:Date|null,createdAt:Date,updatedAt:Date}} OutletDormancyCase
 * @typedef {{id:string,caseId:string,kind:'recovery_visit'|'win_back_offer'|'owner_review'|'close',
 * note:string,dueOn:Date|null,actorId:string,clientKey:string,requestHash:string,createdAt:Date,updatedAt:Date}} OutletDormancyAction
 */
/** F-615 additive row contracts (0454). Amounts are integers in the metric's unit (centavos, counts, basis points).
 * @typedef {{id:string,month:string,metric:'sales_value'|'volume'|'coverage_stores'|'distribution_points'|'calls'|'msl_compliance',
 * productCode:string|null,unit:string,parentLevel:'company'|'channel'|'territory',parentKey:string,parentLabel:string,
 * childLevel:'channel'|'territory'|'agent',parentAmount:bigint,method:'prior_actual'|'equal'|'same_rate'|'manual',
 * basisFrom:Date|null,basisTo:Date|null,version:number,status:'submitted'|'published'|'rejected'|'superseded',
 * sourceRef:string,contentHash:string,preparedBy:string,clientKey:string,requestHash:string,decidedBy:string|null,
 * decidedAt:Date|null,decisionReason:string|null,createdAt:Date,updatedAt:Date}} TargetCascade
 * @typedef {{id:string,cascadeId:string,childKey:string,childLabel:string,basis:bigint|null,amount:bigint,
 * createdAt:Date,updatedAt:Date}} TargetCascadeLine
 * @typedef {{id:string,cascadeId:string,kind:'submitted'|'published'|'rejected'|'superseded',actorId:string,
 * detail:Record<string,unknown>,createdAt:Date,updatedAt:Date}} TargetCascadeEvent
 */
/** F-223 additive row contract (0455). An action is reviewed only in a later joint call of the same pair.
 * @typedef {{id:string,sessionId:string,trainerProfileId:string,traineeProfileId:string,orgUnitId:string,
 * ordinal:number,agreement:string,owner:'trainee'|'trainer',dueOn:Date,status:'open'|'done'|'not_done',
 * reviewedInSessionId:string|null,reviewNote:string|null,reviewedBy:string|null,reviewedAt:Date|null,
 * createdAt:Date,updatedAt:Date}} JointCallAction
 */
/** F-613 additive row contracts (0456). Planning records only; SEAM(SAP) owns AR balances.
 * @typedef {{id:string,orgUnitId:string,customerCode:string,openItemRef:string|null,arSnapshotId:string|null,
 * amountMinor:bigint,promisedOn:Date,status:'open'|'kept'|'broken'|'cancelled',note:string,outcomeNote:string|null,
 * outcomeBy:string|null,outcomeAt:Date|null,createdBy:string,clientKey:string,requestHash:string,
 * createdAt:Date,updatedAt:Date}} CollectionPromise
 * @typedef {{id:string,orgUnitId:string,customerCode:string,chequeNumber:string,bank:string,amountMinor:bigint,
 * chequeDate:Date,receivedOn:Date,promiseId:string|null,status:'received'|'deposited'|'cleared'|'bounced'|'replaced',
 * replacesId:string|null,createdBy:string,clientKey:string,requestHash:string,createdAt:Date,updatedAt:Date}} ChequeInstrument
 * @typedef {{id:string,chequeId:string,kind:'received'|'deposited'|'cleared'|'bounced'|'replaced',onDate:Date,
 * note:string|null,actorId:string,createdAt:Date,updatedAt:Date}} ChequeEvent
 * @typedef {{id:string,orgUnitId:string,routeDate:Date,collectorProfileId:string,sequence:number,customerCode:string,
 * reason:'promise_due'|'promise_overdue'|'cheque_pickup'|'cheque_replacement'|'overdue_balance'|'manual',
 * plannedBy:string,createdAt:Date,updatedAt:Date}} CollectionRouteStop
 */
export {};
