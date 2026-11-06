-- IP-NAV: a variance can be resolved by agreement of the clerk who sent and the seller who received (SPEC 5.2 step 6).
-- Both signatures are kept on the resolution row.
alter table stock_transfer_resolutions
  add column agreement text check (agreement in ('clerk_and_seller')),
  add column agreed_clerk_id text,
  add column agreed_seller_id text;
