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
export {};
