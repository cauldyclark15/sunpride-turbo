-- IP-INT2 ask 3: till cash reasons live in the same reason table as stock reasons (category 'cash').
-- The old store-till codes (till_limit, safe_drop, ...) are kept as seeded rows so movements already written stay readable;
-- `cash_kinds` says which cash movements (float, drop, pickup, paid_out, paid_in, no_sale) a code may be used for.
alter table inventory_reason_codes drop constraint if exists inventory_reason_codes_category_check;
alter table inventory_reason_codes add constraint inventory_reason_codes_category_check
  check (category in ('shrink','damage','expiry','found','count_variance','recall','transit_short','customer_return','system','cash'));
alter table inventory_reason_codes drop constraint if exists inventory_reason_codes_code_check;
alter table inventory_reason_codes add constraint inventory_reason_codes_code_check
  check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$');
alter table inventory_reason_codes add column cash_kinds text[];
alter table inventory_reason_codes add constraint inventory_reason_codes_cash_kinds_check
  check ((category = 'cash') = (cash_kinds is not null)
    and (cash_kinds is null or cash_kinds <@ array['float','drop','pickup','paid_out','paid_in','no_sale']::text[]));

insert into inventory_reason_codes (organization_id, code, label, category, direction, requires_note, requires_photo, cash_kinds) values
  ('sunpride', 'top_up',             'More change needed',                    'cash', 'in',   false, false, array['float']),
  ('sunpride', 'opening_correction', 'Opening float was short',               'cash', 'in',   false, false, array['float']),
  ('sunpride', 'till_limit',         'Too much cash in the drawer',           'cash', 'out',  false, false, array['drop']),
  ('sunpride', 'safe_drop',          'Move to the safe',                      'cash', 'out',  false, false, array['drop']),
  ('sunpride', 'end_of_day',         'End of day drop',                       'cash', 'out',  false, false, array['drop']),
  ('sunpride', 'bank_deposit',       'For the bank',                          'cash', 'out',  false, false, array['pickup']),
  ('sunpride', 'owner_pickup',       'Picked up by the owner or supervisor',  'cash', 'out',  false, false, array['pickup']),
  ('sunpride', 'supplies',           'Store supplies',                        'cash', 'out',  false, false, array['paid_out']),
  ('sunpride', 'delivery_fee',       'Delivery fee',                          'cash', 'out',  false, false, array['paid_out']),
  ('sunpride', 'petty_cash',         'Petty cash',                            'cash', 'out',  false, false, array['paid_out']),
  ('sunpride', 'change_fund',        'Change fund returned',                  'cash', 'in',   false, false, array['paid_in']),
  ('sunpride', 'correction',         'Correction',                            'cash', 'in',   false, false, array['paid_in']),
  ('sunpride', 'change_request',     'Customer needs change',                 'cash', 'both', false, false, array['no_sale']),
  ('sunpride', 'drawer_check',       'Checking the drawer',                   'cash', 'both', false, false, array['no_sale']),
  ('sunpride', 'other',              'Other (write why)',                     'cash', 'both', true,  false, array['paid_out','paid_in','no_sale'])
on conflict (organization_id, code) do nothing;
