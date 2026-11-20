import { parseVisitFrequency } from "@sunpride/customer-master";
import { access } from "../org/readers.js";
import { rule, uuid } from "../org/model.js";

/** Atomic caller transaction: authorize every customer before changing any.
 * @param {any} c @param {unknown} ids @param {unknown} frequency */
export async function setCustomerFrequency(c, ids, frequency) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 100 ||
    new Set(ids).size !== ids.length
  )
    rule("Select between 1 and 100 different customers.");
  let value;
  try {
    value = parseVisitFrequency(frequency);
  } catch (e) {
    rule(e instanceof Error ? e.message : "Choose a visit frequency.");
  }
  const customers = [];
  for (const id of /** @type {string[]} */ (ids)) {
    const customer = await access(
      c,
      "outlets",
      uuid(id),
      "outlet.frequency.manage",
    );
    if (customer.status === "inactive")
      rule("Inactive customers cannot be changed.");
    customers.push(customer);
  }
  for (const customer of customers) {
    await c.db`update outlets set visit_frequency_days=${value.days}, visit_frequency_per_month=${value.perMonth} where id=${customer.id}`;
    await c.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${c.actor.subject},'customer.visit_frequency','outlets',${customer.id},${JSON.stringify({ before: { days: customer.visit_frequency_days, perMonth: customer.visit_frequency_per_month }, after: value })})`;
  }
  return customers.map((c) => c.id);
}
