import Foundation

/// Read-only analytics projection, deliberately separate from the frozen call-sheet payload.
/// Unknown keys and statuses survive backend additions without enabling new actions.
struct SuggestedOrder: Decodable, Equatable, Sendable {
    let version: String
    let asOfDate: String
    let coverDays: Int
    let leadTimeDays: Int
    let leadTimeProvisional: Bool
    let nextVisit: NextVisit
    let outlet: Outlet
    let lines: [Line]

    struct NextVisit: Decodable, Equatable, Sendable { let days: Int }
    struct Outlet: Decodable, Equatable, Sendable { let outletId: String }
    struct Line: Decodable, Equatable, Sendable {
        let productId: String?
        let code: String
        let name: String
        let unit: String
        let status: String
        let suggestedQuantity: Double
        let reasons: [String]

        /// Never round, clamp or coerce an unsafe recommendation into an order.
        var wholeQuantity: Int? {
            guard suggestedQuantity.isFinite, (0...1_000_000).contains(suggestedQuantity),
                  suggestedQuantity.rounded(.towardZero) == suggestedQuantity else { return nil }
            return Int(suggestedQuantity)
        }
        var quantityText: String {
            if let wholeQuantity { return String(wholeQuantity) }
            return String(suggestedQuantity)
        }
        var canUse: Bool { status == "suggest" && wholeQuantity != nil }

        enum CodingKeys: String, CodingKey {
            case productId, code, name, unit, status, suggestedQuantity, reasons
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            productId = try c.decodeIfPresent(String.self, forKey: .productId)
            code = try c.decode(String.self, forKey: .code)
            name = try c.decode(String.self, forKey: .name)
            unit = try c.decode(String.self, forKey: .unit)
            status = try c.decode(String.self, forKey: .status)
            suggestedQuantity = try c.decode(Double.self, forKey: .suggestedQuantity)
            reasons = try c.decode([String].self, forKey: .reasons).prefix(10).map { String($0.prefix(300)) }
        }
    }

    enum Failure: Error, Equatable { case tooManyLines, requestMismatch }
    enum CodingKeys: String, CodingKey {
        case version, asOfDate, coverDays, leadTimeDays, leadTimeProvisional, nextVisit, outlet, lines
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(String.self, forKey: .version)
        asOfDate = try c.decode(String.self, forKey: .asOfDate)
        coverDays = try c.decode(Int.self, forKey: .coverDays)
        leadTimeDays = try c.decode(Int.self, forKey: .leadTimeDays)
        leadTimeProvisional = try c.decode(Bool.self, forKey: .leadTimeProvisional)
        nextVisit = try c.decode(NextVisit.self, forKey: .nextVisit)
        outlet = try c.decode(Outlet.self, forKey: .outlet)
        var items = try c.nestedUnkeyedContainer(forKey: .lines)
        if let count = items.count, count > 200 { throw Failure.tooManyLines }
        var decoded: [Line] = []
        while !items.isAtEnd {
            guard decoded.count < 200 else { throw Failure.tooManyLines }
            decoded.append(try items.decode(Line.self))
        }
        lines = decoded
    }

    func validated(outletId: String, asOfDate: String) throws -> SuggestedOrder {
        guard outlet.outletId == outletId, self.asOfDate == asOfDate else { throw Failure.requestMismatch }
        return self
    }
}

/// These helpers only edit local text fields. They cannot queue or submit anything.
struct SuggestedOrderRules {
    let order: SuggestedOrder
    static let note = "Suggestions only. Nothing is ordered until you save the call sheet."

    func suggestion(for productId: String) -> SuggestedOrder.Line? {
        order.lines.first { $0.productId == productId }
    }

    func useSuggestion(_ drafts: [String: CallSheetDraft], productId: String) -> [String: CallSheetDraft] {
        guard let line = suggestion(for: productId), line.canUse, let quantity = line.wholeQuantity else { return drafts }
        var result = drafts
        var draft = result[productId] ?? CallSheetDraft()
        draft.values[.order] = String(quantity)
        result[productId] = draft
        return result
    }

    func hasApplicableLine(sheet: CallSheet) -> Bool {
        guard sheet.outletId == order.outlet.outletId else { return false }
        return sheet.lines.contains { product in
            guard let line = suggestion(for: product.productId) else { return false }
            return line.canUse && (line.wholeQuantity ?? 0) > 0
        }
    }

    func useAll(_ drafts: [String: CallSheetDraft], sheet: CallSheet) -> [String: CallSheetDraft] {
        guard sheet.outletId == order.outlet.outletId else { return drafts }
        var result = drafts
        for product in sheet.lines {
            guard let line = suggestion(for: product.productId), line.canUse, (line.wholeQuantity ?? 0) > 0,
                  (result[product.productId]?.values[.order] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            result = useSuggestion(result, productId: product.productId)
        }
        return result
    }

    func notOnSheet(_ sheet: CallSheet) -> [SuggestedOrder.Line] {
        guard sheet.outletId == order.outlet.outletId else { return [] }
        let ids = Set(sheet.lines.map(\.productId))
        return order.lines.filter { $0.status == "suggest" && ($0.productId.map { !ids.contains($0) } ?? true) }
    }

    static func statusText(_ line: SuggestedOrder.Line) -> String {
        switch line.status {
        case "suggest": "Suggested: \(line.quantityText) \(line.unit)"
        case "enough_stock": "Enough stock — no order suggested"
        case "unavailable": "Not available to sell"
        case "no_history": "No purchases in 12 weeks — no suggestion"
        default: "No suggestion"
        }
    }

    var summary: String {
        let count = order.lines.filter { $0.canUse && ($0.wholeQuantity ?? 0) > 0 }.count
        let text = "\(count) product(s) suggested · covers \(order.coverDays) days (\(order.nextVisit.days) to next visit + \(order.leadTimeDays) lead time)"
        return text + (order.leadTimeProvisional ? "\nLead time is provisional." : "")
    }
}
