-- F-221/F-606: repeatable investigator actions without duplicate disposition history.
create table integrity_command_receipts (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references users(id), request_key text not null,
 request_hash text not null, response jsonb not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(user_id,request_key)
);
