import CoreLocation
import CryptoKit
import Foundation
import UIKit

/// Where live fixes come from: Core Location on a phone, a scripted source in tests and UI tests.
enum LiveAuthorization: Equatable, Sendable { case notDetermined, denied, whenInUse, always, servicesOff }

@MainActor
protocol LiveLocationSource: AnyObject {
    var onFix: ((LiveFix) -> Void)? { get set }
    var onAuthorization: ((LiveAuthorization) -> Void)? { get set }
    var authorization: LiveAuthorization { get }
    var lastFix: LiveFix? { get }
    var running: Bool { get }
    /// When-In-Use first; once granted, Always (for sharing while the phone is locked).
    func requestPermission()
    func start()
    func stop()
    /// Still for a while: drop to a coarse, low-power fix until the person moves again.
    func setLowPower(_ low: Bool)
    func batteryPercent() -> Int?
}

/// Buffered pings and the local work day, in the encrypted SQLCipher store (schema v8).
@MainActor
protocol LiveLocationStore: AnyObject {
    func enqueuePing(_ ping: LivePing, for partition: StorePartition) throws
    func pendingPings(for partition: StorePartition, limit: Int) throws -> [LivePing]
    func pingCount(for partition: StorePartition) throws -> Int
    func removePings(_ ids: [UUID], for partition: StorePartition) throws
    func dropPings(recordedBefore cutoff: Int64, for partition: StorePartition) throws
    func workDay(_ serviceDate: String, for partition: StorePartition) throws -> WorkDay?
    @discardableResult func startWorkDay(_ serviceDate: String, at: Int64, for partition: StorePartition) throws -> WorkDay
    func endWorkDay(_ serviceDate: String, at: Int64, reason: WorkDay.EndReason, for partition: StorePartition) throws
    func isHeld(_ partition: StorePartition) throws -> Bool
}
extension EncryptedFieldStore: LiveLocationStore {}

/// The consent answer per signed-in account. Only a SHA-256 of the auth subject is stored, never the subject.
@MainActor
protocol LocationConsentStore: AnyObject {
    func consent(subject: String) -> LocationConsent
    func setConsent(_ consent: LocationConsent, subject: String, at: Date)
}

@MainActor
final class DefaultsLocationConsentStore: LocationConsentStore {
    static let key = "field.liveLocation.consent.v1"
    private let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    private static func account(_ subject: String) -> String {
        SHA256.hash(data: Data(subject.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    func consent(subject: String) -> LocationConsent {
        let all = defaults.dictionary(forKey: Self.key) as? [String: String] ?? [:]
        return all[Self.account(subject)].flatMap(LocationConsent.init(rawValue:)) ?? .unanswered
    }
    func setConsent(_ consent: LocationConsent, subject: String, at: Date) {
        var all = defaults.dictionary(forKey: Self.key) as? [String: String] ?? [:]
        all[Self.account(subject)] = consent.rawValue
        defaults.set(all, forKey: Self.key)
        defaults.set(at.timeIntervalSince1970, forKey: Self.key + ".answeredAt." + Self.account(subject))
    }
}

/// Core Location during the work day only. Started and stopped by `LiveLocationController`.
/// Background: `allowsBackgroundLocationUpdates` with the blue status-bar indicator always shown,
/// a 25 m distance filter, a coarse low-power mode while still, and significant-change monitoring as a
/// backstop that wakes the app after the system stops it. Never runs outside the work day.
@MainActor
final class CoreLocationSource: NSObject, LiveLocationSource, @preconcurrency CLLocationManagerDelegate {
    var onFix: ((LiveFix) -> Void)?
    var onAuthorization: ((LiveAuthorization) -> Void)?
    private(set) var lastFix: LiveFix?
    private(set) var running = false
    private let manager = CLLocationManager()
    private var askAlwaysNext = false

    override init() {
        super.init()
        manager.delegate = self
        manager.activityType = .otherNavigation
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.distanceFilter = 25
        // Still pings every 5 minutes need the updates alive; the work day bounds the cost.
        manager.pausesLocationUpdatesAutomatically = false
    }

    var authorization: LiveAuthorization {
        switch manager.authorizationStatus {
        case .notDetermined: .notDetermined
        case .authorizedAlways: .always
        case .authorizedWhenInUse: .whenInUse
        default: .denied
        }
    }

    func requestPermission() {
        switch manager.authorizationStatus {
        case .notDetermined:
            askAlwaysNext = true
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            manager.requestAlwaysAuthorization()
        default: break
        }
    }

    func start() {
        guard !running, [.authorizedAlways, .authorizedWhenInUse].contains(manager.authorizationStatus) else { return }
        running = true
        UIDevice.current.isBatteryMonitoringEnabled = true
        // Requires UIBackgroundModes `location` (Info.plist). When-In-Use also keeps updating in the
        // background once started in the foreground; the indicator tells the person it is on.
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        manager.startUpdatingLocation()
        if CLLocationManager.significantLocationChangeMonitoringAvailable() { manager.startMonitoringSignificantLocationChanges() }
    }

    func stop() {
        guard running else { return }
        running = false
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        manager.allowsBackgroundLocationUpdates = false
        setLowPower(false)
    }

    func setLowPower(_ low: Bool) {
        manager.desiredAccuracy = low ? kCLLocationAccuracyHundredMeters : kCLLocationAccuracyNearestTenMeters
    }

    func batteryPercent() -> Int? { LivePing.batteryPercent(level: UIDevice.current.batteryLevel) }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if askAlwaysNext, manager.authorizationStatus == .authorizedWhenInUse {
            askAlwaysNext = false
            manager.requestAlwaysAuthorization()
        }
        onAuthorization?(authorization)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard running else { return }
        for location in locations {
            guard let fix = LiveFix(location) else { continue }
            lastFix = fix
            onFix?(fix)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .denied { onAuthorization?(.denied) }
    }
}

#if DEBUG
/// UI tests (`FIELD_STUB_BACKEND`): no OS prompt and no real coordinates. `FIELD_STUB_LIVE_AUTH=denied`
/// refuses permission; otherwise Always is granted and a fix near (0, 0) arrives on start and every 15 s.
@MainActor
final class StubLocationSource: LiveLocationSource {
    var onFix: ((LiveFix) -> Void)?
    var onAuthorization: ((LiveAuthorization) -> Void)?
    private(set) var authorization: LiveAuthorization = .notDetermined
    private(set) var lastFix: LiveFix?
    private(set) var running = false
    private var timer: Timer?
    private var step = 0
    private let denies = ProcessInfo.processInfo.environment["FIELD_STUB_LIVE_AUTH"] == "denied"

    func requestPermission() {
        authorization = denies ? .denied : .always
        onAuthorization?(authorization)
    }
    func start() {
        guard !running, authorization == .always else { return }
        running = true
        emit()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.emit() }
        }
    }
    func stop() { running = false; timer?.invalidate(); timer = nil }
    func setLowPower(_ low: Bool) {}
    func batteryPercent() -> Int? { 80 }
    private func emit() {
        guard running else { return }
        step += 1
        // About 60 m north per step: each fix counts as moving.
        guard let fix = LiveFix(latitude: Double(step) * 0.00055, longitude: 0, accuracyMeters: 8,
                                speedMetersPerSecond: 4, headingDegrees: 0, mockLocation: false, timestamp: Date()) else { return }
        lastFix = fix
        onFix?(fix)
    }
}
#endif
