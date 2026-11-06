-- Opening float on a van trip (IP-P0 0.7): cash handed to the seller before the first sale.
-- Expected cash at settlement = float + cash sales + cash collections - cash refunds.
-- Whole centavos, 0..10_000_000 (P100,000). Existing trips carry no float.
alter table van_trips
  add column opening_float_centavos bigint not null default 0
  check (opening_float_centavos >= 0 and opening_float_centavos <= 10000000);
