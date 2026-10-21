import Foundation
import Vision
import PDFKit
import AppKit
import ImageIO

// Local-only text recognition. No image or recognized customer facts leave this host.
let data = FileHandle.standardInput.readDataToEndOfFile()
var images: [CGImage] = []
if data.prefix(4) == Data("%PDF".utf8) {
    guard let document = PDFDocument(data: data), document.pageCount > 0, document.pageCount <= 8 else { exit(2) }
    for n in 0..<document.pageCount {
        guard let page = document.page(at: n) else { exit(2) }
        let image = page.thumbnail(of: NSSize(width: 1800, height: 2400), for: .mediaBox)
        guard let tiff = image.tiffRepresentation, let source = CGImageSourceCreateWithData(tiff as CFData, nil), let cg = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(2) }
        images.append(cg)
    }
} else {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil), image.width * image.height <= 25_000_000 else { exit(2) }
    images = [image]
}
var observations: [[String: Any]] = []
var lines: [String] = []
do {
    for (page, image) in images.enumerated() {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]
        try VNImageRequestHandler(cgImage: image).perform([request])
        let results = (request.results ?? []).sorted { a,b in
            abs(a.boundingBox.midY-b.boundingBox.midY) < 0.012 ? a.boundingBox.minX < b.boundingBox.minX : a.boundingBox.midY > b.boundingBox.midY
        }
        var row: [String] = []
        var previousY: CGFloat? = nil
        for result in results {
            guard let candidate = result.topCandidates(1).first else { continue }
            if let y = previousY, abs(y-result.boundingBox.midY) >= 0.012, !row.isEmpty { lines.append(row.joined(separator: "\t")); row = [] }
            row.append(candidate.string)
            previousY = result.boundingBox.midY
            observations.append(["page":page+1,"text":candidate.string,"confidence":candidate.confidence])
        }
        if !row.isEmpty { lines.append(row.joined(separator:"\t")) }
    }
    let json = try JSONSerialization.data(withJSONObject:["modelVersion":"apple-vision-text/v1","text":lines.joined(separator:"\n"),"observations":observations])
    FileHandle.standardOutput.write(json)
} catch { exit(2) }
