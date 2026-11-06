-- IP-INT2FIX 0770: three safety nets for the day the till-day release lands on registers that already trade.

-- 1. Z from an older app build (no supervisor PIN) is accepted once and logged as an override of its own kind.
do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'store_overrides'::regclass and contype = 'c'
              and (pg_get_constraintdef(oid) like '%void_line%' or pg_get_constraintdef(oid) like '%pin_offline%') loop
    execute format('alter table store_overrides drop constraint %I', c);
  end loop;
end $$;
alter table store_overrides add constraint store_overrides_kind_check
  check (kind in ('void_line','void_sale','refund','price','discount','reprint','no_sale','cash_drop','cash_pickup','paid_out','z_reading','force_close','z_legacy_no_pin'));
alter table store_overrides add constraint store_overrides_method_check
  check (method in ('pin_online','pin_offline','office','legacy_no_pin'));

-- 2. Old days that 0720 backfilled and no Z ever closed: readable for ever, never joined by a new session.
do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'store_till_days'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%closing%' loop
    execute format('alter table store_till_days drop constraint %I', c);
  end loop;
end $$;
alter table store_till_days add constraint store_till_days_status_check
  check (status in ('open', 'closing', 'z_done', 'closed_no_z'));
update store_till_days d set status = 'closed_no_z', updated_at = now()
 where d.status = 'open'
   and not exists (select 1 from store_z_readings z where z.till_day_id = d.id)
   and not exists (select 1 from store_fiscal_accumulators a where a.till_day_id = d.id)
   and d.business_date < (select max(x.business_date) from store_till_days x where x.register_id = d.register_id);

-- 3. Grand totals continue from the register's history: ONE opening row per register, written by the first new Z.
create table store_accumulator_openings (
  id uuid primary key default gen_random_uuid(),
  register_id uuid not null unique references store_registers(id),
  opening_gross_centavos bigint not null check (opening_gross_centavos >= 0),
  opening_net_centavos bigint not null check (opening_net_centavos >= 0),
  sales_count integer not null check (sales_count >= 0),
  through_business_date date not null,                       -- sales on days before this date are inside the opening
  first_till_day_id uuid references store_till_days(id),     -- the day whose Z started the new series
  computed_by text,
  computed_at timestamptz not null default now()
);
create trigger store_accumulator_opening_immutable before update or delete on store_accumulator_openings for each row execute function fiscal_immutable();
create trigger store_accumulator_opening_audit after insert on store_accumulator_openings for each row execute function fiscal_capture_change();

-- The first accumulator row of a register with an opening row must start exactly at it.
create or replace function store_accumulator_guard() returns trigger language plpgsql as $$
declare last_row store_fiscal_accumulators%rowtype; opening store_accumulator_openings%rowtype;
begin
  select * into last_row from store_fiscal_accumulators where register_id = new.register_id order by z_counter desc limit 1;
  if found then
    if new.z_counter <= last_row.z_counter then
      raise exception 'Z counter must increase';
    end if;
    if new.reset_counter < last_row.reset_counter then raise exception 'Reset counter cannot decrease'; end if;
    if new.reset_counter = last_row.reset_counter and
       (new.beginning_gross_centavos <> last_row.ending_gross_centavos or new.beginning_net_centavos <> last_row.ending_net_centavos) then
      raise exception 'Grand totals must continue from the last Z';
    end if;
  else
    select * into opening from store_accumulator_openings where register_id = new.register_id;
    if found and (new.beginning_gross_centavos <> opening.opening_gross_centavos or new.beginning_net_centavos <> opening.opening_net_centavos) then
      raise exception 'Grand totals must continue from the opening balance';
    end if;
  end if;
  if new.reset_counter = coalesce(last_row.reset_counter, 0) and
     (new.ending_gross_centavos < new.beginning_gross_centavos or new.ending_net_centavos < new.beginning_net_centavos) then
    raise exception 'Grand totals cannot decrease';
  end if;
  return new;
end; $$;
