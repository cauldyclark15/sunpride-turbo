/** F-201/F-202/F-224 additive SQL row contracts (0450_pjp.sql).
 * These are server rows, not wire DTOs; timestamps are Date objects from Bun SQL.
 * @typedef {{id:string,organization_id:string,org_unit_id:string,class_key:string,label:string,
 * interval_weeks:1|2|4,service_minutes:number,objectives:string[],effective_from:Date,
 * effective_to:Date|null,source_ref:string,created_by:string,created_at:Date,updated_at:Date}} OutletClassVisitPolicy
 *
 * @typedef {{outletId:string,weekday?:number,phaseWeek?:number}} PjpBeatStop
 * @typedef {{id:string,organization_id:string,org_unit_id:string,assignee_profile_id:string,
 * name:string,version:number,anchor_date:Date,effective_from:Date,effective_to:Date,
 * capacity_minutes:number,travel_minutes:number,selling_weekdays:number[],stops:PjpBeatStop[],
 * created_by:string,created_at:Date,updated_at:Date}} PjpTemplate
 *
 * @typedef {{id:string,template_id:string,local_month:string,input_hash:string,
 * result:Record<string,any>,created_by:string,created_at:Date,updated_at:Date}} PjpSimulation
 * @typedef {{id:string,template_id:string,simulation_id:string,plan_id:string,
 * created_at:Date,updated_at:Date}} PjpPublication
 * @typedef {{id:string,org_unit_id:string,actor_id:string,kind:string,entity_id:string,
 * detail:Record<string,any>,created_at:Date,updated_at:Date}} PjpEvent
 */
export {};
