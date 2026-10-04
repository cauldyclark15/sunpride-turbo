import Foundation

/// Additive Annex C projection. Nullable keys are required on the wire; omission is not null.
struct CallSheet: Codable, Equatable, Sendable {
    let outletId: String
    let revision: Int
    let header: Header
    let lines: [Line]

    struct Header: Codable, Equatable, Sendable {
        let accountName: String
        let address: String?
        let buyerName: String?
        let contactNumber: String?
        let accountInCharge: String?
        let receivingInCharge: String?
        let distributorName: String?
        let distributorSchedule: String?
        let foc: String?
        let pricing: String?
    }
    struct Line: Codable, Equatable, Sendable {
        let productId: String
        let code: String
        let name: String
        let uom: String
        let barcode: String?
        let pricing: String?
    }
    var isValid: Bool {
        !outletId.isEmpty && revision >= 1 && header.isValid && lines.count <= 100 &&
        lines.allSatisfy(\.isValid) && Set(lines.map(\.productId)).count == lines.count
    }
}

extension CallSheet {
    enum CodingKeys: String, CodingKey { case outletId, revision, header, lines }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        outletId = try c.decode(String.self, forKey: .outletId)
        revision = try c.decode(Int.self, forKey: .revision)
        header = try c.decode(Header.self, forKey: .header)
        lines = try c.decode([Line].self, forKey: .lines)
        guard isValid else { throw BootstrapV1.WireError.unsafeValue }
    }
}

extension CallSheet.Header {
    var isValid: Bool {
        !accountName.isEmpty && accountName.count <= 200 &&
        [address, buyerName, contactNumber, accountInCharge, receivingInCharge, distributorName, distributorSchedule, foc, pricing].allSatisfy { ($0?.count ?? 0) <= 200 }
    }
    enum CodingKeys: String, CodingKey, CaseIterable { case accountName, address, buyerName, contactNumber, accountInCharge, receivingInCharge, distributorName, distributorSchedule, foc, pricing }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard CodingKeys.allCases.allSatisfy(c.contains) else { throw BootstrapV1.WireError.invalidEnvelope }
        accountName = try c.decode(String.self, forKey: .accountName)
        address = try c.decodeIfPresent(String.self, forKey: .address)
        buyerName = try c.decodeIfPresent(String.self, forKey: .buyerName)
        contactNumber = try c.decodeIfPresent(String.self, forKey: .contactNumber)
        accountInCharge = try c.decodeIfPresent(String.self, forKey: .accountInCharge)
        receivingInCharge = try c.decodeIfPresent(String.self, forKey: .receivingInCharge)
        distributorName = try c.decodeIfPresent(String.self, forKey: .distributorName)
        distributorSchedule = try c.decodeIfPresent(String.self, forKey: .distributorSchedule)
        foc = try c.decodeIfPresent(String.self, forKey: .foc)
        pricing = try c.decodeIfPresent(String.self, forKey: .pricing)
        guard isValid else { throw BootstrapV1.WireError.unsafeValue }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(accountName, forKey: .accountName)
        try c.encode(address, forKey: .address)
        try c.encode(buyerName, forKey: .buyerName)
        try c.encode(contactNumber, forKey: .contactNumber)
        try c.encode(accountInCharge, forKey: .accountInCharge)
        try c.encode(receivingInCharge, forKey: .receivingInCharge)
        try c.encode(distributorName, forKey: .distributorName)
        try c.encode(distributorSchedule, forKey: .distributorSchedule)
        try c.encode(foc, forKey: .foc)
        try c.encode(pricing, forKey: .pricing)
    }
}

extension CallSheet.Line {
    var isValid: Bool { !productId.isEmpty && (barcode?.count ?? 0) <= 64 && (pricing?.count ?? 0) <= 200 }
    enum CodingKeys: String, CodingKey, CaseIterable { case productId, code, name, uom, barcode, pricing }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard CodingKeys.allCases.allSatisfy(c.contains) else { throw BootstrapV1.WireError.invalidEnvelope }
        productId = try c.decode(String.self, forKey: .productId)
        code = try c.decode(String.self, forKey: .code)
        name = try c.decode(String.self, forKey: .name)
        uom = try c.decode(String.self, forKey: .uom)
        barcode = try c.decodeIfPresent(String.self, forKey: .barcode)
        pricing = try c.decodeIfPresent(String.self, forKey: .pricing)
        guard isValid else { throw BootstrapV1.WireError.unsafeValue }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(productId, forKey: .productId)
        try c.encode(code, forKey: .code)
        try c.encode(name, forKey: .name)
        try c.encode(uom, forKey: .uom)
        try c.encode(barcode, forKey: .barcode)
        try c.encode(pricing, forKey: .pricing)
    }
}

/// The phone never sends a month/week. The server derives both from the visit service date.
enum CallSheetMeasure: String, CaseIterable, Sendable {
    case order, beginningInventory, take, delivered, offtake, endInventory
    var label: String {
        switch self {
        case .order: "Order"
        case .beginningInventory: "Beginning inv."
        case .take: "Take"
        case .delivered: "Delivered"
        case .offtake: "Off-take"
        case .endInventory: "End inv."
        }
    }
}

struct CallSheetDraft: Sendable {
    var values: [CallSheetMeasure: String] = [:]
}

enum CallSheetPayload {
    enum Failure: Error, Equatable { case empty, invalidNumber, unknownProduct, invalidSheet }
    static func lines(sheet: CallSheet, drafts: [String: CallSheetDraft]) throws -> [[String: Any]] {
        guard sheet.isValid else { throw Failure.invalidSheet }
        let allowed = Set(sheet.lines.map(\.productId))
        guard Set(drafts.keys).isSubset(of: allowed) else { throw Failure.unknownProduct }
        var result: [[String: Any]] = []
        for product in sheet.lines {
            var line: [String: Any] = ["productId": product.productId]
            var touched = false
            for measure in CallSheetMeasure.allCases {
                let raw = (drafts[product.productId]?.values[measure] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if raw.isEmpty { line[measure.rawValue] = NSNull(); continue }
                guard raw.utf8.allSatisfy({ (48...57).contains($0) }),
                      let number = Int(raw), (0...1_000_000).contains(number) else { throw Failure.invalidNumber }
                line[measure.rawValue] = number
                touched = true
            }
            if touched { result.append(line) }
        }
        guard !result.isEmpty else { throw Failure.empty }
        return result
    }
}
