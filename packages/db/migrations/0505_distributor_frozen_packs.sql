-- F-406: freeze selling-pack facts so linked returns do not use today's changed pack size.
alter table distributor_secondary_lines add column quantity_units bigint check(quantity_units > 0);
alter table distributor_secondary_lines add column units_per_uom bigint check(units_per_uom > 0);
