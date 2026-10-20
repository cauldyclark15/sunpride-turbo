export type PjpPerson = { _id: string; name: string; currentUnitId: string };
export type PjpPolicy = {
  _id: string;
  orgUnitId: string;
  classKey: string;
  label: string;
  intervalWeeks: number;
  serviceMinutes: number;
  objectives: string[];
  effectiveFrom: number;
  effectiveTo?: number;
  sourceRef: string;
};
export type PjpTemplate = {
  _id: string;
  assigneeProfileId: string;
  assigneeName: string;
  name: string;
  version: number;
  anchorDate: string;
  effectiveFrom: number;
  effectiveTo: number;
  capacityMinutes: number;
  travelMinutes: number;
  sellingWeekdays: number[];
  stops: { outletId: string; weekday?: number; phaseWeek?: number }[];
};
export type PjpRegistry = {
  existingPlans: {
    _id: string;
    assigneeProfileId: string;
    localMonth: string;
    version: number;
    effectiveFrom: number;
    status: string;
  }[];
  people: PjpPerson[];
  policies: PjpPolicy[];
  templates: PjpTemplate[];
  publications: {
    _id: string;
    planId: string;
    templateId: string;
    status: string;
    version: number;
    localMonth: string;
  }[];
};
export type PjpSimulation = {
  simulationId: string;
  hash: string;
  result: {
    month: string;
    totalVisits: number;
    outletCount: number;
    potential: number;
    potentialIncomplete: boolean;
    serviceMinutes: number;
    travelMinutes: number;
    travelSource: string;
    previous: { visits: number; serviceMinutes: number };
    days: {
      date: string;
      visits: number;
      serviceMinutes: number;
      travelMinutes: number;
      totalMinutes: number;
      capacityMinutes: number;
    }[];
    overloadedDays: unknown[];
    assignments: {
      outletId: string;
      outletName: string;
      classKey: string;
      weekday: number;
      phaseWeek: number;
      visits: number;
      potential: number | null;
      latitude: number | null;
      longitude: number | null;
    }[];
  };
};
