import Foundation

/// IOS-013 bootstrap `activityRules[]` entry: the activity forms one visit intent requires or offers.
/// Rule data from the backend (`visits/activity_rules`), never a code literal. Unknown intents and
/// kinds stay raw and never satisfy anything.
struct ActivityRule: Codable, Equatable, Sendable {
    struct Activity: Codable, Equatable, Sendable {
        let kind: String
        let required: Bool
        init(kind: String, required: Bool) { self.kind = kind; self.required = required }
        init(from decoder: Decoder) throws {
            try ActivityRule.requireExactKeys(decoder, ["kind", "required"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = try c.decode(String.self, forKey: .kind)
            required = try c.decode(Bool.self, forKey: .required)
            guard !kind.isEmpty, kind.count <= 40 else { throw BootstrapV1.WireError.unsafeValue }
        }
    }
    let intent: String
    let version: String
    let activities: [Activity]

    init(intent: String, version: String, activities: [Activity]) {
        self.intent = intent; self.version = version; self.activities = activities
    }
    init(from decoder: Decoder) throws {
        try Self.requireExactKeys(decoder, ["intent", "version", "activities"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        intent = try c.decode(String.self, forKey: .intent)
        version = try c.decode(String.self, forKey: .version)
        activities = try c.decode([Activity].self, forKey: .activities)
        guard !intent.isEmpty, intent.count <= 40, !version.isEmpty, version.count <= 200,
              activities.count <= 16, Set(activities.map(\.kind)).count == activities.count else {
            throw BootstrapV1.WireError.unsafeValue
        }
    }

    private struct AnyKey: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }
    fileprivate static func requireExactKeys(_ decoder: Decoder, _ keys: Set<String>) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard Set(c.allKeys.map(\.stringValue)) == keys else { throw BootstrapV1.WireError.invalidEnvelope }
    }
}

/// Turns the downloaded rules and a visit's intents into the activity forms the person must fill.
/// Shared by the model and the encrypted store so a "completed" End cannot go around them.
/// A required form this phone cannot capture (unknown kind, or a product form with no account
/// products) shows as unavailable and does not block End; the server records it as missing.
enum ActivityRules {
    /// v1 `visit.checkIn` intents, in display order.
    static let intents = ["sell", "collect", "merchandise", "audit", "deliver", "promotion", "complaint", "follow-up"]
    /// Forms this app can capture. `order_intent` stays off until order capture is enabled.
    static let forms: Set<String> = ["call_sheet", "merchandising", "inventory_check", "price_check", "promotion", "note"]
    /// Structured forms built by `ActivityForms` (note and call sheet have their own builders).
    static let structuredForms: Set<String> = ["merchandising", "inventory_check", "price_check", "promotion"]
    private static let productForms: Set<String> = ["call_sheet", "inventory_check", "price_check"]

    struct Requirement: Equatable, Sendable {
        enum Status: Equatable, Sendable { case done, toDo, unavailable }
        let kind: String
        let required: Bool
        let status: Status
    }

    static func intentLabel(_ intent: String) -> String {
        switch intent {
        case "sell": "Sell"
        case "collect": "Collect"
        case "merchandise": "Merchandise"
        case "audit": "Store audit"
        case "deliver": "Deliver"
        case "promotion": "Promotion"
        case "complaint": "Complaint"
        case "follow-up": "Follow-up"
        default: intent
        }
    }
    static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "call_sheet": "Call sheet"
        case "merchandising": "Merchandising"
        case "inventory_check": "Inventory check"
        case "price_check": "Price check"
        case "promotion": "Promotion check"
        case "note": "Note"
        case "order_intent": "Order"
        default: "Other activity"
        }
    }

    /// Product forms need the account's call-sheet products (the phone has no nationwide catalog).
    static func capturable(_ kind: String, sheet: CallSheet?) -> Bool {
        forms.contains(kind) && (!productForms.contains(kind) || (sheet.map { !$0.lines.isEmpty } ?? false))
    }

    /// Union over the visit's intents in rule order; a kind is required if any intent requires it.
    static func checklist(rules: [ActivityRule], intents: [String], recorded: Set<String>,
                          capturable: (String) -> Bool) -> [Requirement] {
        var order: [String] = []
        var required: [String: Bool] = [:]
        for rule in rules where intents.contains(rule.intent) {
            for activity in rule.activities {
                if required[activity.kind] == nil { order.append(activity.kind) }
                required[activity.kind] = (required[activity.kind] ?? false) || activity.required
            }
        }
        return order.map { kind in
            let status: Requirement.Status = recorded.contains(kind) ? .done : capturable(kind) ? .toDo : .unavailable
            return Requirement(kind: kind, required: required[kind] ?? false, status: status)
        }
    }
    static func missing(_ checklist: [Requirement]) -> [String] {
        checklist.filter { $0.required && $0.status == .toDo }.map(\.kind)
    }

    /// The visit's intents as recorded in its own check-in (signed MCP intents or chosen purposes).
    static func intents(of checkIn: VisitIntent) -> [String] {
        checkIn.payload?["intents"] as? [String] ?? []
    }
    /// Activity kinds queued or accepted for the call that `checkIn` opened; rejected rows never count.
    static func recordedKinds(checkIn: VisitIntent, intents: [VisitIntent], rejected: Set<UUID>) -> Set<String> {
        let id = checkIn.requestId.uuidString.lowercased()
        return Set(intents.filter { $0.kind == "visit.activity" && $0.dependencies.contains(id) && !rejected.contains($0.requestId) }
            .compactMap { ($0.payload?["activity"] as? [String: Any])?["kind"] as? String })
    }
    /// Required forms still missing for a "completed" End of the call `checkIn` opened.
    static func missingForEnd(checkIn: VisitIntent, rules: [ActivityRule], intents: [VisitIntent],
                              rejected: Set<UUID>, sheet: CallSheet?) -> [String] {
        missing(checklist(rules: rules, intents: Self.intents(of: checkIn),
                          recorded: recordedKinds(checkIn: checkIn, intents: intents, rejected: rejected)) {
            capturable($0, sheet: sheet)
        })
    }
}
