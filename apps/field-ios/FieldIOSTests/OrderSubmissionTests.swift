import CryptoKit
import XCTest
@testable import FieldIOS

/// SP-0043 (IOS-015): review a saved order draft, queue it offline and follow its sync status.
@MainActor
final class OrderSubmissionTests: XCTestCase {
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
        directory = FileManager.default.temporaryDirectory.appending(path: "order-submit-\(UUID().uuidString)")
        secrets = KeychainStore(service: "com.sunpride.field.order-submit.tests.\(UUID().uuidString)")
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        partition = try StorePartition(subject: "test|seller", deviceId: "phone", scope: "scope")
        try save(sheet())
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
    private func line(_ id: String, _ code: String, _ name: String, uom: String = "CS") -> CallSheet.Line {
        .init(productId: id, code: code, name: name, uom: uom, barcode: nil, pricing: nil)
    }
    private func sheet(revision: Int = 1, lines: [CallSheet.Line]? = nil) -> CallSheet {
        CallSheet(outletId: "first", revision: revision,
            header: .init(accountName: "Sto. Niño Mart", address: nil, buyerName: nil, contactNumber: nil, accountInCharge: nil,
                          receivingInCharge: nil, distributorName: nil, distributorSchedule: nil, foc: nil, pricing: nil),
            lines: lines ?? [line("p-corned", "SP-100", "Corned Beef 150g"),
                             line("p-sardines", "SP-200", "Sardines", uom: "PC"),
                             line("p-tuna", "SP-210", "Tuna Flakes")])
    }
    private func save(_ sheet: CallSheet?, leaseSeconds: TimeInterval? = nil) throws {
        let expiry = Int64((leaseSeconds.map { clock.now.addingTimeInterval($0) } ?? FieldDay.nextClose(after: clock.now)).timeIntervalSince1970 * 1000)
        try store.saveSnapshot(.init(employee: .init(id: "seller", role: "sales", orgUnitId: "unit"),
            visits: [.init(id: "first", outletId: "first", serviceDate: day, planId: "plan", planVersion: 1, intents: ["sell"], sequence: 0)],
            outlets: [.init(id: "first", name: "Sto. Niño Mart", routeId: "route-1", code: "O-1", customerId: "cust-1",
                            territoryId: "territory-1", territoryCode: "T-1")],
            customers: [.init(id: "cust-1", code: "C-001")], route: .init(id: "route-1", code: "R-1"), tasks: [],
            callSheets: sheet.map { [$0] } ?? []),
            cursor: "cursor", leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: partition)
    }
    private func visit() throws -> AppModel.TodayVisit { try XCTUnwrap(model.visits.first { $0.id == "first" }) }
    private func startAndDraft(_ quantities: [(productId: String, quantity: Int)] = [("p-corned", 2), ("p-sardines", 24), ("p-tuna", 10)]) throws -> OrderDraft {
        try model.queueCheckIn(try visit(), unplannedReason: nil, location: nil)
        return try model.saveOrderDraft(draftId: nil, quantities: quantities, for: try visit())
    }
    private func checkInId() throws -> UUID { try XCTUnwrap(store.intents(for: partition).first { $0.kind == "visit.checkIn" }).requestId }
    private func expect(_ failure: OrderDraftFailure, _ work: () throws -> Void) {
        XCTAssertThrowsError(try work()) { XCTAssertEqual($0 as? OrderDraftFailure, failure, "\($0)") }
    }

    func testTotalsAreUnitsPerUomNeverAnAmount() throws {
        let draft = try startAndDraft()
        let totals = OrderSubmission.totals(draft)
        XCTAssertEqual(totals.products, 3)
        XCTAssertEqual(totals.units, [.init(uom: "CS", quantity: 12), .init(uom: "PC", quantity: 24)])
        XCTAssertEqual(totals.text, "3 products · 12 CS · 24 PC")
        let big = try model.saveOrderDraft(draftId: draft.draftId, quantities: [("p-corned", 12_345)], for: try visit())
        XCTAssertEqual(OrderSubmission.totals(big).text, "1 product · 12,345 CS")
    }

    func testActivityShapeMatchesTheV1SchemaBounds() throws {
        let draft = try startAndDraft([("p-corned", 2)])
        let activity = OrderSubmission.activity(draft)
        XCTAssertNoThrow(try OrderSubmission.validateActivity(activity))
        XCTAssertEqual(activity["clientOrderId"] as? String, draft.draftId)
        XCTAssertEqual(activity["kind"] as? String, "order_intent")
        let lines = try XCTUnwrap(activity["lines"] as? [[String: Any]])
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(Set(lines[0].keys), ["productId", "uom", "quantity"], "no price, amount or name on the wire")
        let good = ["productId": "p", "uom": "CS", "quantity": 1] as [String: Any]
        func with(_ lines: [[String: Any]], id: String = draft.draftId, extra: [String: Any] = [:]) -> [String: Any] {
            ["kind": "order_intent", "clientOrderId": id, "lines": lines].merging(extra) { a, _ in a }
        }
        let bad: [[String: Any]] = [
            with([good], extra: ["note": "x"]),
            with([good], id: draft.draftId.uppercased()),
            with([]),
            with([good, good]),
            with([good.merging(["unitPrice": 100]) { a, _ in a }]),
            with([good.merging(["quantity": 0]) { _, b in b }]),
            with([good.merging(["quantity": 100_000]) { _, b in b }]),
            with([good.merging(["quantity": 1.5]) { _, b in b }]),
            with([good.merging(["quantity": true]) { _, b in b }]),
            with([good.merging(["uom": " CS"]) { _, b in b }]),
            with([good.merging(["productId": " "]) { _, b in b }]),
        ]
        for activity in bad { XCTAssertThrowsError(try OrderSubmission.validateActivity(activity), "\(activity)") }
    }

    func testOfflineSubmitQueuesOneOrderBehindTheCallStartAndFreezesTheDraft() throws {
        let draft = try startAndDraft()
        XCTAssertEqual(model.orderStatus(draft), .draft)
        XCTAssertTrue(model.orderChecks(draft).allSatisfy { $0.ok }, "\(model.orderChecks(draft))")
        let before = try store.intents(for: partition).count
        clock.advance(30)
        let sent = try model.submitOrderDraft(draft.draftId)

        let requestId = try XCTUnwrap(sent.submittedRequestId.flatMap(UUID.init(uuidString:)))
        XCTAssertEqual(sent.submittedAt, Int64(clock.now.timeIntervalSince1970 * 1000))
        XCTAssertEqual(sent.lines, draft.lines)
        XCTAssertEqual(try store.intents(for: partition).count, before + 1)
        let queued = try XCTUnwrap(store.intent(for: requestId, in: partition))
        XCTAssertEqual(queued.kind, "visit.activity")
        XCTAssertEqual(queued.dependencies, [try checkInId().uuidString.lowercased()])
        XCTAssertNil(queued.payload?["visitId"], "no server visit ID yet: deferred, never a placeholder")
        let activity = try XCTUnwrap(queued.payload?["activity"] as? [String: Any])
        XCTAssertEqual(OrderSubmission.canonical(activity), OrderSubmission.canonical(OrderSubmission.activity(draft)))
        XCTAssertEqual(try store.requestState(for: requestId, in: partition), "deferred")
        XCTAssertEqual(try store.deferredOutbox(for: partition).map(\.intent.requestId), [requestId])
        XCTAssertEqual(model.orderStatus(sent), .queued)
        XCTAssertEqual(model.orderStatus(sent).label, "Waiting to send")

        // Read-only after sending: no edit, discard or second submission.
        expect(.submitted) { try model.saveOrderDraft(draftId: draft.draftId, quantities: [("p-corned", 3)], for: try visit()) }
        expect(.submitted) { try model.discardOrderDraft(draft.draftId) }
        expect(.submitted) { try model.submitOrderDraft(draft.draftId) }
        XCTAssertEqual(try store.intents(for: partition).count, before + 1)
        XCTAssertEqual(model.orderChecks(sent).first { $0.label == "Not sent yet" }?.problem, OrderDraftFailure.submitted.message)
        // The order counts as a recorded activity of the call.
        model.refreshToday()
        XCTAssertTrue(try visit().activityKinds.contains("order_intent"))
    }

    func testSyncStatusFollowsTheOutboxToReceivedOrNeedsReview() throws {
        let first = try startAndDraft([("p-corned", 2)])
        let sentFirst = try model.submitOrderDraft(first.draftId)
        let firstId = try XCTUnwrap(sentFirst.submittedRequestId.flatMap(UUID.init(uuidString:)))
        // The call start is accepted: the deferred order gets the server visit ID, then waits to send.
        try store.recordAck(ServerAck(entityId: "server-visit", eventIds: ["e1"], serverTime: 1), for: try checkInId(), in: partition)
        try store.materialize(firstId, visitId: "server-visit", in: partition)
        XCTAssertEqual(model.orderStatus(sentFirst), .queued)
        try store.recordAck(ServerAck(entityId: "activity-1", eventIds: ["e2"], serverTime: 2), for: firstId, in: partition)
        XCTAssertEqual(model.orderStatus(sentFirst), .received)
        XCTAssertEqual(model.orderStatus(sentFirst).label, "Received by office · not yet posted")

        // After the check-in ack a new order is queued ready to send, with the real visit ID.
        let second = try model.saveOrderDraft(draftId: nil, quantities: [("p-tuna", 1)], for: try visit())
        let sentSecond = try model.submitOrderDraft(second.draftId)
        let secondId = try XCTUnwrap(sentSecond.submittedRequestId.flatMap(UUID.init(uuidString:)))
        XCTAssertEqual(try store.intent(for: secondId, in: partition)?.payload?["visitId"] as? String, "server-visit")
        XCTAssertEqual(try store.requestState(for: secondId, in: partition), "pending")
        try store.recordRejection(code: "invalid_request", for: secondId, in: partition)
        XCTAssertEqual(model.orderStatus(sentSecond), .needsReview(code: "invalid_request"))
        XCTAssertFalse(OrderSubmission.reviewReason("invalid_request").isEmpty)

        // A held phone shows held, not "waiting".
        let third = try model.saveOrderDraft(draftId: nil, quantities: [("p-sardines", 4)], for: try visit())
        let sentThird = try model.submitOrderDraft(third.draftId)
        try store.holdForReview(partition)
        XCTAssertEqual(model.orderStatus(sentThird), .held)
    }

    func testForgedOrUnboundOrdersNeverReachTheOutbox() throws {
        let draft = try startAndDraft([("p-corned", 2)])
        let other = try model.saveOrderDraft(draftId: nil, quantities: [("p-tuna", 5)], for: try visit())
        let checkIn = try checkInId()
        let before = try store.intents(for: partition).count
        // Generic enqueue paths refuse any order_intent.
        let loose = try DiagnosticOperation.order(OrderSubmission.activity(draft), checkIn: checkIn, visitId: nil, now: clock.now)
        XCTAssertThrowsError(try store.enqueueDeferred(loose, for: partition, now: clock.now))
        XCTAssertThrowsError(try store.enqueue(loose, for: partition, now: clock.now))
        // Draft A cannot be frozen by draft B's request, by changed lines, or by a made-up visit ID.
        let otherRequest = try DiagnosticOperation.order(OrderSubmission.activity(other), checkIn: checkIn, visitId: nil, now: clock.now)
        var changed = OrderSubmission.activity(draft)
        changed["lines"] = [["productId": "p-corned", "uom": "CS", "quantity": 99]]
        let changedRequest = try DiagnosticOperation.order(changed, checkIn: checkIn, visitId: nil, now: clock.now)
        let fakeVisit = try DiagnosticOperation.order(OrderSubmission.activity(draft), checkIn: checkIn, visitId: "made-up", now: clock.now)
        let wrongCall = try DiagnosticOperation.order(OrderSubmission.activity(draft), checkIn: UUID(), visitId: nil, now: clock.now)
        for request in [otherRequest, changedRequest, fakeVisit, wrongCall] {
            XCTAssertThrowsError(try store.submitOrderDraft(draft.draftId, intent: request, for: partition, now: clock.now))
        }
        XCTAssertEqual(try store.intents(for: partition).count, before)
        XCTAssertNil(try store.orderDrafts(for: partition).first { $0.draftId == draft.draftId }?.submittedRequestId)
    }

    func testEndedHeldExpiredOrChangedSetupBlocksSending() throws {
        let draft = try startAndDraft([("p-corned", 2)])
        // The office changes the setup: the check blocks and the store refuses.
        try save(sheet(revision: 2))
        model.refreshToday()
        let catalog = model.orderChecks(draft).first { $0.label == "Products are set up for this account" }
        XCTAssertEqual(catalog?.problem, OrderDraftFailure.catalogChanged.message)
        expect(.catalogChanged) { try model.submitOrderDraft(draft.draftId) }
        let current = try model.saveOrderDraft(draftId: draft.draftId, quantities: [("p-corned", 2)], for: try visit())

        try store.holdForReview(partition)
        expect(.held) { try model.submitOrderDraft(current.draftId) }
        XCTAssertNotNil(model.orderChecks(current).first { $0.label == "Phone can still record today's work" }?.problem)
        try store.releaseHeld(partition)

        try save(sheet(revision: 2), leaseSeconds: 30)
        clock.advance(60)
        expect(.offlineExpired) { try model.submitOrderDraft(current.draftId) }
        try save(sheet(revision: 2))

        try model.queueCheckOut(outcome: "nonproductive", reason: "Buyer away", for: try visit())
        expect(.callEnded) { try model.submitOrderDraft(current.draftId) }
        XCTAssertEqual(model.orderStatus(current), .notSent)
        XCTAssertEqual(model.orderChecks(current).first?.problem, OrderDraftFailure.callEnded.message)
        XCTAssertFalse(try store.intents(for: partition).contains { ($0.payload?["activity"] as? [String: Any])?["kind"] as? String == "order_intent" })
    }

    func testPriceAndCreditAreInformationNotBlockers() throws {
        let draft = try startAndDraft([("p-corned", 2)])
        let checks = model.orderChecks(draft)
        XCTAssertEqual(checks.filter { !$0.blocking }.map(\.label), ["Prices", "Credit"])
        XCTAssertEqual(checks.first { $0.label == "Credit" }?.note, "Credit is checked by the office when the order arrives.")
        let summary = AccountSummary(outletId: "first", asOfDate: day, availability: "available", creditLimitMinor: 5_000_000,
            sales: .init(from: "2026-09-03", to: day, complete: true, orders: 1, amountMinor: 1, recentOrders: 0,
                         recentAmountMinor: 0, lastOrderDate: nil, lastOrderAmountMinor: nil),
            openOrders: .init(count: 1, amountMinor: 410_000))
        XCTAssertEqual(OrderSubmission.creditCheck(draft, summary: summary).note, "₱45,900.00 left after this order")
        let withheld = AccountSummary(outletId: "first", asOfDate: day, availability: "withheld", creditLimitMinor: nil, sales: nil, openOrders: nil)
        XCTAssertEqual(OrderSubmission.creditCheck(draft, summary: withheld).note, "Credit is checked by the office when the order arrives.")
    }
}
