import CryptoKit
import XCTest
@testable import FieldIOS

/// IOS-010 daily route: MCP order, visit state, distance where available, customer and navigation access.
@MainActor
final class RouteScreenTests: XCTestCase {
    private let day = "2026-10-02"
    private let manila = StoreSnapshot.Coordinate(latitude: 14.5995, longitude: 120.9842)

    private func visit(_ id: String, planned: Bool = true, status: String = "Planned",
                       started: Date? = nil, ended: Date? = nil) -> AppModel.TodayVisit {
        AppModel.TodayVisit(id: id, outletId: "o-\(id)", outlet: "Store \(id)", serviceDate: day,
                            intents: ["audit"], planned: planned, status: status,
                            startedAt: started, endedAt: ended)
    }

    func testDistanceMathAndLabels() {
        // ~0.0045 degrees of longitude at the equator is ~500 m.
        let meters = RouteMath.meters(from: .init(latitude: 0, longitude: 0), to: .init(latitude: 0, longitude: 0.0045))
        XCTAssertEqual(meters, 500.4, accuracy: 1)
        XCTAssertEqual(RouteMath.label(meters: 0), "0 m")
        XCTAssertEqual(RouteMath.label(meters: 344), "340 m")
        XCTAssertEqual(RouteMath.label(meters: 996), "1.0 km")
        XCTAssertEqual(RouteMath.label(meters: 1_249), "1.2 km")
        XCTAssertEqual(RouteMath.label(meters: 9_960), "10 km")
        XCTAssertEqual(RouteMath.label(meters: 14_400), "14 km")
        XCTAssertFalse(RouteMath.isValid(.init(latitude: 91, longitude: 0)))
        XCTAssertFalse(RouteMath.isValid(.init(latitude: .nan, longitude: 0)))
        XCTAssertTrue(RouteMath.isValid(manila))
    }

    func testStopsKeepPlanOrderMarkStateAndSkipUnplanned() {
        let start = Date(timeIntervalSince1970: 1_790_000_000)
        let visits = [
            visit("a", status: "Queued", started: start, ended: start.addingTimeInterval(25 * 60)),
            visit("b", status: "Accepted", started: start.addingTimeInterval(1_800)),
            visit("c"),
            visit("extra", planned: false, status: "Unplanned")
        ]
        var stops = DailyRoute.stops(visits: visits, outlets: [:], customers: [:], here: nil)
        XCTAssertEqual(stops.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(stops.map(\.position), [1, 2, 3])
        XCTAssertEqual(stops.map(\.state), [.done, .inProgress, .notStarted], "an open call means no stop is Next")
        XCTAssertEqual(stops[0].stateLabel, "Done · 25 min · waiting to send")
        XCTAssertEqual(stops[1].stateLabel, "In progress")

        stops = DailyRoute.stops(visits: [visits[0], visit("b"), visit("c")], outlets: [:], customers: [:], here: nil)
        XCTAssertEqual(stops.map(\.state), [.done, .next, .notStarted])
        XCTAssertEqual(stops[1].stateLabel, "Next")

        // The model's start guard wins: a rejected End leaves nothing startable, so nothing is Next.
        stops = DailyRoute.stops(visits: [visit("a", status: "Needs review"), visit("b")], outlets: [:],
                                 customers: [:], here: nil, canStart: { _ in false })
        XCTAssertEqual(stops.map(\.state), [.needsReview, .notStarted])
        XCTAssertEqual(stops[0].stateLabel, "To review")
    }

    func testDistanceCustomerAndDirectionsOnlyWhereAvailable() throws {
        let outlets: [String: StoreSnapshot.Outlet] = [
            "o-a": .init(id: "o-a", name: "Store a", routeId: nil, code: "OUT-A", customerId: "cust-a",
                         address: "1 Rizal Ave", location: .init(latitude: 14.6040, longitude: 120.9842)),
            "o-b": .init(id: "o-b", name: "Store b", routeId: nil, address: "2 Mabini St"),
            "o-c": .init(id: "o-c", name: "Store c", routeId: nil, location: .init(latitude: 200, longitude: 0))
        ]
        let customers = ["cust-a": StoreSnapshot.Customer(id: "cust-a", code: "C-001", name: "Aling Nena Store")]
        let stops = DailyRoute.stops(visits: [visit("a"), visit("b"), visit("c"), visit("d")],
                                     outlets: outlets, customers: customers, here: manila)
        XCTAssertEqual(try XCTUnwrap(stops[0].distanceMeters), 500, accuracy: 5)
        XCTAssertEqual(stops[0].distanceLabel, "500 m away")
        XCTAssertEqual(stops[0].customerLabel, "C-001 · Aling Nena Store")
        XCTAssertEqual(stops[0].outletCode, "OUT-A")
        let pinURL = try XCTUnwrap(stops[0].directionsURL)
        let items = try XCTUnwrap(URLComponents(url: pinURL, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(pinURL.host, "maps.apple.com")
        XCTAssertEqual(items.first { $0.name == "daddr" }?.value, "14.604,120.9842")
        XCTAssertEqual(items.first { $0.name == "dirflg" }?.value, "d")
        // Address-only store: directions by address, no distance.
        XCTAssertNil(stops[1].distanceMeters)
        XCTAssertEqual(URLComponents(url: try XCTUnwrap(stops[1].directionsURL), resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "daddr" }?.value, "2 Mabini St")
        // Corrupt pin and unknown outlet: neither distance nor a map target.
        XCTAssertNil(stops[2].distanceMeters); XCTAssertNil(stops[2].directionsURL)
        XCTAssertNil(stops[3].distanceMeters); XCTAssertNil(stops[3].directionsURL); XCTAssertNil(stops[3].customerLabel)
        // No phone fix: no distance, but navigation still works.
        let noFix = DailyRoute.stops(visits: [visit("a")], outlets: outlets, customers: customers, here: nil)
        XCTAssertNil(noFix[0].distanceLabel)
        XCTAssertNotNil(noFix[0].directionsURL)
    }

    func testBootstrapRouteFieldsDecodeAndInvalidPinIsRejected() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "bootstrap-response", withExtension: "json"))
        let data = try Data(contentsOf: url)
        let page = try JSONDecoder().decode(BootstrapV1.Page.self, from: data)
        let outlet = try XCTUnwrap(page.outlets.first)
        XCTAssertEqual(outlet.code, "O-1")
        XCTAssertEqual(outlet.address, "1 Rizal Ave, Manila")
        XCTAssertEqual(outlet.location, .init(latitude: 14.5995, longitude: 120.9842))
        XCTAssertNil(outlet.customerId)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var outlets = try XCTUnwrap(object["outlets"] as? [[String: Any]])
        outlets[0]["location"] = ["latitude": 95.0, "longitude": 0.0]
        object["outlets"] = outlets
        XCTAssertThrowsError(try JSONDecoder().decode(BootstrapV1.Page.self,
                                                      from: JSONSerialization.data(withJSONObject: object)))
        // An older server without the route fields still decodes.
        object["outlets"] = outlets.map { $0.filter { ["id", "name", "routeId"].contains($0.key) } }
        let old = try JSONDecoder().decode(BootstrapV1.Page.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertTrue(old.outlets.allSatisfy { $0.location == nil && $0.code == nil && $0.address == nil })
    }

    func testRouteDetailsSurviveEncryptedStoreAndFollowTheCall() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "route-\(UUID().uuidString)")
        let secrets = KeychainStore(service: "com.sunpride.field.route.tests.\(UUID().uuidString)")
        let store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        defer {
            store.close(); try? secrets.delete("db"); try? secrets.delete(StoreAccount.session)
            try? FileManager.default.removeItem(at: directory)
        }
        let clock = TestClock(ISO8601DateFormatter().date(from: "2026-10-02T10:00:00+08:00")!)
        let partition = try StorePartition(subject: "test|seller", deviceId: "phone", scope: "scope")
        let expiry = Int64(FieldDay.nextClose(after: clock.now).timeIntervalSince1970 * 1000)
        let visits = [("second", 1), ("first", 0)].map {
            StoreSnapshot.Visit(id: $0.0, outletId: $0.0, serviceDate: day, planId: "plan", planVersion: 1,
                                intents: ["audit"], sequence: $0.1)
        }
        try store.saveSnapshot(.init(employee: .init(id: "seller", role: "sales", orgUnitId: "unit"), visits: visits,
            outlets: [.init(id: "first", name: "First", routeId: "r1", code: "F-1", customerId: "c1",
                            address: "1 Rizal Ave", location: manila),
                      .init(id: "second", name: "Second", routeId: "r1")],
            customers: [.init(id: "c1", code: "C-001", name: "First Customer")],
            route: .init(id: "r1", code: "R-01"), tasks: []),
            cursor: "cursor", leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: partition)
        try secrets.save(Data("test-session".utf8), for: StoreAccount.session)
        let registry = FakeRegistry()
        registry.lastMine = .success(MineResult(deviceId: "phone", status: "active", bound: true, allowedApp: "IOS"))
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        let model = AppModel(auth: AuthClient(site: StubHTTP.site, store: secrets, http: StubHTTP.client()),
            registry: registry, store: secrets, localStore: store, now: clock.closure) { key }
        defer { model.enrollment.signedOut() }
        await model.launch()
        _ = try model.storage(for: partition)
        model.refreshToday()

        XCTAssertEqual(model.routeCode, "R-01")
        XCTAssertEqual(model.outletDetails["first"]?.location, manila)
        XCTAssertEqual(model.customerDetails["c1"]?.name, "First Customer")
        let route = { DailyRoute.stops(visits: model.visits, outlets: model.outletDetails, customers: model.customerDetails,
                                       here: self.manila, canStart: { model.startFailure(for: $0) == nil }) }
        var stops = route()
        XCTAssertEqual(stops.map(\.id), ["first", "second"])
        XCTAssertEqual(stops.map(\.state), [.next, .notStarted])
        XCTAssertEqual(stops[0].distanceLabel, "0 m away")
        XCTAssertEqual(stops[0].customerLabel, "C-001 · First Customer")

        let first = try XCTUnwrap(model.visits.first { $0.id == "first" })
        try model.queueCheckIn(first, unplannedReason: nil, location: nil)
        stops = route()
        XCTAssertEqual(stops.map(\.state), [.inProgress, .notStarted])
        XCTAssertEqual(stops[0].stateLabel, "In progress · waiting to send")
        clock.advance(12 * 60)
        try model.queueCheckOut(outcome: "completed", reason: nil, for: try XCTUnwrap(model.visits.first { $0.id == "first" }))
        stops = route()
        XCTAssertEqual(stops.map(\.state), [.done, .next])
        XCTAssertEqual(stops[0].stateLabel, "Done · 12 min · waiting to send")

        await model.signOut()
        XCTAssertTrue(model.outletDetails.isEmpty)
        XCTAssertTrue(model.customerDetails.isEmpty)
        XCTAssertNil(model.routeCode)
    }
}
