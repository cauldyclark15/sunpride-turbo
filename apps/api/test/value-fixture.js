// Shared fixture for the VALUE lane tests (IP-VALUE). Import AFTER the mock.module calls of the test file.
import { startHarness, profileStore } from "./harness.js";
import { sha256Hex } from "../src/core/util.js";
import { capabilitiesFor } from "../src/core/capabilities.js";

/** @param {{installers?:any[]}} [opts] */
export async function setup(opts = {}) {
  const h = await startHarness({ installers: opts.installers ?? [] });
  const profiles = profileStore(h);
  const [u] =
    await h.db`insert into org_units (organization_id,code,name,type_code,status,effective_from) values ('sunpride','VAL-ROOT','Value test','national','active',now()) returning id`;
  const unit = u.id;
  h.setHooks({ rootUnitId: async () => unit });
  /** @param {string} role */
  async function person(role) {
    const [x] =
      await h.db`insert into users (email,password_hash) values (${`${crypto.randomUUID()}@test.invalid`},'fixture-not-a-login') returning id`;
    const profile = profiles.set(x.id, { role, orgUnitId: unit });
    const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
    await h.db`insert into sessions (user_id,token_hash,app,expires_at) values (${x.id},${sha256Hex(token)},'web',now()+interval '1 day')`;
    return {
      userId: x.id,
      profileId: profile.id,
      role,
      orgUnitId: unit,
      capabilities: new Set(capabilitiesFor(role)),
      cookie: `sp_session=${token}`,
    };
  }
  const [piece] =
    await h.db`insert into units_of_measure (organization_id,code,name,dimension,decimal_places,active) values ('sunpride','PC','Piece','count',0,true) returning id`;
  const [caseUom] =
    await h.db`insert into units_of_measure (organization_id,code,name,dimension,decimal_places,active) values ('sunpride','CS','Case','count',0,true) returning id`;
  /** @param {string} name @param {string} type */
  async function location(name, type) {
    const [r] =
      await h.db`insert into inventory_locations (organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values ('sunpride',${unit},'TEST',${name},${name},${type},true,true,true,true,false) returning id`;
    return r.id;
  }
  /** @param {{tracked?:boolean,perCase?:number}} [o] */
  async function product(o = {}) {
    const [p] =
      await h.db`insert into products (code,name,category,uom,unit_price,active,organization_id,base_uom_id,quantity_scale,tracking_mode,allocation_policy) values (${`P-${crypto.randomUUID().slice(0, 8)}`},'Test corned beef','Canned','PC',0,true,'sunpride',${piece.id},1,${o.tracked ? "lot" : "none"},'fefo') returning *`;
    await h.db`insert into uom_conversions (organization_id,product_id,from_uom_id,to_uom_id,numerator,denominator,rounding_mode,effective_from,active) values ('sunpride',${p.id},${caseUom.id},${piece.id},${o.perCase ?? 48},1,'exact',now()-interval '1 year',true)`;
    if (o.tracked)
      await h.db`insert into product_inventory_policies (organization_id,product_id,base_uom_id,quantity_scale,quantity_precision,tracking_mode,allocation_policy,allow_mixed_lots_per_line,allow_negative_stock,quality_release_required,expiry_date_required,manufacture_date_required,minimum_remaining_shelf_life_days,costing_method,version,active) values ('sunpride',${p.id},${piece.id},1,0,'lot','fefo',true,false,false,true,false,0,'weighted_average',1,true)`;
    return p;
  }
  /** @param {string} productId @param {string} lotNumber @param {number|null} expiresInDays */
  async function lot(productId, lotNumber, expiresInDays) {
    const [l] =
      await h.db`insert into inventory_lots (organization_id,product_id,lot_number,normalized_lot_number,source_type,received_at,expires_at,quality_status) values ('sunpride',${productId},${lotNumber},${lotNumber.toUpperCase()},'test',now(),${expiresInDays == null ? null : new Date(Date.now() + expiresInDays * 86400000)},'released') returning id`;
    return l.id;
  }
  return { h, person, location, product, lot, unit, pc: piece.id, cs: caseUom.id };
}
