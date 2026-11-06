-- Stock counts v2 (IP-COUNTS, SPEC 4.3): plan with a scope and a counter, save per line, per-line review, no whole-count
-- invalidation, no line cap. Old rows stay readable: every new column is nullable or has a default.

-- A planned count exists before anyone starts counting it.
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'stock_count_sessions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%'
     and pg_get_constraintdef(oid) like '%frozen%';
  if c is not null then execute format('alter table stock_count_sessions drop constraint %I', c); end if;
end $$;
alter table stock_count_sessions add constraint stock_count_sessions_status_check
  check (status in ('planned', 'draft', 'frozen', 'counting', 'submitted', 'reviewed', 'approved', 'posted', 'cancelled'));

alter table stock_count_sessions
  add column title text,
  add column planned_by text,                        -- who planned it; created_by stays the COUNTER so the blind-count stock embargo and
                                                     -- the movement hiding keep working for the assigned counter, not the planner
  add column assigned_to text,                       -- explicit assignment (users.id as text); null = the planner counts
  add column scope jsonb not null default '{"type":"all"}'::jsonb,
  add column scheduled_for date,
  add column schedule_id uuid,
  add column legacy_whole boolean not null default false, -- started with counts/start: approve takes every line, as before
  add column include_sublocations boolean not null default false,
  add column counting_started_at timestamptz,
  add column submitted_at timestamptz,
  add column submitted_by text,
  add column movement_ids jsonb;                     -- extra movement ids when one approval needed more than one writer batch

create index stock_count_sessions_assigned_idx on stock_count_sessions (organization_id, assigned_to, status);
create index stock_count_sessions_schedule_idx on stock_count_sessions (schedule_id) where schedule_id is not null;

alter table stock_count_lines
  add column location_id uuid references inventory_locations(id), -- null = the session's own location
  add column source text not null default 'plan' check (source in ('plan', 'found')),
  add column unit_cost_minor bigint,                 -- cost per scale used for the peso difference
  add column diff_centavos bigint,                   -- |variance| x cost, whole centavos, rounded up
  add column review_decision text check (review_decision in ('accepted', 'rejected', 'recount')),
  add column review_auto boolean not null default false,
  add column reason_code text,
  add column review_note text,
  add column reviewed_by text,
  add column reviewed_at timestamptz,
  add column recount_requested_at timestamptz,
  add column recount_count integer not null default 0,
  add column previous_counted_base bigint,
  add column photo_file_id uuid references files(id),
  add column client_op text,
  add column device_label text;

-- One line per place + product + lot + status in a count; the same line can be saved again from another device.
create unique index stock_count_lines_identity_idx on stock_count_lines (
  session_id,
  coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
  product_id,
  coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid),
  stock_status);
create index stock_count_lines_session_review_idx on stock_count_lines (session_id, review_decision);
create index stock_count_lines_session_diff_idx on stock_count_lines (session_id, diff_centavos desc nulls last);

-- Append-only history of every save, recount and review decision (two devices, audit, recount history).
create table stock_count_line_events (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  session_id uuid not null references stock_count_sessions(id),
  line_id uuid not null references stock_count_lines(id),
  kind text not null check (kind in ('saved', 'added', 'recount_requested', 'accepted', 'rejected', 'auto_accepted', 'reopened')),
  actor_user_id text,
  device_label text,
  counted_base bigint,
  expected_base bigint,
  note text,
  occurred_at timestamptz not null default now()
);
create index stock_count_line_events_line_idx on stock_count_line_events (line_id, occurred_at);
create index stock_count_line_events_session_idx on stock_count_line_events (session_id, occurred_at);

-- Recurring plans (SPEC 4.3: "fast movers weekly, all monthly"). A job plans the due ones.
create table stock_count_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  name text not null,
  location_id uuid not null references inventory_locations(id),
  scope jsonb not null default '{"type":"all"}'::jsonb,
  include_sublocations boolean not null default false,
  count_type text not null default 'cycle' check (count_type in ('cycle', 'full', 'spot')),
  blind_count boolean not null default true,
  assigned_to text,
  cadence_days integer not null check (cadence_days between 1 and 366),
  next_due date not null,
  active boolean not null default true,
  last_session_id uuid references stock_count_sessions(id),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stock_count_schedules_due_idx on stock_count_schedules (organization_id, active, next_due);
create trigger stock_count_schedules_set_updated_at before update on stock_count_schedules for each row execute function set_updated_at();
alter table stock_count_sessions add constraint stock_count_sessions_schedule_fk foreign key (schedule_id) references stock_count_schedules(id);
