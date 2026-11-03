-- Internal messaging. Membership, not organization scope, is the chat read boundary.
create table chat_agents (
 user_id uuid primary key references users(id), handle citext not null unique,
 display_name text not null, avatar_blob_id uuid references files(id),
 created_by uuid not null references users(id), token_hash text not null unique,
 disabled_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table chat_conversations (
 id uuid primary key default gen_random_uuid(), kind text not null check(kind in ('dm','group','channel')),
 title text, topic text, is_private boolean not null default false, dm_key text unique,
 created_by uuid not null references users(id), archived_at timestamptz,
 last_seq bigint not null default 0 check(last_seq>=0),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check((kind='dm')=(dm_key is not null)), check(kind='channel' or not is_private)
);
create table chat_members (
 conversation_id uuid not null references chat_conversations(id), user_id uuid not null references users(id),
 role text not null default 'member' check(role in ('owner','member')),
 joined_at timestamptz not null default now(), last_read_seq bigint not null default 0 check(last_read_seq>=0),
 muted boolean not null default false, left_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(conversation_id,user_id)
);
create index chat_members_user on chat_members(user_id,conversation_id) where left_at is null;
create table chat_messages (
 id uuid primary key default gen_random_uuid(), conversation_id uuid not null references chat_conversations(id),
 seq bigint not null check(seq>0), author_user_id uuid not null references users(id), body text not null check(char_length(body)<=4000),
 client_msg_id text not null check(char_length(client_msg_id) between 1 and 200), parent_message_id uuid references chat_messages(id),
 reply_count integer not null default 0, last_reply_at timestamptz, edited_at timestamptz, deleted_at timestamptz,
 search_vector tsvector generated always as(to_tsvector('simple',body)) stored,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(conversation_id,seq), unique(author_user_id,client_msg_id)
);
create index chat_messages_search on chat_messages using gin(search_vector);
create index chat_messages_thread on chat_messages(conversation_id,parent_message_id,seq);
create table chat_mentions (
 id uuid primary key default gen_random_uuid(), message_id uuid not null references chat_messages(id),
 kind text not null check(kind in ('user','object')), user_id uuid references users(id), ref_type text, ref_id text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check((kind='user' and user_id is not null and ref_type is null and ref_id is null) or
       (kind='object' and user_id is null and ref_type is not null and ref_id is not null))
);
create index chat_mentions_message on chat_mentions(message_id);
create index chat_mentions_user on chat_mentions(user_id,message_id);
create table chat_attachments (
 id uuid primary key default gen_random_uuid(), message_id uuid references chat_messages(id),
 uploader_user_id uuid not null references users(id), blob_id uuid not null references files(id),
 role text not null check(role in ('file','thumb')), of_attachment_id uuid references chat_attachments(id),
 name text not null, mime text not null, bytes bigint not null check(bytes>0), sha256 text not null,
 width integer, height integer,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check((role='file' and of_attachment_id is null) or (role='thumb' and of_attachment_id is not null))
);
create unique index chat_attachments_thumb on chat_attachments(of_attachment_id) where role='thumb';
create index chat_attachments_message on chat_attachments(message_id);
create table chat_reactions (
 message_id uuid not null references chat_messages(id), user_id uuid not null references users(id), emoji text not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), primary key(message_id,user_id,emoji)
);
create table chat_link_previews (
 url_hash text primary key, url text not null, title text, description text, image_url text, site_name text,
 fetched_at timestamptz, status text not null default 'pending' check(status in ('pending','ready','failed')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table chat_message_links (
 message_id uuid not null references chat_messages(id), url_hash text not null references chat_link_previews(url_hash), position integer not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), primary key(message_id,url_hash)
);
-- A durable event cursor survives restarts. Event allocation is serialized in the writer
-- transaction so a later committed cursor cannot jump over an uncommitted earlier event.
create table chat_events (
 id bigint generated always as identity primary key, type text not null check(type in ('message.created','message.edited','message.deleted','member.added')),
 conversation_id uuid not null references chat_conversations(id), message_id uuid references chat_messages(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index chat_events_conversation on chat_events(conversation_id,id);
create trigger chat_agents_touch before update on chat_agents for each row execute function touch_updated_at();
create trigger chat_conversations_touch before update on chat_conversations for each row execute function touch_updated_at();
create trigger chat_members_touch before update on chat_members for each row execute function touch_updated_at();
create trigger chat_messages_touch before update on chat_messages for each row execute function touch_updated_at();
create trigger chat_attachments_touch before update on chat_attachments for each row execute function touch_updated_at();
create trigger chat_link_previews_touch before update on chat_link_previews for each row execute function touch_updated_at();
