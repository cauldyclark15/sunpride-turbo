-- F-608 personal subscriptions, durable instances and independently retried channels.
create table analytics_alert_subscriptions (
 id uuid primary key default gen_random_uuid(),profile_id uuid not null references profiles(id),org_unit_id uuid not null references org_units(id),
 metric text not null check(metric in ('missed_stops','availability_below','integrity_open')),
 threshold numeric not null check(threshold>=0),cooldown_minutes integer not null check(cooldown_minutes between 1 and 10080),
 in_app boolean not null,email boolean not null,enabled boolean not null default true,
 effective_from timestamptz not null default now(),effective_to timestamptz,last_triggered_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(profile_id,org_unit_id,metric),check(in_app or email)
);
create table analytics_alert_instances (
 id uuid primary key default gen_random_uuid(),subscription_id uuid not null references analytics_alert_subscriptions(id),
 fingerprint text not null,title text not null,payload jsonb not null,status text not null check(status in ('pending','delivered','suppressed','acknowledged')),
 in_app_at timestamptz,email_at timestamptz,read_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(subscription_id,fingerprint)
);
create table analytics_mail_sink (
 id uuid primary key default gen_random_uuid(),alert_id uuid not null unique references analytics_alert_instances(id),
 recipient text not null,subject text not null,body text not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table analytics_alert_attempts (
 id uuid primary key default gen_random_uuid(),alert_id uuid not null references analytics_alert_instances(id),channel text not null check(channel in ('app','email')),
 outcome text not null check(outcome in ('delivered','retry','suppressed')),created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
