-- F-401/F-402: partner invitation path uses the existing sign-up and session service.
alter table access_invitations drop constraint access_invitations_role_check;
alter table access_invitations add constraint access_invitations_role_check check(role in ('super_admin','admin','operations','manager','approver','sales','analyst','viewer','distributor'));
-- Retain the core actor snapshot, including a partner profile if provisioned by invitation.
alter table employee_assignments drop constraint employee_assignments_role_check;
alter table employee_assignments add constraint employee_assignments_role_check check(role in ('super_admin','admin','operations','manager','approver','sales','analyst','viewer','distributor'));
