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
            // The office has the order; it is not yet a priced, posted sales order (no price list yet).
            case .received: "Received by office · not yet posted"
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
        var ok: Bool { problem == nil }
    }

    static func grouped(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_PH")
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    /// Units summed per UOM in line order; amounts are never computed (no governed price list).
    static func totals(_ draft: OrderDraft) -> Totals {
        var order: [String] = []
        var sums: [String: Int] = [:]
        for line in draft.lines {
            if sums[line.uom] == nil { order.append(line.uom) }
            sums[line.uom, default: 0] += line.quantity
        }
        return Totals(products: draft.lines.count, units: order.map { .init(uom: $0, quantity: sums[$0]!) })
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
                       summary: AccountSummary?) -> [Check] {
        var unsent = draft
        unsent.submittedRequestId = nil; unsent.submittedAt = nil
        var ruleProblem: String?
        do { try OrderDraftRules.validate(context, draft: unsent, existing: nil) }
        catch let failure as OrderDraftFailure { ruleProblem = failure.message }
        catch { ruleProblem = "This order no longer matches its call." }
        let sheet = context.callSheets.first { $0.outletId == draft.outletId }
        let callProblem = [OrderDraftFailure.callEnded.message, OrderDraftFailure.callNotOpen.message]
            .contains(ruleProblem ?? "") ? ruleProblem : nil
        let catalogProblem: String? = if sheet == nil { OrderDraftFailure.noCatalog.message }
            else if sheet?.revision != draft.catalogRevision || !OrderDraftRules.staleLines(draft, sheet: sheet).isEmpty {
                OrderDraftFailure.catalogChanged.message
            } else { nil }
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
                          note: "No price list on the phone yet. The office prices this order."))
        list.append(Check(label: "Credit", problem: nil, blocking: false, note: creditNote(summary)))
        return list
    }

    /// Credit is information only: without prices the phone cannot value the order against the limit.
    static func creditNote(_ summary: AccountSummary?) -> String {
        guard let summary, summary.isAvailable else {
            return "No credit figures on this phone for this account. The office checks credit."
        }
        let limit = summary.creditLimitMinor.map { "Credit limit \(AccountSummary.peso($0))" } ?? "No credit limit set"
        let open = summary.openOrders.map { open in
            open.count == 0 ? "no open orders" : "open orders \(AccountSummary.peso(open.amountMinor))"
        } ?? "open orders unknown"
        return "\(limit) · \(open) as of \(summary.asOfDate). The office checks this order against credit when it prices it."
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
