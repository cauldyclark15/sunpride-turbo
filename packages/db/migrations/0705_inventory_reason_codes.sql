-- Reason codes (IP-FOUND, SPEC 3.4): one list behind every reason field on adjustments, counts,
-- dispositions, transfer variances, damage and voids. Defaults are editable per organization.
create table inventory_reason_codes (
  organization_id text not null default 'sunpride',
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{1,39}$'),
  label text not null check (length(btrim(label)) between 1 and 120),
  category text not null check (category in ('shrink','damage','expiry','found','count_variance','recall','transit_short','customer_return','system')),
  direction text not null check (direction in ('in','out','both')),
  requires_note boolean not null default false,
  requires_photo boolean not null default false,
  approval_threshold_centavos bigint check (approval_threshold_centavos is null or approval_threshold_centavos >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, code)
);

insert into inventory_reason_codes (organization_id, code, label, category, direction, requires_note, requires_photo) values
  ('sunpride', 'DMG-HANDLING',  'Damaged in handling',        'damage',          'out',  false, true),
  ('sunpride', 'DMG-TRANSIT',   'Damaged in transit',         'damage',          'out',  false, true),
  ('sunpride', 'EXP',           'Expired',                    'expiry',          'out',  false, false),
  ('sunpride', 'SHORT-PICK',    'Short-picked at depot',      'shrink',          'both', false, false),
  ('sunpride', 'SHORT-TRANSIT', 'Missing in transit',         'transit_short',   'out',  false, false),
  ('sunpride', 'FOUND',         'Found stock',                'found',           'in',   true,  false),
  ('sunpride', 'COUNT-ERR',     'Counting error corrected',   'count_variance',  'both', true,  false),
  ('sunpride', 'RECALL',        'Recalled lot',               'recall',          'out',  false, false),
  ('sunpride', 'CUST-RETURN',   'Customer return',            'customer_return', 'in',   false, true),
  ('sunpride', 'SAMPLE',        'Free sample / promo use',    'shrink',          'out',  true,  false);
