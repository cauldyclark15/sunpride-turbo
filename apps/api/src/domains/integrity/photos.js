import { policyAt, validFix } from "./detectors.js";
import { haversine } from "../visits/location.js";

/** F-024: bounded TIFF/EXIF extraction from ORIGINAL uploaded JPEG bytes, never caller metadata.
 * @param {Uint8Array} bytes */
export function inspectJpeg(bytes) {
  /** @type {any} */ const result = {
    exif: null,
    manifest: null,
    malformed: false,
  };
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216)
    return { ...result, malformed: true };
  for (let at = 2, segments = 0; at + 4 <= bytes.length && segments++ < 256;) {
    if (bytes[at] !== 255) {
      result.malformed = true;
      break;
    }
    const marker = bytes[at + 1];
    if (marker === 218 || marker === 217) break;
    const length = (bytes[at + 2] << 8) | bytes[at + 3],
      start = at + 4,
      end = at + 2 + length;
    if (length < 2 || end > bytes.length) {
      result.malformed = true;
      break;
    }
    const segment = bytes.subarray(start, end);
    if (
      marker === 239 &&
      new TextDecoder().decode(segment.subarray(0, 15)) === "SP-INTEGRITY-1\0\0"
    ) {
      try {
        if (segment.length > 32_768 || result.manifest) throw Error();
        result.manifest = JSON.parse(
          new TextDecoder().decode(segment.subarray(15)),
        );
      } catch {
        result.malformed = true;
      }
    }
    if (
      marker === 225 &&
      new TextDecoder().decode(segment.subarray(0, 6)) === "Exif\0\0"
    ) {
      try {
        result.exif = readTiff(segment.subarray(6));
      } catch {
        result.malformed = true;
      }
    }
    at = end;
  }
  return result;
}
/** @param {Uint8Array} b */
function readTiff(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength),
    little = b[0] === 73 && b[1] === 73;
  if (!little && !(b[0] === 77 && b[1] === 77)) throw Error("byte order");
  const u16 = (/** @type {number} */ o) => dv.getUint16(o, little),
    u32 = (/** @type {number} */ o) => dv.getUint32(o, little);
  if (u16(2) !== 42) throw Error("tiff");
  /** @param {number} offset */
  const entries = (offset) => {
    const count = u16(offset);
    if (count > 256 || offset + 2 + count * 12 > b.length) throw Error("ifd");
    /** @type {Map<number,any>} */ const tags = new Map();
    for (let n = 0; n < count; n++) {
      const at = offset + 2 + n * 12,
        type = u16(at + 2),
        count = u32(at + 4),
        size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 }[type] ?? 0;
      if (!size || count > 4096) continue;
      const pos = count * size <= 4 ? at + 8 : u32(at + 8);
      if (pos + count * size > b.length) throw Error("bounds");
      let value;
      if (type === 2)
        value = new TextDecoder()
          .decode(b.subarray(pos, pos + count))
          .replace(/\0+$/, "");
      else if (type === 4) value = u32(pos);
      else if (type === 3) value = u16(pos);
      else if (type === 5)
        value = Array.from({ length: count }, (_, k) => {
          const den = u32(pos + k * 8 + 4);
          if (!den) throw Error("rational");
          return u32(pos + k * 8) / den;
        });
      tags.set(u16(at), value);
    }
    return tags;
  };
  const tags = entries(u32(4)),
    exif = tags.has(34665) ? entries(tags.get(34665)) : new Map(),
    gps = tags.has(34853) ? entries(tags.get(34853)) : new Map();
  /** @param {any} values @param {any} ref */
  const coord = (values, ref) =>
    Array.isArray(values) && values.length === 3
      ? (values[0] + values[1] / 60 + values[2] / 3600) *
        (["S", "W"].includes(ref) ? -1 : 1)
      : null;
  return {
    dateTimeOriginal: exif.get(36867) ?? tags.get(306) ?? null,
    offsetTimeOriginal: exif.get(36881) ?? null,
    latitude: coord(gps.get(2), gps.get(1)),
    longitude: coord(gps.get(4), gps.get(3)),
    orientation: tags.get(274) ?? null,
  };
}
/** @param {any} m */
export function validManifest(m) {
  return (
    m?.version === 1 &&
    validFix(m) &&
    m.accuracyMeters <= 10_000 &&
    Number.isSafeInteger(m.capturedAt) &&
    m.capturedAt > 0 &&
    typeof m.user === "string" &&
    m.user.trim().length > 0 &&
    m.user.length <= 150 &&
    typeof m.outlet === "string" &&
    m.outlet.trim().length > 0 &&
    m.outlet.length <= 200 &&
    typeof m.profileId === "string" &&
    typeof m.outletId === "string" &&
    /^[0-9a-f]{16}$/.test(m.perceptualHash ?? "")
  );
}
/** F-024/F-312: metadata checks create review signals, never allegations of fraud.
 * @param {any} inspected @param {any} expected @param {any} settings */
export function photoChecks(inspected, expected, settings) {
  const reasons = [],
    m = inspected.manifest,
    exif = inspected.exif;
  if (inspected.malformed) reasons.push("malformed_metadata");
  if (!validManifest(m)) reasons.push("watermark_manifest_missing");
  else {
    if (
      m.profileId !== expected.profileId ||
      m.outletId !== (expected.outletId ?? "not_applicable")
    )
      reasons.push("capture_identity_mismatch");
    if (m.mockSignal === true) reasons.push("mock_photo_location");
    if (m.capturedAt > Date.now() + settings.photoTimeToleranceMs)
      reasons.push("capture_time_future");
    if (exif?.dateTimeOriginal) {
      const date = exif.dateTimeOriginal.replace(
        /^(\d{4}):(\d\d):(\d\d) /,
        "$1-$2-$3T",
      );
      const at = Date.parse(date + (exif.offsetTimeOriginal ?? "+08:00"));
      if (
        !Number.isFinite(at) ||
        Math.abs(at - m.capturedAt) > settings.photoTimeToleranceMs
      )
        reasons.push("exif_time_mismatch");
    } else reasons.push("exif_time_missing");
    if (Number.isFinite(exif?.latitude) && Number.isFinite(exif?.longitude)) {
      if (
        haversine(m, exif) >
        settings.photoGpsToleranceMeters + m.accuracyMeters
      )
        reasons.push("exif_gps_mismatch");
    } else reasons.push("exif_gps_missing");
    if (exif?.orientation !== 1) reasons.push("exif_orientation_inconsistent");
    // Compare the camera's pre-redraw tags too: a fresh derivative must not hide old source metadata.
    const source = m.sourceExif;
    if (source && typeof source === "object") {
      if (source.dateTimeOriginal) {
        const at = Date.parse(
          String(source.dateTimeOriginal).replace(
            /^(\d{4}):(\d\d):(\d\d) /,
            "$1-$2-$3T",
          ) + (source.offsetTimeOriginal ?? "+08:00"),
        );
        if (
          !Number.isFinite(at) ||
          Math.abs(at - m.capturedAt) > settings.photoTimeToleranceMs
        )
          reasons.push("source_exif_time_mismatch");
      }
      if (
        Number.isFinite(source.latitude) &&
        Number.isFinite(source.longitude) &&
        haversine(m, source) >
          settings.photoGpsToleranceMeters + m.accuracyMeters
      )
        reasons.push("source_exif_gps_mismatch");
      if (
        source.orientation != null &&
        (!Number.isInteger(source.orientation) ||
          source.orientation < 1 ||
          source.orientation > 8)
      )
        reasons.push("source_exif_orientation_invalid");
    }
  }
  return reasons;
}
/** Called after checksum validation on uploaded bytes; raw upload is untouched. @param {any} ctx @param {any} file @param {Uint8Array} bytes */
export async function inspectUploadedPhoto(ctx, file, bytes) {
  if (
    !["visit-photo", "truck-damage"].includes(file.purpose) ||
    file.mime !== "image/jpeg"
  )
    return;
  const [device] =
    await ctx.db`select * from registered_devices where id=${file.device_id}`;
  if (!device?.org_unit_id) return;
  let outletId = null;
  if (file.purpose === "visit-photo")
    outletId =
      (
        await ctx.db`select outlet_id from visit_executions where id=${file.owner_id}`
      )[0]?.outlet_id ?? null;
  const inspected = inspectJpeg(bytes),
    policy = await policyAt(ctx.db);
  const reasons = photoChecks(
    inspected,
    { profileId: device.profile_id, outletId },
    policy.settings,
  );
  const manifest = inspected.manifest ?? {};
  await ctx.db`insert into photo_integrity_facts(file_id,org_unit_id,profile_id,outlet_id,manifest,exif,perceptual_hash)
    values (${file.id},${device.org_unit_id},${device.profile_id},${outletId},${manifest},${inspected.exif ?? {}},${validManifest(manifest) ? manifest.perceptualHash : null}) on conflict(file_id) do nothing`;
  await ctx.db`insert into integrity_observations(source_key,kind,profile_id,org_unit_id,device_id,outlet_id,occurred_at,facts)
    values (${`photo:${file.id}`},'photo',${device.profile_id},${device.org_unit_id},${device.id},${outletId},now(),${{ checksum: file.sha256, perceptualHash: validManifest(manifest) ? manifest.perceptualHash : null, exifMismatch: reasons.length > 0, exifReasons: reasons }}) on conflict(source_key) do nothing`;
}
