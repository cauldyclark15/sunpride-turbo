import CoreLocation
import Foundation

/// Display-only mirror of the server's `VISIT_LOCATION_POLICY` (packages/backend/convex/visits/policy.ts).
/// The server alone records the distance from the verified outlet pin and the geofence result
/// (within/outside radius, unreliable, unavailable); the phone never sends a verdict. These thresholds only
/// let the phone tell the salesperson, at Start/End, that a fix will go to supervisor review.
/// Client answer 13 (2 Oct 2026): no distance limit, never block a check-in.
enum LocationPolicy {
    static let version = "field-day-2026-10-v3"
    static let maxAccuracyMeters = 50.0
    static let maxFixAgeMs: Int64 = 60_000
    static let maxFixClockDriftMs: Int64 = 120_000
    /// Largest verified pin radius (malls/warehouses). Beyond it every pin's geofence is missed.
    static let maxPinRadiusMeters = 500.0
    /// How long the phone keeps listening for a better fix before using the best one it has.
    static let captureBudget: Duration = .seconds(15)
    /// How long the first-use permission prompt may stay unanswered before Start/End proceed without a fix.
    static let permissionBudget: Duration = .seconds(60)
}

/// One v1 wire location: coordinates, horizontal accuracy, fix time, provider and mock indicator.
struct VisitLocation: Codable, Equatable, Sendable {
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double
    /// Core Location blends GPS, Wi-Fi and cell positioning, so the honest wire value is `fused`.
    let provider: String
    let mockSignal: Bool
    let fixTime: Int64

    init(latitude: Double, longitude: Double, accuracyMeters: Double, fixTime: Int64,
         provider: String = "fused", mockSignal: Bool = false) throws {
        guard latitude.isFinite, abs(latitude) <= 90, longitude.isFinite, abs(longitude) <= 180,
              accuracyMeters.isFinite, accuracyMeters >= 0, fixTime > 0,
              ["gps", "network", "fused", "unknown"].contains(provider) else { throw LocationCapture.Failure.unavailable }
        self.latitude = latitude; self.longitude = longitude; self.accuracyMeters = accuracyMeters
        self.fixTime = fixTime; self.provider = provider; self.mockSignal = mockSignal
    }
    init(_ location: CLLocation) throws {
        // A negative horizontal accuracy means the coordinate is invalid.
        guard location.horizontalAccuracy >= 0, location.timestamp.timeIntervalSince1970.isFinite else {
            throw LocationCapture.Failure.unavailable
        }
        try self.init(latitude: location.coordinate.latitude, longitude: location.coordinate.longitude,
                      accuracyMeters: location.horizontalAccuracy,
                      fixTime: Int64(location.timestamp.timeIntervalSince1970 * 1000),
                      mockSignal: location.sourceInformation?.isSimulatedBySoftware == true)
    }
}

/// Current verified outlet pin delivered in the bootstrap (`outlets[].latitude/longitude`).
struct OutletPin: Equatable, Sendable {
    let latitude: Double
    let longitude: Double
    init?(latitude: Double?, longitude: Double?) {
        guard let latitude, let longitude, latitude.isFinite, abs(latitude) <= 90,
              longitude.isFinite, abs(longitude) <= 180 else { return nil }
        self.latitude = latitude; self.longitude = longitude
    }
}

enum LocationUnavailableReason: Equatable, Sendable { case permissionDenied, locationOff, noFix }

enum LocationOutcome: Equatable, Sendable {
    case captured(VisitLocation)
    case unavailable(LocationUnavailableReason)
    /// The wire value: a missing fix is serialized as null, never a reason to refuse Start or End.
    var fix: VisitLocation? { if case .captured(let fix) = self { fix } else { nil } }
}

/// Picks the fix the server is most likely to accept from a stream of Core Location updates.
enum FixSelector {
    static func fresh(_ fix: VisitLocation, at: Int64) -> Bool {
        fix.fixTime <= at + LocationPolicy.maxFixClockDriftMs && abs(at - fix.fixTime) <= LocationPolicy.maxFixAgeMs
    }
    static func reliable(_ fix: VisitLocation, at: Int64) -> Bool {
        !fix.mockSignal && fix.provider != "unknown" && fix.accuracyMeters <= LocationPolicy.maxAccuracyMeters &&
            fresh(fix, at: at)
    }
    /// Fresh beats stale, then a non-mock fix beats a mock one, then the tighter accuracy wins; ties go to the newer fix.
    static func better(_ current: VisitLocation?, _ candidate: VisitLocation, at: Int64) -> VisitLocation {
        guard let current else { return candidate }
        func rank(_ f: VisitLocation) -> (Int, Int, Double) { (fresh(f, at: at) ? 0 : 1, f.mockSignal ? 1 : 0, f.accuracyMeters) }
        let a = rank(current), b = rank(candidate)
        if b == a { return candidate.fixTime > current.fixTime ? candidate : current }
        return b < a ? candidate : current
    }
}

/// What the salesperson sees after Start/End. Review is a flag for the supervisor, never a refusal.
struct LocationNotice: Equatable, Sendable {
    let text: String
    let review: Bool
}

enum LocationAssessment {
    /// Same great-circle formula and Earth radius as the server's `haversine` (visits/location.ts).
    static func distanceMeters(_ fix: VisitLocation, _ pin: OutletPin) -> Double {
        let rad = Double.pi / 180
        let dLat = (pin.latitude - fix.latitude) * rad, dLon = (pin.longitude - fix.longitude) * rad
        let h = pow(sin(dLat / 2), 2) + cos(fix.latitude * rad) * cos(pin.latitude * rad) * pow(sin(dLon / 2), 2)
        return 2 * 6_371_000 * asin(min(1, h).squareRoot())
    }
    static func formatDistance(_ meters: Double) -> String {
        meters < 1_000 ? "\(Int(meters.rounded())) m" : String(format: "%.1f km", meters / 1_000)
    }
    static func reviewReasons(_ fix: VisitLocation, pin: OutletPin?, at: Int64) -> [String] {
        var reasons: [String] = []
        if fix.mockSignal { reasons.append("simulated location") }
        if fix.provider == "unknown" { reasons.append("unknown location source") }
        if fix.accuracyMeters > LocationPolicy.maxAccuracyMeters { reasons.append("weak signal") }
        if !FixSelector.fresh(fix, at: at) { reasons.append("old fix") }
        if let pin {
            // Every verified radius is at most 500 m, so this distance misses any store's geofence.
            if distanceMeters(fix, pin) > LocationPolicy.maxPinRadiusMeters { reasons.append("far from store") }
        } else {
            reasons.append("store has no verified pin")
        }
        return reasons
    }
    static func notice(_ outcome: LocationOutcome, pin: OutletPin?, at: Date) -> LocationNotice {
        let now = Int64(at.timeIntervalSince1970 * 1000)
        switch outcome {
        case .captured(let fix):
            var text = "Location recorded · ±\(Int(fix.accuracyMeters.rounded())) m"
            if let pin { text += " · \(formatDistance(distanceMeters(fix, pin))) from store" }
            let reasons = reviewReasons(fix, pin: pin, at: now)
            if reasons.isEmpty { return LocationNotice(text: text, review: false) }
            return LocationNotice(text: text + " · supervisor will review: " + reasons.joined(separator: ", "), review: true)
        case .unavailable(let reason):
            let why = switch reason {
            case .permissionDenied: "location permission off"
            case .locationOff: "phone location turned off"
            case .noFix: "no signal"
            }
            return LocationNotice(text: "Location unavailable · supervisor will review: \(why)", review: true)
        }
    }
}

/// Core Location capture for Start/End. Listens for up to `LocationPolicy.captureBudget`, stops early on the
/// first fix the server policy would accept, otherwise keeps the best one so a weak fix is still recorded
/// and flagged for supervisor review rather than lost.
@MainActor
final class LocationCapture: NSObject, @preconcurrency CLLocationManagerDelegate {
    enum Failure: Error { case denied, unavailable }
    private let manager = CLLocationManager()
    private var permission: CheckedContinuation<Void, Never>?
    private var listening: CheckedContinuation<Void, Never>?
    private var best: VisitLocation?
    private var denied = false
    private var busy = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
    }

    /// Best effort fix for display (route distances); no permission or no fix simply means nil.
    func captureIfAvailable() async -> VisitLocation? { await capture().fix }

    /// Fresh evidence for a Start or End. Never throws: a failure is a reason shown to the salesperson.
    func capture() async -> LocationOutcome {
        guard !busy else { return .unavailable(.noFix) }
        busy = true
        defer { busy = false }
        #if DEBUG
        if StubBackend.scenario != nil { return Self.stubOutcome(ProcessInfo.processInfo.environment["FIELD_STUB_LOCATION"]) }
        #endif
        let servicesOn = await Task.detached { CLLocationManager.locationServicesEnabled() }.value
        guard servicesOn else { return .unavailable(.locationOff) }
        if manager.authorizationStatus == .notDetermined {
            let unanswered = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: LocationPolicy.permissionBudget) } catch { return }
                self?.permission?.resume(); self?.permission = nil
            }
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                permission = continuation
                manager.requestWhenInUseAuthorization()
            }
            unanswered.cancel()
        }
        guard [.authorizedWhenInUse, .authorizedAlways].contains(manager.authorizationStatus) else {
            return .unavailable(.permissionDenied)
        }
        if manager.accuracyAuthorization == .reducedAccuracy {
            // Approximate location still records a (weak) fix; ask once for precise for this visit.
            _ = try? await manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: "VisitCheckIn")
        }
        best = nil
        denied = false
        let timeout = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: LocationPolicy.captureBudget) } catch { return }
            self?.finish()
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            listening = continuation
            manager.startUpdatingLocation()
        }
        timeout.cancel()
        if denied { return .unavailable(.permissionDenied) }
        return best.map(LocationOutcome.captured) ?? .unavailable(.noFix)
    }

    private func finish() {
        manager.stopUpdatingLocation()
        listening?.resume(); listening = nil
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard manager.authorizationStatus != .notDetermined else { return }
        permission?.resume(); permission = nil
        if [.denied, .restricted].contains(manager.authorizationStatus), listening != nil { denied = true; finish() }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard listening != nil else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        for location in locations {
            guard let candidate = try? VisitLocation(location) else { continue }
            best = FixSelector.better(best, candidate, at: now)
        }
        if let best, FixSelector.reliable(best, at: now) { finish() }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard listening != nil else { return }
        switch (error as? CLError)?.code {
        case .locationUnknown: return // Transient: Core Location keeps trying within the budget.
        case .denied: denied = true; finish()
        default: finish()
        }
    }

    #if DEBUG
    /// In-process UI backend only; no OS permission dialog and no real coordinates in test artifacts.
    static func stubOutcome(_ mode: String?, now: Date = Date()) -> LocationOutcome {
        let time = Int64(now.timeIntervalSince1970 * 1000)
        switch mode {
        case "denied": return .unavailable(.permissionDenied)
        case "off": return .unavailable(.locationOff)
        case "weak":
            return (try? VisitLocation(latitude: 0, longitude: 0, accuracyMeters: 120, fixTime: time))
                .map(LocationOutcome.captured) ?? .unavailable(.noFix)
        default:
            return (try? VisitLocation(latitude: 0, longitude: 0, accuracyMeters: 5, fixTime: time))
                .map(LocationOutcome.captured) ?? .unavailable(.noFix)
        }
    }
    #endif
}
