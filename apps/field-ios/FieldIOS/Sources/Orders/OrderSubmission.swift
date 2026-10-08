import Foundation

/// Order review and submission (SP-0043, IOS-015); mirrors Android AND-015 (`OrderSubmission.kt`).
///
/// A reviewed draft is submitted by queueing the visit's v1 `order_intent` activity with its lines
/// (product, unit, whole quantity — never a price). It rides the same ordered, idempotent outbox as
/// the rest of the call: one immutable request per order (`clientOrderId` = draft ID), the server
/// visit ID filled in only after the check-in ack. The draft and the queued request are written in
/// one store transaction; after that the draft is read-only and shows its outbox state.
enum OrderSubmission {
    static let kind = "order_intent"
    private static let maxUom = 20

    struct Totals: Equatable {
        let products: Int
        let units: [Unit]
        let totalMinor: Int64?
        let unpricedLines: Int
        var amountText: String { totalMinor.map(OrderSubmission.money) ?? "Amount too large to preview" }
        var officeText: String? { unpricedLines > 0 ? "+ \(unpricedLines) \(unpricedLines == 1 ? "line" : "lines") priced by the office" : nil }
        struct Unit: Equatable { let uom: String; let quantity: Int }
        /// "3 products · 24 PC · 12 CS"
        var text: String {
            ([products == 1 ? "1 product" : "\(products) products"] +
             units.map { "\(OrderSubmission.grouped($0.quantity)) \($0.uom)" }).joined(separator: " · ")
        }
    }

    /// What the person sees about an order's journey to the office.
    enum Status: Equatable {
        case draft, queued, sending, held, received, notSent
        case needsReview(code: String)
        var label: String {
            switch self {
            case .draft: "Draft · not sent"
            case .queued: "Waiting to send"
            case .sending: "Sending"
            case .held: "Held for review"
            // Receipt is not a posted sales order; prices are confirmed by the office.
            case .received: "Received by office"
            case .notSent: "Not sent · call ended"
            case .needsReview: "Not accepted · needs review"
            }
        }
        var sent: Bool {
            switch self { case .draft, .notSent: false; default: true }
        }
    }

    /// A rule shown on the review screen. `blocking` problems stop Send; the others are information
    /// the phone cannot decide (credit, prices), which the office checks when it prices the order.
    struct Check: Equatable {
        let label: String
        let problem: String?
        var blocking = true
        var note: String? = nil
        var warning = false
        var ok: Bool { problem == nil }
    }

    static func grouped(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_PH")
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    /// Exact PHP formatting, including large Int64 values; never rounds through Double.
    static func money(_ minor: Int64) -> String {
        let digits = Array(String(minor.magnitude / 100).reversed())
        let grouped = stride(from: 0, to: digits.count, by: 3).map {
            String(digits[$0..<min($0 + 3, digits.count)].reversed())
        }.reversed().joined(separator: ",")
        let cents = minor.magnitude % 100
        return "\(minor < 0 ? "−" : "")₱\(grouped).\(cents < 10 ? "0" : "")\(cents)"
    }

    static func lineAmount(_ line: OrderDraft.Line) -> Int64? {
        guard let price = line.unitPriceMinor, price >= 0, line.quantity >= 0 else { return nil }
        let (amount, overflow) = price.multipliedReportingOverflow(by: Int64(line.quantity))
        return overflow ? nil : amount
    }

    static func unitPrice(_ price: Int64?, uom: String) -> String {
        price.map { "\(money($0)) / \(uom)" } ?? "Priced by the office"
    }

    /// Units summed per UOM, priced amounts in centavos; nil total means arithmetic overflow.
    static func totals(_ draft: OrderDraft) -> Totals {
        var order: [String] = []
        var sums: [String: Int] = [:]
        var total: Int64? = 0
        var unpriced = 0
        for line in draft.lines {
            if sums[line.uom] == nil { order.append(line.uom) }
            sums[line.uom, default: 0] += line.quantity
            if line.unitPriceMinor == nil { unpriced += 1 }
            else if let amount = lineAmount(line), let sum = total {
                let (next, overflow) = sum.addingReportingOverflow(amount)
                total = overflow ? nil : next
            } else { total = nil }
        }
        return Totals(products: draft.lines.count, units: order.map { .init(uom: $0, quantity: sums[$0]!) },
                      totalMinor: total, unpricedLines: unpriced)
    }

    /// The exact v1 activity for `draft`: clientOrderId is the draft ID, so one order is one submission.
    static func activity(_ draft: OrderDraft) -> [String: Any] {
        ["kind": kind, "clientOrderId": draft.draftId,
         "lines": draft.lines.map { ["productId": $0.productId, "uom": $0.uom, "quantity": $0.quantity] as [String: Any] }]
    }

    /// Canonical bytes for comparing two activities (key order independent).
    static func canonical(_ activity: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(activity) else { return nil }
        return try? JSONSerialization.data(withJSONObject: activity, options: [.sortedKeys])
    }

    /// Shape of an outgoing order activity (mirrors the v1 schema bounds).
    static func validateActivity(_ activity: [String: Any]) throws {
        guard Set(activity.keys) == ["kind", "clientOrderId", "lines"], activity["kind"] as? String == kind,
              let id = activity["clientOrderId"] as? String, UUID(uuidString: id)?.uuidString.lowercased() == id,
              let lines = activity["lines"] as? [[String: Any]],
              (1...OrderDraftRules.maxLines).contains(lines.count) else { throw StoreError.invalidInput }
        var products = Set<String>()
        for line in lines {
            guard Set(line.keys) == ["productId", "uom", "quantity"],
                  let product = line["productId"] as? String, !product.trimmingCharacters(in: .whitespaces).isEmpty,
                  let uom = line["uom"] as? String, !uom.isEmpty, uom.count <= maxUom,
                  uom.trimmingCharacters(in: .whitespaces) == uom,
                  let number = line["quantity"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue == Double(number.intValue),
                  (1...OrderDraftRules.maxQuantity).contains(number.intValue),
                  products.insert(product).inserted else { throw StoreError.invalidInput }
        }
    }

    /// The draft's own request: an `order_intent` activity whose clientOrderId is this draft, after
    /// the draft's check-in. Submitting order B must never freeze draft A.
    static func requireIntent(_ intent: VisitIntent, for draft: OrderDraft) throws {
        guard intent.kind == "visit.activity", intent.dependencies == [draft.checkInRequestId],
              let payload = intent.payload, let activity = payload["activity"] as? [String: Any] else {
            throw StoreError.invalidInput
        }
        try validateActivity(activity)
        guard activity["clientOrderId"] as? String == draft.draftId,
              let sent = canonical(activity), sent == canonical(self.activity(draft)) else { throw StoreError.invalidInput }
    }

    /// Review rules the phone can check offline, in display order. The server re-checks the account
    /// setup, products, units and ownership; the phone never claims more than it can know.
    static func checks(_ context: OrderCallContext, draft: OrderDraft, phoneCanRecord: Bool, held: Bool,
                       summary: AccountSummary?, otherOrders: [OrderDraft] = []) -> [Check] {
        var unsent = draft
        unsent.submittedRequestId = nil; unsent.submittedAt = nil
        var ruleProblem: String?
        do { try OrderDraftRules.validate(context, draft: unsent, existing: nil) }
        catch let failure as OrderDraftFailure { ruleProblem = failure.message }
        catch { ruleProblem = "This order no longer matches its call." }
        let callProblem = [OrderDraftFailure.callEnded.message, OrderDraftFailure.callNotOpen.message]
            .contains(ruleProblem ?? "") ? ruleProblem : nil
        let catalogProblem: String? = [OrderDraftFailure.noCatalog.message, OrderDraftFailure.catalogChanged.message,
                                      OrderDraftFailure.pricesChanged.message].contains(ruleProblem ?? "") ? ruleProblem : nil
        let quantityProblem: String? = if draft.lines.isEmpty { OrderDraftFailure.empty.message }
            else if draft.lines.count > OrderDraftRules.maxLines ||
                    draft.lines.contains(where: { !(1...OrderDraftRules.maxQuantity).contains($0.quantity) }) {
                OrderDraftFailure.invalidQuantity.message
            } else { nil }
        let phoneProblem: String? = held ? OrderDraftFailure.held.message
            : phoneCanRecord ? nil : OrderDraftFailure.offlineExpired.message
        var list = [
            Check(label: "Call is open", problem: callProblem),
            Check(label: "Products are set up for this account", problem: catalogProblem),
            Check(label: "Whole quantities in each product's unit", problem: quantityProblem),
            Check(label: "Phone can still record today's work", problem: phoneProblem),
            Check(label: "Not sent yet", problem: draft.submittedRequestId != nil ? OrderDraftFailure.submitted.message : nil),
        ]
        // Any other rule failure (changed association, etc.) still blocks submission visibly.
        if let ruleProblem, !list.contains(where: { $0.problem == ruleProblem }) {
            list.append(Check(label: "Order matches its call", problem: ruleProblem))
        }
        list.append(Check(label: "Prices", problem: nil, blocking: false,
                          note: draft.priceList == nil ? "Prices: set by the office" : "The office confirms these prices when the order arrives."))
        list.append(creditCheck(draft, summary: summary, otherOrders: otherOrders))
        return list
    }

    /// Advisory only: cached office open orders plus OTHER submitted orders on this phone/day/outlet.
    static func creditCheck(_ draft: OrderDraft, summary: AccountSummary?, otherOrders: [OrderDraft] = []) -> Check {
        func unknown() -> Check {
            Check(label: "Credit", problem: nil, blocking: false,
                  note: "Credit is checked by the office when the order arrives.")
        }
        guard let summary, summary.outletId == draft.outletId, summary.availability.rawValue == "available" else { return unknown() }
        guard let limit = summary.creditLimitMinor else {
            return Check(label: "Credit", problem: nil, blocking: false, note: "No credit limit set for this store")
        }
        let own = totals(draft)
        guard let amount = own.totalMinor else { return unknown() }
        // An office-priced line has no known amount: the known part can prove "over", never "within".
        var incomplete = own.unpricedLines > 0
        var open = summary.openOrders?.amountMinor ?? 0
        var seen = Set<String>()
        for other in otherOrders where other.draftId != draft.draftId && other.outletId == draft.outletId &&
            other.serviceDate == draft.serviceDate && other.submittedRequestId != nil && seen.insert(other.draftId).inserted {
            let otherTotals = totals(other)
            guard let total = otherTotals.totalMinor else { return unknown() }
            if otherTotals.unpricedLines > 0 { incomplete = true }
            let (next, overflow) = open.addingReportingOverflow(total)
            guard !overflow else { return unknown() }
            open = next
        }
        let (headroom, overflow) = limit.subtractingReportingOverflow(open)
        let (left, leftOverflow) = headroom.subtractingReportingOverflow(amount)
        guard !overflow, !leftOverflow, left != Int64.min else { return unknown() }
        if left < 0 {
            return Check(label: "Credit", problem: nil, blocking: false,
                         note: "Over the store's credit limit by \(incomplete ? "at least " : "")\(money(-left)). You can still send it; the office must approve.", warning: true)
        }
        if incomplete {
            return Check(label: "Credit", problem: nil, blocking: false,
                         note: "Some lines are priced by the office, so the office checks credit when the order arrives.")
        }
        return Check(label: "Within the store's credit limit", problem: nil, blocking: false,
                     note: "\(money(left)) left after this order")
    }

    /// The draft's outbox state → what the person sees. `requestState` is the stored state of
    /// the submitted request: "pending", "deferred", "done" or "rejected:<code>".
    static func status(_ draft: OrderDraft, callOpen: Bool, requestState: String?, held: Bool, syncing: Bool) -> Status {
        guard draft.submittedRequestId != nil else { return callOpen ? .draft : .notSent }
        switch requestState {
        case "done": return .received
        case let state? where state.hasPrefix("rejected:"): return .needsReview(code: String(state.dropFirst("rejected:".count)))
        default: return held ? .held : syncing && requestState == "pending" ? .sending : .queued
        }
    }

    /// Plain-words reason for a refused order.
    static func reviewReason(_ code: String) -> String {
        switch code {
        case "invalid_request": "The office's product setup or units no longer allow this order."
        case "conflict": "This order was already received."
        case "dependency_missing": "The call start was not accepted, so the order was not sent."
        case "out_of_scope": "This account is no longer in your assignment."
        case "invalid_transition": "The visit changed on the server."
        default: "Ask your supervisor."
        }
    }
}
