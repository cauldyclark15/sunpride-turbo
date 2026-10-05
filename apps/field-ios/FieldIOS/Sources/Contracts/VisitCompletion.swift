import Foundation

/// IOS-017: what the salesperson confirms before End, and the call's final result once its End is
/// queued. Built from the same rules the model and the encrypted store enforce, so the review can
/// never promise an End the store would refuse.
///
/// - `recorded`: activity kinds queued or accepted for this call, in the order they were recorded.
/// - `officeReview`: required forms this phone could not capture; the server records them as missing
///   (it never refuses a queued End).
/// - `productive`: the governed productive-call result (`ProductiveCall`, rule
///   productive-call/2026-10-02) for a route-plan call; nil for an unplanned visit, which is not a call.
struct EndReview: Equatable {
    let outcome: String
    let reasonCode: String?
    let recorded: [String]
    let officeReview: [String]
    let minutes: Int
    let productive: Bool?
}

/// The immutable result of a queued End, read back from the encrypted outbox.
struct VisitResult: Equatable {
    let outcome: String
    let reasonCode: String?
    let recorded: [String]
    let officeReview: [String]
    let minutes: Int
    let productive: Bool?
    let location: String
    let locationReview: Bool
    let sync: String
}

enum VisitCompletion {
    /// End reason a truck seller (rule `truck_seller`) records when the store needs no stock; it
    /// makes their merchandising count as the productive call (client answer, 2 Oct 2026).
    static let noSalesDueToInventory = ProductiveCall.noSalesDueToInventory
    /// Server `boundedText` limit for an End reason.
    static let maxReasonLength = 200
    /// Phone mirror of `VISIT_LOCATION_POLICY` flags (field-day-2026-10-v3). They only label the
    /// evidence for the person; the server makes the binding assessment and never refuses an End.
    static let maxAccuracyMeters = 50.0
    static let maxFixAgeMs: Int64 = 60_000

    static func outcomeLabel(_ outcome: String) -> String {
        switch outcome {
        case "completed": "Completed"
        case "nonproductive": "Not productive"
        default: "Unknown"
        }
    }
    static func reasonLabel(_ reason: String) -> String {
        reason == noSalesDueToInventory ? "No sales · store has enough stock" : reason
    }

    /// A valid End reason for the wire: trimmed, non-empty, within the server bound; nil otherwise.
    static func cleanReason(_ reason: String?) -> String? {
        guard let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty,
              trimmed.count <= maxReasonLength else { return nil }
        return trimmed
    }

    private static func id(_ intent: VisitIntent) -> String { intent.requestId.uuidString.lowercased() }

    /// The call's queued or accepted End. A server-rejected End no longer closes the call, so the
    /// person can still finish it (otherwise the open call would block the rest of the day).
    static func end(of checkIn: VisitIntent, intents: [VisitIntent], rejected: Set<UUID>) -> VisitIntent? {
        intents.last { $0.kind == "visit.checkOut" && !rejected.contains($0.requestId) && $0.dependencies.contains(id(checkIn)) }
    }

    /// Store guard: once a call's End is queued, the visit is final on this phone. Nothing may be
    /// added to it — the server would refuse it as an invalid transition — and it cannot end twice.
    static func isOpen(_ checkIn: VisitIntent, intents: [VisitIntent], rejected: Set<UUID>) -> Bool {
        end(of: checkIn, intents: intents, rejected: rejected) == nil
    }

    static func recordedInOrder(checkIn: VisitIntent, intents: [VisitIntent], rejected: Set<UUID>) -> [String] {
        var seen = Set<String>()
        return intents.filter { $0.kind == "visit.activity" && $0.dependencies.contains(id(checkIn)) && !rejected.contains($0.requestId) }
            .compactMap { ($0.payload?["activity"] as? [String: Any])?["kind"] as? String }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    private static func minutes(from start: Date?, to end: Date) -> Int {
        guard let start else { return 0 }
        return max(0, Int(end.timeIntervalSince(start) / 60))
    }

    /// What End will record, for the confirmation step. Throws the same failures End would.
    static func review(checkIn: VisitIntent, outcome: String?, reason: String?, rules: [ActivityRule],
                       intents: [VisitIntent], rejected: Set<UUID>, sheet: CallSheet?,
                       productiveRule: String?, now: Date) throws -> EndReview {
        guard isOpen(checkIn, intents: intents, rejected: rejected) else { throw AppModel.CallFailure.alreadyClosed }
        guard let outcome, ["completed", "nonproductive"].contains(outcome) else { throw AppModel.CallFailure.outcomeRequired }
        let reasonCode = cleanReason(reason)
        if reason?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false && reasonCode == nil {
            throw AppModel.CallFailure.reasonRequired // too long for the server
        }
        if outcome == "nonproductive" && reasonCode == nil { throw AppModel.CallFailure.reasonRequired }
        let checklist = ActivityRules.checklist(rules: rules, intents: ActivityRules.intents(of: checkIn),
            recorded: ActivityRules.recordedKinds(checkIn: checkIn, intents: intents, rejected: rejected)) {
            ActivityRules.capturable($0, sheet: sheet)
        }
        if outcome == "completed" && !ActivityRules.missing(checklist).isEmpty { throw AppModel.CallFailure.activitiesRequired }
        let recorded = recordedInOrder(checkIn: checkIn, intents: intents, rejected: rejected)
        return EndReview(outcome: outcome, reasonCode: reasonCode, recorded: recorded,
            officeReview: outcome == "completed" ? checklist.filter { $0.required && $0.status == .unavailable }.map(\.kind) : [],
            minutes: minutes(from: checkIn.deviceTime, to: now),
            productive: productive(checkIn: checkIn, recorded: recorded, reasonCode: reasonCode, rule: productiveRule))
    }

    /// The queued (or accepted) End of this call as the person's final record; nil while open.
    /// `queued` holds request IDs still in the outbox (pending, deferred or held).
    static func result(checkIn: VisitIntent, rules: [ActivityRule], intents: [VisitIntent], rejected: Set<UUID>,
                       queued: Set<UUID>, held: Bool, sheet: CallSheet?, productiveRule: String?) -> VisitResult? {
        guard let end = end(of: checkIn, intents: intents, rejected: rejected), let payload = end.payload,
              let outcome = payload["outcome"] as? String else { return nil }
        let reasonCode = cleanReason(payload["reasonCode"] as? String)
        let endedAt = end.deviceTime ?? checkIn.deviceTime ?? Date(timeIntervalSince1970: 0)
        let recorded = recordedInOrder(checkIn: checkIn, intents: intents, rejected: rejected)
        let officeReview = outcome != "completed" ? [] : ActivityRules.checklist(rules: rules,
            intents: ActivityRules.intents(of: checkIn),
            recorded: ActivityRules.recordedKinds(checkIn: checkIn, intents: intents, rejected: rejected)) {
            ActivityRules.capturable($0, sheet: sheet)
        }.filter { $0.required && $0.status != .done }.map(\.kind)
        let (location, review) = locationNotice(payload["location"] as? [String: Any],
                                                deviceTime: (payload["deviceTime"] as? NSNumber)?.int64Value ?? 0)
        let sync = !queued.contains(end.requestId) ? "Accepted" : held ? "Held for review" : "Waiting to send"
        return VisitResult(outcome: outcome, reasonCode: reasonCode, recorded: recorded, officeReview: officeReview,
                           minutes: minutes(from: checkIn.deviceTime, to: endedAt),
                           productive: productive(checkIn: checkIn, recorded: recorded, reasonCode: reasonCode, rule: productiveRule),
                           location: location, locationReview: review, sync: sync)
    }

    /// Only a route-plan call counts; an unplanned visit is not a call (client answer, 2 Oct 2026).
    private static func productive(checkIn: VisitIntent, recorded: [String], reasonCode: String?, rule: String?) -> Bool? {
        guard checkIn.payload?["plannedVisitId"] is String else { return nil }
        return ProductiveCall.isProductive(rule: rule, activityKinds: recorded, reasonCode: reasonCode)
    }

    /// The End fix as recorded, assessed as of the End instant (the same view the person saw then).
    static func locationNotice(_ fix: [String: Any]?, deviceTime: Int64) -> (text: String, review: Bool) {
        guard let fix, let accuracy = (fix["accuracyMeters"] as? NSNumber)?.doubleValue,
              let fixTime = (fix["fixTime"] as? NSNumber)?.int64Value else {
            return ("End location unavailable · supervisor will review", true)
        }
        if accuracy > maxAccuracyMeters || abs(deviceTime - fixTime) > maxFixAgeMs || fix["mockSignal"] as? Bool == true {
            return ("End location weak signal · supervisor will review", true)
        }
        return ("End location recorded · ±\(Int(accuracy.rounded())) m", false)
    }
}
