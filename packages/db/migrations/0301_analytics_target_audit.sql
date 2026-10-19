create table analytics_target_events (
 id uuid primary key default gen_random_uuid(), target_id uuid not null references sales_targets(id),
 actor_profile_id uuid not null references profiles(id), actor_user_id uuid,
 before_value jsonb, after_value jsonb not null, occurred_at timestamptz not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index analytics_target_events_target on analytics_target_events(target_id,occurred_at);
