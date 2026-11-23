/** Optional, untrusted display metadata. Never a registration or proof requirement.
 * Android percent-encodes UTF-8 so all HTTP header values remain ASCII.
 * @param {Headers} headers
 */
export function phoneHardware(headers) {
  /** @param {string} name */
  const read = (name) => {
    const raw = headers.get(name);
    if (!raw || raw.length > 1440) return null;
    try {
      return cleanHardwareText(decodeURIComponent(raw));
    } catch {
      return null;
    }
  };
  return {
    manufacturer: read("x-device-manufacturer"),
    model: read("x-device-model"),
  };
}

/** Invalid or absent metadata is ignored, never a reason to refuse a phone. @param {unknown} raw */
export function cleanHardwareText(raw) {
  if (typeof raw !== "string" || /[\x00-\x1f\x7f]/.test(raw)) return null;
  const value = raw.trim().replace(/\s+/g, " ");
  return value && value.length <= 120 ? value : null;
}

/** @param {{ manufacturer?: string|null, model?: string|null }} device */
export function phoneModelLabel(device) {
  const model = device.model?.trim();
  if (!model) return "Model not sent yet";
  const maker = device.manufacturer?.trim();
  return maker && !model.toLowerCase().startsWith(maker.toLowerCase())
    ? `${maker} ${model}`
    : model;
}

/** Only call after authenticating this exact phone; missing reports retain known facts.
 * @param {any} db @param {string} deviceId @param {Headers} headers
 */
export async function recordPhoneHardware(db, deviceId, headers) {
  const { manufacturer, model } = phoneHardware(headers);
  if (manufacturer || model)
    await db`update registered_devices set manufacturer=coalesce(${manufacturer},manufacturer),model=coalesce(${model},model) where id=${deviceId}`;
}
