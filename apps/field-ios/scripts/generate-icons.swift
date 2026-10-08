// SP-0132: regenerate the iOS field app's icon, launch-screen and sign-in logo bitmaps from the client's logo.
//
//   swift apps/field-ios/scripts/generate-icons.swift            (from the repo root)
//
// Source of truth: packages/ui/assets/sunpride-logo.jpg (the same file the web app and the Android field app
// use). The logo is only RESIZED (high-quality CoreGraphics interpolation) — never redrawn, recoloured,
// cropped or given transparency (App Store icons must be opaque). iOS applies its own corner mask.
// macOS only (CoreGraphics/ImageIO); no ImageMagick or other tooling needed.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let repo = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = repo.appendingPathComponent("packages/ui/assets/sunpride-logo.jpg")
let assets = repo.appendingPathComponent("apps/field-ios/FieldIOS/Resources/Assets.xcassets")

guard let src = CGImageSourceCreateWithURL(source as CFURL, nil),
      let logo = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    fatalError("Run from the repo root; cannot read \(source.path)")
}

func render(_ size: Int) -> CGImage {
    // noneSkipLast: opaque RGB, no alpha channel (an icon with alpha is rejected by App Store tooling).
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.interpolationQuality = .high
    ctx.draw(logo, in: CGRect(x: 0, y: 0, width: size, height: size))
    return ctx.makeImage()!
}

func write(_ image: CGImage, _ path: URL) {
    try! FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
    let dest = CGImageDestinationCreateWithURL(path as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("cannot write \(path.path)") }
    print("\(image.width)x\(image.height) \(path.path.replacingOccurrences(of: repo.path + "/", with: ""))")
}

func json(_ object: Any, _ path: URL) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    // Prettier's JSON style (`"key": value`) so `bunx prettier --check` stays clean after regenerating.
    let text = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\" : ", with: "\": ")
    try! (text + "\n").write(to: path, atomically: true, encoding: .utf8)
}

// App icon: every iPhone/iPad slot plus the 1024 marketing icon.
// (idiom, point size, scale)
let slots: [(String, Double, Int)] = [
    ("iphone", 20, 2), ("iphone", 20, 3), ("iphone", 29, 2), ("iphone", 29, 3),
    ("iphone", 40, 2), ("iphone", 40, 3), ("iphone", 60, 2), ("iphone", 60, 3),
    ("ipad", 20, 1), ("ipad", 20, 2), ("ipad", 29, 1), ("ipad", 29, 2), ("ipad", 40, 1), ("ipad", 40, 2),
    ("ipad", 76, 1), ("ipad", 76, 2), ("ipad", 83.5, 2), ("ios-marketing", 1024, 1),
]
let iconSet = assets.appendingPathComponent("AppIcon.appiconset")
var images: [[String: String]] = []
var written = Set<Int>()
for (idiom, points, scale) in slots {
    let pixels = Int((points * Double(scale)).rounded())
    let file = "icon-\(pixels).png"
    if written.insert(pixels).inserted { write(render(pixels), iconSet.appendingPathComponent(file)) }
    let size = points == points.rounded() ? "\(Int(points))x\(Int(points))" : "\(points)x\(points)"
    images.append(["idiom": idiom, "size": size, "scale": "\(scale)x", "filename": file])
}
json(["images": images, "info": ["author": "xcode", "version": 1]], iconSet.appendingPathComponent("Contents.json"))

// Launch screen and sign-in logo: shown at 160 pt (1x/2x/3x).
let logoSet = assets.appendingPathComponent("SunprideLogo.imageset")
var logoImages: [[String: String]] = []
for scale in 1...3 {
    let file = "sunpride-logo@\(scale)x.png"
    write(render(160 * scale), logoSet.appendingPathComponent(file))
    logoImages.append(["idiom": "universal", "scale": "\(scale)x", "filename": file])
}
json(["images": logoImages, "info": ["author": "xcode", "version": 1]], logoSet.appendingPathComponent("Contents.json"))
