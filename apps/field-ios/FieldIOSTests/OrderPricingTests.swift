import XCTest
@testable import FieldIOS

@MainActor
final class OrderPricingTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_900_000)
    private let list = OrderTerms.PriceList(id: "sample", code: "SAMPLE-GT", name: "General trade", currency: "PHP", sample: true)
    private func terms(price: Int64? = 4525, caseUnit: Bool = true) -> OrderTerms {
        .init(outletId: "outlet", priceList: list, lines: [
            .init(productId: "p", uom: "CAN", unitPriceMinor: price),
            .init(productId: "unpriced", uom: "PC", unitPriceMinor: nil)
        ] + (caseUnit ? [.init(productId: "p", uom: "CS", unitPriceMinor: 105325)] : []))
    }
    private var sheet: CallSheet {
        .init(outletId: "outlet", revision: 1,
              header: .init(accountName: "Store", address: nil, buyerName: nil, contactNumber: nil,
                            accountInCharge: nil, receivingInCharge: nil, distributorName: nil,
                            distributorSchedule: nil, foc: nil, pricing: nil),
              lines: [.init(productId: "p", code: "P", name: "Corned beef", uom: "CAN", barcode: nil, pricing: nil),
                      .init(productId: "unpriced", code: "U", name: "Office line", uom: "PC", barcode: nil, pricing: nil)])
    }
    private func context(_ terms: OrderTerms?) throws -> (OrderCallContext, VisitIntent) {
        let start = try DiagnosticOperation.checkIn(plannedId: "planned", outletId: "outlet", day: "2026-10-02",
                                                    intents: ["sell"], reason: nil, location: nil, now: now)
        return (.init(intents: [start], rejected: [], callSheets: [sheet],
                      outlets: [.init(id: "outlet", name: "Store", routeId: nil)], customers: [],
                      orderTerms: terms.map { [$0] } ?? []), start)
    }
    private func draft(price: Int64? = 4525, quantity: Int = 2) throws -> OrderDraft {
        let (context, start) = try context(terms(price: price))
        return try OrderDraftRules.build(context, existing: nil, checkIn: start, quantities: [("p", quantity)], now: now)
    }
    private func summary(limit: Int64?, open: Int64? = nil, availability: String = "available") -> AccountSummary {
        .init(outletId: "outlet", asOfDate: "2026-10-02", availability: availability, creditLimitMinor: limit,
              sales: nil, openOrders: open.map { .init(count: 1, amountMinor: $0) })
    }
    private func fixture() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "bootstrap-order-terms-response", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }
    private func page(_ object: [String: Any]) throws -> BootstrapV1.Page {
        try JSONDecoder().decode(BootstrapV1.Page.self, from: JSONSerialization.data(withJSONObject: object))
    }
    func testValidBootstrapTermsAndOmittedLegacyTerms() throws {
        var object = try fixture()
        let parsed = try page(object)
        XCTAssertEqual(parsed.orderTerms[0].lines.map(\.uom), ["PC", "CS", "PC"])
        XCTAssertEqual(parsed.orderTerms[0].lines[0].unitPriceMinor, 4525)
        XCTAssertNil(parsed.orderTerms[0].lines[2].unitPriceMinor)
        XCTAssertEqual(parsed.orderTerms[0].priceList?.currency, "PHP")
        XCTAssertEqual(parsed.orderTerms[0].priceList?.sample, true)
        XCTAssertEqual(try JSONDecoder().decode(BootstrapV1.Page.self, from: JSONEncoder().encode(parsed)).orderTerms, parsed.orderTerms)
        object.removeValue(forKey: "orderTerms")
        XCTAssertTrue(try page(object).orderTerms.isEmpty)
        object["orderTerms"] = NSNull()
        XCTAssertThrowsError(try page(object))
    }
    func testMalformedTermsFailClosed() throws {
        let original = try fixture()
        let originalTerm = (original["orderTerms"] as! [[String: Any]])[0]
        let changes: [(inout [String: Any]) -> Void] = [
            { $0["outletId"] = "foreign" }, { $0.removeValue(forKey: "priceList") },
            { $0["lines"] = NSNull() }, { $0["unexpected"] = true },
            { term in var list = term["priceList"] as! [String: Any]; list["currency"] = "php"; term["priceList"] = list },
            { term in var list = term["priceList"] as! [String: Any]; list["sample"] = "true"; term["priceList"] = list },
            { term in var lines = term["lines"] as! [[String: Any]]; lines.append(lines[0]); term["lines"] = lines },
            { term in var lines = term["lines"] as! [[String: Any]]; lines[0].removeValue(forKey: "unitPriceMinor"); term["lines"] = lines }
        ]
        for change in changes {
            var term = originalTerm; change(&term)
            var object = original; object["orderTerms"] = [term]
            XCTAssertThrowsError(try page(object))
        }
        for value in [-1, 1.5, true, "4525"] as [Any] {
            var term = originalTerm; var lines = term["lines"] as! [[String: Any]]
            lines[0]["unitPriceMinor"] = value; term["lines"] = lines
            var object = original; object["orderTerms"] = [term]
            XCTAssertThrowsError(try page(object), "\(value)")
        }
        for uom in ["", String(repeating: "X", count: 21)] {
            var term = originalTerm; var lines = term["lines"] as! [[String: Any]]
            lines[0]["uom"] = uom; term["lines"] = lines
            var object = original; object["orderTerms"] = [term]
            XCTAssertThrowsError(try page(object))
        }
        var duplicated = original; duplicated["orderTerms"] = [originalTerm, originalTerm]
        XCTAssertThrowsError(try page(duplicated))
        var config = original["appConfig"] as! [String: Any]; config["priceAvailability"] = "available"
        var altered = original; altered["appConfig"] = config
        XCTAssertThrowsError(try page(altered), "The additive prices do not change the v1 config literal")
    }
    func testNullPriceListAndNullPricesAreValid() throws {
        var object = try fixture(); var term = (object["orderTerms"] as! [[String: Any]])[0]
        term["priceList"] = NSNull()
        term["lines"] = [["productId": "p", "uom": "PC", "unitPriceMinor": NSNull()]]
        object["orderTerms"] = [term]
        XCTAssertNil(try page(object).orderTerms[0].priceList)
    }
    func testUnitSwitchSnapshotsPriceAndKeepsOneLinePerProduct() throws {
        let (context, start) = try context(terms())
        let first = try OrderDraftRules.build(context, existing: nil, checkIn: start, quantities: [("p", 2)], now: now)
        XCTAssertEqual(first.lines[0].uom, "CAN")
        XCTAssertEqual(first.lines[0].unitPriceMinor, 4525)
        XCTAssertEqual(first.priceList, list)
        let switched = try OrderDraftRules.build(context, existing: first, checkIn: start, quantities: [("p", 3)], units: ["p": "CS"], now: now)
        XCTAssertEqual(switched.lines.count, 1)
        XCTAssertEqual(switched.lines[0].uom, "CS")
        XCTAssertEqual(switched.lines[0].unitPriceMinor, 105325)
        XCTAssertEqual(OrderSubmission.activity(switched)["lines"] as? [[String: Any]] != nil, true)
        try OrderSubmission.validateActivity(OrderSubmission.activity(switched))
        XCTAssertThrowsError(try OrderDraftRules.build(context, existing: first, checkIn: start, quantities: [("p", 2)], units: ["p": "PALLET"], now: now))
        XCTAssertThrowsError(try OrderDraftRules.build(context, existing: nil, checkIn: start, quantities: [("p", 2), ("p", 3)], now: now))
    }
    func testChangedPriceMissingUnitAndPriceListAreStaleUntilResaved() throws {
        let (context, start) = try context(terms())
        let saved = try OrderDraftRules.build(context, existing: nil, checkIn: start, quantities: [("p", 2)], now: now)
        var changed = context; changed.orderTerms = [terms(price: 4600)]
        XCTAssertThrowsError(try OrderDraftRules.validate(changed, draft: saved, existing: nil)) {
            XCTAssertEqual($0 as? OrderDraftFailure, .pricesChanged)
        }
        XCTAssertEqual(OrderDraftRules.staleLines(saved, sheet: sheet, terms: terms(price: 4600)).count, 1)
        let refreshed = try OrderDraftRules.build(changed, existing: saved, checkIn: start, quantities: [("p", 2)], now: now)
        XCTAssertEqual(refreshed.lines[0].unitPriceMinor, 4600)
        let cases = try OrderDraftRules.build(context, existing: nil, checkIn: start, quantities: [("p", 2)], units: ["p": "CS"], now: now)
        changed.orderTerms = [terms(caseUnit: false)]
        XCTAssertThrowsError(try OrderDraftRules.validate(changed, draft: cases, existing: nil)) {
            XCTAssertEqual($0 as? OrderDraftFailure, .pricesChanged)
        }
        changed.orderTerms = [.init(outletId: "outlet", priceList: .init(id: "new", code: "NEW", name: "New", currency: "PHP", sample: false), lines: terms().lines)]
        XCTAssertThrowsError(try OrderDraftRules.validate(changed, draft: saved, existing: nil))
    }
    func testLegacyDraftDecodesWithoutNewFields() throws {
        let (context, start) = try context(nil)
        let saved = try OrderDraftRules.build(context, existing: nil, checkIn: start, quantities: [("p", 2)], now: now)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(saved)) as? [String: Any])
        object.removeValue(forKey: "priceList")
        var lines = object["lines"] as! [[String: Any]]
        lines[0].removeValue(forKey: "unitPriceMinor"); object["lines"] = lines
        let decoded = try JSONDecoder().decode(OrderDraft.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(decoded.priceList); XCTAssertNil(decoded.lines[0].unitPriceMinor)
        XCTAssertEqual(decoded.lines[0].uom, "CAN")
        try OrderDraftRules.validate(context, draft: decoded, existing: nil)
        XCTAssertEqual(OrderCatalog.items(sheet)[0].units.map(\.uom), ["CAN"])
    }
    func testPricedPartialAndZeroTotalsAndExactMoneyFormatting() throws {
        let (context, start) = try context(terms())
        let saved = try OrderDraftRules.build(context, existing: nil, checkIn: start, quantities: [("p", 2), ("unpriced", 4)], now: now)
        let totals = OrderSubmission.totals(saved)
        XCTAssertEqual(totals.totalMinor, 9050); XCTAssertEqual(totals.amountText, "₱90.50")
        XCTAssertEqual(totals.officeText, "+ 1 line priced by the office")
        XCTAssertEqual(totals.text, "2 products · 2 CAN · 4 PC")
        var pricedContext = context
        pricedContext.orderTerms = [.init(outletId: "outlet", priceList: list, lines: [
            .init(productId: "p", uom: "CAN", unitPriceMinor: 4525),
            .init(productId: "unpriced", uom: "PC", unitPriceMinor: 101)])]
        let allPriced = try OrderDraftRules.build(pricedContext, existing: nil, checkIn: start,
                                                 quantities: [("p", 2), ("unpriced", 4)], now: now)
        XCTAssertEqual(OrderSubmission.totals(allPriced).totalMinor, 9454)
        XCTAssertNil(OrderSubmission.totals(allPriced).officeText)
        XCTAssertEqual(OrderSubmission.unitPrice(4525, uom: "CAN"), "₱45.25 / CAN")
        XCTAssertEqual(OrderSubmission.unitPrice(nil, uom: "CAN"), "Priced by the office")
        XCTAssertEqual(OrderSubmission.money(123450), "₱1,234.50")
        XCTAssertEqual(OrderSubmission.money(0), "₱0.00")
        XCTAssertEqual(OrderSubmission.money(1), "₱0.01")
        XCTAssertEqual(OrderSubmission.money(Int64.max), "₱92,233,720,368,547,758.07")
        XCTAssertEqual(OrderSubmission.totals(try draft(price: 0)).totalMinor, 0)
        XCTAssertEqual(OrderSubmission.totals(try draft(price: nil)).officeText, "+ 1 line priced by the office")
    }
    func testWithinCreditAtBoundaryAndOpenOrdersDefaultZero() throws {
        let saved = try draft()
        let check = OrderSubmission.creditCheck(saved, summary: summary(limit: 10000))
        XCTAssertEqual(check.label, "Within the store's credit limit")
        XCTAssertEqual(check.note, "₱9.50 left after this order"); XCTAssertTrue(check.ok); XCTAssertFalse(check.blocking)
        let boundary = OrderSubmission.creditCheck(saved, summary: summary(limit: 10000, open: 950))
        XCTAssertEqual(boundary.note, "₱0.00 left after this order"); XCTAssertFalse(boundary.warning)
    }
    func testOverCreditIsWarningAndNeverBlocking() throws {
        let (context, start) = try context(terms())
        let saved = try OrderDraftRules.build(context, existing: nil, checkIn: start, quantities: [("p", 2)], now: now)
        let check = OrderSubmission.creditCheck(saved, summary: summary(limit: 10000, open: 1000))
        XCTAssertEqual(check.note, "Over the store's credit limit by ₱0.50. You can still send it; the office must approve.")
        XCTAssertTrue(check.warning); XCTAssertTrue(check.ok); XCTAssertFalse(check.blocking)
        let checks = OrderSubmission.checks(context, draft: saved, phoneCanRecord: true, held: false, summary: summary(limit: 10000, open: 1000))
        XCTAssertTrue(checks.allSatisfy { $0.ok || !$0.blocking })
    }
    func testCreditInfoForNoLimitWithheldAndAbsent() throws {
        let saved = try draft()
        XCTAssertEqual(OrderSubmission.creditCheck(saved, summary: summary(limit: nil)).note, "No credit limit set for this store")
        for summary in [nil, self.summary(limit: nil, availability: "withheld")] {
            let check = OrderSubmission.creditCheck(saved, summary: summary)
            XCTAssertEqual(check.note, "Credit is checked by the office when the order arrives.")
            XCTAssertFalse(check.warning); XCTAssertFalse(check.blocking)
        }
    }
    func testOtherSubmittedOrdersSameOutletAndServiceDayCountOnceExcludingThisOrder() throws {
        let saved = try draft()
        var other = try draft(quantity: 1); other.submittedRequestId = UUID().uuidString.lowercased()
        var unsent = try draft(quantity: 99)
        let data = try JSONEncoder().encode(other)
        func altered(_ key: String, _ value: String) throws -> OrderDraft {
            var object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            object[key] = value
            return try JSONDecoder().decode(OrderDraft.self, from: JSONSerialization.data(withJSONObject: object))
        }
        let otherOutlet = try altered("outletId", "another")
        let otherDay = try altered("serviceDate", "2026-10-03")
        unsent.submittedRequestId = nil
        let check = OrderSubmission.creditCheck(saved, summary: summary(limit: 14000, open: 500),
                                                otherOrders: [other, other, saved, unsent, otherOutlet, otherDay])
        XCTAssertEqual(check.note, "Over the store's credit limit by ₱0.75. You can still send it; the office must approve.")
    }
    func testOverflowFallsBackToOfficeInsteadOfTrapping() throws {
        let saved = try draft(price: Int64.max)
        XCTAssertNil(OrderSubmission.lineAmount(saved.lines[0])); XCTAssertNil(OrderSubmission.totals(saved).totalMinor)
        let check = OrderSubmission.creditCheck(saved, summary: summary(limit: Int64.max))
        XCTAssertEqual(check.note, "Credit is checked by the office when the order arrives.")
        XCTAssertFalse(check.blocking)
    }
}
