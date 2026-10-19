export type SalesTrend = { date: string; sales: number; cumulative: number };
export type TeamDsr = {
  serviceDate: string;
  definition: string;
  totals: {
    todaySales: number;
    mtdSales: number;
    target: number | null;
    prior: number;
  };
  rows: Array<{
    profileId: string;
    name: string;
    todaySales: number;
    mtdSales: number;
    target: number | null;
    dailyTarget: number | null;
    balanceToSell: number | null;
    calls: number;
    productive: number;
    trend: SalesTrend[];
    prior: number;
  }>;
};
export type TeamCockpit = {
  serviceDate: string;
  week: { start: string; end: string };
  definition: string;
  rows: Array<{
    profileId: string;
    name: string;
    position: string | null;
    channel: string;
    today: {
      planned: number;
      visited: number;
      productive: number;
      standard: number | null;
    };
    week: {
      planned: number;
      visited: number;
      productive: number;
      priorVisited: number;
    };
    trend: number[];
    workWith: { done: number; required: number | null };
    talkActions: number;
    overdue: number;
    perDiemWaiting: number;
    darMissing: boolean;
    actions: Record<"day" | "workWith" | "talk" | "perDiem" | "report", string>;
  }>;
};
