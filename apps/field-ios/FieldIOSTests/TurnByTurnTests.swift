import XCTest
@testable import FieldIOS

/// IOS-018: hand the outlet's pin (else address) to the phone's own navigation app.
@MainActor
final class TurnByTurnTests: XCTestCase {
    private let pin = StoreSnapshot.Coordinate(latitude: 14.604, longitude: 120.9842)

    private func items(_ url: URL?) throws -> [String: String] {
        let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(url), resolvingAgainstBaseURL: false))
        return Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    }

    func testTargetPrefersValidPinThenAddressElseNothing() {
        XCTAssertEqual(NavigationTarget(name: "A", location: pin, address: "1 Rizal Ave")?.destination, .pin(pin))
        XCTAssertEqual(NavigationTarget(name: "B", location: .init(latitude: 200, longitude: 0), address: " 2 Mabini St ")?.destination,
                       .address("2 Mabini St"), "a corrupt pin falls back to the address")
        XCTAssertNil(NavigationTarget(name: "C", location: nil, address: "  "))
        XCTAssertNil(NavigationTarget(name: "D", location: .init(latitude: .nan, longitude: 0), address: nil))
    }

    func testEachAppGetsADrivingNavigationURLForThePin() throws {
        let target = try XCTUnwrap(NavigationTarget(name: "Store & Co", location: pin, address: "ignored"))
        let apple = TurnByTurn.url(.appleMaps, to: target)
        XCTAssertEqual(apple?.host, "maps.apple.com")
        XCTAssertEqual(try items(apple), ["daddr": "14.604,120.9842", "q": "Store & Co", "dirflg": "d"])
        let google = TurnByTurn.url(.googleMaps, to: target)
        XCTAssertEqual(google?.scheme, "comgooglemaps")
        XCTAssertEqual(try items(google), ["daddr": "14.604,120.9842", "directionsmode": "driving"])
        let waze = TurnByTurn.url(.waze, to: target)
        XCTAssertEqual(waze?.scheme, "waze")
        XCTAssertEqual(try items(waze), ["ll": "14.604,120.9842", "navigate": "yes"])
    }

    func testAddressOnlyStoreNavigatesByAddressInEveryApp() throws {
        let target = try XCTUnwrap(NavigationTarget(name: "B", location: nil, address: "2 Mabini St, Quezon City"))
        XCTAssertEqual(try items(TurnByTurn.url(.appleMaps, to: target)), ["daddr": "2 Mabini St, Quezon City", "dirflg": "d"])
        XCTAssertEqual(try items(TurnByTurn.url(.googleMaps, to: target)),
                       ["daddr": "2 Mabini St, Quezon City", "directionsmode": "driving"])
        XCTAssertEqual(try items(TurnByTurn.url(.waze, to: target)), ["q": "2 Mabini St, Quezon City", "navigate": "yes"])
    }

    func testInstalledAlwaysOffersAppleMapsThenProbedApps() {
        XCTAssertEqual(TurnByTurn.installed { _ in false }, [.appleMaps])
        XCTAssertEqual(TurnByTurn.installed { $0.scheme == "waze" }, [.appleMaps, .waze])
        XCTAssertEqual(TurnByTurn.installed { _ in true }, [.appleMaps, .googleMaps, .waze])
    }

    func testOnlyAppleMapsOpensDirectlyWithoutAsking() async throws {
        let launcher = DirectionsLauncher(canOpen: { _ in false })
        var opened: [URL] = []
        launcher.request(try XCTUnwrap(NavigationTarget(name: "A", location: pin, address: nil))) { url, done in
            opened.append(url); done(true)
        }
        XCTAssertNil(launcher.pending, "no choice to make")
        XCTAssertEqual(opened.map(\.host), ["maps.apple.com"])
        await Task.yield()
        XCTAssertNil(launcher.failure)
    }

    func testSeveralAppsAskThenOpenTheChosenOne() async throws {
        let launcher = DirectionsLauncher(canOpen: { _ in true })
        var opened: [URL] = []
        let target = try XCTUnwrap(NavigationTarget(name: "A", location: pin, address: nil))
        launcher.request(target) { url, done in opened.append(url); done(true) }
        XCTAssertEqual(launcher.pending, target)
        XCTAssertEqual(launcher.choices, [.appleMaps, .googleMaps, .waze])
        XCTAssertTrue(opened.isEmpty, "nothing opens until the salesperson picks")
        launcher.choose(.waze) { url, done in opened.append(url); done(true) }
        XCTAssertNil(launcher.pending)
        XCTAssertEqual(opened.map(\.scheme), ["waze"])
        // Choosing again after the dialog closed does nothing.
        launcher.choose(.googleMaps) { url, done in opened.append(url); done(true) }
        XCTAssertEqual(opened.count, 1)
    }

    func testRefusedOpenShowsAMessage() async throws {
        let launcher = DirectionsLauncher(canOpen: { _ in false })
        launcher.request(try XCTUnwrap(NavigationTarget(name: "A", location: nil, address: "1 Rizal Ave"))) { _, done in done(false) }
        for _ in 0..<10 where launcher.failure == nil { await Task.yield() }
        XCTAssertEqual(launcher.failure, "Could not open Apple Maps")
    }

    func testRouteStopAndCustomerRecordCarryTheSameTarget() {
        let outlets: [String: StoreSnapshot.Outlet] = [
            "o-a": .init(id: "o-a", name: "Store a", routeId: nil, address: "1 Rizal Ave", location: pin)
        ]
        let visit = AppModel.TodayVisit(id: "a", outletId: "o-a", outlet: "Store a", serviceDate: "2026-10-05",
                                        intents: [], planned: true, status: "Planned")
        let stop = DailyRoute.stops(visits: [visit], outlets: outlets, customers: [:], here: nil)[0]
        XCTAssertEqual(stop.navigationTarget?.destination, .pin(pin))
        let record = CustomerRecord(outletId: "o-a", name: "Store a", address: "1 Rizal Ave", location: pin)
        XCTAssertEqual(record.navigationTarget, stop.navigationTarget)
        XCTAssertEqual(record.directionsURL, stop.directionsURL)
    }
}
