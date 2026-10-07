#!/usr/bin/env bash
# SP-0125: generate the van app's launcher icons from the client's real logo
# (packages/ui/assets/sunpride-logo.jpg, the same file the web app uses). The logo is only
# scaled, padded with its own background red and (legacy round icon) circle-masked; it is never
# redrawn or recoloured.
#
#   mipmap-<density>/ic_launcher_background.png  adaptive background: logo filling the visible
#                                                72dp of the 108dp layer, padded with logo red
#   mipmap-<density>/ic_launcher.png             legacy square icon (48dp)
#   mipmap-<density>/ic_launcher_round.png       legacy round icon (48dp, circle crop)
#   drawable-nodpi/sunpride_logo.jpg             the logo itself (sign-in screen and splash)
#   ic_launcher-playstore.png                    512x512 listing icon
#
# macOS only (CoreGraphics via swiftc, sRGB throughout); no ImageMagick. Re-run after the client
# changes the logo.
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$APP/../.." && pwd)"
LOGO="$REPO/packages/ui/assets/sunpride-logo.jpg"
RES="$APP/app/src/main/res"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[[ -f "$LOGO" ]] || { echo "Logo missing: $LOGO" >&2; exit 1; }

# render <logo> <out.png> <canvas px> <logo px> <round 0|1>
# The padding is the logo's own left-edge red: a 4x4 patch of the logo stretched over the canvas,
# so it goes through the same colour pipeline as the logo and the seam is invisible.
cat > "$TMP/render.swift" <<'SWIFT'
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
let a = CommandLine.arguments
let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil)!
let logo = CGImageSourceCreateImageAtIndex(source, 0, nil)!
let canvas = Int(a[3])!, size = Int(a[4])!, round = a[5] == "1"
let ctx = CGContext(data: nil, width: canvas, height: canvas, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.interpolationQuality = .high
let full = CGRect(x: 0, y: 0, width: canvas, height: canvas)
if round { ctx.addEllipse(in: full); ctx.clip() }
if size < canvas, let patch = logo.cropping(to: CGRect(x: 2, y: logo.height / 2 - 2, width: 4, height: 4)) {
    ctx.draw(patch, in: full)
}
let offset = (canvas - size) / 2
ctx.draw(logo, in: CGRect(x: offset, y: offset, width: size, height: size))
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
precondition(CGImageDestinationFinalize(dest))
SWIFT
swiftc -O -o "$TMP/render" "$TMP/render.swift"

for pair in mdpi:1 hdpi:1.5 xhdpi:2 xxhdpi:3 xxxhdpi:4; do
  density="${pair%%:*}"; scale="${pair##*:}"
  dir="$RES/mipmap-$density"
  mkdir -p "$dir"
  px() { awk -v s="$scale" -v d="$1" 'BEGIN{printf "%d", d*s}'; }
  "$TMP/render" "$LOGO" "$dir/ic_launcher_background.png" "$(px 108)" "$(px 72)" 0
  "$TMP/render" "$LOGO" "$dir/ic_launcher.png" "$(px 48)" "$(px 48)" 0
  "$TMP/render" "$LOGO" "$dir/ic_launcher_round.png" "$(px 48)" "$(px 48)" 1
done

mkdir -p "$RES/drawable-nodpi"
cp "$LOGO" "$RES/drawable-nodpi/sunpride_logo.jpg"
"$TMP/render" "$LOGO" "$APP/app/src/main/ic_launcher-playstore.png" 512 512 0
echo "Launcher icons written under $RES"
