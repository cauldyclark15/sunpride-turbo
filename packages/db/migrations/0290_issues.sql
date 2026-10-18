-- Lane ISSUES: command replay and honest backup completeness, additive to 0117.
create table issue_commands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  command_key text not null,
  payload_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, command_key)
);
alter table issues add column backup_missing_comments integer not null default 0;
alter table issues add column backup_missing_attachments integer not null default 0;
alter table issues add column backup_summary_only boolean not null default false;
alter table issue_comments add column backup_key text;
create unique index issue_comments_backup_key on issue_comments(issue_id, backup_key) where backup_key is not null;
