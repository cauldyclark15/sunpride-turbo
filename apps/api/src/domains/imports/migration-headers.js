// F-022 cutover templates; identifiers are text, money is integer centavos.
export const MIGRATION_KINDS = [
  "customers",
  "outlet_universe",
  "route_master",
  "open_ar",
];
export const MIGRATION_HEADERS = {
  customers: "legacy_id,sap_id,code,name,channel_code,org_unit_code",
  outlet_universe:
    "legacy_id,sap_id,code,name,address,owner_name,owner_phone,channel_code,subchannel_code,org_unit_code,customer_code,latitude,longitude,accuracy_meters",
  route_master:
    "legacy_id,sap_id,code,name,org_unit_code,territory_code,weekdays,cycle_days",
  open_ar:
    "legacy_id,sap_id,customer_code,document_number,document_date,due_date,currency,original_centavos,open_centavos,as_of",
};
