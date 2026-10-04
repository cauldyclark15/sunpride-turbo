import CryptoKit
import XCTest
@testable import FieldIOS

@MainActor
final class SuggestedOrderTests: XCTestCase {
    private let outletId = "0000000000000000000010019outlets"
    private let day = "2026-09-29"
    private func fixture() throws -> Data {
        try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "for-outlet", withExtension: "json")))
    }
    private func object() throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: fixture()) as? [String: Any])
    }
    private func decode(_ object: [String: Any]) throws -> SuggestedOrder {
        try JSONDecoder().decode(SuggestedOrder.self, from: JSONSerialization.data(withJSONObject: object))
    }
    private func order() throws -> SuggestedOrder { try decode(object()) }
    private func modifiedLines(_ edit: (inout [[String: Any]]) -> Void) throws -> SuggestedOrder {
        var value = try object()
        var lines = try XCTUnwrap(value["lines"] as? [[String: Any]])
        edit(&lines)
        value["lines"] = lines
        return try decode(value)
    }
    private func sheet(_ order: SuggestedOrder, ids: [String]? = nil) -> CallSheet {
        let lines = order.lines.compactMap { line -> CallSheet.Line? in
            guard let id = line.productId, ids == nil || ids!.contains(id) else { return nil }
            return .init(productId: id, code: line.code, name: line.name, uom: line.unit, barcode: nil, pricing: nil)
        }
        return CallSheet(outletId: order.outlet.outletId, revision: 1,
            header: .init(accountName: "Account", address: nil, buyerName: nil, contactNumber: nil,
                accountInCharge: nil, receivingInCharge: nil, distributorName: nil, distributorSchedule: nil, foc: nil, pricing: nil),
            lines: lines)
    }
    private func clock() -> TestClock {
        TestClock(ISO8601DateFormatter().date(from: "2026-09-29T10:05:00+08:00")!)
    }

    func testSharedFixtureDecodesIgnoringExtraKeys() throws {
        let order = try order().validated(outletId: outletId, asOfDate: day)
        XCTAssertEqual(order.version, "suggested-order/v1/2026-10-05")
        XCTAssertEqual(order.lines.count, 5)
        XCTAssertEqual(order.lines[0].suggestedQuantity, 8)
        XCTAssertEqual(order.lines[0].reasons.count, 4)
        XCTAssertEqual(order.nextVisit.days, 7)
        XCTAssertEqual(order.coverDays, 8)
        XCTAssertEqual(order.leadTimeDays, 1)
        XCTAssertTrue(order.leadTimeProvisional)
    }
    func testUnknownStatusKeptRawAndNeverActionable() throws {
        let order = try modifiedLines { $0[0]["status"] = "future_status" }
        let line = order.lines[0], id = try XCTUnwrap(line.productId)
        XCTAssertEqual(line.status, "future_status")
        XCTAssertFalse(line.canUse)
        XCTAssertEqual(SuggestedOrderRules.statusText(line), "No suggestion")
        let rules = SuggestedOrderRules(order: order)
        let drafts: [String: CallSheetDraft] = [id: .init(values: [.order: "99", .take: "7"])]
        XCTAssertEqual(rules.useSuggestion(drafts, productId: id)[id]?.values, drafts[id]?.values)
        XCTAssertNil(rules.useAll([:], sheet: sheet(order))[id])
    }
    func testLineCountBoundRejectsWholeResponse() throws {
        var value = try object()
        let line = try XCTUnwrap((value["lines"] as? [[String: Any]])?.first)
        value["lines"] = Array(repeating: line, count: 200)
        XCTAssertEqual(try decode(value).lines.count, 200)
        value["lines"] = Array(repeating: line, count: 201)
        XCTAssertThrowsError(try decode(value)) { XCTAssertEqual($0 as? SuggestedOrder.Failure, .tooManyLines) }
    }
    func testReasonsBoundedToTenAndThreeHundredCharacters() throws {
        let text = String(repeating: "é", count: 301)
        let order = try modifiedLines { $0[0]["reasons"] = Array(repeating: text, count: 11) }
        XCTAssertEqual(order.lines[0].reasons.count, 10)
        XCTAssertTrue(order.lines[0].reasons.allSatisfy { $0.count == 300 })
    }
    func testUnsafeQuantitiesHaveNoUseActionAndCannotEditDrafts() throws {
        for quantity in [-1.0, 1.5, 1_000_001.0, 1e30] {
            let order = try modifiedLines { $0[0]["suggestedQuantity"] = quantity }
            let line = order.lines[0], id = try XCTUnwrap(line.productId)
            XCTAssertNil(line.wholeQuantity)
            XCTAssertFalse(line.canUse)
            let rules = SuggestedOrderRules(order: order)
            XCTAssertTrue(rules.useSuggestion([:], productId: id).isEmpty)
            XCTAssertNil(rules.useAll([:], sheet: sheet(order))[id])
        }
        for quantity in [0, 1_000_000] {
            let order = try modifiedLines { $0[0]["suggestedQuantity"] = quantity }
            XCTAssertEqual(order.lines[0].wholeQuantity, quantity)
            XCTAssertTrue(order.lines[0].canUse)
        }
    }
    func testOutletAndDateMustMatchRequestExactly() throws {
        let order = try order()
        XCTAssertThrowsError(try order.validated(outletId: "another-outlet", asOfDate: day)) {
            XCTAssertEqual($0 as? SuggestedOrder.Failure, .requestMismatch)
        }
        XCTAssertThrowsError(try order.validated(outletId: outletId, asOfDate: "2026-09-30")) {
            XCTAssertEqual($0 as? SuggestedOrder.Failure, .requestMismatch)
        }
    }
    func testUseSuggestionOverwritesOnlyOrdersAndStaysEditable() throws {
        let order = try order(), id = try XCTUnwrap(order.lines[0].productId)
        let rules = SuggestedOrderRules(order: order)
        let original: [String: CallSheetDraft] = [
            id: .init(values: [.order: "99", .beginningInventory: "10", .take: "3", .delivered: "5", .offtake: "2", .endInventory: "11"]),
            "other": .init(values: [.order: "4", .take: "6"])
        ]
        var result = rules.useSuggestion(original, productId: id)
        XCTAssertEqual(result[id]?.values[.order], "8")
        for measure in CallSheetMeasure.allCases where measure != .order {
            XCTAssertEqual(result[id]?.values[measure], original[id]?.values[measure])
        }
        XCTAssertEqual(result["other"]?.values, original["other"]?.values)
        XCTAssertEqual(original[id]?.values[.order], "99")
        result[id]?.values[.order] = "12"
        XCTAssertEqual(result[id]?.values[.order], "12")
        XCTAssertEqual(rules.useSuggestion(original, productId: "absent")[id]?.values, original[id]?.values)
    }
    func testUseAllOnlyFillsEmptyOrdersOnTheSheet() throws {
        let order = try order(), ids = order.lines.compactMap(\.productId)
        let rules = SuggestedOrderRules(order: order)
        let drafts: [String: CallSheetDraft] = [
            ids[0]: .init(values: [.order: "  \n", .take: "9", .delivered: "2"]),
            ids[1]: .init(values: [.order: "0", .beginningInventory: "3"]),
            ids[3]: .init(values: [.endInventory: "7"])
        ]
        let result = rules.useAll(drafts, sheet: sheet(order, ids: [ids[0], ids[1], ids[3], ids[4]]))
        XCTAssertEqual(result[ids[0]]?.values[.order], "8")
        XCTAssertEqual(result[ids[0]]?.values[.take], "9")
        XCTAssertEqual(result[ids[0]]?.values[.delivered], "2")
        XCTAssertEqual(result[ids[1]]?.values, drafts[ids[1]]?.values, "typed zero is not blank")
        XCTAssertNil(result[ids[2]], "recommendation not on the sheet stays read-only")
        XCTAssertEqual(result[ids[3]]?.values, drafts[ids[3]]?.values, "enough_stock adds no order")
        XCTAssertNil(result[ids[4]], "no_history adds no order")
        let invalid: [String: CallSheetDraft] = [ids[0]: .init(values: [.order: "oops"])]
        XCTAssertEqual(rules.useAll(invalid, sheet: sheet(order))[ids[0]]?.values[.order], "oops")
    }
    func testUseAllSkipsUnavailableAndZeroRecommendations() throws {
        let order = try modifiedLines {
            $0[0]["status"] = "unavailable"
            $0[1]["suggestedQuantity"] = 0
        }
        let rules = SuggestedOrderRules(order: order)
        let result = rules.useAll([:], sheet: sheet(order))
        XCTAssertNil(result[order.lines[0].productId!])
        XCTAssertNil(result[order.lines[1].productId!])
        XCTAssertEqual(result[order.lines[2].productId!]?.values[.order], "8")
    }
    func testNotOnSheetIncludesNullAndAbsentSuggestLinesOnly() throws {
        let order = try modifiedLines { $0[1]["productId"] = NSNull() }
        let rules = SuggestedOrderRules(order: order)
        let missing = rules.notOnSheet(sheet(order, ids: [order.lines[0].productId!]))
        XCTAssertEqual(missing.map(\.code), ["P2", "P4"])
        XCTAssertNil(missing[0].productId)
    }
    func testStatusSummaryAndFixedNoteWording() throws {
        let order = try order()
        XCTAssertEqual(SuggestedOrderRules.statusText(order.lines[0]), "Suggested: 8 CS")
        XCTAssertEqual(SuggestedOrderRules.statusText(order.lines[3]), "Enough stock — no order suggested")
        XCTAssertEqual(SuggestedOrderRules.statusText(order.lines[4]), "No purchases in 12 weeks — no suggestion")
        let unavailable = try modifiedLines { $0[0]["status"] = "unavailable" }
        XCTAssertEqual(SuggestedOrderRules.statusText(unavailable.lines[0]), "Not available to sell")
        XCTAssertEqual(SuggestedOrderRules(order: order).summary,
            "3 product(s) suggested · covers 8 days (7 to next visit + 1 lead time)\nLead time is provisional.")
        var value = try object(); value["leadTimeProvisional"] = false
        XCTAssertEqual(SuggestedOrderRules(order: try decode(value)).summary,
            "3 product(s) suggested · covers 8 days (7 to next visit + 1 lead time)")
        XCTAssertEqual(SuggestedOrderRules.note, "Suggestions only. Nothing is ordered until you save the call sheet.")
    }
    func testSuggestedAndManuallyTypedPayloadsAreIdentical() throws {
        let order = try order(), sheet = sheet(order), rules = SuggestedOrderRules(order: order)
        let accepted = rules.useAll([:], sheet: sheet)
        let typed = Dictionary(uniqueKeysWithValues: order.lines.prefix(3).map { ($0.productId!, CallSheetDraft(values: [.order: $0.quantityText])) })
        let dependency = UUID(), date = clock().now
        let suggested = try DiagnosticOperation.callSheet(sheet, drafts: accepted, checkIn: dependency, visitId: "visit", now: date)
        let manual = try DiagnosticOperation.callSheet(sheet, drafts: typed, checkIn: dependency, visitId: "visit", now: date)
        XCTAssertEqual(suggested.payload as NSDictionary?, manual.payload as NSDictionary?)
        let payload = try XCTUnwrap(suggested.payload)
        XCTAssertEqual(Set(payload.keys), Set(["activity", "visitId", "deviceTime"]))
        let activity = try XCTUnwrap(payload["activity"] as? [String: Any])
        XCTAssertEqual(Set(activity.keys), Set(["kind", "lines"]))
        XCTAssertEqual(activity["kind"] as? String, "call_sheet")
    }

    func testLoaderCacheIsKeyedByOutletAndManilaDay() async throws {
        let order = try order(), clock = clock()
        var fetched: [SuggestedOrderLoader.Request] = []
        let loader = SuggestedOrderLoader(now: clock.closure) { request in fetched.append(request); return order }
        XCTAssertEqual(loader.state(outletId: outletId).message, "Loading suggestions…")
        await loader.load(outletId: outletId, offline: false)
        XCTAssertEqual(fetched, [.init(outletId: outletId, asOfDate: day)])
        XCTAssertEqual(loader.state(outletId: outletId).order, order)
        await loader.load(outletId: outletId, offline: true)
        XCTAssertEqual(loader.state(outletId: outletId).message, "Offline — showing suggestions loaded at 10:05 AM")
        XCTAssertEqual(fetched.count, 1)
        await loader.load(outletId: "other", offline: true)
        XCTAssertEqual(loader.state(outletId: "other"), .connectionNeeded)
        clock.advance(14 * 60 * 60) // Manila midnight while UTC is still on the fixture date.
        XCTAssertEqual(loader.request(outletId: outletId).asOfDate, "2026-09-30")
        await loader.load(outletId: outletId, offline: true)
        XCTAssertEqual(loader.state(outletId: outletId), .connectionNeeded)
    }
    func testTransportFailureUsesCacheOrConnectionMessage() async throws {
        let order = try order(), clock = clock()
        var offline = true
        let loader = SuggestedOrderLoader(now: clock.closure) { _ in
            if offline { throw MobileError.offline }; return order
        }
        await loader.load(outletId: outletId, offline: false)
        XCTAssertEqual(loader.state(outletId: outletId).message, "Suggestions need a connection. Enter your order as usual.")
        offline = false
        await loader.load(outletId: outletId, offline: false)
        offline = true
        await loader.load(outletId: outletId, offline: false)
        XCTAssertEqual(loader.state(outletId: outletId).order, order)
        XCTAssertEqual(loader.state(outletId: outletId).message, "Offline — showing suggestions loaded at 10:05 AM")
    }
    func testRejectionNeverShowsCacheEvenWhenReopenedOffline() async throws {
        let order = try order(), clock = clock()
        var reject = false
        let loader = SuggestedOrderLoader(now: clock.closure) { _ in
            if reject { throw MobileError.rejected("no scope") }; return order
        }
        await loader.load(outletId: outletId, offline: false)
        reject = true
        await loader.load(outletId: outletId, offline: false)
        XCTAssertNil(loader.state(outletId: outletId).order)
        XCTAssertEqual(loader.state(outletId: outletId).message, "Suggestions aren't available for your account.")
        await loader.load(outletId: outletId, offline: true)
        XCTAssertEqual(loader.state(outletId: outletId), .rejected)
    }
    func testUnreadableNullAndMisaddressedResponsesNeverShowCache() async throws {
        let order = try order(), clock = clock()
        var bad = false
        let loader = SuggestedOrderLoader(now: clock.closure) { _ in
            if bad { throw MobileError.invalidResponse }; return order
        }
        await loader.load(outletId: outletId, offline: false)
        bad = true
        await loader.load(outletId: outletId, offline: false)
        XCTAssertEqual(loader.state(outletId: outletId).message, "Couldn't read suggestions. Enter your order as usual.")
        XCTAssertNil(loader.state(outletId: outletId).order)
        let mismatch = SuggestedOrderLoader(now: clock.closure) { _ in order }
        await mismatch.load(outletId: "other", offline: false)
        XCTAssertEqual(mismatch.state(outletId: "other"), .unreadable)
        clock.advance(24 * 60 * 60)
        await mismatch.load(outletId: outletId, offline: false)
        XCTAssertEqual(mismatch.state(outletId: outletId), .unreadable)
        let null = SuggestedOrderLoader(now: clock.closure) { _ in nil }
        await null.load(outletId: outletId, offline: false)
        XCTAssertEqual(null.state(outletId: outletId), .unreadable)
    }
    func testClearDropsCacheAndInvalidatesInFlightRead() async throws {
        let order = try order(), clock = clock()
        var pending: CheckedContinuation<SuggestedOrder?, Never>?
        let loader = SuggestedOrderLoader(now: clock.closure) { _ in
            await withCheckedContinuation { pending = $0 }
        }
        let task = Task { await loader.load(outletId: outletId, offline: false) }
        while pending == nil { await Task.yield() }
        loader.clear()
        pending?.resume(returning: order)
        await task.value
        await loader.load(outletId: outletId, offline: true)
        XCTAssertEqual(loader.state(outletId: outletId), .connectionNeeded)
    }
    func testAppModelUsesAuthenticatedQueryWithOnlyOutletAndDateAndClearsOnSignOut() async throws {
        let clock = clock(), secrets = InMemoryStore()
        try secrets.save(Data("test-session".utf8), for: StoreAccount.session)
        let http = StubHTTP.client()
        let auth = AuthClient(site: StubHTTP.site, store: secrets, http: http, now: clock.closure)
        let functions = ConvexFunctions(url: StubHTTP.cloud, auth: auth, http: http)
        let key = SoftwareDeviceKey(key: P256.Signing.PrivateKey(), storage: .ephemeralTest)
        let model = AppModel(auth: auth, registry: FakeRegistry(), store: secrets, functions: functions, now: clock.closure) { key }
        let value = try object()
        let reply = try JSONSerialization.data(withJSONObject: ["status": "success", "value": value])
        let token = StubHTTP.jwt(exp: clock.now.timeIntervalSince1970 + 900)
        StubURLProtocol.install { request in
            if request.path == "/api/auth/convex/token" { return .reply(.json(200, ["token": token])) }
            return .reply(.init(status: 200, body: reply))
        }
        await model.suggestedOrders.load(outletId: outletId, offline: false)
        XCTAssertNotNil(model.suggestedOrders.state(outletId: outletId).order)
        let query = try XCTUnwrap(StubURLProtocol.requests(to: "/api/query").first)
        XCTAssertEqual(query.headers["Authorization"], "Bearer \(token)")
        let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: query.body) as? [String: Any])
        XCTAssertEqual(envelope["path"] as? String, "analytics/suggested_orders:forOutlet")
        XCTAssertEqual(envelope["args"] as? [String: String], ["outletId": outletId, "asOfDate": day])
        XCTAssertTrue(StubURLProtocol.requests(to: "/api/mutation").isEmpty)
        XCTAssertTrue(StubURLProtocol.requests(to: "/mobile/v1/push").isEmpty)
        await model.signOut()
        await model.suggestedOrders.load(outletId: outletId, offline: true)
        XCTAssertEqual(model.suggestedOrders.state(outletId: outletId), .connectionNeeded)
    }
}
