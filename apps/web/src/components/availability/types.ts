export type RetailAvailability = {
  universe: {
    id: string;
    label: string;
    date: string;
    sourceRef: string;
    sample: boolean;
    fresh: boolean;
    members: number;
  } | null;
  required: number;
  checked: number;
  present: number;
  completeness: number | null;
  rows: Array<{
    productId: string;
    code: string;
    name: string;
    universe: number;
    stocking: number;
    absent: number;
    unknown: number;
    ndPct: number | null;
    wdPct: number | null;
    ndLowerPct: number | null;
    wdLowerPct: number | null;
    weightsKnown: boolean;
    gaps: Array<{
      outletId: string;
      name: string;
      state: string;
      backroomBase?: number | null;
    }>;
    shelfGaps?: Array<{
      outletId: string;
      name: string;
      state: string;
      backroomBase?: number | null;
    }>;
  }>;
  depths: Array<{
    outletId: string;
    name: string;
    stockedSkus: number;
    unknownSkus: number;
    boughtSkus: number;
    planned?: number;
    actual?: number;
  }>;
  trend: Array<{
    date: string;
    osa: number | null;
    completeness: number | null;
  }>;
};
export type RetailRelease = {
  id: string;
  kind: "msl" | "focus" | "launch" | "rules";
  policy_key: string;
  label: string;
  version: number;
  status: string;
  sample: boolean;
  effective_from: string;
  source_ref: string;
  payload: {
    channel?: string;
    subchannel?: string;
    classification?: string;
    priority?: number;
    lines?: Array<{
      productId: string;
      minimumBase: number;
      objective?: string;
    }>;
  };
};
export type RetailSetup = {
  rows: RetailRelease[];
  products: Array<{ id: string; code: string; name: string }>;
  territories: Array<{ id: string; code: string; name: string }>;
  outlets: Array<{
    id: string;
    code: string;
    name: string;
    channel: string | null;
    subchannel: string | null;
    classification: string | null;
    enrolment_status: string | null;
    territoryId: string | null;
  }>;
};
