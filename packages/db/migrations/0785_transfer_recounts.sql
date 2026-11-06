-- IP-INT3: a supervisor can send a received-with-a-difference document back to the receiving side for a recount.
-- The document goes back to a receivable state with variance_status 'recount'; every round is kept here (append only,
-- only the "answered" columns are filled in when the receiver counts again).
alter table stock_transfers drop constraint if exists stock_transfers_variance_status_check;
alter table stock_transfers add constraint stock_transfers_variance_status_check
  check (variance_status in ('none', 'open', 'resolved', 'auto_accepted', 'recount'));

create table stock_transfer_recounts (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null default 'sunpride',
  transfer_id uuid not null references stock_transfers(id),
  round integer not null check (round >= 1),
  reason text not null check (length(btrim(reason)) >= 3),
  requested_by text not null,
  requested_by_profile uuid,
  requested_at timestamptz not null default now(),
  -- what the document said when it was sent back: variance value and per-batch short / over / damaged
  snapshot jsonb not null default '{}'::jsonb,
  answered_by text,
  answered_at timestamptz,
  unique (transfer_id, round)
);
create index stock_transfer_recounts_open_idx on stock_transfer_recounts (transfer_id) where answered_at is null;

create function stock_transfer_recounts_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A recount request is part of the document history and cannot be deleted';
  end if;
  if new.transfer_id is distinct from old.transfer_id or new.round is distinct from old.round
     or new.reason is distinct from old.reason or new.requested_by is distinct from old.requested_by
     or new.requested_at is distinct from old.requested_at or new.snapshot is distinct from old.snapshot then
    raise exception 'A recount request cannot be changed after it is made';
  end if;
  if old.answered_at is not null then
    raise exception 'This recount request was already answered';
  end if;
  return new;
end $$;
create trigger stock_transfer_recounts_guard before update or delete on stock_transfer_recounts
  for each row execute function stock_transfer_recounts_guard();
