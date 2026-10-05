import CoreLocation
import XCTest
@testable import FieldIOS

/// IOS-012: GPS check-in evidence. The phone records timestamp, coordinates, accuracy, provider and mock
/// indicator; the server records distance from the verified pin and the geofence result. These tests cover
/// the on-phone selection and the notice the salesperson sees; none of it may block Start or End.
final class VisitLocationTests: XCTestCase {
    private let now: Int64 = 1_790_380_800_000
    private let store = OutletPin(latitude: 14.5764, longitude: 121.0851)!

    private func fix(_ accuracy: Double = 10, age: Int64 = 0, lat: Double = 14.5764, lng: Double = 121.0851,
                     provider: String = "fused", mock: Bool = false) throws -> VisitLocation {
        try VisitLocation(latitude: lat, longitude: lng, accuracyMeters: accuracy, fixTime: now - age,
                          provider: provider, mockSignal: mock)
    }

    func testPolicyMirrorsBackendVisitLocationPolicy() throws {
        // Parity with packages/backend/convex/visits/policy.ts and outlets/validation.ts (read from the repo).
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        guard let policy = try? String(contentsOf: root.appending(path: "packages/backend/convex/visits/policy.ts"), encoding: .utf8),
              let outlets = try? String(contentsOf: root.appending(path: "packages/backend/convex/outlets/validation.ts"), encoding: .utf8)
        else { throw XCTSkip("backend sources are not readable from the simulator sandbox") }
        XCTAssertTrue(policy.contains("version: \"\(LocationPolicy.version)\""))
        XCTAssertTrue(policy.contains("maxAccuracyMeters: \(Int(LocationPolicy.maxAccuracyMeters)),"))
        XCTAssertTrue(policy.contains("maxFixAgeMs: 60_000,") && LocationPolicy.maxFixAgeMs == 60_000)
        XCTAssertTrue(policy.contains("maxFixClockDriftMs: 120_000,") && LocationPolicy.maxFixClockDriftMs == 120_000)
        XCTAssertTrue(outlets.contains("MAX_RADIUS_METERS = \(Int(LocationPolicy.maxPinRadiusMeters));"))
    }

    func testWireFixCarriesFusedProviderMockSignalAndEpochMilliseconds() throws {
        let location = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 14.5, longitude: 121.0), altitude: 0,
            horizontalAccuracy: 8, verticalAccuracy: 4, timestamp: Date(timeIntervalSince1970: 1_790_380_800.123))
        let wire = try VisitLocation(location)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(wire)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["latitude", "longitude", "accuracyMeters", "provider", "mockSignal", "fixTime"],
                       "exactly the v1 location keys; no client geofence verdict")
        XCTAssertEqual(object["provider"] as? String, "fused")
        XCTAssertEqual(object["mockSignal"] as? Bool, false)
        XCTAssertEqual((object["fixTime"] as? NSNumber)?.int64Value, 1_790_380_800_123)
        XCTAssertEqual(object["accuracyMeters"] as? Double, 8)
    }

    func testInvalidCoreLocationValuesAreNotEvidence() {
        XCTAssertThrowsError(try VisitLocation(CLLocation(coordinate: CLLocationCoordinate2D(latitude: 14, longitude: 121),
            altitude: 0, horizontalAccuracy: -1, verticalAccuracy: 0, timestamp: Date())))
        XCTAssertThrowsError(try fix(lat: 91))
        XCTAssertThrowsError(try fix(lng: .nan))
        XCTAssertThrowsError(try fix(-1))
        XCTAssertThrowsError(try fix(provider: "satellite"))
    }

    func testSelectorPrefersFreshThenRealThenTighterAndStopsOnReliable() throws {
        let stale = try fix(5, age: 120_000), freshWeak = try fix(80), mock = try fix(3, mock: true), good = try fix(20)
        XCTAssertEqual(FixSelector.better(stale, freshWeak, at: now), freshWeak, "fresh beats a tighter stale fix")
        XCTAssertEqual(FixSelector.better(mock, freshWeak, at: now), freshWeak, "real beats a tighter mock fix")
        XCTAssertEqual(FixSelector.better(freshWeak, good, at: now), good)
        XCTAssertEqual(FixSelector.better(good, freshWeak, at: now), good)
        XCTAssertTrue(FixSelector.reliable(good, at: now))
        XCTAssertFalse(FixSelector.reliable(freshWeak, at: now))
        XCTAssertFalse(FixSelector.reliable(mock, at: now))
        XCTAssertFalse(FixSelector.reliable(stale, at: now))
        XCTAssertFalse(FixSelector.reliable(try fix(provider: "unknown"), at: now))
        // Minor phone clock drift ahead of the server is tolerated like the backend; beyond it is not.
        XCTAssertTrue(FixSelector.reliable(try fix(age: -30_000), at: now))
        XCTAssertFalse(FixSelector.reliable(try fix(age: -130_000), at: now))
    }

    func testDistanceMatchesServerHaversine() throws {
        // 0.001° of latitude ≈ 111.19 m on the server's 6,371 km sphere.
        let d = LocationAssessment.distanceMeters(try fix(lat: 14.5774), store)
        XCTAssertEqual(d, 111.19, accuracy: 0.05)
        XCTAssertEqual(LocationAssessment.formatDistance(d), "111 m")
        XCTAssertEqual(LocationAssessment.formatDistance(1_540), "1.5 km")
    }

    func testNoticeShowsAccuracyDistanceAndOnlyCertainReviewReasons() throws {
        let at = Date(timeIntervalSince1970: Double(now) / 1000)
        let near = LocationAssessment.notice(.captured(try fix(12, lat: 14.5765)), pin: store, at: at)
        XCTAssertEqual(near, LocationNotice(text: "Location recorded · ±12 m · 11 m from store", review: false))
        // 300 m may be inside a mall's verified radius; the phone does not guess the server verdict.
        XCTAssertFalse(LocationAssessment.notice(.captured(try fix(lat: 14.5791)), pin: store, at: at).review)
        let far = LocationAssessment.notice(.captured(try fix(lat: 14.5864)), pin: store, at: at)
        XCTAssertEqual(far.text, "Location recorded · ±10 m · 1.1 km from store · supervisor will review: far from store")
        XCTAssertTrue(far.review)
        let poor = LocationAssessment.notice(.captured(try fix(120, age: 90_000, mock: true)), pin: store, at: at)
        XCTAssertEqual(poor.text, "Location recorded · ±120 m · 0 m from store · supervisor will review: simulated location, weak signal, old fix")
        let unpinned = LocationAssessment.notice(.captured(try fix()), pin: nil, at: at)
        XCTAssertEqual(unpinned.text, "Location recorded · ±10 m · supervisor will review: store has no verified pin")
    }

    func testUnavailableFixExplainsWhyAndStaysReviewOnly() {
        let at = Date()
        XCTAssertEqual(LocationAssessment.notice(.unavailable(.permissionDenied), pin: store, at: at).text,
                       "Location unavailable · supervisor will review: location permission off")
        XCTAssertEqual(LocationAssessment.notice(.unavailable(.locationOff), pin: store, at: at).text,
                       "Location unavailable · supervisor will review: phone location turned off")
        XCTAssertEqual(LocationAssessment.notice(.unavailable(.noFix), pin: nil, at: at).text,
                       "Location unavailable · supervisor will review: no signal")
        XCTAssertNil(LocationOutcome.unavailable(.noFix).fix)
    }

    func testOutletPinNeedsBothCoordinatesInRange() {
        XCTAssertNil(OutletPin(latitude: 14, longitude: nil))
        XCTAssertNil(OutletPin(latitude: 95, longitude: 121))
        XCTAssertTrue(StoreSnapshot.Outlet(id: "a", name: "A", routeId: nil).hasValidPinFields)
        var halfPinned = StoreSnapshot.Outlet(id: "a", name: "A", routeId: nil)
        halfPinned.latitude = 14
        XCTAssertFalse(halfPinned.hasValidPinFields)
        XCTAssertEqual(StoreSnapshot.Outlet(id: "a", name: "A", routeId: nil,
                                            location: .init(latitude: 14, longitude: 121)).pin,
                       OutletPin(latitude: 14, longitude: 121))
    }
}
