-- SP-0240: retain individual enrollment names without guessing the order of legacy names.
-- outlets.name remains the combined display/search name; imported and older names stay intact.
alter table customer_profiles
  add column first_name text check (length(first_name) <= 200),
  add column middle_name text check (length(middle_name) <= 200),
  add column last_name text check (length(last_name) <= 200);
