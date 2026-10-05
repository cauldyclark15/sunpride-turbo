import CoreLocation
import CryptoKit
import XCTest
@testable import FieldIOS

/// IOS-017: End confirmation, the queued visit result, and no edits after End.
@MainActor
final class VisitCompletionTests: XCTestCase {
    private var directory: URL!
    private var secrets: KeychainStore!
    private var store: EncryptedFieldStore!
    private var partition: StorePartition!
    private var model: AppModel!
    private var clock: TestClock!
    private let day = "2026-10-02"

    private static let rules: [ActivityRule] = [
        .init(intent: "merchandise", version: "r1", activities: [.init(kind: "merchandising", required: true),
                                                                 .init(kind: "price_check", required: false)]),
        .init(intent: "future", version: "r4", activities: [.init(kind: "future_form", required: true)])
    ]
    private static let merchandising: [String: Any] = ["kind": "merchandising", "displayCondition": "compliant"]

    override func setUp() async throws {
        try await super.setUp()
        clock = TestClock(ISO8601DateFormatter().date(from: "2026-10-02T10:00:00+08:00")!)
        directory = FileManager.default.temporaryDirectory.appending(path: "visit-completion-\(UUID().uuidString)")
        secrets = KeychainStore(service: "com.sunpride.field.completion.tests.\(UUID().uuidString)")
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        partition = try StorePartition(subject: "test|seller", deviceId: "phone", scope: "scope")
        try save(rule: nil)
        try secrets.save(Data("test-session".utf8), for: StoreAccount.session)
        let registry = FakeRegistry()
        registry.lastMine = .success(MineResult(deviceId: "phone", status: "active", bound: true, allowedApp: "IOS"))
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        model = AppModel(auth: AuthClient(site: StubHTTP.site, store: secrets, http: StubHTTP.client()),
            registry: registry, store: secrets, localStore: store, now: clock.closure) { key }
        await model.launch()
        _ = try model.storage(for: partition)
        model.refreshToday()
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
    private func save(rule: String?) throws {
        let expiry = Int64(FieldDay.nextClose(after: clock.now).timeIntervalSince1970 * 1000)
        try store.saveSnapshot(.init(employee: .init(id: "seller", role: "sales", orgUnitId: "unit"),
            visits: [.init(id: "first", outletId: "first", serviceDate: day, planId: "plan", planVersion: 1,
                           intents: ["merchandise", "future"], sequence: 0),
                     .init(id: "second", outletId: "second", serviceDate: day, planId: "plan", planVersion: 1,
                           intents: ["merchandise"], sequence: 1)],
            outlets: ["first", "second", "extra"].map { .init(id: $0, name: $0, routeId: nil) },
            customers: [], route: nil, tasks: [], dayTarget: .init(productiveCallRule: rule), activityRules: Self.rules),
            cursor: "cursor", leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: partition)
    }
    private func visit(_ id: String) throws -> AppModel.TodayVisit { try XCTUnwrap(model.visits.first { $0.id == id }) }
    private func expect(_ error: AppModel.CallFailure, _ work: () throws -> Void) {
        XCTAssertThrowsError(try work()) { XCTAssertEqual($0 as? AppModel.CallFailure, error) }
    }
    private func fix(at time: Date, accuracy: Double) throws -> VisitLocation {
        try VisitLocation(CLLocation(coordinate: .init(latitude: 14.5, longitude: 121.0), altitude: 0,
                                     horizontalAccuracy: accuracy, verticalAccuracy: -1, timestamp: time))
    }

    func testReviewRefusesWhatEndWouldRefuseAndSummarisesTheRest() throws {
        try model.queueCheckIn(try visit("first"), unplannedReason: nil, location: nil)
        expect(.outcomeRequired) { _ = try model.endReview(outcome: nil, reason: nil, for: try visit("first")) }
        expect(.outcomeRequired) { _ = try model.endReview(outcome: "maybe", reason: nil, for: try visit("first")) }
        expect(.reasonRequired) { _ = try model.endReview(outcome: "nonproductive", reason: "  ", for: try visit("first")) }
        expect(.reasonRequired) { _ = try model.endReview(outcome: "nonproductive", reason: String(repeating: "x", count: 201), for: try visit("first")) }
        expect(.activitiesRequired) { _ = try model.endReview(outcome: "completed", reason: nil, for: try visit("first")) }
        try model.queueActivity(Self.merchandising, for: try visit("first"))
        clock.advance(12 * 60)
        let review = try model.endReview(outcome: "completed", reason: nil, for: try visit("first"))
        // future_form cannot be captured on this phone: the office reviews it, End is not blocked.
        XCTAssertEqual(review, EndReview(outcome: "completed", reasonCode: nil, recorded: ["merchandising"],
                                         officeReview: ["future_form"], minutes: 12, productive: true))
        let nonproductive = try model.endReview(outcome: "nonproductive", reason: " Store closed ", for: try visit("first"))
        XCTAssertEqual(nonproductive.reasonCode, "Store closed")
        XCTAssertEqual(nonproductive.officeReview, [], "not productive owes no forms")
        XCTAssertEqual(try store.intents(for: partition).count, 2, "review queues nothing")
    }

    func testConfirmedEndIsTheImmutableFinalRecord() throws {
        try model.queueCheckIn(try visit("first"), unplannedReason: nil, location: nil)
        let checkIn = try XCTUnwrap(store.intents(for: partition).first)
        try store.recordAck(.init(entityId: "server-visit", eventIds: [], serverTime: 1_800_000_000_000), for: checkIn.requestId, in: partition)
        try model.queueActivity(Self.merchandising, for: try visit("first"))
        XCTAssertNil(model.visitResult(for: try visit("first")))
        clock.advance(25 * 60)
        try model.queueCheckOut(outcome: "completed", reason: nil, for: try visit("first"),
                                location: try fix(at: clock.now, accuracy: 12))
        let end = try XCTUnwrap(store.intents(for: partition).last)
        XCTAssertEqual(end.kind, "visit.checkOut")
        let payload = try XCTUnwrap(end.payload)
        XCTAssertEqual(payload["outcome"] as? String, "completed")
        XCTAssertTrue(payload["reasonCode"] is NSNull)
        XCTAssertEqual((payload["deviceTime"] as? NSNumber)?.int64Value, Int64(clock.now.timeIntervalSince1970 * 1000))
        XCTAssertEqual(((payload["location"] as? [String: Any])?["accuracyMeters"] as? NSNumber)?.doubleValue, 12)
        let result = try XCTUnwrap(model.visitResult(for: try visit("first")))
        XCTAssertEqual(result, VisitResult(outcome: "completed", reasonCode: nil, recorded: ["merchandising"],
            officeReview: ["future_form"], minutes: 25, productive: true,
            location: "End location recorded · ±12 m", locationReview: false, sync: "Waiting to send"))
        // Final on this phone: no second End, no more forms or notes, through the model or the store.
        expect(.alreadyClosed) { _ = try model.endReview(outcome: "completed", reason: nil, for: try visit("first")) }
        expect(.alreadyClosed) { try model.queueCheckOut(outcome: "nonproductive", reason: "x", for: try visit("first")) }
        expect(.alreadyClosed) { try model.queueNote("late", for: try visit("first")) }
        expect(.alreadyClosed) { try model.queueActivity(Self.merchandising, for: try visit("first")) }
        let late = try DiagnosticOperation.note("late", checkIn: checkIn.requestId, visitId: "server-visit", now: clock.now)
        XCTAssertThrowsError(try store.enqueue(late, for: partition, now: clock.now)) { XCTAssertEqual($0 as? StoreError, .invalidInput) }
        let twice = try DiagnosticOperation.checkOut(outcome: "nonproductive", reason: "x", checkIn: checkIn.requestId,
                                                     visitId: "server-visit", now: clock.now)
        XCTAssertThrowsError(try store.enqueue(twice, for: partition, now: clock.now)) { XCTAssertEqual($0 as? StoreError, .invalidInput) }
        XCTAssertEqual(try store.intents(for: partition).count, 3, "nothing written after End")
        // Accepted once the server acks it.
        try store.recordAck(.init(entityId: "server-visit", eventIds: [], serverTime: 1_800_000_000_000), for: end.requestId, in: partition)
        XCTAssertEqual(model.visitResult(for: try visit("first"))?.sync, "Accepted")
    }

    func testMissingOrWeakEndLocationIsFlaggedNeverRefused() throws {
        try model.queueCheckIn(try visit("first"), unplannedReason: nil, location: nil)
        try model.queueCheckOut(outcome: "nonproductive", reason: "Closed", for: try visit("first"), location: nil)
        let none = try XCTUnwrap(model.visitResult(for: try visit("first")))
        XCTAssertTrue(none.locationReview)
        XCTAssertEqual(none.location, "End location unavailable · supervisor will review")
        XCTAssertEqual(none.reasonCode, "Closed")
        XCTAssertEqual(none.officeReview, [])
        XCTAssertEqual(none.productive, false)
        XCTAssertTrue(VisitCompletion.locationNotice(["accuracyMeters": 400, "fixTime": 0], deviceTime: 0).review)
        XCTAssertTrue(VisitCompletion.locationNotice(["accuracyMeters": 5, "fixTime": 0], deviceTime: 61_000).review, "stale fix")
        XCTAssertTrue(VisitCompletion.locationNotice(["accuracyMeters": 5, "fixTime": 0, "mockSignal": true], deviceTime: 0).review)
        XCTAssertFalse(VisitCompletion.locationNotice(["accuracyMeters": 50, "fixTime": 0], deviceTime: 60_000).review)
    }

    func testRejectedEndReopensTheCallSoItCanBeFinished() throws {
        try model.queueCheckIn(try visit("first"), unplannedReason: nil, location: nil)
        try model.queueCheckOut(outcome: "nonproductive", reason: "Closed", for: try visit("first"))
        let end = try XCTUnwrap(store.deferredOutbox(for: partition).last?.intent)
        try store.recordRejection(code: "invalid_request", for: end.requestId, in: partition)
        model.refreshToday()
        XCTAssertNil(model.visitResult(for: try visit("first")))
        XCTAssertFalse(model.visitProgress(for: try visit("first")).checkedOut)
        expect(.callOpen) { try model.queueCheckIn(try visit("second"), unplannedReason: nil, location: nil) }
        try model.queueNote("Owner back", for: try visit("first"))
        try model.queueCheckOut(outcome: "nonproductive", reason: "Closed", for: try visit("first"))
        XCTAssertEqual(model.visitResult(for: try visit("first"))?.recorded, ["note"])
        XCTAssertNoThrow(try model.queueCheckIn(try visit("second"), unplannedReason: nil, location: nil))
    }

    func testTruckSellerNoSalesMarkerMakesMerchandisingProductive() throws {
        try save(rule: "truck_seller")
        model.refreshToday()
        try model.queueCheckIn(try visit("first"), unplannedReason: nil, location: nil)
        try model.queueActivity(Self.merchandising, for: try visit("first"))
        XCTAssertEqual(try model.endReview(outcome: "completed", reason: nil, for: try visit("first")).productive, false)
        let marked = try model.endReview(outcome: "completed", reason: VisitCompletion.noSalesDueToInventory, for: try visit("first"))
        XCTAssertEqual(marked.productive, true)
        try model.queueCheckOut(outcome: "completed", reason: VisitCompletion.noSalesDueToInventory, for: try visit("first"))
        XCTAssertEqual(try store.intents(for: partition).last?.payload?["reasonCode"] as? String, "no_sales_due_to_inventory")
        let result = try XCTUnwrap(model.visitResult(for: try visit("first")))
        XCTAssertEqual(result.reasonCode, "no_sales_due_to_inventory")
        XCTAssertEqual(result.productive, true)
        XCTAssertEqual(VisitCompletion.reasonLabel(result.reasonCode!), "No sales · store has enough stock")
    }

    func testUnplannedVisitIsNotACallSoHasNoProductiveResult() throws {
        try model.queueCheckIn(try visit("unplanned-extra"), unplannedReason: "Walk-in", intents: ["merchandise"], location: nil)
        try model.queueActivity(Self.merchandising, for: try visit("unplanned-extra"))
        let review = try model.endReview(outcome: "completed", reason: nil, for: try visit("unplanned-extra"))
        XCTAssertNil(review.productive)
        try model.queueCheckOut(outcome: "completed", reason: nil, for: try visit("unplanned-extra"))
        XCTAssertNil(model.visitResult(for: try visit("unplanned-extra"))?.productive)
    }

    func testCheckOutOperationTrimsAndBoundsTheReason() throws {
        let start = UUID()
        let trimmed = try DiagnosticOperation.checkOut(outcome: "nonproductive", reason: "  Closed  ", checkIn: start, visitId: "v")
        XCTAssertEqual(trimmed.payload?["reasonCode"] as? String, "Closed")
        XCTAssertThrowsError(try DiagnosticOperation.checkOut(outcome: "nonproductive", reason: " ", checkIn: start, visitId: "v"))
        XCTAssertThrowsError(try DiagnosticOperation.checkOut(outcome: "completed", reason: String(repeating: "x", count: 201),
                                                              checkIn: start, visitId: "v"))
        let blank = try DiagnosticOperation.checkOut(outcome: "completed", reason: " ", checkIn: start, visitId: "v")
        XCTAssertTrue(blank.payload?["reasonCode"] is NSNull)
    }
}
