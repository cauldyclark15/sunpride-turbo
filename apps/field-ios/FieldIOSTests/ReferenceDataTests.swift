import Foundation
import XCTest
@testable import FieldIOS

/// Typed fixtures exercise the real wire encoder/decoder, without copying shared contract files.
enum ReferenceDataFixture {
    static func product(revision: Int64 = 1_759_550_000_000, name: String = "CatalogCiphertextMarker123456789", code: String = "SUNP-001", uom: String = "CAN",
                        barcodes: [BootstrapV1.Product.Barcode] = [.init(barcode: "4800000000017", uom: "CAN")]) -> BootstrapV1.Product {
        .init(id: "product-1", code: code, name: name, uom: uom, revision: revision,
              quantityScale: 1000, baseUom: .init(code: "CAN", name: "Can", decimalPlaces: 0),
              sellingUoms: [.init(code: "CS", name: "Case", decimalPlaces: 0,
                                 toBase: .init(numerator: 48000, denominator: 1, roundingMode: "exact"))], barcodes: barcodes)
    }
    static func stock(revision: Int64 = 1_759_550_000_123, available: Int64 = 24000) -> BootstrapV1.InventoryAvailability {
        .init(id: "balance-1", productId: "product-1", locationId: "location-1", locationCode: "BR-MNL-01",
              locationName: "InventoryCiphertextMarker123456789", availableBase: available, physicalBase: 30000,
              reservedBase: 6000, revision: revision, asOf: revision)
    }
    static func sheet(outletId: String = "outlet-1") -> CallSheet {
        .init(outletId: outletId, revision: 2,
              header: .init(accountName: "Account", address: nil, buyerName: nil, contactNumber: nil,
                            accountInCharge: nil, receivingInCharge: nil, distributorName: nil,
                            distributorSchedule: nil, foc: nil, pricing: nil),
              lines: [.init(productId: "product-1", code: "OLD", name: "Old name", uom: "PC", barcode: "old-barcode", pricing: "Account price"),
                      .init(productId: "other-product", code: "OTHER", name: "Unaffected", uom: "PC", barcode: nil, pricing: nil)])
    }
    static func snapshot(products: [BootstrapV1.Product] = [product()],
                         inventory: [BootstrapV1.InventoryAvailability] = [stock()]) -> StoreSnapshot {
        .init(employee: .init(id: "employee-1", role: "sales", orgUnitId: "unit-1"), visits: [],
              outlets: [.init(id: "outlet-1", name: "One", routeId: nil), .init(id: "outlet-2", name: "Two", routeId: nil)],
              customers: [], route: nil, tasks: [], callSheets: [sheet(), sheet(outletId: "outlet-2")],
              productCatalog: products, inventoryAvailability: inventory)
    }
    private struct WireChange<T: Encodable>: Encodable {
        let seq: Int64; let entity: String; let id: String; let revision: Int64
        let op = "upsert"; let value: T
    }
    static func change<T: Encodable>(_ entity: String, id: String, revision: Int64, value: T, seq: Int64 = 1) throws -> DeltaChange {
        try JSONDecoder().decode(DeltaChange.self, from: JSONEncoder().encode(
            WireChange(seq: seq, entity: entity, id: id, revision: revision, value: value)))
    }
    static func change(_ product: BootstrapV1.Product, seq: Int64 = 1) throws -> DeltaChange {
        try change("product", id: product.id, revision: XCTUnwrap(product.revision), value: product, seq: seq)
    }
    static func change(_ stock: BootstrapV1.InventoryAvailability, seq: Int64 = 1) throws -> DeltaChange {
        try change("inventory", id: stock.id, revision: stock.revision, value: stock, seq: seq)
    }
}

@MainActor
final class ReferenceDataTests: XCTestCase {
    private var directory: URL!
    private var secrets: KeychainStore!
    private var store: EncryptedFieldStore!
    private var partition: StorePartition!
    private let expiry: Int64 = 1_900_000_000_000

    override func setUp() async throws {
        try await super.setUp()
        directory = FileManager.default.temporaryDirectory.appending(path: "reference-data-\(UUID().uuidString)")
        secrets = KeychainStore(service: "com.sunpride.reference.tests.\(UUID().uuidString)")
        partition = try StorePartition(subject: "issuer|seller", deviceId: "phone-1", scope: "scope-1")
        store = try open()
    }
    override func tearDown() async throws {
        store.close()
        try? secrets.delete("db")
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }
    private func open() throws -> EncryptedFieldStore {
        try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
    }
    private func seed(_ snapshot: StoreSnapshot = ReferenceDataFixture.snapshot(), cursor: String = "initial") throws {
        try store.saveSnapshot(snapshot, cursor: cursor, leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: partition)
    }

    func testOldAndNewCatalogShapesAndNullableMetadataRoundTrip() throws {
        let old = try JSONDecoder().decode(BootstrapV1.Product.self,
            from: Data(#"{"id":"legacy","code":"OLD","name":"Legacy","uom":"PC"}"#.utf8))
        XCTAssertNil(old.revision); XCTAssertNil(old.quantityScale); XCTAssertNil(old.baseUom)
        XCTAssertNil(old.sellingUoms); XCTAssertNil(old.barcodes)
        let product = ReferenceDataFixture.product()
        let decoded = try JSONDecoder().decode(BootstrapV1.Product.self, from: JSONEncoder().encode(product))
        XCTAssertEqual(decoded, product)
        XCTAssertEqual(decoded.sellingUoms?.first?.toBase?.numerator, 48000)
        XCTAssertEqual(decoded.sellingUoms?.first?.toBase?.roundingMode, "exact")
        let nullable = try JSONDecoder().decode(BootstrapV1.Product.self, from: Data(#"{"id":"p","code":"P","name":"P","uom":"PC","revision":1759550000000,"quantityScale":1000,"baseUom":null,"sellingUoms":[{"code":"PC","name":"Piece","decimalPlaces":0,"toBase":null}],"barcodes":[{"barcode":"123","uom":null}]}"#.utf8))
        XCTAssertNil(nullable.baseUom); XCTAssertNil(nullable.sellingUoms?.first?.toBase)
        XCTAssertNil(nullable.barcodes?.first?.uom)
    }

    func testBootstrapPageAcceptsReferenceDataAndOldCatalog() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "bootstrap-response", withExtension: "json"))
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let product = ReferenceDataFixture.product(), stock = ReferenceDataFixture.stock()
        object["productCatalog"] = [try JSONSerialization.jsonObject(with: JSONEncoder().encode(product))]
        object["inventoryAvailability"] = [try JSONSerialization.jsonObject(with: JSONEncoder().encode(stock))]
        let page = try JSONDecoder().decode(BootstrapV1.Page.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(page.productCatalog, [product]); XCTAssertEqual(page.inventoryAvailability, [stock])
        let roundTrip = try JSONDecoder().decode(BootstrapV1.Page.self, from: JSONEncoder().encode(page))
        XCTAssertEqual(roundTrip.inventoryAvailability, [stock])
        object["productCatalog"] = [["id": "old", "code": "OLD", "name": "Old", "uom": "PC"]]
        object.removeValue(forKey: "inventoryAvailability")
        let old = try JSONDecoder().decode(BootstrapV1.Page.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(old.productCatalog.first?.revision); XCTAssertTrue(old.inventoryAvailability.isEmpty)
    }

    func testReferenceInt64sSurviveDeltaDecodeAndPersistenceExactly() throws {
        let large: Int64 = 9_007_199_254_740_993 // Beyond Double's exact integer range.
        let product = ReferenceDataFixture.product(revision: large)
        let stock = ReferenceDataFixture.stock(revision: large, available: Int64.max)
        try seed()
        try store.applyDelta([ReferenceDataFixture.change(product), ReferenceDataFixture.change(stock)], nextCursor: "large", for: partition)
        XCTAssertEqual(try store.catalog(for: partition).first?.revision, large)
        XCTAssertEqual(try store.availability(productId: product.id, for: partition).first, stock)
        XCTAssertEqual(try store.availability(productId: product.id, for: partition).first?.availableBase, Int64.max)
    }

    func testReferenceDeltaAcceptsSharedAndZeroSequenceButRejectsUnknownAndTombstone() throws {
        let changes = try [ReferenceDataFixture.change(ReferenceDataFixture.product(), seq: 0),
                           ReferenceDataFixture.change(ReferenceDataFixture.stock(), seq: 0)]
        XCTAssertEqual(changes.map(\.seq), [0, 0])
        XCTAssertThrowsError(try JSONDecoder().decode(DeltaChange.self,
            from: Data(#"{"seq":1,"entity":"future","id":"x","revision":1,"op":"upsert","value":{}}"#.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(DeltaChange.self,
            from: Data(#"{"seq":1,"entity":"product","id":"x","revision":1,"op":"tombstone"}"#.utf8)))
        try seed(); try store.applyDelta(changes, nextCursor: "zero", for: partition)
        XCTAssertEqual(try store.catalog(for: partition).count, 1)
        XCTAssertEqual(try store.availability(productId: "product-1", for: partition).count, 1)
    }

    func testSnapshotPersistenceEncryptionAndPartitionIsolation() throws {
        let snapshot = ReferenceDataFixture.snapshot()
        try seed(snapshot)
        for suffix in ["", "-wal"] {
            if let bytes = try? Data(contentsOf: URL(fileURLWithPath: store.url.path + suffix)) {
                XCTAssertNil(bytes.range(of: Data("CatalogCiphertextMarker123456789".utf8)))
                XCTAssertNil(bytes.range(of: Data("InventoryCiphertextMarker123456789".utf8)))
            }
        }
        store.close(); store = try open()
        XCTAssertEqual(try store.snapshot(for: partition)?.productCatalog, snapshot.productCatalog)
        XCTAssertEqual(try store.snapshot(for: partition)?.inventoryAvailability, snapshot.inventoryAvailability)
        XCTAssertTrue(try store.availability(productId: "missing", for: partition).isEmpty)
        for other in [try StorePartition(subject: "issuer|other", deviceId: partition.deviceId, scope: partition.scope),
                      try StorePartition(subject: partition.subject, deviceId: "other-phone", scope: partition.scope),
                      try StorePartition(subject: partition.subject, deviceId: partition.deviceId, scope: "other-scope")] {
            XCTAssertTrue(try store.catalog(for: other).isEmpty)
            XCTAssertTrue(try store.availability(productId: "product-1", for: other).isEmpty)
            try store.saveSnapshot(ReferenceDataFixture.snapshot(products: [], inventory: []), cursor: "other",
                                   leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: other)
            try store.applyDelta([ReferenceDataFixture.change(ReferenceDataFixture.product(name: "Other partition"))], nextCursor: "other-delta", for: other)
            XCTAssertEqual(try store.catalog(for: partition), snapshot.productCatalog)
            XCTAssertEqual(try store.callSheets(for: partition), snapshot.callSheets)
        }
    }

    /// QSR-010: sign-out and revocation drop cached products and stock with the rest of the server cache.
    func testCachePurgeDropsProductsAndStock() throws {
        try seed(ReferenceDataFixture.snapshot())
        try store.purgeCacheForReview(partition)
        XCTAssertTrue(try store.catalog(for: partition).isEmpty)
        XCTAssertTrue(try store.availability(productId: "product-1", for: partition).isEmpty)
        try seed(ReferenceDataFixture.snapshot())
        try store.releaseHeld(partition)
        XCTAssertFalse(try store.catalog(for: partition).isEmpty)
        try store.purgeAllCachesForReview()
        store.close(); store = try open()
        XCTAssertTrue(try store.catalog(for: partition).isEmpty)
        XCTAssertTrue(try store.availability(productId: "product-1", for: partition).isEmpty)
    }

    func testSnapshotReferenceInsertRollbackAndGenerationReplacement() throws {
        let snapshot = ReferenceDataFixture.snapshot()
        try seed(snapshot)
        let invalid = ReferenceDataFixture.snapshot(products: [ReferenceDataFixture.product(name: "Replacement")],
                                                    inventory: snapshot.inventoryAvailability + snapshot.inventoryAvailability)
        XCTAssertThrowsError(try store.saveSnapshot(invalid, cursor: "bad", leaseExpiresAt: 1, cacheExpiresAt: 1, for: partition))
        XCTAssertEqual(try store.cursor(for: partition), "initial")
        XCTAssertEqual(try store.leaseExpiry(for: partition), expiry)
        XCTAssertEqual(try store.catalog(for: partition), snapshot.productCatalog)
        XCTAssertEqual(try store.availability(productId: "product-1", for: partition), snapshot.inventoryAvailability)
        try seed(ReferenceDataFixture.snapshot(products: [], inventory: []), cursor: "empty-snapshot")
        XCTAssertTrue(try store.catalog(for: partition).isEmpty)
        XCTAssertTrue(try store.availability(productId: "product-1", for: partition).isEmpty)
        store.close(); store = try open()
        XCTAssertEqual(try store.cursor(for: partition), "empty-snapshot")
        XCTAssertTrue(try store.catalog(for: partition).isEmpty)
    }

    func testV3ToV4MigrationPreservesCallSheetsEvidenceLeaseAndCursor() throws {
        try seed()
        let intent = VisitIntent(requestId: UUID(), kind: "visit.checkIn", operationJSON: Data())
        let bytes = Data("{\"kind\":\"visit.checkIn\",\"clientRequestId\":\"\(intent.requestId.uuidString.lowercased())\",\"payload\":{}}".utf8)
        let accepted = VisitIntent(requestId: intent.requestId, kind: intent.kind, operationJSON: bytes)
        try store.enqueue(accepted, for: partition, now: Date(timeIntervalSince1970: 1_800_000_000))
        let ack = ServerAck(entityId: "visit-1", eventIds: ["event-1"], serverTime: 1_800_000_000_000)
        try store.recordAck(ack, for: accepted.requestId, in: partition)
        let pending = try DiagnosticOperation.checkIn(plannedId: nil, outletId: "outlet-1", day: "2026-10-04", intents: [], reason: "Diagnostic", location: nil)
        try store.enqueue(pending, for: partition, now: Date(timeIntervalSince1970: 1_800_000_000))
        let visit = try ReferenceDataFixture.change("visit", id: "visit-2", revision: 3, value: ["id": "visit-2"])
        try store.applyDelta([visit], nextCursor: "v3-cursor", for: partition)
        try store.prepareLegacyV3(); XCTAssertEqual(store.schemaVersion, 3)
        store.close(); store = try open()
        XCTAssertEqual(store.schemaVersion, 4)
        XCTAssertEqual(try store.callSheets(for: partition), ReferenceDataFixture.snapshot().callSheets)
        XCTAssertEqual(try store.pendingOutbox(for: partition).map(\.intent), [pending])
        XCTAssertEqual(try store.ack(for: accepted.requestId, in: partition), ack)
        XCTAssertNotNil(try store.deltaValue(entity: "visit", id: "visit-2", for: partition))
        XCTAssertEqual(try store.cursor(for: partition), "v3-cursor")
        XCTAssertEqual(try store.leaseExpiry(for: partition), expiry)
        XCTAssertTrue(try store.catalog(for: partition).isEmpty)
        XCTAssertTrue(try store.availability(productId: "product-1", for: partition).isEmpty)
        try seed(); store.close(); store = try open()
        XCTAssertEqual(store.schemaVersion, 4)
        XCTAssertEqual(try store.catalog(for: partition), ReferenceDataFixture.snapshot().productCatalog)
        XCTAssertEqual(try store.pendingOutbox(for: partition).map(\.intent), [pending])
    }

    func testNewerOlderAndEqualProductRevisionRefreshesEveryCallSheet() throws {
        try seed()
        let revision: Int64 = 1_759_550_000_001
        let newer = ReferenceDataFixture.product(revision: revision, name: "New name", code: "EDITED", uom: "CS")
        try store.applyDelta([ReferenceDataFixture.change(newer)], nextCursor: "newer", for: partition)
        XCTAssertEqual(try store.catalog(for: partition), [newer])
        for sheet in try store.callSheets(for: partition) {
            XCTAssertEqual(sheet.lines[0].code, newer.code); XCTAssertEqual(sheet.lines[0].name, newer.name)
            XCTAssertEqual(sheet.lines[0].uom, newer.uom); XCTAssertEqual(sheet.lines[0].barcode, "4800000000017")
            XCTAssertEqual(sheet.lines[0].pricing, "Account price"); XCTAssertEqual(sheet.revision, 2)
            XCTAssertEqual(sheet.lines[1], ReferenceDataFixture.sheet().lines[1])
        }
        let older = ReferenceDataFixture.product(revision: revision - 1, name: "Stale", barcodes: [])
        try store.applyDelta([ReferenceDataFixture.change(older)], nextCursor: "older", for: partition)
        XCTAssertEqual(try store.catalog(for: partition), [newer])
        XCTAssertEqual(try store.callSheets(for: partition).first?.lines[0].name, newer.name)
        XCTAssertEqual(try store.cursor(for: partition), "older")
        let equal = ReferenceDataFixture.product(revision: revision, name: "Equal revision", barcodes: [])
        try store.applyDelta([ReferenceDataFixture.change(equal)], nextCursor: "equal", for: partition)
        XCTAssertEqual(try store.catalog(for: partition), [equal])
        XCTAssertTrue(try store.callSheets(for: partition).allSatisfy { $0.lines[0].name == equal.name && $0.lines[0].barcode == nil })
        store.close(); store = try open()
        XCTAssertEqual(try store.cursor(for: partition), "equal")
        XCTAssertEqual(try store.callSheets(for: partition).first?.lines[0].name, equal.name)
    }

    func testNewerOlderAndEqualInventoryRevisionsAndNewRows() throws {
        try seed()
        let initial = ReferenceDataFixture.stock(), newer = ReferenceDataFixture.stock(revision: 1_759_550_000_124, available: 25000)
        try store.applyDelta([ReferenceDataFixture.change(newer)], nextCursor: "newer", for: partition)
        XCTAssertEqual(try store.availability(productId: "product-1", for: partition), [newer])
        try store.applyDelta([ReferenceDataFixture.change(initial)], nextCursor: "older", for: partition)
        XCTAssertEqual(try store.availability(productId: "product-1", for: partition), [newer])
        let equal = ReferenceDataFixture.stock(revision: newer.revision, available: 26000)
        try store.applyDelta([ReferenceDataFixture.change(equal)], nextCursor: "equal", for: partition)
        XCTAssertEqual(try store.availability(productId: "product-1", for: partition), [equal])
        try seed(ReferenceDataFixture.snapshot(products: [], inventory: []))
        try store.applyDelta([ReferenceDataFixture.change(ReferenceDataFixture.product()), ReferenceDataFixture.change(equal)], nextCursor: "insert", for: partition)
        XCTAssertEqual(try store.catalog(for: partition).count, 1)
        XCTAssertEqual(try store.availability(productId: "product-1", for: partition), [equal])
    }

    func testDeltaFailureRollsBackReferenceCallSheetsVisitsAndCursor() throws {
        try seed()
        let initial = ReferenceDataFixture.snapshot()
        let newer = ReferenceDataFixture.product(revision: 1_759_550_000_200, name: "Must rollback")
        let stock = ReferenceDataFixture.stock(revision: 1_759_550_000_200, available: 999)
        let visit = try ReferenceDataFixture.change("visit", id: "visit-1", revision: 1, value: ["id": "visit-1"])
        let changes = try [ReferenceDataFixture.change(newer), ReferenceDataFixture.change(stock), visit]
        store.failBeforeDeltaCursor = true
        XCTAssertThrowsError(try store.applyDelta(changes, nextCursor: "bad", for: partition))
        XCTAssertEqual(try store.catalog(for: partition), initial.productCatalog)
        XCTAssertEqual(try store.availability(productId: "product-1", for: partition), initial.inventoryAvailability)
        XCTAssertEqual(try store.callSheets(for: partition), initial.callSheets)
        XCTAssertNil(try store.deltaValue(entity: "visit", id: "visit-1", for: partition))
        XCTAssertEqual(try store.cursor(for: partition), "initial")
        store.failBeforeDeltaCursor = false
        try store.applyDelta(changes, nextCursor: "committed", for: partition)
        store.close(); store = try open()
        XCTAssertEqual(try store.catalog(for: partition), [newer])
        XCTAssertEqual(try store.availability(productId: "product-1", for: partition), [stock])
        XCTAssertNotNil(try store.deltaValue(entity: "visit", id: "visit-1", for: partition))
        XCTAssertEqual(try store.cursor(for: partition), "committed")
    }

    func testMalformedReferenceValueRollsBackEarlierChangeAndCursor() throws {
        try seed()
        let newer = ReferenceDataFixture.product(revision: 1_759_550_000_200, name: "Must rollback")
        let mismatch = try ReferenceDataFixture.change("inventory", id: "wrong-id", revision: 1_759_550_000_200,
                                                      value: ReferenceDataFixture.stock(revision: 1_759_550_000_200))
        XCTAssertThrowsError(try store.applyDelta([ReferenceDataFixture.change(newer), mismatch], nextCursor: "bad", for: partition))
        XCTAssertEqual(try store.cursor(for: partition), "initial")
        XCTAssertEqual(try store.catalog(for: partition), ReferenceDataFixture.snapshot().productCatalog)
        XCTAssertEqual(try store.callSheets(for: partition), ReferenceDataFixture.snapshot().callSheets)
        let wrongRevision = try ReferenceDataFixture.change("product", id: newer.id, revision: 1, value: newer)
        XCTAssertThrowsError(try store.applyDelta([wrongRevision], nextCursor: "bad", for: partition))
        XCTAssertEqual(try store.cursor(for: partition), "initial")
    }

    func testEmptyDeltaCursorTransactionAndLegacyProductUpgrade() throws {
        let legacy = BootstrapV1.Product(id: "product-1", code: "OLD", name: "Legacy", uom: "PC")
        try seed(ReferenceDataFixture.snapshot(products: [legacy], inventory: []))
        store.failBeforeDeltaCursor = true
        XCTAssertThrowsError(try store.applyDelta([], nextCursor: "bad", for: partition))
        XCTAssertEqual(try store.cursor(for: partition), "initial")
        store.failBeforeDeltaCursor = false
        try store.applyDelta([], nextCursor: "empty", for: partition)
        XCTAssertEqual(try store.cursor(for: partition), "empty")
        try store.applyDelta([ReferenceDataFixture.change(ReferenceDataFixture.product())], nextCursor: "upgrade", for: partition)
        XCTAssertEqual(try store.catalog(for: partition), [ReferenceDataFixture.product()])
        store.close(); store = try open()
        XCTAssertEqual(try store.cursor(for: partition), "upgrade")
    }
}
