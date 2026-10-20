-- F-007: retain explicit identity-link history and allow prospective revocation.
alter table federated_identities add column effective_from timestamptz not null default now();
alter table federated_identities add column effective_to timestamptz;
alter table federated_identities add column source_ref text not null default 'Existing explicit identity link';
alter table federated_identities add constraint federated_identity_interval check(effective_to is null or effective_to > effective_from);
alter table federated_identities drop constraint federated_identities_issuer_subject_key;
create unique index federated_identity_current_uq on federated_identities(issuer,subject) where effective_to is null;

-- F-007: browser authorization returns only to this server; no bearer in a redirect.
-- The Android-held poll secret and P-256 signature bind redemption to its install.
create table native_oidc_requests (
  id uuid primary key default gen_random_uuid(),
  secret_hash text not null unique,
  app text not null check(app in ('field-android','van-android')),
  key_id text not null,
  public_key_spki text not null,
  integrity jsonb not null,
  user_id uuid references users(id),
  provider_id uuid not null references identity_providers(id),
  identity_id uuid references federated_identities(id),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  browser_started_at timestamptz,
  created_at timestamptz not null default now()
);
alter table oidc_requests add column native_request_id uuid references native_oidc_requests(id);
