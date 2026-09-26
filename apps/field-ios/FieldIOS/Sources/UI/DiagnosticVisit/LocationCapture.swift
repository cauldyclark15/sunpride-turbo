import CoreLocation
import Foundation

struct VisitLocation: Encodable {
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double
    let provider = "gps"
    let fixTime: Int64
    init(_ location: CLLocation) throws {
        guard location.horizontalAccuracy >= 0, location.horizontalAccuracy.isFinite,
              abs(location.coordinate.latitude) <= 90, abs(location.coordinate.longitude) <= 180,
              abs(Date().timeIntervalSince(location.timestamp)) < 120 else { throw LocationCapture.Failure.unavailable }
        latitude = location.coordinate.latitude
        longitude = location.coordinate.longitude
        accuracyMeters = location.horizontalAccuracy
        fixTime = Int64(location.timestamp.timeIntervalSince1970 * 1000)
    }
}

@MainActor
final class LocationCapture: NSObject, @preconcurrency CLLocationManagerDelegate {
    enum Failure: Error { case denied, unavailable }
    private let manager = CLLocationManager()
    private var permission: CheckedContinuation<Void, Error>?
    private var fix: CheckedContinuation<VisitLocation, Error>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }
    func capture() async throws -> VisitLocation {
        #if DEBUG
        if StubBackend.scenario != nil {
            // In-process UI backend only; no OS permission dialog and no real coordinates in test artifacts.
            return try VisitLocation(CLLocation(latitude: 0, longitude: 0))
        }
        #endif
        switch manager.authorizationStatus {
        case .denied, .restricted: throw Failure.denied
        case .notDetermined:
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                permission = continuation
                manager.requestWhenInUseAuthorization()
            }
        default: break
        }
        guard manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways else { throw Failure.denied }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<VisitLocation, Error>) in
            fix = continuation
            manager.requestLocation()
        }
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: permission?.resume(); permission = nil
        case .denied, .restricted:
            permission?.resume(throwing: Failure.denied); permission = nil
            fix?.resume(throwing: Failure.denied); fix = nil
        default: break
        }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let fix else { return }
        self.fix = nil
        do {
            guard let location = locations.last else { throw Failure.unavailable }
            fix.resume(returning: try VisitLocation(location))
        }
        catch { fix.resume(throwing: error) }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        fix?.resume(throwing: Failure.unavailable); fix = nil
    }
}
