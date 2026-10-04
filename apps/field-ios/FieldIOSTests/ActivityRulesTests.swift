import CryptoKit
import XCTest
@testable import FieldIOS

/// IOS-013: visit intents and backend-rule activity forms.
@MainActor
final class ActivityRulesTests: XCTestCase {
    private var directory: URL!
    private var secrets: KeychainStore!
    private var store: EncryptedFieldStore!
    private var partition: StorePartition!
    private var model: AppModel!
    private var clock: TestClock!
    private let day = "2026-10-02"

    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "json")))
    }
    private func altered(_ name: String, _ change: (inout [String: Any]) -> Void) throws -> Data {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture(name)) as? [String: Any])
        change(&object)
        return try JSONSerialization.data(withJSONObject: object)
    }
    private static let rules: [ActivityRule] = [
        .init(intent: "audit", version: "r1", activities: [.init(kind: "inventory_check", required: true),
                                                           .init(kind: "price_check", required: false)]),
        .init(intent: "merchandise", version: "r1", activities: [.init(kind: "merchandising", required: true),
                                                                 .init(kind: "price_check", required: false)]),
        .init(intent: "complaint", version: "r1", activities: [.init(kind: "note", required: true)]),
        .init(intent: "sell", version: "r1", activities: [.init(kind: "order_intent", required: true)])
    ]
    private static let sheet = CallSheet(outletId: "first", revision: 1,
        header: .init(accountName: "First", address: nil, buyerName: nil, contactNumber: nil, accountInCharge: nil,
                      receivingInCharge: nil, distributorName: nil, distributorSchedule: nil, foc: nil, pricing: nil),
        lines: [.init(productId: "product-1", code: "SUNP-001", name: "Hotdog", uom: "PC", barcode: nil, pricing: nil)])

    override func setUp() async throws {
        try await super.setUp()
        clock = TestClock(ISO8601DateFormatter().date(from: "2026-10-02T10:00:00+08:00")!)
        directory = FileManager.default.temporaryDirectory.appending(path: "activity-rules-\(UUID().uuidString)")
        secrets = KeychainStore(service: "com.sunpride.field.activity.tests.\(UUID().uuidString)")
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        partition = try StorePartition(subject: "test|seller", deviceId: "phone", scope: "scope")
        let expiry = Int64(FieldDay.nextClose(after: clock.now).timeIntervalSince1970 * 1000)
        try store.saveSnapshot(.init(employee: .init(id: "seller", role: "sales", orgUnitId: "unit"),
            visits: [.init(id: "first", outletId: "first", serviceDate: day, planId: "plan", planVersion: 1,
                           intents: ["audit"], sequence: 0)],
            outlets: ["first", "extra"].map { .init(id: $0, name: $0, routeId: nil) },
            customers: [], route: nil, tasks: [], callSheets: [Self.sheet], activityRules: Self.rules),
            cursor: "cursor", leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: partition)
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
    private func visit(_ id: String) throws -> AppModel.TodayVisit { try XCTUnwrap(model.visits.first { $0.id == id }) }
    private func expect(_ error: AppModel.CallFailure, _ work: () throws -> Void) {
        XCTAssertThrowsError(try work()) { XCTAssertEqual($0 as? AppModel.CallFailure, error) }
    }

    // MARK: Wire

    func testFixtureDecodesRulesKeepsUnknownRawAndOldServersOmitThem() throws {
        let page = try JSONDecoder().decode(BootstrapV1.Page.self, from: fixture("bootstrap-activity-rules-response"))
        let rules = try XCTUnwrap(page.activityRules)
        XCTAssertEqual(rules.map(\.intent), ["merchandise", "complaint", "future-intent"])
        XCTAssertEqual(rules[0].activities, [.init(kind: "merchandising", required: true), .init(kind: "price_check", required: false)])
        XCTAssertEqual(rules[2].activities.first?.kind, "future_form")
        XCTAssertEqual(try JSONDecoder().decode(BootstrapV1.Page.self, from: JSONEncoder().encode(page)).activityRules, rules)
        XCTAssertNil(try JSONDecoder().decode(BootstrapV1.Page.self, from: fixture("bootstrap-response")).activityRules)
    }
    func testMalformedRulesAreRejected() throws {
        let mutations: [(inout [[String: Any]]) -> Void] = [
            { $0[0]["extra"] = true },
            { $0[1]["intent"] = "merchandise" },
            { $0[0]["intent"] = "" },
            { $0[0]["version"] = String(repeating: "v", count: 201) },
            { $0[0]["activities"] = [["kind": "note", "required": true], ["kind": "note", "required": false]] },
            { $0[0]["activities"] = [["kind": "", "required": true]] },
            { $0[0]["activities"] = [["kind": "note", "required": "yes"]] },
            { $0[0]["activities"] = [["kind": "note", "required": true, "label": "x"]] },
            { $0[0]["activities"] = Array(repeating: ["kind": "note", "required": true], count: 17) },
            { rules in rules = Array(repeating: rules[0], count: 33) }
        ]
        for (index, mutate) in mutations.enumerated() {
            let data = try altered("bootstrap-activity-rules-response") { object in
                var rules = object["activityRules"] as! [[String: Any]]
                mutate(&rules); object["activityRules"] = rules
            }
            XCTAssertThrowsError(try JSONDecoder().decode(BootstrapV1.Page.self, from: data), "mutation \(index)")
        }
        XCTAssertThrowsError(try JSONDecoder().decode(BootstrapV1.Page.self,
            from: altered("bootstrap-activity-rules-response") { $0["activityRules"] = NSNull() }))
    }
    func testRulesPersistInServerOrderAndReplaceWithEachGeneration() throws {
        XCTAssertEqual(try store.snapshot(for: partition)?.activityRules, Self.rules)
        XCTAssertEqual(model.activityRules.map(\.intent), ["audit", "merchandise", "complaint", "sell"])
        store.close()
        store = try EncryptedFieldStore(url: directory.appending(path: "field.sqlite"), secrets: secrets, keyAccount: "db")
        XCTAssertEqual(try store.snapshot(for: partition)?.activityRules, Self.rules)
        let expiry = Int64(FieldDay.nextClose(after: clock.now).timeIntervalSince1970 * 1000)
        try store.saveSnapshot(.init(employee: .init(id: "seller", role: "sales", orgUnitId: "unit"), visits: [],
            outlets: [], customers: [], route: nil, tasks: []), cursor: "c2", leaseExpiresAt: expiry, cacheExpiresAt: expiry, for: partition)
        XCTAssertEqual(try store.snapshot(for: partition)?.activityRules, [], "an older server's download carries no rules")
    }

    func testBootstrapKeepsOneRuleSetAndRestartsWhenItChangesMidDownload() async throws {
        let http = StubHTTP.client()
        let auth = AuthClient(site: StubHTTP.site, store: secrets, http: http)
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        let client = BootstrapClient(site: StubHTTP.site, auth: auth,
            registry: ConvexDeviceRegistry(functions: ConvexFunctions(url: StubHTTP.cloud, auth: auth, http: http)),
            http: http, key: key)
        func serve(_ first: Data, _ second: Data) {
            let jwt = StubHTTP.jwt(exp: Date().timeIntervalSince1970 + 900)
            StubURLProtocol.install { request in
                if request.path == "/api/auth/convex/token" { return .reply(.json(200, ["token": jwt])) }
                if request.path == "/api/mutation" {
                    return .reply(.json(200, ["status": "success", "value": [
                        "nonce": UUID().uuidString.lowercased(), "expiresAt": 1_790_380_860_000]]))
                }
                guard request.path == "/mobile/v1/bootstrap" else { return .fail(.badURL) }
                let fields = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any]
                return .reply(.init(status: 200, body: fields?["pageCursor"] != nil ? second : first))
            }
        }
        let first = try altered("bootstrap-activity-rules-response") { $0["nextPageCursor"] = "page-2"; $0["syncCursor"] = NSNull() }
        let second = try altered("bootstrap-activity-rules-response") { $0["page"] = 2; $0["plannedVisits"] = []; $0["outlets"] = [] }
        serve(first, second)
        let p = try await client.run(deviceId: "device-1", subject: "issuer|seller", store: store)
        XCTAssertEqual(try store.snapshot(for: p)?.activityRules.map(\.intent), ["merchandise", "complaint", "future-intent"])
        let changed = try altered("bootstrap-activity-rules-response") {
            $0["page"] = 2; $0["plannedVisits"] = []; $0["outlets"] = []
            var rules = $0["activityRules"] as! [[String: Any]]
            rules[0]["version"] = "visit-activities/2026-10-05"; $0["activityRules"] = rules
        }
        serve(first, changed)
        do { _ = try await client.run(deviceId: "device-1", subject: "issuer|seller", store: store, previous: p); XCTFail("must restart") }
        catch { XCTAssertEqual(error as? BootstrapClient.Failure, .restartRequired) }
        XCTAssertEqual(try store.snapshot(for: p)?.activityRules.first?.version, "visit-activities/2026-10-04", "prior generation kept")
    }

    // MARK: Rules engine

    func testChecklistIsUnionInRuleOrderWithRequiredWinningAndUnavailableForms() {
        let list = ActivityRules.checklist(rules: Self.rules, intents: ["merchandise", "audit", "sell"], recorded: ["merchandising"]) {
            ActivityRules.capturable($0, sheet: nil)
        }
        XCTAssertEqual(list.map(\.kind), ["inventory_check", "price_check", "merchandising", "order_intent"])
        XCTAssertEqual(list.map(\.required), [true, false, true, true])
        XCTAssertEqual(list.map(\.status), [.unavailable, .unavailable, .done, .unavailable])
        XCTAssertEqual(ActivityRules.missing(list), [], "forms the phone can't capture never block End")
        let withSheet = ActivityRules.checklist(rules: Self.rules, intents: ["audit"], recorded: []) {
            ActivityRules.capturable($0, sheet: Self.sheet)
        }
        XCTAssertEqual(ActivityRules.missing(withSheet), ["inventory_check"])
        XCTAssertTrue(ActivityRules.checklist(rules: Self.rules, intents: ["future-intent"], recorded: []) { _ in true }.isEmpty)
        XCTAssertTrue(ActivityRules.checklist(rules: [], intents: ["audit"], recorded: []) { _ in true }.isEmpty)
    }

    // MARK: Forms

    func testFormsBuildExactWireShapes() throws {
        XCTAssertEqual(try ActivityForms.merchandising(displayCondition: "needs_action", actionTaken: "  Faced up  ") as NSDictionary,
                       ["kind": "merchandising", "displayCondition": "needs_action", "actionTaken": "Faced up"])
        XCTAssertEqual(try ActivityForms.merchandising(displayCondition: "compliant", actionTaken: " ") as NSDictionary,
                       ["kind": "merchandising", "displayCondition": "compliant"])
        XCTAssertEqual(try ActivityForms.promotion(programRef: "Hotdog Fiesta", finding: "executed") as NSDictionary,
                       ["kind": "promotion", "programRef": "Hotdog Fiesta", "finding": "executed"])
        XCTAssertEqual(try ActivityForms.inventoryCheck(sheet: Self.sheet, productId: "product-1", finding: "present", quantity: "12") as NSDictionary,
                       ["kind": "inventory_check", "productId": "product-1", "icoFinding": "present", "observedQuantity": 12])
        XCTAssertEqual(try ActivityForms.priceCheck(sheet: Self.sheet, productId: "product-1", price: "189.5", compliant: false) as NSDictionary,
                       ["kind": "price_check", "productId": "product-1", "observedPriceMinor": 18950, "currency": "PHP", "compliant": false])
        for (price, minor) in [("189", 18900), ("0.05", 5), ("189.50", 18950)] {
            XCTAssertEqual(try ActivityForms.priceCheck(sheet: Self.sheet, productId: "product-1", price: price, compliant: nil)["observedPriceMinor"] as? Int64, Int64(minor))
        }
        for bad in ["", "-1", "1,000", "1.234", ".5", "1.", "1e3", "١٢", "1234567890"] {
            XCTAssertThrowsError(try ActivityForms.priceCheck(sheet: Self.sheet, productId: "product-1", price: bad, compliant: nil), bad)
        }
        for bad in ["-1", "1.5", "１２", "99999999999"] {
            XCTAssertThrowsError(try ActivityForms.inventoryCheck(sheet: Self.sheet, productId: "product-1", finding: "present", quantity: bad), bad)
        }
        XCTAssertThrowsError(try ActivityForms.inventoryCheck(sheet: Self.sheet, productId: "other", finding: "present", quantity: ""))
        XCTAssertThrowsError(try ActivityForms.inventoryCheck(sheet: nil, productId: "product-1", finding: "present", quantity: ""))
        XCTAssertThrowsError(try ActivityForms.merchandising(displayCondition: "great", actionTaken: ""))
        XCTAssertThrowsError(try ActivityForms.merchandising(displayCondition: "compliant", actionTaken: String(repeating: "a", count: 501)))
        XCTAssertThrowsError(try ActivityForms.promotion(programRef: "  ", finding: "executed"))
        XCTAssertThrowsError(try ActivityForms.promotion(programRef: "P", finding: nil))
    }
    func testValidateRefusesUnknownKeysWrongTypesAndForeignProducts() throws {
        let valid: [[String: Any]] = [
            ["kind": "merchandising", "displayCondition": "compliant"],
            ["kind": "promotion", "programRef": "P", "finding": "not_applicable"],
            ["kind": "inventory_check", "productId": "product-1", "icoFinding": "unknown", "observedQuantity": 0],
            ["kind": "price_check", "productId": "product-1", "observedPriceMinor": 100, "currency": "PHP", "compliant": true]
        ]
        for activity in valid { XCTAssertNoThrow(try ActivityForms.validate(activity, sheet: Self.sheet), "\(activity)") }
        let invalid: [[String: Any]] = [
            ["kind": "merchandising", "displayCondition": "compliant", "extra": 1],
            ["kind": "merchandising", "displayCondition": "compliant", "actionTaken": "  "],
            ["kind": "promotion", "programRef": "P"],
            ["kind": "inventory_check", "productId": "product-1", "icoFinding": "unknown", "observedQuantity": 1.5],
            ["kind": "inventory_check", "productId": "product-1", "icoFinding": "unknown", "observedQuantity": true],
            ["kind": "inventory_check", "productId": "other", "icoFinding": "present"],
            ["kind": "price_check", "productId": "product-1", "observedPriceMinor": 100, "currency": "USD"],
            ["kind": "price_check", "productId": "product-1", "observedPriceMinor": -1, "currency": "PHP"],
            ["kind": "price_check", "productId": "product-1", "observedPriceMinor": 100, "currency": "PHP", "compliant": 1],
            ["kind": "order_intent", "clientOrderId": UUID().uuidString.lowercased()]
        ]
        for activity in invalid { XCTAssertThrowsError(try ActivityForms.validate(activity, sheet: Self.sheet), "\(activity)") }
    }

    // MARK: Visit flow

    func testUnplannedVisitNeedsAPurposeAndRecordsChosenIntents() throws {
        let extra = try visit("unplanned-extra")
        expect(.intentRequired) { try model.queueCheckIn(extra, unplannedReason: "Walk-in", location: nil) }
        expect(.intentRequired) { try model.queueCheckIn(extra, unplannedReason: "Walk-in", intents: ["bogus"], location: nil) }
        XCTAssertThrowsError(try DiagnosticOperation.checkIn(plannedId: nil, outletId: "extra", day: day,
            intents: ["sell", "sell"], reason: "Walk-in", location: nil))
        XCTAssertEqual(try store.intents(for: partition).count, 0)
        try model.queueCheckIn(extra, unplannedReason: "Walk-in", intents: ["complaint", "merchandise"], location: nil)
        let checkIn = try XCTUnwrap(store.intents(for: partition).first)
        XCTAssertEqual(checkIn.payload?["intents"] as? [String], ["merchandise", "complaint"], "v1 order, each once")
        XCTAssertEqual(model.visitIntents(for: try visit("unplanned-extra")), ["merchandise", "complaint"])
        XCTAssertEqual(model.activityChecklist(for: try visit("unplanned-extra")).map(\.kind), ["merchandising", "price_check", "note"])
    }
    func testPlannedVisitKeepsSignedIntentsAndCompletedEndNeedsRequiredForms() throws {
        let first = try visit("first")
        try model.queueCheckIn(first, unplannedReason: nil, intents: ["merchandise"], location: nil)
        XCTAssertEqual(try store.intents(for: partition).first?.payload?["intents"] as? [String], ["audit"])
        XCTAssertEqual(ActivityRules.missing(model.activityChecklist(for: try visit("first"))), ["inventory_check"])
        expect(.activitiesRequired) { try model.queueCheckOut(outcome: "completed", reason: nil, for: try visit("first")) }
        XCTAssertThrowsError(try model.queueActivity(["kind": "inventory_check", "productId": "other", "icoFinding": "present"],
                                                     for: try visit("first")))
        try model.queueActivity(ActivityForms.inventoryCheck(sheet: Self.sheet, productId: "product-1", finding: "absent", quantity: ""),
                                for: try visit("first"))
        let queued = try XCTUnwrap(store.deferredOutbox(for: partition).last?.intent)
        XCTAssertEqual(queued.kind, "visit.activity")
        XCTAssertEqual(Set(try XCTUnwrap(queued.payload).keys), ["activity", "deviceTime"], "visitId added after the check-in ack")
        let checklist = model.activityChecklist(for: try visit("first"))
        XCTAssertEqual(checklist.first { $0.kind == "inventory_check" }?.status, .done)
        XCTAssertEqual(try visit("first").activityKinds, ["inventory_check"])
        try model.queueCheckOut(outcome: "completed", reason: nil, for: try visit("first"))
        XCTAssertNotNil(try visit("first").endedAt)
        expect(.alreadyClosed) { try model.queueActivity(["kind": "merchandising", "displayCondition": "compliant"], for: try visit("first")) }
    }
    func testNotProductiveEndNeedsNoForms() throws {
        try model.queueCheckIn(try visit("first"), unplannedReason: nil, location: nil)
        try model.queueCheckOut(outcome: "nonproductive", reason: "Store closed", for: try visit("first"))
        XCTAssertNotNil(try visit("first").endedAt)
    }
    func testStoreRefusesCompletedEndAndForeignProductEvenAroundTheModel() throws {
        try model.queueCheckIn(try visit("first"), unplannedReason: nil, location: nil)
        let checkIn = try XCTUnwrap(store.intents(for: partition).first)
        let end = try DiagnosticOperation.checkOut(outcome: "completed", reason: nil, checkIn: checkIn.requestId, visitId: nil, now: clock.now)
        XCTAssertThrowsError(try store.enqueueDeferred(end, for: partition, now: clock.now)) { XCTAssertEqual($0 as? StoreError, .invalidInput) }
        let foreign = try DiagnosticOperation.activity(["kind": "price_check", "productId": "other", "observedPriceMinor": 1, "currency": "PHP"],
                                                       checkIn: checkIn.requestId, visitId: nil, now: clock.now)
        XCTAssertThrowsError(try store.enqueueDeferred(foreign, for: partition, now: clock.now)) { XCTAssertEqual($0 as? StoreError, .invalidInput) }
        let orphan = try DiagnosticOperation.activity(["kind": "merchandising", "displayCondition": "compliant"],
                                                      checkIn: UUID(), visitId: nil, now: clock.now)
        XCTAssertThrowsError(try store.enqueueDeferred(orphan, for: partition, now: clock.now)) { XCTAssertEqual($0 as? StoreError, .invalidInput) }
        XCTAssertEqual(try store.intents(for: partition).count, 1, "nothing written")
        let nonproductive = try DiagnosticOperation.checkOut(outcome: "nonproductive", reason: "Closed", checkIn: checkIn.requestId, visitId: nil, now: clock.now)
        XCTAssertNoThrow(try store.enqueueDeferred(nonproductive, for: partition, now: clock.now))
    }
    func testRejectedActivityDoesNotSatisfyTheRule() throws {
        try model.queueCheckIn(try visit("first"), unplannedReason: nil, location: nil)
        let checkIn = try XCTUnwrap(store.intents(for: partition).first)
        try store.recordAck(.init(entityId: "server-visit", eventIds: [], serverTime: 1_800_000_000_000), for: checkIn.requestId, in: partition)
        try model.queueActivity(ActivityForms.inventoryCheck(sheet: Self.sheet, productId: "product-1", finding: "present", quantity: "3"),
                                for: try visit("first"))
        let activity = try XCTUnwrap(store.pendingOutbox(for: partition).last?.intent)
        XCTAssertEqual(activity.payload?["visitId"] as? String, "server-visit")
        try store.recordRejection(code: "invalid_request", for: activity.requestId, in: partition)
        model.refreshToday()
        XCTAssertEqual(model.activityChecklist(for: try visit("first")).first?.status, .toDo)
        expect(.activitiesRequired) { try model.queueCheckOut(outcome: "completed", reason: nil, for: try visit("first")) }
    }
}
