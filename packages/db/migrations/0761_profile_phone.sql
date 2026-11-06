-- IP-INT2 ask 6: a staff phone number the office keeps (shown on the handheld as "call your supervisor").
alter table profiles add column phone text
  check (phone is null or phone ~ '^\+?[0-9][0-9 ()-]{5,24}$');
