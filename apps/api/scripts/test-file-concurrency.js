/** F-025: bound disposable-test pools on the shared native database without
 * changing any individual test, timeout or latency assertion.
 * @param {string|undefined} value */
export function testFileConcurrency(value) {
  if (value === undefined) return 4;
  if (!/^[1-4]$/.test(value))
    throw new Error("SP_TEST_CONCURRENCY must be an integer from 1 to 4");
  return Number(value);
}
