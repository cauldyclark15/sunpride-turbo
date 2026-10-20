-- F-121 immutable reload state transitions; physical in-transit stock is canonical inventory stock.
create table van_reload_events (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null references van_trip_observations(id),
 kind text not null check(kind in ('approved','dispatched','received')),
 facts jsonb not null,
 actor_profile_id uuid not null references profiles(id),
 movement_id uuid references inventory_movements(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(request_id,kind)
);
create trigger van_reload_event_immutable before update or delete on van_reload_events for each row execute function vanops_immutable();
