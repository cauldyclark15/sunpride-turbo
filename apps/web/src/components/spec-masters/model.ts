export const MASTER_SECTIONS = [
  ["geography", "Geography"],
  ["beat", "Routes and beats"],
  ["channel", "Channels"],
  ["subchannel", "Sub-channels"],
  ["class_policy", "Potential classes"],
  ["msl", "Must-stock lists"],
  ["chain", "Account chains"],
  ["banner", "Banners"],
  ["branch", "Branches"],
] as const;
export type MasterKind = (typeof MASTER_SECTIONS)[number][0];
export type Polygon = { type: "Polygon"; coordinates: [number, number][][] };
export type NamedPoint = { label: string; latitude: number; longitude: number };
export type MasterData = {
  type?: string;
  parentId?: string | null;
  polygon?: Polygon;
  territoryId?: string | null;
  channelId?: string;
  subchannelId?: string | null;
  outletClass?: string;
  productIds?: string[];
  bands?: { class: string; minPotentialCentavos: number }[];
  routeId?: string;
  geographyId?: string;
  weekdays?: number[];
  cycleWeeks?: number;
  start?: NamedPoint;
  end?: NamedPoint;
  expectedOutlets?: number;
  distanceMeters?: number;
  repId?: string | null;
  vanId?: string | null;
  chainId?: string;
  bannerId?: string;
  outletId?: string;
  sapCustomerId?: string;
};
export type Master = {
  id: string;
  kind: MasterKind;
  code: string;
  label: string;
  versionId: string;
  version: number;
  status: string;
  orgUnitId: string | null;
  effectiveFrom: number;
  effectiveTo: number | null;
  data: MasterData;
  sample: boolean;
};
export type Choice = { id: string; name: string; code?: string };
export type Options = Record<
  "units" | "products" | "people" | "vans" | "outlets" | "routes" | "customers",
  Choice[]
>;
export type Setup = { sections: Record<MasterKind, Master[]> };
const text = (form: FormData, key: string) =>
  String(form.get(key) ?? "").trim();
const number = (form: FormData, key: string) => Number(text(form, key));
/** F-009/F-010/F-013/F-014/F-017/F-305 explicit form-to-wire boundary. */
export function masterDataFromForm(
  kind: MasterKind,
  form: FormData,
  polygon: Polygon | null,
): MasterData {
  switch (kind) {
    case "channel":
    case "chain":
      return {};
    case "subchannel":
      return { channelId: text(form, "channelId") };
    case "banner":
      return { chainId: text(form, "chainId") };
    case "branch":
      return {
        bannerId: text(form, "bannerId"),
        outletId: text(form, "outletId"),
        sapCustomerId: text(form, "sapCustomerId"),
      };
    case "msl":
      return {
        channelId: text(form, "channelId"),
        subchannelId: text(form, "subchannelId") || null,
        outletClass: text(form, "outletClass"),
        productIds: form.getAll("productIds").map(String),
      };
    case "class_policy":
      return {
        bands: ["A", "B", "C", "D"].map((outletClass) => ({
          class: outletClass,
          minPotentialCentavos: Math.round(
            number(form, `threshold-${outletClass}`) * 100,
          ),
        })),
      };
    case "geography": {
      if (!polygon) throw new Error("Draw a closed boundary before saving.");
      return {
        type: text(form, "type"),
        parentId: text(form, "parentId") || null,
        territoryId: text(form, "territoryId") || null,
        polygon,
      };
    }
    case "beat": {
      const point = (prefix: string): NamedPoint => ({
        label: text(form, `${prefix}Label`),
        latitude: number(form, `${prefix}Latitude`),
        longitude: number(form, `${prefix}Longitude`),
      });
      return {
        routeId: text(form, "routeId"),
        geographyId: text(form, "geographyId"),
        weekdays: form.getAll("weekdays").map(Number),
        cycleWeeks: number(form, "cycleWeeks"),
        start: point("start"),
        end: point("end"),
        expectedOutlets: number(form, "expectedOutlets"),
        distanceMeters: Math.round(number(form, "distanceKm") * 1000),
        repId: text(form, "repId") || null,
        vanId: text(form, "vanId") || null,
      };
    }
  }
}
/** Manila date entry does not depend on the browser's current timezone. */
export function masterEffectiveDate(input: string): number | null {
  if (!input) return null;
  const at = Date.parse(`${input}+08:00`);
  if (!Number.isFinite(at))
    throw new Error("Choose a valid Manila effective date.");
  return at;
}
