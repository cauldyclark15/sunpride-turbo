-- SP-0194: per-person App mode for the Field app, picked by the office in Setup > People.
--   mapping  = Customer mapping (default): Home · Customers · More
--   visits   = Field visits:               Today · Route · Customers · More
--   selling  = Truck selling:              Today · Sell · Customers · More
-- `profiles.selling` (SP-0191) STAYS for old phone builds and the van/fiscal/storepos gates; the API keeps it equal
-- to (app_mode = 'selling') on every write. Backfill: Sales people with Selling on -> selling; super_admin -> selling
-- (the owner may switch between every mode on the phone); everyone else -> mapping.
-- Additive: the previous API version never reads the column and the default fills rows it creates.
alter table profiles add column if not exists app_mode text;
update profiles
   set app_mode = case
     when role = 'super_admin' then 'selling'
     when role = 'sales' and selling then 'selling'
     else 'mapping'
   end
 where app_mode is null;
alter table profiles alter column app_mode set default 'mapping';
alter table profiles alter column app_mode set not null;
alter table profiles drop constraint if exists profiles_app_mode_check;
alter table profiles add constraint profiles_app_mode_check check (app_mode in ('mapping', 'visits', 'selling'));
-- selling := (app_mode = 'selling'). Only rows where Selling was never effective change (a non-Sales person with a
-- stale switch), plus super_admin rows, whose stored switch the Selling rule ignores.
update profiles set selling = (app_mode = 'selling') where selling is distinct from (app_mode = 'selling');
