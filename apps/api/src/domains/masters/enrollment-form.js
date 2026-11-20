import { tx } from "@sunpride/db/client";
import {
  enrollmentFields,
  validateEnrollment,
} from "@sunpride/customer-master";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { currentActor } from "../van/access.js";

/** @param {any} db */
export async function readEnrollmentForm(db) {
  const [r] =
    await db`select revision,fields from enrollment_forms where id='customer'`;
  return {
    revision: r.revision,
    fields:
      /** @type {import('@sunpride/customer-master').EnrollmentField[]} */ (
        r.fields
      ),
  };
}
/** @param {any} db @param {Record<string,any>} customer */
export async function checkEnrollment(db, customer) {
  const form = await readEnrollmentForm(db);
  const result = validateEnrollment(
    form.fields,
    customer.customFields,
    customer,
  );
  if (result.errors.length)
    throw new ApiError(
      "validation_failed",
      422,
      result.errors[0].message,
      false,
      { details: { errors: result.errors } },
    );
  return result.value;
}
/** @param {any} router @param {any} platform */
export function installEnrollmentForm(router, platform) {
  router.get(
    "/api/v1/customers/enrollment-form",
    async (/** @type {any} */ c) => {
      await requireCapability(c, "outlet.read");
      return readEnrollmentForm(c.db);
    },
  );
  router.put(
    "/api/v1/customers/enrollment-form",
    async (/** @type {any} */ ctx) => {
      const result = await tx(ctx.db, async (db) => {
        const c = { ...ctx, db, actor: await currentActor(db, ctx.actor) };
        await requireCapability(c, "admin.manage");
        await db`select pg_advisory_xact_lock(4310420)`;
        const prior = await readEnrollmentForm(db);
        if (ctx.body?.revision !== prior.revision)
          throw new ApiError(
            "conflict",
            409,
            "The form changed. Reload before saving.",
          );
        let fields;
        try {
          fields = enrollmentFields(ctx.body?.fields);
        } catch (e) {
          throw new ApiError(
            "invalid_request",
            400,
            e instanceof Error ? e.message : "Check the fields.",
          );
        }
        for (const old of prior.fields) {
          const next = fields.find((f) => f.key === old.key);
          if (
            !next ||
            next.kind !== old.kind ||
            old.choices.some((v) => !next.choices.includes(v))
          )
            throw new ApiError(
              "invalid_request",
              400,
              "Keep existing fields, types and choices so saved answers remain readable. You can change their names, order and required customers.",
            );
        }
        const refs =
          await db`select list,code from customer_reference_values where active and list in ('distribution_channel','type_of_business')`;
        for (const f of fields)
          for (const [list, values] of [
            ["distribution_channel", f.requiredChannels],
            ["type_of_business", f.requiredTypes],
          ]) {
            for (const code of values)
              if (
                !refs.some(
                  (/** @type {any} */ r) => r.list === list && r.code === code,
                )
              )
                throw new ApiError(
                  "invalid_request",
                  400,
                  "Choose current channels and customer types from the lists.",
                );
          }
        await db`update enrollment_forms set fields=${JSON.stringify(fields)}::text::jsonb,revision=revision+1,updated_by=${c.actor.userId},updated_at=now() where id='customer'`;
        await db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${c.actor.userId},'enrollment_form.update','enrollment_forms','customer',${JSON.stringify({ before: prior, after: { revision: prior.revision + 1, fields } })})`;
        await platform.recordChange(db, {
          entity: "org.reference",
          entityId: "customer-enrollment-form",
          scopeKey: "global",
          op: "upsert",
        });
        return readEnrollmentForm(db);
      });
      await ctx.publish("masters");
      return result;
    },
  );
}
