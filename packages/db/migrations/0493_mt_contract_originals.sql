-- F-307: immutable contract originals, captured atomically with a proposed terms version.
-- This extends the MT evidence store, not pricing authority or the canonical sales order.
create table mt_term_documents (
  id uuid primary key default gen_random_uuid(),
  term_id uuid not null unique references mt_trade_terms(id),
  filename text not null,
  sha256 text not null,
  content_base64 text not null,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger mt_contract_originals_immutable before update or delete on mt_term_documents
  for each row execute function mt_immutable();
