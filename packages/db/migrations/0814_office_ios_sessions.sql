-- SP-0165: the native Office app (iPhone/iPad) signs in like the other native apps
-- (long-lived session + short access token) but is an office client: no handheld
-- registration, so only the sessions check widens; registered_devices is unchanged.
alter table sessions drop constraint if exists sessions_app_check;
alter table sessions add constraint sessions_app_check
  check (app in ('web', 'field-android', 'van-android', 'field-ios', 'office-ios'));
