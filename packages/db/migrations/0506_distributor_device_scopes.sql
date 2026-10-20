-- F-407: each partner has an independent native device/cache scope, not its supervising employee subtree.
alter table distributors add column device_org_unit_id uuid unique references org_units(id);
