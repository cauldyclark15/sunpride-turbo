import CoreLocation
import Foundation

/// SP-0138 live map (iOS field app). Mirrors the server's `LOCATION_POLICY`
/// (`packages/backend/convex/location/model.ts`). Sharing runs ONLY during the work day: from the day's
/// first call Start (or "Start day") until "End day", sign-out or the 10 PM Manila daily close; never otherwise.
enum LiveLocationPolicy {
    /// While moving: about one ping a minute, or sooner after 50 m.
    static let movingInterval: TimeInterval = 60
    static let movingDistanceMeters: Double = 50
    /// While still: one ping every 5 minutes.
    static let stillInterval: TimeInterval = 5 * 60
    /// Server rate limit is one ping per 10 s (start/stop exempt); the phone never goes below it.
    static let minSpacing: TimeInterval = 10
    /// Reported speed (m/s, ~3.6 km/h) at which the phone counts as moving (server `movingSpeed`).
    static let movingSpeed: Double = 1
    /// Pings in one upload (server `maxBatch`).
    static let maxBatch = 100
    /// Buffered pings the server would refuse as `too_old` are dropped on the phone (server `maxAgeMs`).
    static let maxAge: TimeInterval = 7 * 24 * 3_600
    /// Upload when this many pings wait, or when the oldest waiting ping is this old.
    static let uploadBatchSize = 5
    static let uploadInterval: TimeInterval = 5 * 60
    /// Field working hours, Asia/Manila (server `workStartHour` / `dailyCloseHour`).
    static let workStartHour = 5
    static let dailyCloseHour = 22
    /// Bound on locally buffered pings per partition (about two weeks of moving pings); oldest go first.
    static let maxBuffered = 20_000

    static func withinWorkHours(_ date: Date) -> Bool {
        let hour = FieldDay.calendar.component(.hour, from: date)
        return hour >= workStartHour && hour < dailyCloseHour
    }
}

/// One local work day for a person on this phone (Manila service date). Started by "Start day" or the
/// day's first call Start; ended by "End day", sign-out or the 10 PM close.
struct WorkDay: Equatable, Sendable {
    enum EndReason: String, Sendable { case endDay = "end_day", signOut = "sign_out", dailyClose = "daily_close" }
    let serviceDate: String
    let startedAt: Int64
    var endedAt: Int64?
    var endReason: EndReason?
    var isOpen: Bool { endedAt == nil }
}

/// The phone's consent answer for live-location sharing (Data Privacy Act notice), per signed-in account.
enum LocationConsent: String, Equatable, Sendable { case unanswered, accepted, declined }

/// What the phone may do right now. Pure, so every edge is unit tested.
enum LiveSharingDecision: Equatable, Sendable {
    case share
    case off(Reason)
    enum Reason: Equatable, Sendable { case notSignedIn, phoneNotReady, noConsent, dayNotStarted, dayEnded, outsideHours, held }

    static func decide(signedIn: Bool, ready: Bool, held: Bool, consent: LocationConsent, day: WorkDay?, now: Date,
                       withinHours: Bool? = nil) -> Self {
        guard signedIn else { return .off(.notSignedIn) }
        guard ready else { return .off(.phoneNotReady) }
        guard !held else { return .off(.held) }
        guard consent == .accepted else { return .off(.noConsent) }
        guard let day, day.serviceDate == BootstrapClient.manilaDay(now) else { return .off(.dayNotStarted) }
        guard day.isOpen else { return .off(.dayEnded) }
        guard withinHours ?? LiveLocationPolicy.withinWorkHours(now) else { return .off(.outsideHours) }
        return .share
    }
}

/// One fix as the phone saw it (Core Location or a test source), before it becomes a ping.
struct LiveFix: Equatable, Sendable {
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double
    /// nil when the phone does not know (Core Location reports a negative value).
    let speedMetersPerSecond: Double?
    let headingDegrees: Double?
    let mockLocation: Bool
    let timestamp: Date

    init?(latitude: Double, longitude: Double, accuracyMeters: Double, speedMetersPerSecond: Double?,
          headingDegrees: Double?, mockLocation: Bool, timestamp: Date) {
        guard latitude.isFinite, abs(latitude) <= 90, longitude.isFinite, abs(longitude) <= 180,
              accuracyMeters.isFinite, accuracyMeters >= 0, accuracyMeters <= 100_000 else { return nil }
        self.latitude = latitude; self.longitude = longitude; self.accuracyMeters = accuracyMeters
        // Same bounds as the server's `validWirePing`; an unknown or out-of-range value becomes null.
        self.speedMetersPerSecond = speedMetersPerSecond.flatMap { $0.isFinite && $0 >= 0 && $0 <= 100 ? $0 : nil }
        self.headingDegrees = headingDegrees.flatMap { $0.isFinite && $0 >= 0 && $0 <= 360 ? $0 : nil }
        self.mockLocation = mockLocation
        self.timestamp = timestamp
    }

    init?(_ location: CLLocation) {
        guard location.horizontalAccuracy >= 0 else { return nil }
        self.init(latitude: location.coordinate.latitude, longitude: location.coordinate.longitude,
                  accuracyMeters: location.horizontalAccuracy,
                  speedMetersPerSecond: location.speed >= 0 ? location.speed : nil,
                  headingDegrees: location.course >= 0 ? location.course : nil,
                  mockLocation: location.sourceInformation?.isSimulatedBySoftware == true,
                  timestamp: location.timestamp)
    }

    func distance(to other: LiveFix) -> Double {
        let rad = Double.pi / 180
        let dLat = (other.latitude - latitude) * rad, dLon = (other.longitude - longitude) * rad
        let h = pow(sin(dLat / 2), 2) + cos(latitude * rad) * cos(other.latitude * rad) * pow(sin(dLon / 2), 2)
        return 2 * 6_371_000 * asin(min(1, h).squareRoot())
    }
}

/// Phone cadence: ~60 s (or 50 m) while moving, every 5 minutes while still, never under 10 s.
enum PingSampler {
    struct Last: Equatable, Sendable { let fix: LiveFix; let at: Date }

    /// The trigger for recording `fix` at `now`, or nil to skip it.
    static func trigger(last: Last?, fix: LiveFix, now: Date) -> LivePing.Trigger? {
        guard let last else { return .start }
        let elapsed = now.timeIntervalSince(last.at)
        guard elapsed >= LiveLocationPolicy.minSpacing else { return nil }
        let moved = last.fix.distance(to: fix)
        let moving = (fix.speedMetersPerSecond ?? 0) >= LiveLocationPolicy.movingSpeed
        if moved >= LiveLocationPolicy.movingDistanceMeters { return .moving }
        if moving && elapsed >= LiveLocationPolicy.movingInterval { return .moving }
        if elapsed >= LiveLocationPolicy.stillInterval { return .still }
        return nil
    }
}

/// One buffered v1 `locationPing` (`packages/domain-contracts/schemas/mobile-v1.schema.json`).
struct LivePing: Codable, Equatable, Sendable {
    enum Trigger: String, Codable, Sendable { case start, moving, still, stop }
    let clientPingId: UUID
    /// Device clock, epoch ms. The server stamps its own `receivedAt`.
    let recordedAt: Int64
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double
    let speedMetersPerSecond: Double?
    let headingDegrees: Double?
    let batteryPercent: Int?
    let mockLocation: Bool
    /// Core Location blends GPS, Wi-Fi and cell positioning, so the honest wire value is `fused`.
    let provider: String
    let trigger: Trigger
    /// Server visit ID of the open call, when the call start has been accepted.
    let visitId: String?

    init(clientPingId: UUID = UUID(), fix: LiveFix, at: Date, trigger: Trigger, batteryPercent: Int?, visitId: String?) {
        self.clientPingId = clientPingId
        self.recordedAt = Int64((at.timeIntervalSince1970 * 1000).rounded(.down))
        self.latitude = fix.latitude; self.longitude = fix.longitude; self.accuracyMeters = fix.accuracyMeters
        self.speedMetersPerSecond = fix.speedMetersPerSecond; self.headingDegrees = fix.headingDegrees
        self.batteryPercent = batteryPercent.flatMap { (0...100).contains($0) ? $0 : nil }
        self.mockLocation = fix.mockLocation
        self.provider = "fused"
        self.trigger = trigger
        self.visitId = visitId.flatMap { (1...64).contains($0.count) ? $0 : nil }
    }

    /// Exact wire keys: nullable numbers are explicit nulls; `visitId` is omitted when unknown.
    var wireObject: [String: Any] {
        var object: [String: Any] = [
            "clientPingId": clientPingId.uuidString.lowercased(), "recordedAt": recordedAt,
            "latitude": latitude, "longitude": longitude, "accuracyMeters": accuracyMeters,
            "speedMetersPerSecond": speedMetersPerSecond ?? NSNull(), "headingDegrees": headingDegrees ?? NSNull(),
            "batteryPercent": batteryPercent ?? NSNull(), "mockLocation": mockLocation,
            "provider": provider, "trigger": trigger.rawValue,
        ]
        if let visitId { object["visitId"] = visitId }
        return object
    }

    /// Battery level as the server wants it: whole percent, nil when unknown (UIDevice reports -1).
    static func batteryPercent(level: Float) -> Int? {
        guard level.isFinite, level >= 0, level <= 1 else { return nil }
        return Int((level * 100).rounded())
    }
}

/// Plain-language notice shown once before sharing starts (Data Privacy Act: what, when, who, how long).
enum LocationConsentText {
    static let title = "Share your location during work"
    static let what = "Your phone's position, how accurate it is, speed and direction, battery level, the time, and whether the location looks simulated."
    static let when = "Only during your work day: from Start day or your first call until End day, sign-out or 10 PM. Never outside work."
    static let who = "Your supervisors and managers in your area, and head office. Kept for 90 days, then deleted."
    static let choice = "If you choose Not now, the app still works and your supervisor sees your location as off. You can change this on Today."
    static let always = "Next, iPhone asks about location. Choose Allow While Using App, then Change to Always Allow so sharing continues while the phone is locked during work."
}
