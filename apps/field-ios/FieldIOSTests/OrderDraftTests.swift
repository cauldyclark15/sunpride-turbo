import CryptoKit
import XCTest
@testable import FieldIOS

/// SP-0044 (IOS-014): offline order drafts from the account's authorized catalog.
@MainActor
final class OrderDraftTests: XCTestCase {
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
        directory = FileManager.default.temporaryDirectory.appending(path: "order-draft-\(UUID().uuidString)")
        secrets = KeychainStore(service: "com.sunpride.field.order.tests.\(UUID().uuidString)")
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        partition = try StorePartition(subject: "test|seller", deviceId: "phone", scope: "scope")
        try save(sheet())
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
    private func line(_ id: String, _ code: String, _ name: String, uom: String = "CS", barcode: String? = nil) -> CallSheet.Line {
        .init(productId: id, code: code, name: name, uom: uom, barcode: barcode, pricing: "Net of 5% outright")
    }
    private func sheet(revision: Int = 1, lines: [CallSheet.Line]? = nil) -> CallSheet {
        CallSheet(outletId: "first", revision: revision,
            header: .init(accountName: "Sto. Niño Mart", address: nil, buyerName: nil, contactNumber: nil, accountInCharge: nil,
                          receivingInCharge: nil, distributorName: nil, distributorSchedule: nil, foc: nil, pricing: "Per Annex C"),
            lines: lines ?? [line("p-corned", "SP-100", "Corned Beef 150g", barcode: "4800001"),
                             line("p-sardines", "SP-200", "Sardines in Tomato Sauce", uom: "PC"),
                             line("p-tuna", "SP-210", "Tuna Flakes Niçoise")])
    }
    private func save(_ sheet: CallSheet?, territory: Bool = true, leaseSeconds: TimeInterval? = nil) throws {
        let expiry = Int64((leaseSeconds.map { clock.now.addingTimeInterval($0) } ?? FieldDay.nextClose(after: clock.now)).timeIntervalSince1970 * 1000)
        let outlets: [StoreSnapshot.Outlet] = [
            .init(id: "first", name: "Sto. Niño Mart", routeId: "route-1", code: "O-1", customerId: "cust-1",
                  territoryId: territory ? "territory-1" : nil, territoryCode: territory ? "T-NCR-1" : nil),
            .init(id: "second", name: "Second", routeId: "route-1"),
        ]
        try store.saveSnapshot(.init(employee: .init(id: "seller", role: "sales", orgUnitId: "unit"),
            visits: [.init(id: "first", outletId: "first", serviceDate: day, planId: "plan", planVersion: 1, intents: ["sell"], sequence: 0),
                     .init(id: "second", outletId: "second", serviceDate: day, planId: "plan", planVersion: 1, intents: ["sell"], sequence: 1)],
            outlets: outlets, customers: [.init(id: "cust-1", code: "C-001")], route: .init(id: "route-1", code: "R-1"), tasks: [],
            callSheets: sheet.map { [$0] } ?? []),
            cursor: "cursor", leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: partition)
    }
    private func visit(_ id: String = "first") throws -> AppModel.TodayVisit { try XCTUnwrap(model.visits.first { $0.id == id }) }
    private func start(_ id: String = "first") throws { try model.queueCheckIn(try visit(id), unplannedReason: nil, location: nil) }
    private func expect(_ failure: OrderDraftFailure, _ work: () throws -> Void) {
        XCTAssertThrowsError(try work()) { XCTAssertEqual($0 as? OrderDraftFailure, failure, "\($0)") }
    }

    func testSearchIsAccentAndCaseInsensitiveExactCodeFirst() {
        let items = OrderCatalog.items(sheet())
        XCTAssertEqual(OrderCatalog.search(items, "").map(\.productId), ["p-corned", "p-sardines", "p-tuna"])
        XCTAssertEqual(OrderCatalog.search(items, "nicoise").map(\.productId), ["p-tuna"])
        XCTAssertEqual(OrderCatalog.search(items, "TOMATO sardines").map(\.productId), ["p-sardines"])
        XCTAssertEqual(OrderCatalog.search(items, "4800001").map(\.productId), ["p-corned"])
        // Exact code ranks before a name that merely contains the words.
        XCTAssertEqual(OrderCatalog.search(items, "sp 210").first?.productId, "p-tuna")
        XCTAssertEqual(OrderCatalog.search(items, "sp").map(\.productId), ["p-corned", "p-sardines", "p-tuna"])
        XCTAssertTrue(OrderCatalog.search(items, "milk").isEmpty)
        XCTAssertEqual(OrderCatalog.normalize("  Sto. Niño—Mart "), "sto nino mart")
        XCTAssertTrue(OrderCatalog.items(nil).isEmpty, "no setup, no products: the national master is never offered")
    }

    func testQuantityIsBlankOrWholeNumberInRange() throws {
        XCTAssertNil(try OrderDraftRules.quantity("  "))
        XCTAssertEqual(try OrderDraftRules.quantity(" 12 "), 12)
        XCTAssertEqual(try OrderDraftRules.quantity("99999"), 99_999)
        for bad in ["0", "100000", "1.5", "-2", "1e3", "١٢", "12a", "000001"] {
            XCTAssertThrowsError(try OrderDraftRules.quantity(bad), bad) { XCTAssertEqual($0 as? OrderDraftFailure, .invalidQuantity) }
        }
    }

    func testDraftBelongsToTheOpenCallIsAssociatedFromTheSnapshotAndSurvivesRelaunch() async throws {
        expect(.callNotOpen) { try model.saveOrderDraft(draftId: nil, quantities: [("p-corned", 2)], for: try visit()) }
        try start()
        let intentsBefore = try store.intents(for: partition).count
        let draft = try model.saveOrderDraft(draftId: nil, quantities: [("p-corned", 2), ("p-tuna", 10)], for: try visit())
        let checkIn = try XCTUnwrap(store.intents(for: partition).first)
        XCTAssertEqual(draft.checkInRequestId, checkIn.requestId.uuidString.lowercased())
        XCTAssertEqual(draft.clientVisitId, checkIn.payload?["clientVisitId"] as? String)
        XCTAssertEqual(draft.plannedVisitId, "first")
        XCTAssertEqual(draft.outletId, "first")
        XCTAssertEqual(draft.serviceDate, day)
        XCTAssertEqual(draft.customerId, "cust-1")
        XCTAssertEqual(draft.customerCode, "C-001")
        XCTAssertEqual(draft.territoryId, "territory-1")
        XCTAssertEqual(draft.territoryCode, "T-NCR-1")
        XCTAssertEqual(draft.routeId, "route-1")
        XCTAssertEqual(draft.catalogRevision, 1)
        XCTAssertEqual(draft.priceAvailability, "unavailable")
        XCTAssertEqual(draft.lines, [.init(productId: "p-corned", code: "SP-100", name: "Corned Beef 150g", uom: "CS", quantity: 2),
                                     .init(productId: "p-tuna", code: "SP-210", name: "Tuna Flakes Niçoise", uom: "CS", quantity: 10)])
        XCTAssertNil(draft.submittedRequestId)
        // Local only: nothing new in the outbox; no price/amount keys at all.
        XCTAssertEqual(try store.intents(for: partition).count, intentsBefore)
        let encoded = String(decoding: try JSONEncoder().encode(draft), as: UTF8.self)
        XCTAssertFalse(encoded.contains("price\""), "no unit price"); XCTAssertFalse(encoded.contains("amount")); XCTAssertFalse(encoded.contains("total"))
        XCTAssertEqual(model.orderDrafts(for: try visit()).map(\.draftId), [draft.draftId])
        XCTAssertTrue(model.orderDrafts(for: try visit("second")).isEmpty)

        clock.advance(60)
        let edited = try model.saveOrderDraft(draftId: draft.draftId, quantities: [("p-sardines", 5)], for: try visit())
        XCTAssertEqual(edited.draftId, draft.draftId)
        XCTAssertEqual(edited.createdAt, draft.createdAt)
        XCTAssertEqual(edited.updatedAt, draft.createdAt + 60_000)
        XCTAssertEqual(edited.lines.map(\.productId), ["p-sardines"])
        XCTAssertEqual(try store.orderDrafts(for: partition).count, 1)

        // Offline relaunch: the draft is still there for the same call.
        model.enrollment.signedOut()
        model = try await makeModel()
        XCTAssertEqual(model.orderDrafts(for: try visit()), [edited])
    }

    func testRefusesEmptyUnknownProductsAndStaleCatalog() throws {
        try start()
        expect(.empty) { try model.saveOrderDraft(draftId: nil, quantities: [], for: try visit()) }
        expect(.catalogChanged) { try model.saveOrderDraft(draftId: nil, quantities: [("national-only", 1)], for: try visit()) }
        expect(.invalidQuantity) { try model.saveOrderDraft(draftId: nil, quantities: [("p-corned", 0)], for: try visit()) }
        let draft = try model.saveOrderDraft(draftId: nil, quantities: [("p-corned", 2), ("p-tuna", 1)], for: try visit())

        // The office drops tuna and changes corned beef's UOM: revision 2 arrives with the next sync.
        try save(sheet(revision: 2, lines: [line("p-corned", "SP-100", "Corned Beef 150g", uom: "PC"),
                                            line("p-sardines", "SP-200", "Sardines in Tomato Sauce", uom: "PC")]))
        model.refreshToday()
        XCTAssertEqual(OrderDraftRules.staleLines(draft, sheet: model.callSheet(for: try visit())).map(\.productId), ["p-corned", "p-tuna"])
        // The old version can no longer be written back as-is (stale screen / forged write).
        let resaved = OrderDraft(draftId: draft.draftId, clientVisitId: draft.clientVisitId, checkInRequestId: draft.checkInRequestId,
            plannedVisitId: draft.plannedVisitId, outletId: draft.outletId, serviceDate: draft.serviceDate,
            customerId: draft.customerId, customerCode: draft.customerCode, territoryId: draft.territoryId,
            territoryCode: draft.territoryCode, routeId: draft.routeId, catalogRevision: 1, lines: draft.lines,
            createdAt: draft.createdAt, updatedAt: draft.updatedAt + 1)
        XCTAssertThrowsError(try store.saveOrderDraft(resaved, for: partition, now: clock.now)) {
            XCTAssertEqual($0 as? OrderDraftFailure, .catalogChanged)
        }
        let updated = try model.saveOrderDraft(draftId: draft.draftId, quantities: [("p-corned", 3)], for: try visit())
        XCTAssertEqual(updated.catalogRevision, 2)
        XCTAssertEqual(updated.lines.first?.uom, "PC")

        // Account loses its whole setup.
        try save(nil)
        model.refreshToday()
        XCTAssertTrue(model.orderCatalog(for: try visit()).isEmpty)
        expect(.noCatalog) { try model.saveOrderDraft(draftId: draft.draftId, quantities: [("p-corned", 3)], for: try visit()) }
    }

    func testForgedAssociationAndIdentityAreRefusedInTheTransaction() throws {
        try start()
        let draft = try model.saveOrderDraft(draftId: nil, quantities: [("p-corned", 2)], for: try visit())
        func forged(customerId: String? = "cust-1", outletId: String = "first", createdAt: Int64? = nil,
                    submitted: String? = nil, price: String = "unavailable") -> OrderDraft {
            var d = OrderDraft(draftId: draft.draftId, clientVisitId: draft.clientVisitId, checkInRequestId: draft.checkInRequestId,
                plannedVisitId: draft.plannedVisitId, outletId: outletId, serviceDate: draft.serviceDate,
                customerId: customerId, customerCode: draft.customerCode, territoryId: draft.territoryId,
                territoryCode: draft.territoryCode, routeId: draft.routeId, catalogRevision: draft.catalogRevision,
                lines: draft.lines, createdAt: createdAt ?? draft.createdAt, updatedAt: draft.updatedAt + 1)
            d.submittedRequestId = submitted; d.priceAvailability = price
            return d
        }
        for bad in [forged(customerId: "someone-else"), forged(outletId: "second"), forged(createdAt: 1),
                    forged(submitted: UUID().uuidString.lowercased()), forged(price: "available")] {
            XCTAssertThrowsError(try store.saveOrderDraft(bad, for: partition, now: clock.now))
        }
        XCTAssertEqual(try store.orderDrafts(for: partition), [draft])
    }

    func testEndedHeldAndExpiredCallsFreezeTheDraft() throws {
        try start()
        let draft = try model.saveOrderDraft(draftId: nil, quantities: [("p-corned", 2)], for: try visit())
        try model.queueCheckOut(outcome: "nonproductive", reason: "Buyer away", for: try visit())
        expect(.callEnded) { try model.saveOrderDraft(draftId: draft.draftId, quantities: [("p-corned", 4)], for: try visit()) }
        expect(.callEnded) { try model.saveOrderDraft(draftId: nil, quantities: [("p-corned", 4)], for: try visit()) }
        XCTAssertEqual(model.orderDrafts(for: try visit()), [draft], "ended call keeps its saved draft for review")

        try start("second") // Another open call, no setup for it.
        expect(.noCatalog) { try model.saveOrderDraft(draftId: nil, quantities: [("p-corned", 1)], for: try visit("second")) }

        try store.holdForReview(partition)
        expect(.held) { try store.discardOrderDraft(draft.draftId, for: partition) }
        try store.releaseHeld(partition)

        // Lease expiry (end of offline day) stops new saves.
        try save(sheet(), leaseSeconds: 30)
        model.refreshToday()
        clock.advance(60)
        XCTAssertThrowsError(try store.saveOrderDraft(draft, for: partition, now: clock.now)) {
            XCTAssertEqual($0 as? OrderDraftFailure, .offlineExpired)
        }
    }

    func testHeldPartitionRefusesSaveAndDiscardIsScoped() throws {
        try start()
        let draft = try model.saveOrderDraft(draftId: nil, quantities: [("p-tuna", 7)], for: try visit())
        let other = try StorePartition(subject: "test|other", deviceId: "phone", scope: "scope")
        XCTAssertTrue(try store.orderDrafts(for: other).isEmpty)
        XCTAssertThrowsError(try store.discardOrderDraft(draft.draftId, for: other)) {
            XCTAssertEqual($0 as? OrderDraftFailure, .unknownDraft)
        }
        try store.holdForReview(partition)
        expect(.held) { try model.saveOrderDraft(draftId: draft.draftId, quantities: [("p-tuna", 8)], for: try visit()) }
        try store.releaseHeld(partition)
        try model.discardOrderDraft(draft.draftId)
        XCTAssertTrue(model.orderDrafts(for: try visit()).isEmpty)
        XCTAssertTrue(try store.orderDrafts(for: partition).isEmpty)
        expect(.unknownDraft) { try model.discardOrderDraft(draft.draftId) }
    }

    func testDraftsStayEncryptedAndSurviveCachePurgeAsHeldWork() throws {
        try start()
        _ = try model.saveOrderDraft(draftId: nil, quantities: [("p-corned", 2)], for: try visit())
        for suffix in ["", "-wal"] {
            if let raw = try? Data(contentsOf: URL(fileURLWithPath: store.url.path + suffix)) {
                XCTAssertNil(raw.range(of: Data("Corned Beef 150g".utf8)))
            }
        }
        try store.purgeCacheForReview(partition)
        XCTAssertEqual(try store.orderDrafts(for: partition).count, 1, "unsent work is kept for supervised review")
        XCTAssertThrowsError(try store.saveOrderDraft(try XCTUnwrap(store.orderDrafts(for: partition).first), for: partition, now: clock.now)) {
            XCTAssertEqual($0 as? OrderDraftFailure, .held)
        }
    }

    func testOlderServerWithoutTerritoryStoresNull() throws {
        try save(sheet(), territory: false)
        model.refreshToday()
        try start()
        let draft = try model.saveOrderDraft(draftId: nil, quantities: [("p-corned", 1)], for: try visit())
        XCTAssertNil(draft.territoryId)
        XCTAssertNil(draft.territoryCode)
    }

    func testV3MigrationKeepsOutboxAndAddsDraftsAndPhotos() throws {
        try start()
        let queued = try XCTUnwrap(store.intents(for: partition).first)
        try store.prepareLegacyV3()
        XCTAssertEqual(store.schemaVersion, 3)
        store.close()
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        XCTAssertEqual(store.schemaVersion, 5)
        XCTAssertEqual(try store.pendingOutbox(for: partition).map(\.intent), [queued])
        XCTAssertEqual(try store.snapshot(for: partition)?.callSheets.count, 1)
        XCTAssertTrue(try store.orderDrafts(for: partition).isEmpty)
        XCTAssertTrue(try store.pendingPhotos(for: partition).isEmpty)
    }
}
