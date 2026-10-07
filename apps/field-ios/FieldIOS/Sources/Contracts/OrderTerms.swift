import Foundation

/// SP-0088: account-scoped selling units and price previews. The office re-prices the wire order.
struct OrderTerms: Codable, Equatable, Sendable {
    struct PriceList: Codable, Equatable, Sendable {
        let id: String; let code: String; let name: String; let currency: String; let sample: Bool
        var isValid: Bool {
            !id.isEmpty && !code.isEmpty && !name.isEmpty && currency.utf8.count == 3 &&
            currency.utf8.allSatisfy { (65...90).contains($0) }
        }
        enum CodingKeys: String, CodingKey { case id, code, name, currency, sample }
        init(id: String, code: String, name: String, currency: String, sample: Bool) {
            self.id = id; self.code = code; self.name = name; self.currency = currency; self.sample = sample
        }
        init(from decoder: Decoder) throws {
            try OrderTerms.requireKeys(decoder, ["id", "code", "name", "currency", "sample"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id); code = try c.decode(String.self, forKey: .code)
            name = try c.decode(String.self, forKey: .name); currency = try c.decode(String.self, forKey: .currency)
            sample = try c.decode(Bool.self, forKey: .sample)
            guard isValid else { throw BootstrapV1.WireError.unsafeValue }
        }
    }
    struct Line: Codable, Equatable, Sendable {
        let productId: String; let uom: String; let unitPriceMinor: Int64?
        var isValid: Bool { !productId.isEmpty && (1...20).contains(uom.count) && (unitPriceMinor == nil || unitPriceMinor! >= 0) }
        enum CodingKeys: String, CodingKey { case productId, uom, unitPriceMinor }
        init(productId: String, uom: String, unitPriceMinor: Int64?) {
            self.productId = productId; self.uom = uom; self.unitPriceMinor = unitPriceMinor
        }
        init(from decoder: Decoder) throws {
            try OrderTerms.requireKeys(decoder, ["productId", "uom", "unitPriceMinor"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            productId = try c.decode(String.self, forKey: .productId); uom = try c.decode(String.self, forKey: .uom)
            unitPriceMinor = try c.decodeIfPresent(Int64.self, forKey: .unitPriceMinor)
            guard isValid else { throw BootstrapV1.WireError.unsafeValue }
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(productId, forKey: .productId); try c.encode(uom, forKey: .uom)
            try c.encode(unitPriceMinor, forKey: .unitPriceMinor)
        }
    }
    let outletId: String; let priceList: PriceList?; let lines: [Line]
    var isValid: Bool {
        var seen: [String: Set<String>] = [:]
        return !outletId.isEmpty && (priceList?.isValid ?? true) && lines.count <= 1800 && lines.allSatisfy {
            $0.isValid && seen[$0.productId, default: []].insert($0.uom).inserted &&
            (priceList != nil || $0.unitPriceMinor == nil)
        }
    }
    enum CodingKeys: String, CodingKey { case outletId, priceList, lines }
    init(outletId: String, priceList: PriceList?, lines: [Line]) {
        self.outletId = outletId; self.priceList = priceList; self.lines = lines
    }
    init(from decoder: Decoder) throws {
        try Self.requireKeys(decoder, ["outletId", "priceList", "lines"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        outletId = try c.decode(String.self, forKey: .outletId)
        priceList = try c.decodeIfPresent(PriceList.self, forKey: .priceList)
        lines = try c.decode([Line].self, forKey: .lines)
        guard isValid else { throw BootstrapV1.WireError.unsafeValue }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(outletId, forKey: .outletId); try c.encode(priceList, forKey: .priceList)
        try c.encode(lines, forKey: .lines)
    }
    private struct Key: CodingKey {
        let stringValue: String; var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    private static func requireKeys(_ decoder: Decoder, _ expected: Set<String>) throws {
        let keys = try decoder.container(keyedBy: Key.self).allKeys.map(\.stringValue)
        guard Set(keys) == expected else { throw BootstrapV1.WireError.invalidEnvelope }
    }
}
