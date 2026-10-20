-- F-020: extend the same audit projection, retaining privacy exclusions.
create or replace function fiscal_audit_facts(row_data jsonb) returns jsonb language sql immutable as $$
 select coalesce(jsonb_object_agg(key,value),'{}') from jsonb_each(row_data) where key=any(array[
 'id','code','name','status','active','role','org_unit_id','channel','classification',
 'unit_price_centavos','total_centavos','discount_centavos','amount_centavos','amount_minor',
 'effective_from','effective_to','reason','reason_code','method','kind','variance_centavos',
 'expected_centavos','declared_centavos','quantity_base','unit_price_minor','total_minor',
 'source','source_type','source_id','sale_id','trip_id','product_id','price_list_id',
 'first_serial','last_serial','next_allocate','next_issue','registration_id','permit_reference',
 'evidence_reference','document_type','min_centavos','max_centavos','self_limit_centavos','approver_roles','offline_allowed',
 'entity_name','branch_name','tin','address','tax_basis_points','device_id','filed_at','acknowledged_at',
 'application_reference','document_id','request_id','actor_profile_id','decision'
 ]);
$$;
