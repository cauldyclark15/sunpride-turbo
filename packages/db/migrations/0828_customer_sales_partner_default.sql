-- 0828_customer_sales_partner_default: Sales Partner is "pre-determined based on who saved the
-- customer profile" (client's Customer Enrollment Form). New records get it from the writer
-- (apps/api/src/domains/masters/customers.js defaultSalesPartner); this fills the field "Add
-- customer" records already waiting, with the salesman who proposed them. Only while Sunpride's
-- "List of Agents" is empty (the Sales Partner list falls back to active sales employees, keyed
-- by employee code), and only where the office has not chosen one yet.
update customer_profiles cp
   set sales_partner_code = coalesce(pr.employee_code, pr.id::text),
       updated_by = 'system:0828-sales-partner-default'
  from outlet_enrolments e
  join profiles pr on pr.id = e.proposed_by_profile_id
 where e.outlet_id = cp.outlet_id
   and e.deleted_at is null
   and cp.deleted_at is null
   and cp.sales_partner_code is null
   and pr.role = 'sales'
   and pr.status = 'active'
   and pr.deleted_at is null
   and not exists (
     select 1 from customer_reference_values r where r.list = 'sales_partner' and r.active
   );
