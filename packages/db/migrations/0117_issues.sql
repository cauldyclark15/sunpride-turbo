-- 0117_issues: Issue board.
-- Generated from packages/backend/convex/schema.ts (via the v2 backend inventory).
-- Tables: issues, issue_comments, issue_attachments, issue_activity, issue_counters.

-- issues
create table issues (
  id uuid primary key default gen_random_uuid(),
  number integer not null,
  title text not null,
  description text,
  steps text,
  actual text,
  expected text,
  area text not null,
  priority text not null check (priority in ('low', 'medium', 'high', 'critical')),
  status text not null check (status in ('draft', 'ongoing_test', 'need_to_rectify', 'awaiting_client_response', 'dev_work_ongoing', 'for_retest', 'completed')),
  sort_order integer not null,
  assignee_id uuid,
  reporter_id uuid,
  reporter_label text,
  external_ref text,
  milestone text,
  archived boolean not null,
  archived_at timestamptz,
  search_text text not null,
  comment_count integer not null,
  attachment_count integer not null,
  last_comment_at timestamptz,
  last_comment_author_id uuid,
  last_comment_author_label text,
  updated_by uuid,
  search_tsv tsvector generated always as (to_tsvector('simple', coalesce(search_text, ''))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index issues_number_key on issues (number);
create unique index issues_external_ref_key on issues (external_ref);
create index issues_archived_and_updated_at_idx on issues (archived, updated_at);
create index issues_archived_and_status_and_order_idx on issues (archived, status, sort_order);
create index issues_search_issues_gin on issues using gin (search_tsv);
create index issues_search_status_idx on issues (archived, status);
create index issues_search_area_idx on issues (archived, area);
create index issues_search_assignee_id_idx on issues (archived, assignee_id);
create index issues_search_milestone_idx on issues (archived, milestone);
create trigger issues_set_updated_at before update on issues for each row execute function set_updated_at();

-- issueComments
create table issue_comments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null,
  author_id uuid,
  author_label text,
  body text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index issue_comments_issue_id_and_created_at_idx on issue_comments (issue_id, created_at);
create trigger issue_comments_set_updated_at before update on issue_comments for each row execute function set_updated_at();

-- issueAttachments
create table issue_attachments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null,
  comment_id uuid not null,
  storage_id uuid not null,
  file_name text not null,
  file_type text not null,
  file_size bigint not null,
  uploaded_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index issue_attachments_comment_id_idx on issue_attachments (comment_id);
create index issue_attachments_storage_id_idx on issue_attachments (storage_id);
create unique index issue_attachments_storage_key on issue_attachments (storage_id);
create trigger issue_attachments_set_updated_at before update on issue_attachments for each row execute function set_updated_at();

-- issueActivity
create table issue_activity (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null,
  actor_id uuid,
  actor_label text,
  kind text not null check (kind in ('created', 'updated', 'status_changed', 'commented', 'comment_updated', 'comment_deleted', 'attachment_removed', 'archived', 'restored')),
  from_status text check (from_status in ('draft', 'ongoing_test', 'need_to_rectify', 'awaiting_client_response', 'dev_work_ongoing', 'for_retest', 'completed')),
  to_status text check (to_status in ('draft', 'ongoing_test', 'need_to_rectify', 'awaiting_client_response', 'dev_work_ongoing', 'for_retest', 'completed')),
  changes jsonb,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index issue_activity_issue_id_and_created_at_idx on issue_activity (issue_id, created_at);
create trigger issue_activity_set_updated_at before update on issue_activity for each row execute function set_updated_at();

-- issueCounters
create table issue_counters (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  last_number integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index issue_counters_key_key on issue_counters (key);
create trigger issue_counters_set_updated_at before update on issue_counters for each row execute function set_updated_at();

-- Foreign keys (added after every table in this file exists).
alter table issues add constraint issues_assignee_id_fkey foreign key (assignee_id) references profiles(id);
alter table issues add constraint issues_reporter_id_fkey foreign key (reporter_id) references profiles(id);
alter table issues add constraint issues_last_comment_author_id_fkey foreign key (last_comment_author_id) references profiles(id);
alter table issues add constraint issues_updated_by_fkey foreign key (updated_by) references profiles(id);
alter table issue_comments add constraint issue_comments_issue_id_fkey foreign key (issue_id) references issues(id);
alter table issue_comments add constraint issue_comments_author_id_fkey foreign key (author_id) references profiles(id);
alter table issue_attachments add constraint issue_attachments_issue_id_fkey foreign key (issue_id) references issues(id);
alter table issue_attachments add constraint issue_attachments_comment_id_fkey foreign key (comment_id) references issue_comments(id);
alter table issue_attachments add constraint issue_attachments_storage_id_fkey foreign key (storage_id) references files(id);
alter table issue_attachments add constraint issue_attachments_uploaded_by_fkey foreign key (uploaded_by) references profiles(id);
alter table issue_activity add constraint issue_activity_issue_id_fkey foreign key (issue_id) references issues(id);
alter table issue_activity add constraint issue_activity_actor_id_fkey foreign key (actor_id) references profiles(id);

-- Supporting indexes for foreign keys without a leading index.
create index issues_assignee_id_fk_idx on issues (assignee_id);
create index issues_reporter_id_fk_idx on issues (reporter_id);
create index issues_last_comment_author_id_fk_idx on issues (last_comment_author_id);
create index issues_updated_by_fk_idx on issues (updated_by);
create index issue_comments_author_id_fk_idx on issue_comments (author_id);
create index issue_attachments_issue_id_fk_idx on issue_attachments (issue_id);
create index issue_attachments_uploaded_by_fk_idx on issue_attachments (uploaded_by);
create index issue_activity_actor_id_fk_idx on issue_activity (actor_id);
