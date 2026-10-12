// SP-0126: regenerate the field app's launcher/splash bitmaps from the client's logo.
//
//   swift apps/field-android/scripts/generate-icons.swift            (from the repo root)
//
// Source of truth: packages/ui/assets/sunpride-logo.jpg (the same file the web app uses). The logo is
// only RESIZED (high-quality CoreGraphics interpolation) — never redrawn, recoloured or cropped. The one
// derived shape is the legacy round icon, which is the same square logo clipped to a circle exactly as a
// launcher would. macOS only (CoreGraphics/ImageIO); no ImageMagick or other tooling needed.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let repo = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = repo.appendingPathComponent("packages/ui/assets/sunpride-logo.jpg")
let res = repo.appendingPathComponent("apps/field-android/app/src/main/res")

guard let src = CGImageSourceCreateWithURL(source as CFURL, nil),
      let logo = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    fatalError("Run from the repo root; cannot read \(source.path)")
}

func render(_ size: Int, round: Bool = false) -> CGImage {
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high
    let rect = CGRect(x: 0, y: 0, width: size, height: size)
    if round { ctx.addEllipse(in: rect); ctx.clip() }
    ctx.draw(logo, in: rect)
    return ctx.makeImage()!
}

func write(_ image: CGImage, _ path: URL) {
    try! FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
    let dest = CGImageDestinationCreateWithURL(path as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("cannot write \(path.path)") }
    print("\(image.width)x\(image.height) \(path.path.replacingOccurrences(of: repo.path + "/", with: ""))")
}

// SP-0140: in-app bitmaps ship as LOSSLESS WebP (same pixels, ~40% smaller). Needs `cwebp`
// (`brew install webp`); the PNG is removed so Android never sees two copies of one resource.
func writeWebP(_ image: CGImage, _ path: URL) {
    let png = path.deletingPathExtension().appendingPathExtension("png")
    write(image, png)
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    task.arguments = ["cwebp", "-quiet", "-lossless", "-z", "9", "-m", "6", png.path, "-o", path.path]
    try! task.run(); task.waitUntilExit()
    guard task.terminationStatus == 0 else { fatalError("cwebp failed for \(png.path); install it with brew install webp") }
    try! FileManager.default.removeItem(at: png)
}

// density → scale factor against mdpi (1dp = 1px).
let densities: [(String, Double)] = [("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)]
for (name, scale) in densities {
    // Legacy launcher icons: 48dp, square and round.
    let legacy = Int(48 * scale)
    writeWebP(render(legacy), res.appendingPathComponent("mipmap-\(name)/ic_launcher.webp"))
    writeWebP(render(legacy, round: true), res.appendingPathComponent("mipmap-\(name)/ic_launcher_round.webp"))
    // Adaptive-icon/splash logo layer: 72dp, i.e. the visible viewport of the 108dp adaptive canvas.
    writeWebP(render(Int(72 * scale)), res.appendingPathComponent("drawable-\(name)/sunpride_logo_icon.webp"))
}
// Sign-in screen logo (shown at up to 120dp; 480px covers xxxhdpi).
writeWebP(render(480), res.appendingPathComponent("drawable-nodpi/sunpride_logo.webp"))
// Store / listing icon (not packaged into the app; stores expect PNG).
write(render(512), repo.appendingPathComponent("apps/field-android/app/src/main/ic_launcher-playstore.png"))
