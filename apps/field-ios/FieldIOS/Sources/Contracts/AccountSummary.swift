import Foundation

/// IOS-011 cached account figures for one outlet (bootstrap `accountSummaries[]`), as of `asOfDate`.
/// Amounts are PHP centavos. `withheld` carries no figures: the account is shared with an outlet
/// outside this person's plan. `openOrders` are submitted orders not yet fulfilled or posted; there
/// is no receivables balance on the wire.
struct AccountSummary: Codable, Equatable, Sendable {
    struct Sales: Codable, Equatable, Sendable {
        let from: String
        let to: String
        let complete: Bool
        let orders: Int64
        let amountMinor: Int64
        let recentOrders: Int64
        let recentAmountMinor: Int64
        let lastOrderDate: String?
        let lastOrderAmountMinor: Int64?
    }
    struct OpenOrders: Codable, Equatable, Sendable {
        let count: Int64
        let amountMinor: Int64
    }
    let outletId: String
    let asOfDate: String
    let availability: ResponseValue
    let creditLimitMinor: Int64?
    let sales: Sales?
    let openOrders: OpenOrders?

    enum CodingKeys: String, CodingKey { case outletId, asOfDate, availability, creditLimitMinor, sales, openOrders }

    init(outletId: String, asOfDate: String, availability: String, creditLimitMinor: Int64?,
         sales: Sales?, openOrders: OpenOrders?) {
        self.outletId = outletId; self.asOfDate = asOfDate; self.availability = ResponseValue(availability)
        self.creditLimitMinor = creditLimitMinor; self.sales = sales; self.openOrders = openOrders
    }

    /// Required explicit nullable fields: an omitted figure is a corrupt feed, not "none".
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard c.contains(.creditLimitMinor), c.contains(.sales), c.contains(.openOrders) else {
            throw BootstrapV1.WireError.invalidEnvelope
        }
        outletId = try c.decode(String.self, forKey: .outletId)
        asOfDate = try c.decode(String.self, forKey: .asOfDate)
        availability = try c.decode(ResponseValue.self, forKey: .availability)
        creditLimitMinor = try c.decodeIfPresent(Int64.self, forKey: .creditLimitMinor)
        sales = try c.decodeIfPresent(Sales.self, forKey: .sales)
        openOrders = try c.decodeIfPresent(OpenOrders.self, forKey: .openOrders)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(outletId, forKey: .outletId); try c.encode(asOfDate, forKey: .asOfDate)
        try c.encode(availability, forKey: .availability); try c.encode(creditLimitMinor, forKey: .creditLimitMinor)
        try c.encode(sales, forKey: .sales); try c.encode(openOrders, forKey: .openOrders)
    }

    /// Figures are shown only for a known `available` summary; anything else (including a future
    /// availability value) shows as withheld, never as zero sales.
    var isAvailable: Bool { availability.rawValue == "available" && sales != nil && openOrders != nil }

    var isValid: Bool {
        guard !outletId.isEmpty, Self.isDay(asOfDate) else { return false }
        if availability.rawValue == "withheld" {
            return creditLimitMinor == nil && sales == nil && openOrders == nil
        }
        if let limit = creditLimitMinor, limit < 0 { return false }
        if let open = openOrders, open.count < 0 { return false }
        if let s = sales {
            guard Self.isDay(s.from), Self.isDay(s.to), s.from <= s.to, s.to == asOfDate,
                  s.orders >= 0, s.recentOrders >= 0, s.recentOrders <= s.orders,
                  (s.lastOrderDate == nil) == (s.lastOrderAmountMinor == nil),
                  s.lastOrderDate.map({ Self.isDay($0) && $0 >= s.from && $0 <= s.to }) ?? true else { return false }
        }
        return true
    }

    private static func isDay(_ value: String) -> Bool {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = FieldDay.timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        return formatter.date(from: value).map { formatter.string(from: $0) == value } ?? false
    }

    /// "₱12,345.50" from centavos.
    static func peso(_ minor: Int64) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_PH")
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        let value = formatter.string(from: NSDecimalNumber(value: minor).multiplying(byPowerOf10: -2)) ?? "0.00"
        return value.hasPrefix("-") ? "-₱" + value.dropFirst() : "₱" + value
    }
}
