/**
 * SP-0129 (BETA-SAMPLE-DATA): made-up, realistic master data for beta testers.
 *
 * NOTHING HERE IS SUNPRIDE'S REAL DATA. Every code starts with `SMP` so a sample row is
 * recognisable anywhere in the app; every row the seed writes is also listed in
 * `sampleDataRows` so `beta/sample:reset` removes exactly those rows when the real master
 * data arrives (SP-0033 / SP-0034). Prices are invented peso amounts (VAT-inclusive).
 */

export const SAMPLE_BATCH = "beta-sample-v1";
export const SAMPLE_ACTOR = "system:beta-sample";
/** Sample rows take effect from 1 Oct 2026 00:00 Manila (or the seed time if earlier). */
export const SAMPLE_EPOCH = Date.UTC(2026, 8, 30, 16, 0, 0);
export const SAMPLE_EMAIL_DOMAIN = "sunpride.test";

export type SampleUnit = "PC" | "PACK" | "CASE";
export const SAMPLE_UOMS: { code: SampleUnit; name: string }[] = [
  { code: "PC", name: "Piece" },
  { code: "PACK", name: "Pack" },
  { code: "CASE", name: "Case" },
];

export type SampleProduct = {
  code: string;
  name: string;
  category: string;
  /** Route Sales price of one piece, in centavos. */
  piecePriceMinor: number;
  caseQty: number;
  packQty?: number;
};

export const SAMPLE_PRODUCTS: SampleProduct[] = [
  // Canned fruit
  {
    code: "SMP-PCH-227",
    name: "Pineapple Chunks 227g",
    category: "Canned Fruit",
    piecePriceMinor: 4275,
    caseQty: 48,
  },
  {
    code: "SMP-PCH-432",
    name: "Pineapple Chunks 432g",
    category: "Canned Fruit",
    piecePriceMinor: 6850,
    caseQty: 24,
  },
  {
    code: "SMP-PTB-227",
    name: "Pineapple Tidbits 227g",
    category: "Canned Fruit",
    piecePriceMinor: 4250,
    caseQty: 48,
  },
  {
    code: "SMP-PSL-439",
    name: "Pineapple Slices 439g",
    category: "Canned Fruit",
    piecePriceMinor: 7175,
    caseQty: 24,
  },
  {
    code: "SMP-PCR-567",
    name: "Crushed Pineapple 567g",
    category: "Canned Fruit",
    piecePriceMinor: 8450,
    caseQty: 24,
  },
  {
    code: "SMP-FCK-432",
    name: "Fruit Cocktail 432g",
    category: "Canned Fruit",
    piecePriceMinor: 7900,
    caseQty: 24,
  },
  {
    code: "SMP-FCK-836",
    name: "Fruit Cocktail 836g",
    category: "Canned Fruit",
    piecePriceMinor: 13950,
    caseQty: 12,
  },
  {
    code: "SMP-TFC-836",
    name: "Tropical Fruit Cocktail 836g",
    category: "Canned Fruit",
    piecePriceMinor: 14500,
    caseQty: 12,
  },
  {
    code: "SMP-MNG-425",
    name: "Mango Halves in Syrup 425g",
    category: "Canned Fruit",
    piecePriceMinor: 9875,
    caseQty: 24,
  },
  {
    code: "SMP-LYC-565",
    name: "Lychee in Syrup 565g",
    category: "Canned Fruit",
    piecePriceMinor: 11200,
    caseQty: 24,
  },
  // Juices
  {
    code: "SMP-PJ-240",
    name: "Pineapple Juice 240ml",
    category: "Juices",
    piecePriceMinor: 2650,
    caseQty: 24,
    packQty: 6,
  },
  {
    code: "SMP-PJ-1L",
    name: "Pineapple Juice 1L",
    category: "Juices",
    piecePriceMinor: 9900,
    caseQty: 12,
  },
  {
    code: "SMP-POJ-240",
    name: "Pineapple-Orange Juice 240ml",
    category: "Juices",
    piecePriceMinor: 2750,
    caseQty: 24,
    packQty: 6,
  },
  {
    code: "SMP-MJ-240",
    name: "Mango Juice Drink 240ml",
    category: "Juices",
    piecePriceMinor: 2500,
    caseQty: 24,
    packQty: 6,
  },
  {
    code: "SMP-CJ-1L",
    name: "Calamansi Juice Drink 1L",
    category: "Juices",
    piecePriceMinor: 8500,
    caseQty: 12,
  },
  // Canned meat and fish
  {
    code: "SMP-CB-150",
    name: "Corned Beef 150g",
    category: "Canned Meat",
    piecePriceMinor: 4650,
    caseQty: 48,
  },
  {
    code: "SMP-CB-260",
    name: "Corned Beef 260g",
    category: "Canned Meat",
    piecePriceMinor: 7600,
    caseQty: 24,
  },
  {
    code: "SMP-LM-165",
    name: "Luncheon Meat 165g",
    category: "Canned Meat",
    piecePriceMinor: 5500,
    caseQty: 48,
  },
  {
    code: "SMP-LM-340",
    name: "Luncheon Meat 340g",
    category: "Canned Meat",
    piecePriceMinor: 10450,
    caseQty: 24,
  },
  {
    code: "SMP-MLF-150",
    name: "Meat Loaf 150g",
    category: "Canned Meat",
    piecePriceMinor: 2875,
    caseQty: 48,
  },
  {
    code: "SMP-VS-88",
    name: "Vienna Sausage 88g",
    category: "Canned Meat",
    piecePriceMinor: 3125,
    caseQty: 48,
  },
  {
    code: "SMP-PB-230",
    name: "Pork and Beans 230g",
    category: "Canned Meat",
    piecePriceMinor: 3400,
    caseQty: 48,
  },
  {
    code: "SMP-SRD-155",
    name: "Sardines in Tomato Sauce 155g",
    category: "Canned Meat",
    piecePriceMinor: 2475,
    caseQty: 100,
    packQty: 10,
  },
  // Sauces and mixes
  {
    code: "SMP-SPS-250",
    name: "Spaghetti Sauce Sweet Style 250g",
    category: "Mixes",
    piecePriceMinor: 3850,
    caseQty: 48,
  },
  {
    code: "SMP-SPS-1KG",
    name: "Spaghetti Sauce Sweet Style 1kg",
    category: "Mixes",
    piecePriceMinor: 12900,
    caseQty: 12,
  },
  {
    code: "SMP-TS-250",
    name: "Tomato Sauce 250g",
    category: "Mixes",
    piecePriceMinor: 2350,
    caseQty: 48,
  },
  {
    code: "SMP-PCM-400",
    name: "Pancake Mix 400g",
    category: "Mixes",
    piecePriceMinor: 7250,
    caseQty: 24,
  },
  {
    code: "SMP-CHP-250",
    name: "Champorado Mix 250g",
    category: "Mixes",
    piecePriceMinor: 5400,
    caseQty: 24,
  },
  {
    code: "SMP-LFM-80",
    name: "Leche Flan Mix 80g",
    category: "Mixes",
    piecePriceMinor: 3275,
    caseQty: 48,
    packQty: 12,
  },
  {
    code: "SMP-GJM-25",
    name: "Gulaman Jelly Mix 25g",
    category: "Mixes",
    piecePriceMinor: 1850,
    caseQty: 96,
    packQty: 12,
  },
  {
    code: "SMP-CSM-50",
    name: "Caldereta Sauce Mix 50g",
    category: "Mixes",
    piecePriceMinor: 2900,
    caseQty: 72,
    packQty: 12,
  },
  // Frozen
  {
    code: "SMP-HD-1KG",
    name: "Jumbo Hotdog 1kg",
    category: "Frozen",
    piecePriceMinor: 22500,
    caseQty: 12,
  },
  {
    code: "SMP-HD-500",
    name: "Regular Hotdog 500g",
    category: "Frozen",
    piecePriceMinor: 10900,
    caseQty: 24,
  },
  {
    code: "SMP-LNG-450",
    name: "Pork Longganisa 450g",
    category: "Frozen",
    piecePriceMinor: 15500,
    caseQty: 24,
  },
  {
    code: "SMP-TCN-450",
    name: "Pork Tocino 450g",
    category: "Frozen",
    piecePriceMinor: 16250,
    caseQty: 24,
  },
  {
    code: "SMP-CNG-400",
    name: "Chicken Nuggets 400g",
    category: "Frozen",
    piecePriceMinor: 13800,
    caseQty: 24,
  },
  {
    code: "SMP-SMI-300",
    name: "Pork Siomai 300g (20s)",
    category: "Frozen",
    piecePriceMinor: 12500,
    caseQty: 24,
  },
  {
    code: "SMP-EMB-250",
    name: "Embutido 250g",
    category: "Frozen",
    piecePriceMinor: 9800,
    caseQty: 24,
  },
  {
    code: "SMP-SKL-1KG",
    name: "Skinless Longganisa 1kg",
    category: "Frozen",
    piecePriceMinor: 24800,
    caseQty: 12,
  },
  {
    code: "SMP-BRG-12",
    name: "Beef Burger Patties 12s",
    category: "Frozen",
    piecePriceMinor: 18900,
    caseQty: 12,
  },
];

export type SampleChannel = "KEY_ACCOUNTS" | "ROUTE_SALES" | "PUBLIC_MARKET";

/** One price list per channel; prices are the Route Sales piece price times `factor`. */
export const SAMPLE_PRICE_LISTS: {
  code: string;
  name: string;
  channel: SampleChannel;
  /** Basis points of the Route Sales piece price (10000 = same). */
  pieceFactorBp: number;
}[] = [
  {
    code: "SMP-PL-KA",
    name: "Key Accounts (sample)",
    channel: "KEY_ACCOUNTS",
    pieceFactorBp: 9_600,
  },
  {
    code: "SMP-PL-RS",
    name: "Route Sales / PMOT (sample)",
    channel: "ROUTE_SALES",
    pieceFactorBp: 10_000,
  },
  {
    code: "SMP-PL-PM",
    name: "Public Market (sample)",
    channel: "PUBLIC_MARKET",
    pieceFactorBp: 10_300,
  },
];
/** A case sells 5% under 'case quantity x piece', a pack 2% under (rounded to 25 centavos). */
export const CASE_DISCOUNT_BP = 500;
export const PACK_DISCOUNT_BP = 200;

const roundTo25 = (minor: number) => Math.round(minor / 25) * 25;
export function samplePrice(
  product: SampleProduct,
  list: (typeof SAMPLE_PRICE_LISTS)[number],
  unit: SampleUnit,
): number | null {
  const piece = roundTo25(
    (product.piecePriceMinor * list.pieceFactorBp) / 10_000,
  );
  if (unit === "PC") return piece;
  if (unit === "CASE")
    return roundTo25(
      (piece * product.caseQty * (10_000 - CASE_DISCOUNT_BP)) / 10_000,
    );
  if (!product.packQty) return null;
  return roundTo25(
    (piece * product.packQty * (10_000 - PACK_DISCOUNT_BP)) / 10_000,
  );
}

/** GS1 check digit for a 12/13-digit body (EAN-13 / GTIN-14). */
export function gs1CheckDigit(body: string) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return String((10 - (sum % 10)) % 10);
}
/** Piece EAN-13 (480 = Philippines prefix, 99999 = made-up company) and case GTIN-14. */
export function sampleBarcodes(index: number) {
  const body = `48099999${String(1000 + index).padStart(4, "0")}`;
  const piece = body + gs1CheckDigit(body);
  const caseBody = `1${body}`;
  return { piece, case: caseBody + gs1CheckDigit(caseBody) };
}

export const SAMPLE_PROMOTIONS: {
  code: string;
  name: string;
  /** Absent: every list. */
  priceListCode?: string;
  rule:
    | {
        kind: "buy_x_get_y";
        buy: [string, SampleUnit, number];
        free: [string, SampleUnit, number];
      }
    | {
        kind: "percent_off";
        item: [string, SampleUnit, number];
        percentOffBasisPoints: number;
      }
    | {
        kind: "bundle";
        components: [string, SampleUnit, number][];
        bundlePriceMinor: number;
      };
}[] = [
  {
    code: "SMP-PROMO-PJ240-B10G1",
    name: "Buy 10 Pineapple Juice 240ml, get 1 free",
    rule: {
      kind: "buy_x_get_y",
      buy: ["SMP-PJ-240", "PC", 10],
      free: ["SMP-PJ-240", "PC", 1],
    },
  },
  {
    code: "SMP-PROMO-CB150-CASE5",
    name: "5% off every case of Corned Beef 150g",
    rule: {
      kind: "percent_off",
      item: ["SMP-CB-150", "CASE", 1],
      percentOffBasisPoints: 500,
    },
  },
  {
    code: "SMP-PROMO-MERIENDA",
    name: "Merienda bundle: Pancake Mix 400g + Pineapple Juice 1L for P159",
    priceListCode: "SMP-PL-RS",
    rule: {
      kind: "bundle",
      components: [
        ["SMP-PCM-400", "PC", 1],
        ["SMP-PJ-1L", "PC", 1],
      ],
      bundlePriceMinor: 15_900,
    },
  },
];

/** National root (existing) > Visayas > Cebu > Cebu North / Cebu South. */
export const SAMPLE_ORG_UNITS: {
  code: string;
  name: string;
  typeCode: "REGION" | "AREA" | "TERRITORY";
  parent: string | null;
}[] = [
  { code: "SMP-VIS", name: "Visayas", typeCode: "REGION", parent: null },
  { code: "SMP-CEBU", name: "Cebu", typeCode: "AREA", parent: "SMP-VIS" },
  {
    code: "SMP-CEBU-N",
    name: "Cebu North",
    typeCode: "TERRITORY",
    parent: "SMP-CEBU",
  },
  {
    code: "SMP-CEBU-S",
    name: "Cebu South",
    typeCode: "TERRITORY",
    parent: "SMP-CEBU",
  },
];

export const SAMPLE_TERRITORIES = [
  {
    code: "SMP-T-CBN",
    name: "Mandaue - Consolacion",
    channel: "Route Sales",
    orgUnit: "SMP-CEBU-N",
  },
  {
    code: "SMP-T-CBS",
    name: "Talisay - Minglanilla",
    channel: "Route Sales",
    orgUnit: "SMP-CEBU-S",
  },
  {
    code: "SMP-T-CKA",
    name: "Metro Cebu Key Accounts",
    channel: "Key Accounts",
    orgUnit: "SMP-CEBU",
  },
] as const;

/** Weekdays: Sunday = 0. */
export const SAMPLE_ROUTES = [
  {
    code: "SMP-R-CBN-1",
    name: "Mandaue Route 1 (Mon/Wed/Fri)",
    territory: "SMP-T-CBN",
    weekdays: [1, 3, 5],
  },
  {
    code: "SMP-R-CBS-1",
    name: "Talisay Truck Route (Tue/Thu/Sat)",
    territory: "SMP-T-CBS",
    weekdays: [2, 4, 6],
  },
  {
    code: "SMP-R-CKA-1",
    name: "Key Accounts Round (Mon-Fri)",
    territory: "SMP-T-CKA",
    weekdays: [1, 2, 3, 4, 5],
  },
] as const;

export type SampleStore = {
  code: string;
  name: string;
  channel: SampleChannel;
  classification: string;
  address: string;
  lat: number;
  lng: number;
  route: (typeof SAMPLE_ROUTES)[number]["code"];
  contact: string;
  phone: string;
  /** Made-up credit limit in pesos (legacy customer master; SP-0088 credit check). */
  creditLimit: number;
};

export const SAMPLE_STORES: SampleStore[] = [
  // Key accounts (supermarkets, groceries) - Metro Cebu
  {
    code: "SMP-O-0001",
    name: "Fortune Supermart Mandaue",
    channel: "KEY_ACCOUNTS",
    classification: "Supermarket",
    address: "A. C. Cortes Ave, Ibabao-Estancia, Mandaue City, Cebu",
    lat: 10.329,
    lng: 123.9393,
    route: "SMP-R-CKA-1",
    contact: "Liza Tan",
    phone: "0917 555 0101",
    creditLimit: 350000,
  },
  {
    code: "SMP-O-0002",
    name: "Colon Grocery Center",
    channel: "KEY_ACCOUNTS",
    classification: "Grocery",
    address: "Colon St, Cebu City, Cebu",
    lat: 10.2967,
    lng: 123.901,
    route: "SMP-R-CKA-1",
    contact: "Ramon Go",
    phone: "0917 555 0102",
    creditLimit: 250000,
  },
  {
    code: "SMP-O-0003",
    name: "Banilad Fresh Market Supermart",
    channel: "KEY_ACCOUNTS",
    classification: "Supermarket",
    address: "Gov. M. Cuenco Ave, Banilad, Cebu City",
    lat: 10.3436,
    lng: 123.9137,
    route: "SMP-R-CKA-1",
    contact: "Grace Uy",
    phone: "0917 555 0103",
    creditLimit: 300000,
  },
  {
    code: "SMP-O-0004",
    name: "Talamban Family Mart",
    channel: "KEY_ACCOUNTS",
    classification: "Supermarket",
    address: "Gov. M. Cuenco Ave, Talamban, Cebu City",
    lat: 10.3667,
    lng: 123.9147,
    route: "SMP-R-CKA-1",
    contact: "Jojo Lim",
    phone: "0917 555 0104",
    creditLimit: 200000,
  },
  {
    code: "SMP-O-0005",
    name: "Mabolo Shoppers Grocery",
    channel: "KEY_ACCOUNTS",
    classification: "Grocery",
    address: "Juan Luna Ave, Mabolo, Cebu City",
    lat: 10.3175,
    lng: 123.9117,
    route: "SMP-R-CKA-1",
    contact: "Annie Sy",
    phone: "0917 555 0105",
    creditLimit: 180000,
  },
  {
    code: "SMP-O-0006",
    name: "Lapu-Lapu Value Supermarket",
    channel: "KEY_ACCOUNTS",
    classification: "Supermarket",
    address: "M. L. Quezon Hwy, Pusok, Lapu-Lapu City",
    lat: 10.3216,
    lng: 123.9656,
    route: "SMP-R-CKA-1",
    contact: "Dennis Chua",
    phone: "0917 555 0106",
    creditLimit: 280000,
  },
  {
    code: "SMP-O-0007",
    name: "Guadalupe Savers Mart",
    channel: "KEY_ACCOUNTS",
    classification: "Grocery",
    address: "V. Rama Ave, Guadalupe, Cebu City",
    lat: 10.3221,
    lng: 123.8857,
    route: "SMP-R-CKA-1",
    contact: "Marivic Ong",
    phone: "0917 555 0107",
    creditLimit: 150000,
  },
  {
    code: "SMP-O-0008",
    name: "Talisay Prime Supermart",
    channel: "KEY_ACCOUNTS",
    classification: "Supermarket",
    address: "Tabunok, Talisay City, Cebu",
    lat: 10.2595,
    lng: 123.8408,
    route: "SMP-R-CKA-1",
    contact: "Edwin Yap",
    phone: "0917 555 0108",
    creditLimit: 220000,
  },
  // Route sales north (sari-sari, minimarts) - Mandaue / Consolacion
  {
    code: "SMP-O-0101",
    name: "Aling Nena Sari-Sari Store",
    channel: "ROUTE_SALES",
    classification: "Sari-sari",
    address: "Sitio Pagsabungan, Basak, Mandaue City",
    lat: 10.348,
    lng: 123.945,
    route: "SMP-R-CBN-1",
    contact: "Nena Cabahug",
    phone: "0918 555 0201",
    creditLimit: 15000,
  },
  {
    code: "SMP-O-0102",
    name: "Jun-Jun Minimart",
    channel: "ROUTE_SALES",
    classification: "Minimart",
    address: "Plaridel St, Alang-Alang, Mandaue City",
    lat: 10.3331,
    lng: 123.9418,
    route: "SMP-R-CBN-1",
    contact: "Junrey Ouano",
    phone: "0918 555 0202",
    creditLimit: 30000,
  },
  {
    code: "SMP-O-0103",
    name: "Tindahan ni Lola Pacing",
    channel: "ROUTE_SALES",
    classification: "Sari-sari",
    address: "Looc, Mandaue City",
    lat: 10.3392,
    lng: 123.953,
    route: "SMP-R-CBN-1",
    contact: "Pacita Cuizon",
    phone: "0918 555 0203",
    creditLimit: 10000,
  },
  {
    code: "SMP-O-0104",
    name: "RJ Variety Store",
    channel: "ROUTE_SALES",
    classification: "Sari-sari",
    address: "Subangdaku, Mandaue City",
    lat: 10.3255,
    lng: 123.9309,
    route: "SMP-R-CBN-1",
    contact: "Rodel Jumao-as",
    phone: "0918 555 0204",
    creditLimit: 15000,
  },
  {
    code: "SMP-O-0105",
    name: "Bebeng's Store",
    channel: "ROUTE_SALES",
    classification: "Sari-sari",
    address: "Tipolo, Mandaue City",
    lat: 10.3352,
    lng: 123.9241,
    route: "SMP-R-CBN-1",
    contact: "Bebeng Alcoseba",
    phone: "0918 555 0205",
    creditLimit: 12000,
  },
  {
    code: "SMP-O-0106",
    name: "Consolacion 8-to-8 Mart",
    channel: "ROUTE_SALES",
    classification: "Minimart",
    address: "Poblacion Oriental, Consolacion, Cebu",
    lat: 10.3766,
    lng: 123.9573,
    route: "SMP-R-CBN-1",
    contact: "Allan Sanchez",
    phone: "0918 555 0206",
    creditLimit: 25000,
  },
  {
    code: "SMP-O-0107",
    name: "Mang Tonyo Sari-Sari",
    channel: "ROUTE_SALES",
    classification: "Sari-sari",
    address: "Lamac, Consolacion, Cebu",
    lat: 10.3895,
    lng: 123.9612,
    route: "SMP-R-CBN-1",
    contact: "Antonio Dabon",
    phone: "0918 555 0207",
    creditLimit: 10000,
  },
  // Route sales south (truck route) - Talisay / Minglanilla
  {
    code: "SMP-O-0201",
    name: "Lucky Seven Store",
    channel: "ROUTE_SALES",
    classification: "Sari-sari",
    address: "Lawaan II, Talisay City, Cebu",
    lat: 10.264,
    lng: 123.8533,
    route: "SMP-R-CBS-1",
    contact: "Lucy Abellana",
    phone: "0919 555 0301",
    creditLimit: 12000,
  },
  {
    code: "SMP-O-0202",
    name: "Dumlog Minimart",
    channel: "ROUTE_SALES",
    classification: "Minimart",
    address: "Dumlog, Talisay City, Cebu",
    lat: 10.2523,
    lng: 123.8456,
    route: "SMP-R-CBS-1",
    contact: "Ricky Gabuya",
    phone: "0919 555 0302",
    creditLimit: 25000,
  },
  {
    code: "SMP-O-0203",
    name: "Tata Inting Sari-Sari",
    channel: "ROUTE_SALES",
    classification: "Sari-sari",
    address: "Bulacao, Talisay City, Cebu",
    lat: 10.2729,
    lng: 123.853,
    route: "SMP-R-CBS-1",
    contact: "Jacinto Labra",
    phone: "0919 555 0303",
    creditLimit: 10000,
  },
  {
    code: "SMP-O-0204",
    name: "San Isidro General Merchandise",
    channel: "ROUTE_SALES",
    classification: "Minimart",
    address: "San Isidro, Talisay City, Cebu",
    lat: 10.2468,
    lng: 123.837,
    route: "SMP-R-CBS-1",
    contact: "Isidro Rama",
    phone: "0919 555 0304",
    creditLimit: 30000,
  },
  {
    code: "SMP-O-0205",
    name: "Minglanilla Corner Store",
    channel: "ROUTE_SALES",
    classification: "Sari-sari",
    address: "Tungkop, Minglanilla, Cebu",
    lat: 10.244,
    lng: 123.7956,
    route: "SMP-R-CBS-1",
    contact: "Gemma Paras",
    phone: "0919 555 0305",
    creditLimit: 12000,
  },
  {
    code: "SMP-O-0206",
    name: "Tunghaan Variety Store",
    channel: "ROUTE_SALES",
    classification: "Sari-sari",
    address: "Tunghaan, Minglanilla, Cebu",
    lat: 10.2357,
    lng: 123.7879,
    route: "SMP-R-CBS-1",
    contact: "Nonoy Villarin",
    phone: "0919 555 0306",
    creditLimit: 10000,
  },
  {
    code: "SMP-O-0207",
    name: "Calajo-an Mini Grocery",
    channel: "ROUTE_SALES",
    classification: "Minimart",
    address: "Calajo-an, Minglanilla, Cebu",
    lat: 10.2489,
    lng: 123.8024,
    route: "SMP-R-CBS-1",
    contact: "Wilma Bacalso",
    phone: "0919 555 0307",
    creditLimit: 20000,
  },
  // Public market stalls
  {
    code: "SMP-O-0301",
    name: "Carbon Market Stall 12 - Dela Cruz",
    channel: "PUBLIC_MARKET",
    classification: "Market stall",
    address: "Carbon Public Market, M. C. Briones St, Cebu City",
    lat: 10.2918,
    lng: 123.899,
    route: "SMP-R-CBS-1",
    contact: "Rosa Dela Cruz",
    phone: "0920 555 0401",
    creditLimit: 8000,
  },
  {
    code: "SMP-O-0302",
    name: "Carbon Market Stall 27 - Almonte",
    channel: "PUBLIC_MARKET",
    classification: "Market stall",
    address: "Carbon Public Market, M. C. Briones St, Cebu City",
    lat: 10.2922,
    lng: 123.8996,
    route: "SMP-R-CBS-1",
    contact: "Ben Almonte",
    phone: "0920 555 0402",
    creditLimit: 8000,
  },
  {
    code: "SMP-O-0303",
    name: "Pardo Public Market Stall 5",
    channel: "PUBLIC_MARKET",
    classification: "Market stall",
    address: "Pardo Public Market, Cebu City",
    lat: 10.2795,
    lng: 123.8566,
    route: "SMP-R-CBS-1",
    contact: "Tess Ybanez",
    phone: "0920 555 0403",
    creditLimit: 6000,
  },
  {
    code: "SMP-O-0304",
    name: "Talisay Public Market Stall 18",
    channel: "PUBLIC_MARKET",
    classification: "Market stall",
    address: "Talisay Public Market, Poblacion, Talisay City",
    lat: 10.2447,
    lng: 123.8492,
    route: "SMP-R-CBS-1",
    contact: "Cora Mendoza",
    phone: "0920 555 0404",
    creditLimit: 6000,
  },
  {
    code: "SMP-O-0305",
    name: "Mandaue Public Market Stall 9",
    channel: "PUBLIC_MARKET",
    classification: "Market stall",
    address: "Mandaue Public Market, Centro, Mandaue City",
    lat: 10.3262,
    lng: 123.9437,
    route: "SMP-R-CBN-1",
    contact: "Jessa Seno",
    phone: "0920 555 0405",
    creditLimit: 8000,
  },
  {
    code: "SMP-O-0306",
    name: "Mandaue Public Market Stall 31",
    channel: "PUBLIC_MARKET",
    classification: "Market stall",
    address: "Mandaue Public Market, Centro, Mandaue City",
    lat: 10.3265,
    lng: 123.9441,
    route: "SMP-R-CBN-1",
    contact: "Boy Ceniza",
    phone: "0920 555 0406",
    creditLimit: 6000,
  },
  {
    code: "SMP-O-0307",
    name: "Consolacion Public Market Stall 3",
    channel: "PUBLIC_MARKET",
    classification: "Market stall",
    address: "Consolacion Public Market, Poblacion, Consolacion",
    lat: 10.3773,
    lng: 123.9581,
    route: "SMP-R-CBN-1",
    contact: "Linda Remedio",
    phone: "0920 555 0407",
    creditLimit: 6000,
  },
  {
    code: "SMP-O-0308",
    name: "Minglanilla Public Market Stall 7",
    channel: "PUBLIC_MARKET",
    classification: "Market stall",
    address: "Minglanilla Public Market, Poblacion Ward II, Minglanilla",
    lat: 10.2443,
    lng: 123.7962,
    route: "SMP-R-CBS-1",
    contact: "Elena Canete",
    phone: "0920 555 0408",
    creditLimit: 6000,
  },
];

/** Call sheet (order catalog) per channel: product codes each store may order. */
export const SAMPLE_CATALOG: Record<SampleChannel, string[]> = {
  KEY_ACCOUNTS: SAMPLE_PRODUCTS.map((product) => product.code),
  ROUTE_SALES: SAMPLE_PRODUCTS.filter(
    (product) => product.category !== "Frozen",
  ).map((product) => product.code),
  PUBLIC_MARKET: [
    "SMP-PCH-227",
    "SMP-FCK-432",
    "SMP-PJ-240",
    "SMP-MJ-240",
    "SMP-CB-150",
    "SMP-LM-165",
    "SMP-MLF-150",
    "SMP-VS-88",
    "SMP-PB-230",
    "SMP-SRD-155",
    "SMP-SPS-250",
    "SMP-TS-250",
    "SMP-LFM-80",
    "SMP-GJM-25",
    "SMP-CSM-50",
  ],
};

export const SAMPLE_DEPOT = {
  code: "SMP-DEPOT-CEBU",
  name: "Cebu Depot (sample)",
  orgUnit: "SMP-CEBU",
};
/** Opening depot stock per product, in cases. */
export const SAMPLE_OPENING_CASES = 40;

export const SAMPLE_TRUCKS = [
  {
    vehicleCode: "SMP-TRK-01",
    plateNumber: "GAC 4521",
    name: "Isuzu Elf wing van",
    truckLocation: "SMP-TRUCK-01",
    capacityNote: "About 180 cases",
    orgUnit: "SMP-CEBU-S",
  },
  {
    vehicleCode: "SMP-TRK-02",
    plateNumber: "NBQ 7783",
    name: "Mitsubishi Canter",
    truckLocation: "SMP-TRUCK-02",
    capacityNote: "About 220 cases",
    orgUnit: "SMP-CEBU-N",
  },
] as const;

/** One invited tester per role (invitations only; testers choose their own password). */
export const SAMPLE_PEOPLE: {
  key: string;
  email: string;
  name: string;
  role: "sales" | "manager" | "operations" | "approver" | "admin" | "analyst";
  position?: string;
  orgUnit: string | "ROOT";
  territory?: string;
  route?: string;
  supervisedBy?: string;
}[] = [
  {
    key: "manager",
    email: `supervisor@${SAMPLE_EMAIL_DOMAIN}`,
    name: "Carmela Villanueva",
    role: "manager",
    position: "CDS",
    orgUnit: "SMP-CEBU",
  },
  {
    key: "sales",
    email: `sales@${SAMPLE_EMAIL_DOMAIN}`,
    name: "Rhea Santos",
    role: "sales",
    position: "RS",
    orgUnit: "SMP-CEBU-N",
    territory: "SMP-T-CBN",
    route: "SMP-R-CBN-1",
    supervisedBy: "manager",
  },
  {
    key: "van",
    email: `van@${SAMPLE_EMAIL_DOMAIN}`,
    name: "Jomar Abella",
    role: "sales",
    position: "PMOT_EXTRUCK",
    orgUnit: "SMP-CEBU-S",
    territory: "SMP-T-CBS",
    route: "SMP-R-CBS-1",
    supervisedBy: "manager",
  },
  {
    key: "operations",
    email: `operations@${SAMPLE_EMAIL_DOMAIN}`,
    name: "Dennis Ramos",
    role: "operations",
    orgUnit: "SMP-CEBU",
  },
  {
    key: "approver",
    email: `approver@${SAMPLE_EMAIL_DOMAIN}`,
    name: "Teresita Lim",
    role: "approver",
    orgUnit: "SMP-VIS",
  },
  {
    key: "admin",
    email: `admin@${SAMPLE_EMAIL_DOMAIN}`,
    name: "Paolo Garcia",
    role: "admin",
    orgUnit: "ROOT",
  },
  {
    key: "analyst",
    email: `analyst@${SAMPLE_EMAIL_DOMAIN}`,
    name: "Kristine Bautista",
    role: "analyst",
    orgUnit: "ROOT",
  },
];
