import Foundation

/// Offline field order capture (SP-0044, IOS-014); mirrors Android AND-014.
///
/// Authorized catalog: the account's server-owned Annex C product setup that arrived in the scoped
/// bootstrap (call-sheet lines). The nationwide product master is never offered on the phone
/// (`productCatalog` stays empty in contract v1).
///
/// Price rules: v1 bootstrap sends `priceAvailability: "unavailable"` (no governed price list yet,
/// ADR-008), so a draft carries whole quantities in the setup UOM only — never a price, amount or
/// total. The account's free-text pricing note is shown as a reference, never computed.
///
/// Drafts are local (SQLCipher `order_drafts`) until reviewed and sent: IOS-015 (`OrderSubmission`)
/// queues the draft's own `order_intent` and freezes the draft in the same transaction.
enum OrderCatalog {
    struct Item: Equatable, Sendable {
        let productId: String; let code: String; let name: String; let uom: String
        let barcode: String?; let priceNote: String?
    }

    static func items(_ sheet: CallSheet?) -> [Item] {
        (sheet?.lines ?? []).map {
            Item(productId: $0.productId, code: $0.code, name: $0.name, uom: $0.uom, barcode: $0.barcode, priceNote: $0.pricing)
        }
    }

    /// Lowercase, accents removed, every run of non-alphanumerics collapsed to one space.
    static func normalize(_ value: String) -> String {
        let folded = value.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX")).lowercased()
        let mapped = folded.unicodeScalars.map { scalar -> Character in
            (("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)) ? Character(scalar) : " "
        }
        return String(mapped).split(separator: " ").joined(separator: " ")
    }

    /// Every word must appear in code, name or barcode; exact code/barcode first, then prefixes, then setup order.
    static func search(_ items: [Item], _ query: String) -> [Item] {
        let words = normalize(query).split(separator: " ").map(String.init)
        guard !words.isEmpty else { return items }
        let phrase = words.joined(separator: " ")
        return items.enumerated().compactMap { index, item -> (Item, Int, Int)? in
            let codes = [item.code, item.barcode].compactMap { $0 }.map(normalize)
            let name = normalize(item.name)
            let joined = (codes + [name]).joined(separator: " ")
            guard words.allSatisfy(joined.contains) else { return nil }
            let score = codes.contains(phrase) ? 0 : (codes.contains { $0.hasPrefix(phrase) } || name.hasPrefix(phrase)) ? 1 : 2
            return (item, score, index)
        }.sorted { $0.1 == $1.1 ? $0.2 < $1.2 : $0.1 < $1.1 }.map(\.0)
    }
}

struct OrderDraft: Codable, Equatable, Sendable {
    struct Line: Codable, Equatable, Sendable {
        let productId: String; let code: String; let name: String; let uom: String; let quantity: Int
    }
    let draftId: String
    let clientVisitId: String
    let checkInRequestId: String
    let plannedVisitId: String?
    let outletId: String
    let serviceDate: String
    let customerId: String?
    let customerCode: String?
    let territoryId: String?
    let territoryCode: String?
    let routeId: String?
    let catalogRevision: Int
    let lines: [Line]
    let createdAt: Int64
    let updatedAt: Int64
    var priceAvailability: String = OrderDraftRules.priceUnavailable
    /// IOS-015: the queued order request once submitted; the draft is read-only after that.
    var submittedRequestId: String? = nil
    var submittedAt: Int64? = nil
}

enum OrderDraftFailure: Error, Equatable {
    case callNotOpen, callEnded, noCatalog, catalogChanged, empty, invalidQuantity, held, submitted, offlineExpired, unknownDraft
    var message: String {
        switch self {
        case .callNotOpen: "Start the call before taking an order."
        case .callEnded: "This call has ended. The saved draft can no longer be changed."
        case .noCatalog: "No products set up for this account yet. Ask your office."
        case .catalogChanged: "The office changed this account's products. Check the lines and save again."
        case .empty: "Add at least one product."
        case .invalidQuantity: "Use whole numbers from 1 to 99,999."
        case .held: "This phone's work is held for review. Sync and ask your administrator."
        case .submitted: "This order was sent. It can no longer be changed."
        case .offlineExpired: "Today's offline access has ended. Sync to continue."
        case .unknownDraft: "This draft is no longer on the phone."
        }
    }
}

/// Everything a draft is checked against, read from one verified partition.
struct OrderCallContext {
    let intents: [VisitIntent]
    let rejected: Set<UUID>
    let callSheets: [CallSheet]
    let outlets: [StoreSnapshot.Outlet]
    let customers: [StoreSnapshot.Customer]

    @MainActor static func read(store: any FieldLocalStore, partition: StorePartition) throws -> OrderCallContext {
        let snapshot = try store.snapshot(for: partition)
        return OrderCallContext(intents: try store.intents(for: partition),
                                rejected: Set(try store.reviewOutbox(for: partition).map { $0.intent.requestId }),
                                callSheets: snapshot?.callSheets ?? [], outlets: snapshot?.outlets ?? [],
                                customers: snapshot?.customers ?? [])
    }
}

enum OrderDraftRules {
    static let priceUnavailable = "unavailable"
    static let maxLines = 100
    static let maxQuantity = 99_999

    /// Blank means "not ordered"; anything else must be a whole number 1...99,999 in the setup UOM.
    static func quantity(_ text: String) throws -> Int? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return nil }
        guard t.count <= 5, t.utf8.allSatisfy({ (48...57).contains($0) }), let value = Int(t),
              (1...maxQuantity).contains(value) else { throw OrderDraftFailure.invalidQuantity }
        return value
    }

    /// The open call this order belongs to: a non-rejected check-in with no End call yet.
    static func openCheckIn(_ context: OrderCallContext, clientVisitId: String, checkInRequestId: String) throws -> [String: Any] {
        guard let id = UUID(uuidString: checkInRequestId),
              let checkIn = context.intents.first(where: { $0.requestId == id }), checkIn.kind == "visit.checkIn",
              !context.rejected.contains(id), let payload = checkIn.payload,
              payload["clientVisitId"] as? String == clientVisitId else { throw OrderDraftFailure.callNotOpen }
        let key = id.uuidString.lowercased()
        if context.intents.contains(where: { $0.kind == "visit.checkOut" && $0.dependencies.contains(key) }) {
            throw OrderDraftFailure.callEnded
        }
        return payload
    }

    private static func text(_ value: Any?) -> String? {
        guard let string = value as? String, !string.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return string
    }

    /// A new draft (or the next version of `existing`) for the open call, associated from the stored
    /// check-in and cached snapshot — never from user input. `quantities` = productId → whole number.
    static func build(_ context: OrderCallContext, existing: OrderDraft?, checkIn: VisitIntent,
                      quantities: [(productId: String, quantity: Int)], now: Date, newId: () -> UUID = UUID.init) throws -> OrderDraft {
        let clientVisitId = checkIn.payload?["clientVisitId"] as? String ?? ""
        let checkInId = checkIn.requestId.uuidString.lowercased()
        let payload = try openCheckIn(context, clientVisitId: clientVisitId, checkInRequestId: checkInId)
        guard let outletId = payload["outletId"] as? String, let serviceDate = payload["serviceDate"] as? String else {
            throw OrderDraftFailure.callNotOpen
        }
        guard let sheet = context.callSheets.first(where: { $0.outletId == outletId }) else { throw OrderDraftFailure.noCatalog }
        let catalog = Dictionary(OrderCatalog.items(sheet).map { ($0.productId, $0) }, uniquingKeysWith: { a, _ in a })
        let lines = try quantities.map { entry -> OrderDraft.Line in
            guard let item = catalog[entry.productId] else { throw OrderDraftFailure.catalogChanged }
            return .init(productId: item.productId, code: item.code, name: item.name, uom: item.uom, quantity: entry.quantity)
        }
        let outlet = context.outlets.first { $0.id == outletId }
        let customerCode = outlet?.customerId.flatMap { id in context.customers.first { $0.id == id }?.code }
        if let existing, existing.checkInRequestId != checkInId || existing.clientVisitId != clientVisitId {
            throw OrderDraftFailure.unknownDraft
        }
        let stamp = Int64(now.timeIntervalSince1970 * 1000)
        let draft = OrderDraft(draftId: existing?.draftId ?? newId().uuidString.lowercased(), clientVisitId: clientVisitId,
            checkInRequestId: checkInId, plannedVisitId: text(payload["plannedVisitId"]), outletId: outletId,
            serviceDate: serviceDate, customerId: outlet?.customerId, customerCode: customerCode,
            territoryId: outlet?.territoryId, territoryCode: outlet?.territoryCode, routeId: outlet?.routeId,
            catalogRevision: sheet.revision, lines: lines, createdAt: existing?.createdAt ?? stamp,
            updatedAt: max(stamp, existing?.updatedAt ?? stamp))
        try validate(context, draft: draft, existing: existing)
        return draft
    }

    /// Re-checked inside the store transaction: a stale screen or forged draft never persists.
    static func validate(_ context: OrderCallContext, draft: OrderDraft, existing: OrderDraft?) throws {
        guard let id = UUID(uuidString: draft.draftId), id.uuidString.lowercased() == draft.draftId else { throw StoreError.invalidInput }
        // A sent order is frozen; saves never set or clear the submission marker themselves.
        if existing?.submittedRequestId != nil { throw OrderDraftFailure.submitted }
        guard draft.submittedRequestId == nil, draft.submittedAt == nil,
              draft.priceAvailability == priceUnavailable else { throw StoreError.invalidInput }
        if draft.lines.isEmpty { throw OrderDraftFailure.empty }
        if draft.lines.count > maxLines || draft.lines.contains(where: { !(1...maxQuantity).contains($0.quantity) }) {
            throw OrderDraftFailure.invalidQuantity
        }
        guard Set(draft.lines.map(\.productId)).count == draft.lines.count else { throw StoreError.invalidInput }
        let payload = try openCheckIn(context, clientVisitId: draft.clientVisitId, checkInRequestId: draft.checkInRequestId)
        guard payload["outletId"] as? String == draft.outletId, payload["serviceDate"] as? String == draft.serviceDate,
              text(payload["plannedVisitId"]) == draft.plannedVisitId else { throw StoreError.invalidInput }
        guard let sheet = context.callSheets.first(where: { $0.outletId == draft.outletId }) else { throw OrderDraftFailure.noCatalog }
        if sheet.revision != draft.catalogRevision || !staleLines(draft, sheet: sheet).isEmpty { throw OrderDraftFailure.catalogChanged }
        let outlet = context.outlets.first { $0.id == draft.outletId }
        let customerCode = outlet?.customerId.flatMap { id in context.customers.first { $0.id == id }?.code }
        guard outlet?.customerId == draft.customerId, customerCode == draft.customerCode,
              outlet?.territoryId == draft.territoryId, outlet?.territoryCode == draft.territoryCode,
              outlet?.routeId == draft.routeId else { throw StoreError.invalidInput }
        if let existing {
            guard existing.draftId == draft.draftId, existing.clientVisitId == draft.clientVisitId,
                  existing.checkInRequestId == draft.checkInRequestId, existing.outletId == draft.outletId,
                  existing.createdAt == draft.createdAt, draft.updatedAt >= existing.updatedAt else { throw StoreError.invalidInput }
        }
    }

    /// Lines whose product left the account setup or changed code/name/UOM since the draft was saved.
    static func staleLines(_ draft: OrderDraft, sheet: CallSheet?) -> [OrderDraft.Line] {
        let catalog = Dictionary(OrderCatalog.items(sheet).map { ($0.productId, $0) }, uniquingKeysWith: { a, _ in a })
        return draft.lines.filter { line in
            guard let item = catalog[line.productId] else { return true }
            return item.code != line.code || item.name != line.name || item.uom != line.uom
        }
    }
}
