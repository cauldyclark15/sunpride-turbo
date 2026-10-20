-- F-502/F-504: an already-granted invoice discount is not a payable claim.
-- Claimable benefits retain full invoice value and earn a separately posted liability.
alter table promotions add column benefit_timing text not null default 'on_invoice'
  check(benefit_timing in ('on_invoice','claimable'));
