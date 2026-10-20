// F-022 browser mirror of the pure API template contract (parity-tested).
export const MIGRATION_HEADERS = {
  customers: "legacy_id,sap_id,code,name,channel_code,org_unit_code",
  outlet_universe:
    "legacy_id,sap_id,code,name,address,owner_name,owner_phone,channel_code,subchannel_code,org_unit_code,customer_code,latitude,longitude,accuracy_meters",
  route_master:
    "legacy_id,sap_id,code,name,org_unit_code,territory_code,weekdays,cycle_days",
  open_ar:
    "legacy_id,sap_id,customer_code,document_number,document_date,due_date,currency,original_centavos,open_centavos,as_of",
} as const;
export type MigrationKind = keyof typeof MIGRATION_HEADERS;
export function isMigration(kind: string): kind is MigrationKind {
  return Object.hasOwn(MIGRATION_HEADERS, kind);
}
export function migrationPesos(centavos: string): string {
  const n = BigInt(centavos),
    negative = n < 0n,
    abs = negative ? -n : n;
  return `${negative ? "−" : ""}₱${(abs / 100n).toLocaleString("en-PH")}.${String(abs % 100n).padStart(2, "0")}`;
}
