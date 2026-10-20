import { rule } from "../org/model.js";

/** F-009 bounded simple Polygon geometry. No implicit repair of bad coordinates.
 * @typedef {[number,number]} Point */
/** @param {Point} a @param {Point} b @param {Point} c */
const cross = (a, b, c) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
/** @param {Point} a @param {Point} b @param {Point} p */
const on = (a, b, p) =>
  Math.abs(cross(a, b, p)) < 1e-10 &&
  p[0] >= Math.min(a[0], b[0]) - 1e-10 &&
  p[0] <= Math.max(a[0], b[0]) + 1e-10 &&
  p[1] >= Math.min(a[1], b[1]) - 1e-10 &&
  p[1] <= Math.max(a[1], b[1]) + 1e-10;
/** @param {Point} a @param {Point} b @param {Point} c @param {Point} d */
export function intersects(a, b, c, d) {
  return (
    (cross(a, b, c) * cross(a, b, d) < 0 &&
      cross(c, d, a) * cross(c, d, b) < 0) ||
    on(a, b, c) ||
    on(a, b, d) ||
    on(c, d, a) ||
    on(c, d, b)
  );
}
/** @param {Point} p @param {Point[]} ring */
export function contains(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const a = ring[j],
      b = ring[i];
    if (on(a, b, p)) return true;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
/** @param {any} value @returns {{type:'Polygon',coordinates:Point[][]}} */
export function polygon(value) {
  if (
    value?.type !== "Polygon" ||
    !Array.isArray(value.coordinates) ||
    value.coordinates.length !== 1
  )
    rule("Draw one polygon without holes.");
  const ring = value.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > 101)
    rule("A boundary needs 3 to 100 corners.");
  for (const p of ring)
    if (
      !Array.isArray(p) ||
      p.length !== 2 ||
      !Number.isFinite(p[0]) ||
      !Number.isFinite(p[1]) ||
      Math.abs(p[0]) > 180 ||
      Math.abs(p[1]) > 90
    )
      rule("Boundary coordinates must be longitude, latitude.");
  if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])
    rule("Close the boundary polygon.");
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i],
      b = ring[i + 1];
    if ((a[0] === b[0] && a[1] === b[1]) || Math.abs(a[0] - b[0]) > 180)
      rule("Boundary has a repeated corner or crosses the date line.");
    area += a[0] * b[1] - b[0] * a[1];
    for (let j = i + 2; j < ring.length - 1; j++)
      if (
        !(i === 0 && j === ring.length - 2) &&
        intersects(a, b, ring[j], ring[j + 1])
      )
        rule("Boundary edges must not cross or touch themselves.");
  }
  if (Math.abs(area) < 1e-10) rule("Boundary has no area.");
  return { type: "Polygon", coordinates: [ring] };
}
/** Entire edges, not just vertices: concave parents must not be bridged.
 * @param {Point[]} child @param {Point[]} parent */
export function containedRing(child, parent) {
  for (let i = 0; i < child.length - 1; i++) {
    if (!contains(child[i], parent)) return false;
    const a = child[i],
      b = child[i + 1];
    // Partition each edge at all parent vertex projections; check every open section.
    const cuts = [0, 1];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    for (let j = 0; j < parent.length - 1; j++) {
      const c = parent[j],
        d = parent[j + 1];
      const ex = d[0] - c[0],
        ey = d[1] - c[1],
        den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den;
      const u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
    }
    cuts.sort((x, y) => x - y);
    for (let j = 1; j < cuts.length; j++) {
      const t = (cuts[j - 1] + cuts[j]) / 2;
      if (!contains([a[0] + t * dx, a[1] + t * dy], parent)) return false;
    }
  }
  return true;
}
/** F-012 distance in metres, not degrees. @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2 */
export function distance(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180,
    dlat = (lat2 - lat1) * r,
    dlon = (lon2 - lon1) * r;
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dlon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}
