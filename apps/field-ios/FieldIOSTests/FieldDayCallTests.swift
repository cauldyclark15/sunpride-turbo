import CoreLocation
import CryptoKit
import XCTest
@testable import FieldIOS

@MainActor
final class FieldDayCallTests: XCTestCase {
    private var directory: URL!
    private var secrets: KeychainStore!
    private var store: EncryptedFieldStore!
    private var partition: StorePartition!
    private var model: AppModel!
    private var clock: TestClock!
    private let day = "2026-10-02"

    override func setUp() async throws {
        try await super.setUp()
        clock = TestClock(ISO8601DateFormatter().date(from: "2026-10-02T10:00:00+08:00")!)
        directory = FileManager.default.temporaryDirectory.appending(path: "field-day-\(UUID().uuidString)")
        secrets = KeychainStore(service: "com.sunpride.field.day.tests.\(UUID().uuidString)")
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        partition = try StorePartition(subject: "test|seller", deviceId: "phone", scope: "scope")
        try save([planned("second", sequence: 1), planned("first", sequence: 0)])
        model = try await makeModel()
    }
    override func tearDown() async throws {
        model.enrollment.signedOut()
        model = nil
        store.close()
        try? secrets.delete("db")
        try? secrets.delete(StoreAccount.session)
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }
    private func makeModel() async throws -> AppModel {
        try secrets.save(Data("test-session".utf8), for: StoreAccount.session)
        let registry = FakeRegistry()
        registry.lastMine = .success(MineResult(deviceId: "phone", status: "active", bound: true, allowedApp: "IOS"))
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        let model = AppModel(auth: AuthClient(site: StubHTTP.site, store: secrets, http: StubHTTP.client()),
            registry: registry, store: secrets, localStore: store, now: clock.closure) { key }
        await model.launch()
        _ = try model.storage(for: partition)
        model.refreshToday()
        return model
    }
    private func planned(_ id: String, sequence: Int? = nil) -> StoreSnapshot.Visit {
        .init(id: id, outletId: id, serviceDate: day, planId: "plan", planVersion: 1, intents: ["audit"], sequence: sequence)
    }
    private func save(_ visits: [StoreSnapshot.Visit], target: StoreSnapshot.DayTarget? = nil) throws {
        let expiry = Int64(FieldDay.nextClose(after: clock.now).timeIntervalSince1970 * 1000)
        try store.saveSnapshot(.init(employee: .init(id: "seller", role: "sales", orgUnitId: "unit"), visits: visits,
            outlets: ["first", "second", "extra"].map { .init(id: $0, name: $0, routeId: nil) },
            customers: [], route: nil, tasks: [], dayTarget: target), cursor: "cursor", leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: partition)
    }
    private func visit(_ id: String) throws -> AppModel.TodayVisit {
        try XCTUnwrap(model.visits.first { $0.id == id })
    }
    private func start(_ visit: AppModel.TodayVisit, location: VisitLocation? = nil) throws {
        try model.queueCheckIn(visit, unplannedReason: visit.planned ? nil : "Extra call", location: location)
    }
    private func expect(_ error: AppModel.CallFailure, _ work: () throws -> Void) {
        XCTAssertThrowsError(try work()) { XCTAssertEqual($0 as? AppModel.CallFailure, error) }
    }
    func testPlanOrderOpenCallAndExplicitProductivityGuard() throws {
        XCTAssertEqual(model.visits.filter(\.planned).map(\.id), ["first", "second"])
        let first = try visit("first"), second = try visit("second"), extra = try visit("unplanned-extra")
        expect(.mcpOrder) { try start(second) }
        // Supplying an unplanned reason on a planned row cannot bypass its plan order.
        expect(.mcpOrder) { try model.queueCheckIn(second, unplannedReason: "Bypass", location: nil) }
        try start(first)
        XCTAssertNil(try visit("first").endedAt)
        expect(.alreadyStarted) { try start(first) }
        expect(.callOpen) { try start(second) }
        expect(.callOpen) { try start(extra) }
        XCTAssertThrowsError(try model.queueCheckOut(outcome: "", reason: nil, for: first))
        XCTAssertThrowsError(try model.queueCheckOut(outcome: "nonproductive", reason: "  ", for: first))
        XCTAssertEqual(try store.intents(for: partition).count, 1)
        expect(.callOpen) { try start(second) }
        clock.advance(24 * 60)
        try model.queueCheckOut(outcome: "nonproductive", reason: "Store closed", for: first)
        XCTAssertEqual(try visit("first").timeSpent, "24 min")
        expect(.alreadyClosed) { try model.queueCheckOut(outcome: "completed", reason: nil, for: first) }
        try start(second)
        XCTAssertEqual(try store.deferredOutbox(for: partition).count, 1, "offline End persisted before next Start")
    }
    func testAcceptedStartIsStillOpenAcrossModelRelaunch() async throws {
        let first = try visit("first"), second = try visit("second")
        try start(first)
        let initial = try XCTUnwrap(store.intents(for: partition).first)
        try store.recordAck(.init(entityId: "server-visit", eventIds: [], serverTime: 1_800_000_000_000),
                            for: initial.requestId, in: partition)
        model.enrollment.signedOut()
        model = try await makeModel()
        XCTAssertEqual(try visit("first").status, "Accepted")
        XCTAssertNotNil(try visit("first").startedAt)
        XCTAssertNil(try visit("first").endedAt)
        expect(.callOpen) { try start(second) }
        try model.queueCheckOut(outcome: "completed", reason: nil, for: first)
        XCTAssertEqual(try store.pendingOutbox(for: partition).first?.intent.kind, "visit.checkOut")
        XCTAssertNil(model.startFailure(for: second))
    }
    func testLegacyAbsentSequenceUsesSavedListOrder() throws {
        try save([planned("second"), planned("first")])
        model.refreshToday()
        XCTAssertEqual(model.visits.filter(\.planned).map(\.id), ["second", "first"])
        expect(.mcpOrder) { try start(try visit("first")) }
        try start(try visit("second"))
        try model.queueCheckOut(outcome: "completed", reason: nil, for: try visit("second"))
        try start(try visit("first"))
    }
    func testUnplannedNeedsNoEarlierPlanButBlocksEveryOtherCall() throws {
        let extra = try visit("unplanned-extra"), first = try visit("first"), second = try visit("second")
        try start(extra)
        expect(.callOpen) { try start(first) }
        expect(.callOpen) { try start(second) }
        try model.queueCheckOut(outcome: "completed", reason: nil, for: extra)
        expect(.mcpOrder) { try start(second) }
        try start(first)
    }
    func testOpenCallOnPastDayDoesNotBlockTodaysCall() throws {
        let old = try DiagnosticOperation.checkIn(plannedId: nil, outletId: "extra", day: "2026-10-01",
            intents: [], reason: "Earlier call", location: nil, now: clock.now.addingTimeInterval(-86_400))
        try store.enqueue(old, for: partition, now: clock.now)
        try start(try visit("first"))
    }
    func testFarUnreliableFixRecordedForStartAndEndAndMissingFixDoesNotBlock() throws {
        let fix = try VisitLocation(CLLocation(coordinate: CLLocationCoordinate2D(latitude: -80, longitude: -170),
            altitude: 0, horizontalAccuracy: 9_999, verticalAccuracy: 0, timestamp: clock.now.addingTimeInterval(-600)))
        let first = try visit("first")
        try start(first, location: fix)
        try model.queueCheckOut(outcome: "completed", reason: nil, for: first, location: fix)
        for op in try store.intents(for: partition) {
            let recorded = try XCTUnwrap(op.payload?["location"] as? [String: Any])
            XCTAssertEqual(recorded["latitude"] as? Double, -80)
            XCTAssertEqual(recorded["longitude"] as? Double, -170)
            XCTAssertEqual(recorded["accuracyMeters"] as? Double, 9_999)
            XCTAssertEqual(recorded["provider"] as? String, "gps")
            XCTAssertEqual((recorded["fixTime"] as? NSNumber)?.int64Value, fix.fixTime)
        }
        let second = try visit("second")
        try start(second)
        try model.queueCheckOut(outcome: "completed", reason: nil, for: second, location: nil)
        let missing = try store.intents(for: partition).suffix(2)
        XCTAssertTrue(missing.allSatisfy { $0.payload?["location"] is NSNull })
    }
    func testRejectedEndDoesNotUnlockNextStoreAndMapsServerReasons() throws {
        let first = try visit("first"), second = try visit("second")
        try start(first)
        try model.queueCheckOut(outcome: "completed", reason: nil, for: first)
        let end = try XCTUnwrap(store.deferredOutbox(for: partition).first?.intent)
        try store.recordRejection(code: "call_open", for: end.requestId, in: partition)
        model.refreshToday()
        expect(.callOpen) { try start(second) }
        XCTAssertTrue(model.review.contains { $0.contains("Finish the open call first") })
        let rejected = try DiagnosticOperation.checkIn(plannedId: "second", outletId: "second", day: day,
            intents: [], reason: nil, location: nil, now: clock.now)
        try store.enqueue(rejected, for: partition, now: clock.now)
        try store.recordRejection(code: "mcp_order", for: rejected.requestId, in: partition)
        model.refreshToday()
        XCTAssertTrue(model.review.contains { $0.contains("Visit stores in plan order") })
    }
    func testTodayDashboardFollowsTheDayFromTheStoreAndSurvivesRelaunch() async throws {
        try save([planned("second", sequence: 1), planned("first", sequence: 0)],
                 target: .init(dailyCalls: 30, productivePct: 85, sourceRef: "memo"))
        model.refreshToday()
        var board = model.dashboard
        XCTAssertEqual(board.dateLabel, "Fri, 2 Oct")
        XCTAssertEqual(board.route.map(\.id), ["first", "second"])
        XCTAssertEqual(board.route.map(\.position), [1, 2])
        XCTAssertEqual(board.next?.id, "first")
        XCTAssertNil(board.current)
        XCTAssertEqual(board.callsLabel, "0 of 30")
        XCTAssertEqual(board.productiveLabel, "0 · target 85%")
        XCTAssertEqual(board.completionLabel, "0 of 2 stores")

        try start(try visit("first"))
        board = model.dashboard
        XCTAssertEqual(board.current?.id, "first")
        XCTAssertNil(board.next, "no next outlet while a call is open")
        XCTAssertEqual(board.route.map(\.state), [.inProgress, .upcoming])

        clock.advance(20 * 60)
        try model.queueCheckOut(outcome: "completed", reason: nil, for: try visit("first"))
        board = model.dashboard
        XCTAssertEqual(board.next?.id, "second")
        XCTAssertEqual(board.route.first?.timeSpent, "20 min")
        XCTAssertEqual(board.callsLabel, "1 of 30")
        XCTAssertEqual(board.productiveLabel, "1 · 100% of 85%")

        // Offline: queued work and the saved target survive a relaunch without a network round trip.
        model.enrollment.signedOut()
        model = try await makeModel()
        try start(try visit("second"))
        try model.queueCheckOut(outcome: "nonproductive", reason: "Store closed", for: try visit("second"))
        board = model.dashboard
        XCTAssertEqual(board.target?.dailyCalls, 30)
        XCTAssertTrue(board.dayComplete)
        XCTAssertNil(board.next)
        XCTAssertEqual(board.completionLabel, "2 of 2 stores")
        XCTAssertEqual(board.productiveLabel, "1 · 50% of 85%")
        XCTAssertEqual(try store.pendingOutbox(for: partition).count + store.deferredOutbox(for: partition).count, 4)
    }
    func testTodayDashboardRejectedEndNeedsReviewAndDoesNotCount() throws {
        try start(try visit("first"))
        try model.queueCheckOut(outcome: "completed", reason: nil, for: try visit("first"))
        let end = try XCTUnwrap(store.deferredOutbox(for: partition).first?.intent)
        try store.recordRejection(code: "call_open", for: end.requestId, in: partition)
        model.refreshToday()
        let board = model.dashboard
        XCTAssertEqual(board.route.first?.state, .review)
        XCTAssertEqual(board.calls, 0)
        XCTAssertEqual(board.callsLabel, "0 · no target set")
    }
}
