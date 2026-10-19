/** Bun 1.3's single-connection transaction query pipeline can strand duplicate prepared
 * statements issued concurrently. Keep Promise.all at the domain boundary, but run wire
 * queries in order on this connection. SQL IN-list constructors stay synchronous.
 * @param {any} db */
export function orderedDb(db) {
  let tail = Promise.resolve();
  /** @param {()=>any} fn */
  const queue = (fn) => {
    const result = tail.then(fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return new Proxy(db, {
    apply(target, thisArg, args) {
      if (Array.isArray(args[0]) && Object.hasOwn(args[0], "raw"))
        return queue(() => Reflect.apply(target, thisArg, args));
      return Reflect.apply(target, thisArg, args);
    },
    get(target, key) {
      if (key === "unsafe")
        return (/** @type {string} */ sql, /** @type {any[]} */ params) =>
          queue(() => target.unsafe(sql, params));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
