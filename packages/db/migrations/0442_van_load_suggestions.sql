-- F-102 frozen explanation and independent reviewed application.
create table van_load_suggestions (
 id uuid primary key default gen_random_uuid(),
 trip_id uuid not null references van_trips(id),
 content_hash text not null,
 facts jsonb not null,
 created_by uuid not null references profiles(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index van_load_suggestions_trip on van_load_suggestions(trip_id,created_at);
create trigger van_load_suggestion_immutable before update or delete on van_load_suggestions for each row execute function vanops_immutable();
create table van_load_suggestion_reviews (
 id uuid primary key default gen_random_uuid(),
 suggestion_id uuid not null unique references van_load_suggestions(id),
 load_id uuid not null references van_trip_loads(id),
 facts jsonb not null,
 reviewed_by uuid not null references profiles(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create trigger van_load_suggestion_review_immutable before update or delete on van_load_suggestion_reviews for each row execute function vanops_immutable();
