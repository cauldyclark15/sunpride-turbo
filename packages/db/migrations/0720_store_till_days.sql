-- IP-ZDAY 0720: the till day. A register has one business day at a time; cashier sessions belong to it,
-- the Z reading closes it, and a session opened after the Z belongs to the next business date.
create table store_till_days (
  id uuid primary key default gen_random_uuid(),
  register_id uuid not null references store_registers(id),
  business_date date not null,
  status text not null default 'open' check (status in ('open','closing','z_done')),
  doc_number text,
  opened_at timestamptz not null default now(),
  closing_at timestamptz,
  closing_by uuid references profiles(id),
  z_done_at timestamptz,
  z_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (register_id, business_date),
  check ((status = 'z_done') = (z_done_at is not null))
);
create index store_till_days_register on store_till_days(register_id, business_date desc);
create trigger store_till_day_audit after insert or update on store_till_days for each row execute function fiscal_capture_change();

alter table store_shifts add column till_day_id uuid references store_till_days(id);
alter table store_shifts add column doc_number text;
create index store_shifts_till_day on store_shifts(till_day_id);

-- Backfill: one till day per (register, service date) of every existing session. Old rows stay readable.
insert into store_till_days (register_id, business_date, status, opened_at, z_done_at)
select s.register_id, s.service_date,
       case when z.captured_at is not null then 'z_done' else 'open' end,
       min(s.opened_at),
       z.captured_at
from store_shifts s
left join lateral (
  select max(r.captured_at) as captured_at from store_reads r
  where r.register_id = s.register_id and r.kind = 'z' and r.snapshot->>'date' = s.service_date::text
) z on true
group by s.register_id, s.service_date, z.captured_at
on conflict do nothing;

alter table store_shifts disable trigger store_shift_immutable;
update store_shifts s set till_day_id = d.id
from store_till_days d where d.register_id = s.register_id and d.business_date = s.service_date;
alter table store_shifts enable trigger store_shift_immutable;
