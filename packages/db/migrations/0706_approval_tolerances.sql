-- Approval tolerances (IP-FOUND, SPEC 3.5): effective-dated, editable by admin.
-- A null limit means that measure is not checked. Shipped rows are defaults, not confirmed by Sunpride.
create table approval_tolerances (
  organization_id text not null default 'sunpride',
  event text not null check (event in ('load_out_difference','transfer_receive_variance','load_in_difference','count_variance','truck_damage','cash_variance')),
  effective_from timestamptz not null default '2000-01-01T00:00:00Z',
  max_centavos bigint check (max_centavos is null or max_centavos >= 0),
  max_qty_base bigint check (max_qty_base is null or max_qty_base >= 0),
  max_cases bigint check (max_cases is null or max_cases >= 0),
  is_default boolean not null default false,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, event, effective_from)
);

insert into approval_tolerances (organization_id, event, max_centavos, max_qty_base, max_cases, is_default, updated_by) values
  ('sunpride', 'load_out_difference',       50000,  null, 1,    true, 'system:default'),
  ('sunpride', 'transfer_receive_variance', 50000,  null, null, true, 'system:default'),
  ('sunpride', 'load_in_difference',        50000,  null, null, true, 'system:default'),
  ('sunpride', 'count_variance',            50000,  2,    null, true, 'system:default'),
  ('sunpride', 'truck_damage',              100000, null, null, true, 'system:default'),
  ('sunpride', 'cash_variance',             5000,   null, null, true, 'system:default');
