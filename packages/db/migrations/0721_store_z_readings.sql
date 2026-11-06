-- IP-ZDAY 0721: typed Z readings and the append-only fiscal accumulators. Only a Z advances an accumulator.
create table store_fiscal_accumulators (
  id uuid primary key default gen_random_uuid(),
  register_id uuid not null references store_registers(id),
  z_counter bigint not null check (z_counter > 0),
  reset_counter integer not null default 0 check (reset_counter >= 0),
  beginning_gross_centavos bigint not null check (beginning_gross_centavos >= 0),
  ending_gross_centavos bigint not null check (ending_gross_centavos >= 0),
  beginning_net_centavos bigint not null check (beginning_net_centavos >= 0),
  ending_net_centavos bigint not null check (ending_net_centavos >= 0),
  till_day_id uuid not null unique references store_till_days(id),
  created_at timestamptz not null default now(),
  unique (register_id, z_counter)
);
create trigger store_accumulator_immutable before update or delete on store_fiscal_accumulators for each row execute function fiscal_immutable();
create trigger store_accumulator_audit after insert on store_fiscal_accumulators for each row execute function fiscal_capture_change();
-- Grand totals only grow: inside one reset cycle ending >= beginning, and a new row starts where the last one ended.
create function store_accumulator_guard() returns trigger language plpgsql as $$
declare last_row store_fiscal_accumulators%rowtype;
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
  end if;
  if new.reset_counter = coalesce(last_row.reset_counter, 0) and
     (new.ending_gross_centavos < new.beginning_gross_centavos or new.ending_net_centavos < new.beginning_net_centavos) then
    raise exception 'Grand totals cannot decrease';
  end if;
  return new;
end; $$;
create trigger store_accumulator_guard before insert on store_fiscal_accumulators for each row execute function store_accumulator_guard();

create table store_z_readings (
  id uuid primary key default gen_random_uuid(),
  till_day_id uuid not null unique references store_till_days(id),
  register_id uuid not null references store_registers(id),
  read_id uuid not null unique references store_reads(id),
  doc_number text not null,
  business_date date not null,
  z_counter bigint not null,
  reset_counter integer not null,
  beginning_invoice text, ending_invoice text,
  beginning_void text, ending_void text,
  beginning_refund text, ending_refund text,
  beginning_gross_centavos bigint not null, ending_gross_centavos bigint not null,
  beginning_net_centavos bigint not null, ending_net_centavos bigint not null,
  sessions_count integer not null, transactions_count integer not null,
  gross_sales_centavos bigint not null,
  promo_discount_centavos bigint not null default 0,
  net_sales_centavos bigint not null,
  vatable_sales_centavos bigint not null, vat_centavos bigint not null,
  vat_exempt_centavos bigint not null, zero_rated_centavos bigint not null,
  vat_removed_centavos bigint not null default 0,
  senior_discount_centavos bigint not null default 0, pwd_discount_centavos bigint not null default 0,
  solo_parent_discount_centavos bigint not null default 0, athlete_discount_centavos bigint not null default 0,
  uniformed_discount_centavos bigint not null default 0,
  voids_count integer not null default 0, voids_centavos bigint not null default 0,
  refunds_count integer not null default 0, refunds_centavos bigint not null default 0,
  cash_tender_centavos bigint not null default 0, gcash_tender_centavos bigint not null default 0,
  card_tender_centavos bigint not null default 0, other_tender_centavos bigint not null default 0,
  opening_float_centavos bigint not null default 0, float_in_centavos bigint not null default 0,
  paid_in_centavos bigint not null default 0, drops_centavos bigint not null default 0,
  pickups_centavos bigint not null default 0, paid_out_centavos bigint not null default 0,
  no_sale_count integer not null default 0,
  expected_cash_centavos bigint not null, counted_cash_centavos bigint, short_over_centavos bigint,
  forced_sessions integer not null default 0,
  model jsonb not null,
  generated_by uuid not null references profiles(id),
  generated_at timestamptz not null default now(),
  unique (register_id, z_counter)
);
create trigger store_z_reading_immutable before update or delete on store_z_readings for each row execute function fiscal_immutable();
create trigger store_z_reading_audit after insert on store_z_readings for each row execute function fiscal_capture_change();
