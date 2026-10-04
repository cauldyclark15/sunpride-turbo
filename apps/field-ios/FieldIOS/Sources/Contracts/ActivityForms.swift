import Foundation

/// IOS-013 structured activity forms → exact v1 `visit.activity` wire shapes (mirrors
/// `mobile/http_handlers.ts`). Product forms only accept products on the account's call sheet,
/// because the field phone has no nationwide catalog.
enum ActivityForms {
    /// A form the person must fix; the message is fixed copy, safe to show.
    struct Failure: Error, Equatable { let message: String }

    static let display: [(code: String, label: String)] = [
        ("compliant", "Compliant"), ("needs_action", "Needs action"), ("not_present", "Not on shelf")]
    static let promotionFindings: [(code: String, label: String)] = [
        ("executed", "Executed"), ("not_executed", "Not executed"), ("not_applicable", "Not applicable")]
    static let stock: [(code: String, label: String)] = [
        ("present", "In stock"), ("absent", "Out of stock"), ("unknown", "Not checked")]
    private static let maxQuantity: Int64 = 1_000_000_000

    private static func fail(_ text: String) -> Failure { Failure(message: text) }
    private static func asciiDigits(_ text: Substring) -> Bool { !text.isEmpty && text.utf8.allSatisfy { (48...57).contains($0) } }
    private static func requireProduct(_ sheet: CallSheet?, _ productId: String?) throws {
        guard let productId, !productId.isEmpty, sheet?.lines.contains(where: { $0.productId == productId }) == true else {
            throw fail("Choose a product from this account's call sheet")
        }
    }

    static func merchandising(displayCondition: String?, actionTaken: String) throws -> [String: Any] {
        guard let displayCondition, display.contains(where: { $0.code == displayCondition }) else {
            throw fail("Choose the display condition")
        }
        let action = actionTaken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard action.count <= 500 else { throw fail("Keep the action under 500 characters") }
        var form: [String: Any] = ["kind": "merchandising", "displayCondition": displayCondition]
        if !action.isEmpty { form["actionTaken"] = action }
        return form
    }

    static func promotion(programRef: String, finding: String?) throws -> [String: Any] {
        let ref = programRef.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !ref.isEmpty, ref.count <= 200 else { throw fail("Enter the promotion or program name") }
        guard let finding, promotionFindings.contains(where: { $0.code == finding }) else { throw fail("Choose what you found") }
        return ["kind": "promotion", "programRef": ref, "finding": finding]
    }

    static func inventoryCheck(sheet: CallSheet?, productId: String?, finding: String?, quantity: String) throws -> [String: Any] {
        try requireProduct(sheet, productId)
        guard let finding, stock.contains(where: { $0.code == finding }) else { throw fail("Choose the stock finding") }
        var form: [String: Any] = ["kind": "inventory_check", "productId": productId!, "icoFinding": finding]
        let q = quantity.trimmingCharacters(in: .whitespacesAndNewlines)
        if !q.isEmpty {
            guard q.count <= 10, asciiDigits(Substring(q)), let n = Int64(q), n <= maxQuantity else {
                throw fail("Use a whole number for the quantity")
            }
            form["observedQuantity"] = n
        }
        return form
    }

    /// Price in pesos (up to two decimals) → integer centavos, PHP.
    static func priceCheck(sheet: CallSheet?, productId: String?, price: String, compliant: Bool?) throws -> [String: Any] {
        try requireProduct(sheet, productId)
        let text = price.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...2).contains(parts.count), asciiDigits(parts[0]), parts[0].count <= 9,
              parts.count == 1 || (asciiDigits(parts[1]) && parts[1].count <= 2),
              let whole = Int64(parts[0]) else { throw fail("Enter the shelf price in pesos, e.g. 189.50") }
        let fraction = parts.count == 2 ? Int64(String(parts[1]).padding(toLength: 2, withPad: "0", startingAt: 0))! : 0
        var form: [String: Any] = ["kind": "price_check", "productId": productId!,
                                   "observedPriceMinor": whole * 100 + fraction, "currency": "PHP"]
        if let compliant { form["compliant"] = compliant }
        return form
    }

    private static func isBool(_ value: Any?) -> Bool {
        guard let n = value as? NSNumber else { return false }
        return CFGetTypeID(n) == CFBooleanGetTypeID()
    }
    private static func integer(_ value: Any?) -> Int64? {
        guard let n = value as? NSNumber, !isBool(n), n.doubleValue == Double(n.int64Value) else { return nil }
        return n.int64Value
    }

    /// Re-validate a queued form (inside the store transaction); unknown keys or values are refused.
    static func validate(_ activity: [String: Any], sheet: CallSheet?) throws {
        func keys(_ allowed: Set<String>, _ required: Set<String>) throws {
            let present = Set(activity.keys)
            guard present.isSuperset(of: required), allowed.isSuperset(of: present) else { throw fail("Invalid activity") }
        }
        func text(_ key: String) throws -> String {
            guard let value = activity[key] as? String else { throw fail("Invalid activity") }
            return value
        }
        switch activity["kind"] as? String {
        case "merchandising":
            try keys(["kind", "displayCondition", "actionTaken"], ["kind", "displayCondition"])
            let action = try activity["actionTaken"] == nil ? "" : text("actionTaken")
            if activity["actionTaken"] != nil, action.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                throw fail("Invalid activity")
            }
            _ = try merchandising(displayCondition: try text("displayCondition"), actionTaken: action)
        case "promotion":
            try keys(["kind", "programRef", "finding"], ["kind", "programRef", "finding"])
            _ = try promotion(programRef: try text("programRef"), finding: try text("finding"))
        case "inventory_check":
            try keys(["kind", "productId", "icoFinding", "observedQuantity"], ["kind", "productId", "icoFinding"])
            var quantity = ""
            if activity["observedQuantity"] != nil {
                guard let n = integer(activity["observedQuantity"]), (0...maxQuantity).contains(n) else { throw fail("Invalid activity") }
                quantity = String(n)
            }
            _ = try inventoryCheck(sheet: sheet, productId: try text("productId"), finding: try text("icoFinding"), quantity: quantity)
        case "price_check":
            try keys(["kind", "productId", "observedPriceMinor", "currency", "compliant"],
                     ["kind", "productId", "observedPriceMinor", "currency"])
            guard let minor = integer(activity["observedPriceMinor"]), minor >= 0, try text("currency") == "PHP",
                  activity["compliant"] == nil || isBool(activity["compliant"]) else { throw fail("Invalid activity") }
            try requireProduct(sheet, try text("productId"))
        default:
            throw fail("This activity can't be recorded on this phone")
        }
    }
}
