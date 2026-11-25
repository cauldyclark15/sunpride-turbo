-- SP-0241: serial, editable field captures; business rows remain the canonical customer.
create table customer_capture_revisions (
  profile_id uuid not null references profiles(id),
  draft_id uuid not null,
  outlet_id uuid not null references outlets(id),
  revision integer not null check (revision > 0),
  customer_hash text not null,
  primary key (profile_id, draft_id)
);
create index customer_capture_revisions_outlet on customer_capture_revisions(outlet_id);
