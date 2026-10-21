-- F-006: publication points to an inspected immutable APK, never an arbitrary download URL.
create table app_releases (
 id uuid primary key default gen_random_uuid(),
 app text not null check(app in ('field-android','van-android')),
 package_name text not null,
 version_code bigint not null check(version_code>0),
 version_name text not null,
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 signer_sha256 text not null check(signer_sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes bigint not null check(size_bytes>0 and size_bytes<=125829120),
 release_notes text not null,
 effective_from timestamptz not null,
 effective_to timestamptz,
 withdrawn_at timestamptz,
 published_by uuid not null references profiles(id),
 created_at timestamptz not null default now(),
 unique(package_name,version_code),
 check(effective_to is null or effective_to>effective_from)
);
create trigger fiscal_capture after insert or update or delete on app_releases for each row execute function fiscal_capture_change();
