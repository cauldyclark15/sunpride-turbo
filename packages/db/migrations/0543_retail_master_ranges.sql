-- F-311 F-314 F-316 F-320: reject ambiguous effective masters at publication, including concurrent writers.
alter table retail_master_versions add constraint retail_layout_class_period exclude using gist
  (kind with =,outlet_class with =,tstzrange(effective_from,effective_to,'[)') with &&)
  where(kind in ('planogram','scorecard'));
alter table retail_master_versions add constraint retail_expiry_product_period exclude using gist
  ((data->>'productId') with =,tstzrange(effective_from,effective_to,'[)') with &&)
  where(kind='expiry_policy');
alter table retail_master_versions add constraint retail_equipment_serial_period exclude using gist
  ((data->>'serial') with =,tstzrange(effective_from,effective_to,'[)') with &&)
  where(kind='equipment');
alter table retail_master_versions add constraint retail_equipment_sap_period exclude using gist
  ((data->>'sapFixedAssetId') with =,tstzrange(effective_from,effective_to,'[)') with &&)
  where(kind='equipment');
