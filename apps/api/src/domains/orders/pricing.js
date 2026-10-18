// placeholder: replaced by lane orders
/** @param {any} _db @param {{organizationId:string, productId:string, uom:string, channelKey:string|null, customerCode:string|null, at:number}} _q @returns {Promise<{unitPriceCentavos:number|null, priceListId:string|null, source:string|null}>} */
export async function resolvePrice(_db, _q) {
  throw new Error("not implemented");
}
/** @param {any} _db @param {{customerCode:string, addCentavos:number|null}} _q @returns {Promise<{status:"within"|"over"|"no_limit"|"unknown", limit:number|null, exposure:number|null}>} */
export async function creditCheck(_db, _q) {
  throw new Error("not implemented");
}
