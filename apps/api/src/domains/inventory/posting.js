// placeholder: replaced by lane inventory
/**
 * Sole writer of stock balances and ledger (seam; see wave3 shared brief).
 * @param {any} _tx
 * @param {{kind:string, sourceType:string, sourceId:string, idempotencyKey:string, occurredAt:number, actor:{profileId:string|null,userId:string|null}, organizationId:string, lines:Array<{productId:string, fromLocationId:string|null, toLocationId:string|null, quantityBase:number, uom:string, lotId?:string|null, stockStatus?:string}>, note?:string}} _input
 * @returns {Promise<{movementId:string, duplicate:boolean}>}
 */
export async function postMovement(_tx, _input) {
  throw new Error("not implemented");
}
