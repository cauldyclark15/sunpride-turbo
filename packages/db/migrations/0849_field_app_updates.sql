-- SP-0245: announcements from the APK publisher, separate from privately staged APKs.
create table field_app_updates (
 id uuid primary key default gen_random_uuid(),
 app text not null check(app='field'),
 package_name text not null check(package_name ~ '^com\.sunpride\.field\.(dev|beta|staging|prod)$'),
 version_code integer not null check(version_code>0),
 version_name text not null,
 download_url text not null,
 minimum_supported_version_code integer not null default 0 check(minimum_supported_version_code>=0 and minimum_supported_version_code<=version_code),
 notes text not null,
 git_sha text not null,
 publisher text not null,
 created_at timestamptz not null default now(),
 unique(package_name,version_code)
);
create trigger fiscal_capture after insert or update or delete on field_app_updates for each row execute function fiscal_capture_change();
