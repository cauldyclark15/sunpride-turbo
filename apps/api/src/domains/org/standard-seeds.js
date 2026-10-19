// Ported from sfa/constants.ts; client evidence, not app roles.
export const POSITIONS = [
  { code: "SALES_HEAD", label: "Sales Head", category: "leadership" },
  { code: "SCDM", label: "SCDM", category: "leadership" },
  {
    code: "CDM_KA",
    label: "Channel Development Manager — Key Accounts Group",
    category: "supervisory",
  },
  {
    code: "CDM_GT",
    label: "Channel Development Manager — Gen Trade",
    category: "supervisory",
  },
  {
    code: "SR_CDS",
    label: "Sr Channel Development Specialist",
    category: "supervisory",
  },
  {
    code: "CDS",
    label: "Channel Development Specialist",
    category: "supervisory",
  },
  { code: "DS", label: "Distributor Specialist", category: "specialist" },
  { code: "KAS", label: "Key Account Specialist (KAS)", category: "field" },
  { code: "BOOKING", label: "Booking (GT-Booking)", category: "field" },
  { code: "RS", label: "Route Sales (RS)", category: "field" },
  {
    code: "PMOT",
    label: "PMOT (Public Market and Open Trade)",
    category: "field",
  },
  { code: "PMOT_EXTRUCK", label: "PMOT Extruck", category: "field" },
  {
    code: "PM_STALLS",
    label: "Public Market Stalls (pre-booking)",
    category: "field",
  },
  {
    code: "RDS",
    label: "Route Distribution Salesman (RDS)",
    category: "field",
  },
  {
    code: "DSP",
    label: "Distributor Sales Personnel (DSP)",
    category: "field",
  },
  { code: "ADP_PERSONNEL", label: "ADP Personnel", category: "field" },
  { code: "HR_ADMIN", label: "HR / Admin", category: "support" },
  { code: "FINANCE", label: "Finance / Treasury", category: "support" },
  { code: "MIS_IT", label: "MIS / IT", category: "support" },
];
export const DAILY = [
  ["KAS", 5, 90, "any_listed_activity"],
  ["BOOKING", 5, 90, "any_listed_activity"],
  ["RS", 30, 85, "any_listed_activity"],
  ["PM_STALLS", 30, 85, "any_listed_activity"],
  ["PMOT", 30, 85, "truck_seller"],
  ["PMOT_EXTRUCK", 30, 85, "truck_seller"],
  ["RDS", 30, 85, "truck_seller"],
];
export const COACHING = [
  ["SR_CDS", 1, 4],
  ["CDS", 3, 12],
  ["DS", 4, 16],
];
