import { decode } from "jpeg-js";
import { rule } from "../org/model.js";

/** F-011 a MIME label and SOI/EOI bytes are not a storefront photo. The field
 * app downsizes to 960 px; cap both decoding memory and pixels before accepting
 * untrusted signed bytes. No EXIF metadata is copied into generic audit logs.
 * @param {Uint8Array} bytes */
export function validateCensusJpeg(bytes) {
  if (bytes.length > 160 * 1024)
    rule("Take a storefront JPEG photo up to 160 KiB.");
  return validateJpeg(bytes);
}
/** F-616 catalogue photos share the bounded real decoder. @param {Uint8Array} bytes */
export function validateCatalogueJpeg(bytes) {
  if (bytes.length > 512 * 1024) rule("Choose a catalogue JPEG up to 512 KiB.");
  return validateJpeg(bytes);
}
/** F-613: bounded cheque evidence uses the same real decoder, not MIME/magic bytes alone. @param {Uint8Array} bytes */
export function validateCollectionJpeg(bytes) {
  if (bytes.length > 64 * 1024) rule("Take a clear cheque JPEG up to 64 KiB.");
  return validateJpeg(bytes);
}
/** @param {Uint8Array} bytes */
function validateJpeg(bytes) {
  try {
    const image = decode(bytes, {
      useTArray: true,
      formatAsRGBA: false,
      tolerantDecoding: false,
      maxResolutionInMP: 1,
      maxMemoryUsageInMB: 16,
    });
    if (image.width < 32 || image.height < 32)
      rule("Take a clear storefront photo at least 32 pixels wide and high.");
    return { width: image.width, height: image.height };
  } catch {
    rule(
      "The storefront photo is incomplete, unreadable or too large. Take it again.",
    );
  }
}
