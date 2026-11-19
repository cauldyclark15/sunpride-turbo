-- SP-0206: invitation delivery is separate from account acceptance.
-- Existing invitations remain eligible for an explicit resend; nothing is mailed by migration.
alter table access_invitations
  add column if not exists email_state text not null default 'not_sent'
    check (email_state in ('not_sent', 'accepted', 'failed', 'dev_sink')),
  add column if not exists email_attempted_at timestamptz;

alter table auth_email_deliveries drop constraint if exists auth_email_deliveries_kind_check;
alter table auth_email_deliveries add constraint auth_email_deliveries_kind_check
  check (kind in ('reset_link', 'temporary_password', 'invitation'));
