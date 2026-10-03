import Foundation

/// Typed construction boundary for the narrow DEV visit workflow. The JSON is frozen at enqueue;
/// dependent local templates are materialized only once the server's visit ID is known.
extension VisitIntent {
    var object: [String: Any]? { try? JSONSerialization.jsonObject(with: operationJSON) as? [String: Any] }
    var payload: [String: Any]? { object?["payload"] as? [String: Any] }
    var dependencies: [String] { object?["dependsOn"] as? [String] ?? [] }
    var deviceTime: Date? {
        (payload?["deviceTime"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
    }
    func matches(_ visit: AppModel.TodayVisit) -> Bool {
        guard kind == "visit.checkIn", let payload, payload["serviceDate"] as? String == visit.serviceDate else { return false }
        return payload["plannedVisitId"] as? String == visit.id ||
            (!visit.planned && payload["plannedVisitId"] is NSNull && payload["outletId"] as? String == visit.outletId)
    }
}

enum DiagnosticOperation {
    enum Failure: Error { case invalidReason, invalidNote, invalidOutcome }
    private static func make(_ kind: String, payload: [String: Any], dependency: UUID? = nil) throws -> VisitIntent {
        let id = UUID()
        var object: [String: Any] = ["kind": kind, "clientRequestId": id.uuidString.lowercased(), "payload": payload]
        if let dependency { object["dependsOn"] = [dependency.uuidString.lowercased()] }
        return VisitIntent(requestId: id, kind: kind,
            operationJSON: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
    }
    static func checkIn(plannedId: String?, outletId: String, day: String, intents: [String],
                        reason: String?, location: VisitLocation?, now: Date = Date()) throws -> VisitIntent {
        if plannedId == nil && (reason?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false || (reason?.count ?? 0) > 500) {
            throw Failure.invalidReason
        }
        let fix: Any = try location.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) } ?? NSNull()
        var payload: [String: Any] = ["clientVisitId": UUID().uuidString.lowercased(),
            "plannedVisitId": (plannedId as Any?) ?? NSNull(), "outletId": outletId,
            "serviceDate": day, "deviceTime": Int64(now.timeIntervalSince1970 * 1000),
            "location": fix, "intents": intents]
        if plannedId == nil { payload["unplannedReason"] = reason! }
        return try make("visit.checkIn", payload: payload)
    }
    static func note(_ text: String, checkIn: UUID, visitId: String?, now: Date = Date()) throws -> VisitIntent {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 2000 else { throw Failure.invalidNote }
        var payload: [String: Any] = ["activity": ["kind": "note", "text": text],
            "deviceTime": Int64(now.timeIntervalSince1970 * 1000)]
        if let visitId { payload["visitId"] = visitId }
        return try make("visit.activity", payload: payload, dependency: checkIn)
    }
    static func checkOut(outcome: String, reason: String?, checkIn: UUID, visitId: String?, location: VisitLocation? = nil, now: Date = Date()) throws -> VisitIntent {
        guard ["completed", "nonproductive"].contains(outcome),
              outcome != "nonproductive" || reason?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else { throw Failure.invalidOutcome }
        let fix: Any = try location.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) } ?? NSNull()
        var payload: [String: Any] = ["outcome": outcome,
            "reasonCode": (reason as Any?) ?? NSNull(), "location": fix,
            "deviceTime": Int64(now.timeIntervalSince1970 * 1000)]
        if let visitId { payload["visitId"] = visitId }
        return try make("visit.checkOut", payload: payload, dependency: checkIn)
    }
}
