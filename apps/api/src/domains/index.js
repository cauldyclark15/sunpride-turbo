// Registry of domain modules. Lead-owned: lanes replace only their own domain folder.
import { install as tpm } from "./tpm/index.js";
import { install as integrity } from "./integrity/index.js";
import { install as org } from "./org/index.js";
import { install as coverage } from "./coverage/index.js";
import { install as visits } from "./visits/index.js";
import { install as fieldsync } from "./fieldsync/index.js";
import { install as van } from "./van/index.js";
import { install as inventory } from "./inventory/index.js";
import { install as imports } from "./imports/index.js";
import { install as orders } from "./orders/index.js";
import { install as fieldreports } from "./fieldreports/index.js";
import { install as issues } from "./issues/index.js";
import { install as analytics } from "./analytics/index.js";
import { install as programme } from "./programme/index.js";
import { install as integration } from "./integration/index.js";
import { install as callflow } from "./callflow/index.js";
import { install as distributors } from "./distributors/index.js";
import { install as masters } from "./masters/index.js";
import { install as fiscal } from "./fiscal/index.js";
/** @type {Array<(router: any, ctx: any) => void>} */
export const domainInstallers = [
  org,
  coverage,
  visits,
  fieldsync,
  van,
  inventory,
  imports,
  orders,
  fieldreports,
  issues,
  analytics,
  programme,
  integration,
  callflow,
  distributors,
  tpm,
  masters,
  fiscal,
  integrity,
];
