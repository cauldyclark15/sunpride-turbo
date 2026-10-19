-- Durable bridge for the native visit.activity/order_intent union.
-- VISITS remains the only writer of visit_activities. This trigger only queues ORDERS work.
-- Observation + queue + CORE receipt commit together, even when the response is lost.
create table order_intent_queue (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null unique references visit_activities(id),
  status text not null default 'pending' check(status in ('pending','captured','review')),
  review_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index order_intent_queue_pending_idx on order_intent_queue(status,created_at,id);
create function queue_order_intent() returns trigger language plpgsql as $$
begin
  if new.activity_kind = 'order_intent' then
    insert into order_intent_queue(activity_id) values(new.id) on conflict(activity_id) do nothing;
  end if;
  return new;
end;
$$;
create trigger orders_queue_intent after insert on visit_activities for each row execute function queue_order_intent();
insert into order_intent_queue(activity_id) select id from visit_activities where activity_kind = 'order_intent' and deleted_at is null on conflict do nothing;
