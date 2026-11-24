import Foundation
import CoreLocation

/// SP-0251: additional location evidence, never a rewrite of the saved capture or sent bytes.
struct StoreLocationTag: Codable {
    static let kind = "store.location"
    static let entity = "local.store-location"
    static let window: Int64 = 15 * 60_000
    static let tip = "Go outside or near the door; GPS works without signal but needs a clear sky."
    var captureId: String?
    var outletId: String?
    var startedAt: Int64
    var anchor: VisitLocation?
    var best: VisitLocation?
    var stopped = false
    func active(at: Int64) -> Bool { !stopped && at >= startedAt && at - startedAt < Self.window }
    static func fresh(_ fix: VisitLocation, at: Int64) -> Bool {
        CensusCapture.gpsUsable(fix, at: at) && abs(at - fix.fixTime) <= 120_000 && fix.provider != "network"
    }
    mutating func accept(_ fix: VisitLocation, speed: Double?, at: Int64) -> Bool {
        guard active(at: at), Self.fresh(fix, at: at), fix.fixTime >= startedAt - 10_000 else { return false }
        let moved = anchor.flatMap { CensusDuplicates.distanceMeters($0.latitude, $0.longitude, fix.latitude, fix.longitude) } ?? 0
        if (speed ?? 0) > 2.5 || moved > 150 { stopped = true; return false }
        if anchor == nil { anchor = fix }
        if let best, fix.accuracyMeters >= best.accuracyMeters { return false }
        best = fix
        if fix.accuracyMeters <= 15 { stopped = true }
        return true
    }
    func intent(_ fix: VisitLocation, at: Int64) throws -> VisitIntent {
        guard Self.fresh(fix, at: at), (captureId == nil) != (outletId == nil) else { throw StoreError.invalidInput }
        let id = UUID()
        var payload: [String: Any] = ["deviceTime": at, "location": ["latitude": fix.latitude, "longitude": fix.longitude,
            "accuracyMeters": fix.accuracyMeters, "fixTime": fix.fixTime, "provider": fix.provider, "mockSignal": false]]
        if let captureId { payload["captureId"] = captureId }
        if let outletId { payload["outletId"] = outletId }
        let op: [String: Any] = ["clientRequestId": id.uuidString.lowercased(), "kind": Self.kind,
            "dependsOn": captureId.map { [$0] } ?? [], "payload": payload]
        return VisitIntent(requestId: id, kind: Self.kind, operationJSON: try JSONSerialization.data(withJSONObject: op, options: [.sortedKeys]))
    }
    static func valid(_ payload: [String: Any], at: Int64) -> Bool {
        guard ((payload["captureId"] as? String) == nil) != ((payload["outletId"] as? String) == nil),
              let target = (payload["captureId"] ?? payload["outletId"]) as? String, UUID(uuidString: target) != nil,
              let data = try? JSONSerialization.data(withJSONObject: payload["location"] ?? [:]),
              let fix = try? JSONDecoder().decode(VisitLocation.self, from: data), Self.fresh(fix, at: at) else { return false }
        return true
    }
}

/// iOS exposes Core Location, not a GPS-only provider selector. BestForNavigation requests the
/// highest precision available and works without internet; never use address lookup for tagging.
@MainActor
final class StoreLocationCollector: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var timer: Timer?
    private var onFix: ((VisitLocation, Double?) -> Bool)?
    private var onTick: (() -> Bool)?
    override init() {
        super.init(); manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
    }
    func start(onFix: @escaping (VisitLocation, Double?) -> Bool, onTick: @escaping () -> Bool) {
        stop(); self.onFix = onFix; self.onTick = onTick
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        else if [.authorizedWhenInUse, .authorizedAlways].contains(manager.authorizationStatus) { manager.startUpdatingLocation() }
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in if self?.onTick?() != true { self?.stop() } }
        }
    }
    func stop() { manager.stopUpdatingLocation(); timer?.invalidate(); timer = nil; onFix = nil; onTick = nil }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard onFix != nil else { return }
        if [.authorizedWhenInUse, .authorizedAlways].contains(manager.authorizationStatus) { manager.startUpdatingLocation() }
        else if manager.authorizationStatus != .notDetermined { stop() }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for location in locations {
            guard let fix = try? VisitLocation(location) else { continue }
            if onFix?(fix, location.speed >= 0 ? location.speed : nil) != true { stop(); break }
        }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .denied { stop() }
    }
}
