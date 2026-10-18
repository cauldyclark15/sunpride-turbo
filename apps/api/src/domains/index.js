// Registry of domain modules. Lead-owned: lanes replace only their own domain folder.
/** @typedef {import('../core/router.js').Router} Router */
/** @type {Array<(router: any, ctx: any) => void>} */
export const domainInstallers = [];
