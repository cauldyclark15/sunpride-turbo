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
 * actorId:string,detail:Record<string,unknown>,createdAt:Date,updatedAt:Date}} WorkforceEvent
 */
export {};
