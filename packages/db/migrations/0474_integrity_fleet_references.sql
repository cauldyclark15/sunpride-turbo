-- F-021: assignment references remain graph-visible to safe seed/reset and ordinary ownership checks.
alter table fleet_asset_versions add constraint fleet_asset_versions_unit_fk foreign key(org_unit_id) references org_units(id);
alter table fleet_asset_versions add constraint fleet_asset_versions_person_fk foreign key(assigned_profile_id) references profiles(id);
