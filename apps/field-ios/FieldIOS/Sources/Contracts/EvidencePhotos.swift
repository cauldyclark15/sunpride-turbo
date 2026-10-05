import CryptoKit
import Foundation

/// IOS-016 bootstrap `photoTypes[]` entry: a code the server accepts on attach, and its label.
struct PhotoType: Codable, Equatable, Sendable {
    let code: String
    let label: String

    init(code: String, label: String) throws {
        guard EvidencePhotos.isCode(code) else { throw BootstrapV1.WireError.unsafeValue }
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, label.count <= 80 else { throw BootstrapV1.WireError.unsafeValue }
        self.code = code
        self.label = trimmed
    }
    enum CodingKeys: String, CodingKey { case code, label }
    /// Strict: exactly `code` and `label`, both bounded, as the v1 schema says.
    init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: AnyKey.self).allKeys.map(\.stringValue)
        guard Set(keys) == ["code", "label"] else { throw BootstrapV1.WireError.unsafeValue }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(code: c.decode(String.self, forKey: .code), label: c.decode(String.self, forKey: .label))
    }
    private struct AnyKey: CodingKey {
        let stringValue: String
        init?(stringValue: String) { self.stringValue = stringValue }
        var intValue: Int? { nil }
        init?(intValue: Int) { nil }
    }
}

/// One captured photo as the encrypted store keeps it. The bytes live in `PhotoFiles`, never here.
struct EvidencePhotoRow: Equatable, Sendable {
    let localId: UUID
    /// The call's Start: the visit association, resolved to a server visit ID from its ack.
    let checkInRequestId: UUID
    let photoType: String
    let mime: String
    let sizeBytes: Int64
    /// Lowercase SHA-256 hex of the JPEG bytes; the server compares it with the stored blob.
    let sha256: String
    /// Epoch ms, taken when the shutter was pressed.
    let capturedAt: Int64
    var state: String = "pending"
    var attempts: Int = 0
    var evidenceId: String? = nil
    var reviewCode: String? = nil
    var uploadedAt: Int64? = nil
}

/// What the person sees for one captured photo; never the file, key or server IDs.
struct VisitPhoto: Equatable, Identifiable, Sendable {
    let id: UUID
    let photoType: String
    let capturedAt: Date
    let sizeBytes: Int64
    let state: String
    let reviewCode: String?
}

/// Visit photo evidence rules shared by the model, the store and the uploader (mirrors Android AND-016).
///
/// A photo is local first: the sealed bytes and this metadata are durable before anything is sent.
/// Upload runs separately from the visit outbox, so a waiting photo never blocks Start, activities or
/// End, and End never waits for a network.
enum EvidencePhotos {
    static let mime = "image/jpeg"
    /// Server `MAX_EVIDENCE_BYTES`.
    static let maxBytes: Int64 = 10 * 1024 * 1024
    /// Photos per call kept on the phone; the server accepts up to 500 per visit.
    static let maxPerVisit = 20
    /// A claim that expired mid-upload gets a fresh one; after this many tries the office reviews it.
    static let maxAttempts = 5
    static let states: Set<String> = ["pending", "uploaded", "review"]
    /// Server refusals that a retry cannot fix: the office reviews the photo instead.
    static let finalCodes: Set<String> = ["invalid_request", "out_of_scope", "conflict"]

    /// Used only when the server predates `photoTypes` (or sent none). Mirrors the backend's
    /// provisional `EVIDENCE_PHOTO_TYPES`; the server still validates every code on attach.
    static let defaultTypes: [PhotoType] = [
        ("storefront", "Store front"), ("shelf_display", "Shelf and display"), ("price_tag", "Price tags"),
        ("promotion", "Promotion material"), ("other", "Other"),
    ].map { try! PhotoType(code: $0.0, label: $0.1) }

    static func isCode(_ code: String) -> Bool {
        (1...40).contains(code.count) && code.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "_" || $0 == "-" }
    }
    /// The configured list, or the provisional defaults when none was downloaded.
    static func offered(_ downloaded: [PhotoType]) -> [PhotoType] { downloaded.isEmpty ? defaultTypes : downloaded }
    static func label(_ code: String, types: [PhotoType]) -> String {
        offered(types).first { $0.code == code }?.label ?? "Photo"
    }
    static func sha256Hex(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    /// A JPEG starts with SOI (FF D8) and ends with EOI (FF D9).
    static func isJpeg(_ bytes: Data) -> Bool {
        let b = [UInt8](bytes)
        return b.count >= 4 && b[0] == 0xFF && b[1] == 0xD8 && b[b.count - 2] == 0xFF && b[b.count - 1] == 0xD9
    }

    static func isValidNew(_ row: EvidencePhotoRow, types: [PhotoType]) -> Bool {
        row.state == "pending" && row.attempts == 0 && row.evidenceId == nil && row.reviewCode == nil &&
            row.uploadedAt == nil && row.mime == mime && (1...maxBytes).contains(row.sizeBytes) &&
            row.sha256.count == 64 && row.sha256.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) &&
            row.capturedAt > 0 && offered(types).contains { $0.code == row.photoType }
    }

    static func view(_ row: EvidencePhotoRow) -> VisitPhoto {
        VisitPhoto(id: row.localId, photoType: row.photoType,
                   capturedAt: Date(timeIntervalSince1970: Double(row.capturedAt) / 1000),
                   sizeBytes: row.sizeBytes, state: row.state, reviewCode: row.reviewCode)
    }
    static func stateLabel(_ photo: VisitPhoto) -> String {
        switch photo.state {
        case "uploaded": "Uploaded"
        case "review": "Not uploaded · office will review"
        default: "Saved on phone · uploads when online"
        }
    }
    /// Short Done-card summary, e.g. "3 photos · 1 waiting to upload".
    static func summary(_ photos: [VisitPhoto]) -> String? {
        guard !photos.isEmpty else { return nil }
        let waiting = photos.filter { $0.state == "pending" }.count
        let review = photos.filter { $0.state == "review" }.count
        return ["\(photos.count) photo" + (photos.count == 1 ? "" : "s"),
                waiting > 0 ? "\(waiting) waiting to upload" : nil,
                review > 0 ? "\(review) for office review" : nil].compactMap { $0 }.joined(separator: " · ")
    }
}
