import XCTest
@testable import FieldIOS

/// IOS-011 scoped customer search and outlet detail: pure projection, ranking and action helpers.
@MainActor
final class CustomerDirectoryTests: XCTestCase {
    private let day = "2026-10-05"
    /// 2026-10-05 10:00 Manila.
    private let now = Date(timeIntervalSince1970: 1_791_165_600)

    private func header(_ name: String, buyer: String? = nil, contact: String? = nil, address: String? = nil) -> CallSheet.Header {
        CallSheet.Header(accountName: name, address: address, buyerName: buyer, contactNumber: contact, accountInCharge: nil,
                         receivingInCharge: nil, distributorName: nil, distributorSchedule: nil, foc: nil, pricing: nil)
    }

    private func snapshot() -> StoreSnapshot {
        StoreSnapshot(
            employee: .init(id: "p1", role: "sales", orgUnitId: "u1"),
            visits: [
                .init(id: "v-b", outletId: "o-b", serviceDate: day, planId: "plan", planVersion: 1, intents: ["audit"], sequence: 1),
                .init(id: "v-a", outletId: "o-a", serviceDate: day, planId: "plan", planVersion: 1, intents: ["audit"], sequence: 0),
                .init(id: "v-a2", outletId: "o-a", serviceDate: "2026-10-06", planId: "plan", planVersion: 1, intents: ["merchandise_check"]),
                .init(id: "v-old", outletId: "o-a", serviceDate: "2026-10-01", planId: "plan", planVersion: 1, intents: [])
            ],
            outlets: [
                .init(id: "o-a", name: "Sto. Niño Sari-Sari", routeId: "r1", code: "OUT-100", customerId: "c-a",
                      address: "12 Rizal Ave", location: .init(latitude: 14.6, longitude: 120.98)),
                .init(id: "o-b", name: "Peña Grocery", routeId: "r2", code: "OUT-200"),
                .init(id: "o-c", name: "Corner Mart 100", routeId: nil),
                .init(id: "o-a", name: "Duplicate row", routeId: nil)
            ],
            customers: [.init(id: "c-a", code: "C-100")],
            route: .init(id: "r1", code: "RT-NORTH"),
            tasks: [.init(id: "t1", kind: "price_survey", required: true)],
            callSheets: [CallSheet(outletId: "o-b", revision: 1, header: header("Pena Grocery Inc", buyer: "Maria Santos",
                                                                                  contact: "+63 917 555 0101", address: "5 Mabini St"),
                                   lines: [])],
            accountSummaries: [summary()])
    }

    private func summary(complete: Bool = true, last: String? = "2026-10-03", open: Int64 = 2) -> AccountSummary {
        AccountSummary(outletId: "o-a", asOfDate: day, availability: "available", creditLimitMinor: 5_000_000,
                       sales: .init(from: complete ? "2026-07-07" : "2026-09-01", to: day, complete: complete,
                                    orders: 9, amountMinor: 4_825_050, recentOrders: 1, recentAmountMinor: 530_000,
                                    lastOrderDate: last, lastOrderAmountMinor: last == nil ? nil : 530_000),
                       openOrders: .init(count: open, amountMinor: open == 0 ? 0 : 410_000))
    }

    private func today() -> [AppModel.TodayVisit] {
        [AppModel.TodayVisit(id: "v-a", outletId: "o-a", outlet: "Sto. Niño Sari-Sari", serviceDate: day, intents: ["audit"],
                             planned: true, status: "Planned", sequence: 0),
         AppModel.TodayVisit(id: "v-b", outletId: "o-b", outlet: "Peña Grocery", serviceDate: day, intents: ["audit"],
                             planned: true, status: "Planned", sequence: 1),
         AppModel.TodayVisit(id: "unplanned-o-c", outletId: "o-c", outlet: "Corner Mart 100", serviceDate: day, intents: [],
                             planned: false, status: "Unplanned")]
    }

    private func records(history: [(VisitIntent, LocalIntentState)] = []) -> [CustomerRecord] {
        CustomerDirectory.build(snapshot: snapshot(), today: today(), day: day, history: history)
    }

    func testOfficeSalesHistoryOpenOrdersAndCreditLimitAreWordedForTheField() throws {
        let all = records()
        XCTAssertEqual(all[0].summary, summary(), "joined by outlet")
        XCTAssertNil(all[1].summary, "no summary downloaded for this outlet")
        let rows = CustomerDirectory.salesRows(all[0].summary, now: now)
        XCTAssertEqual(rows.map(\.label), ["Last order", "Last 4 weeks", "Last 13 weeks", "Open orders", "Credit limit"])
        XCTAssertEqual(rows.map(\.value), ["Sat, Oct 3 · ₱5,300.00", "₱5,300.00 · 1 order", "₱48,250.50 · 9 orders",
                                           "2 orders · ₱4,100.00", "₱50,000.00"])
        let capped = CustomerDirectory.salesRows(summary(complete: false, last: nil, open: 0), now: now)
        XCTAssertEqual(capped[0].value, "No orders in this period")
        XCTAssertEqual(capped[2].label, "Since Tue, Sep 1", "a capped read never claims 13 weeks")
        XCTAssertEqual(capped[3].value, "None")
        let withheld = AccountSummary(outletId: "o-a", asOfDate: day, availability: "withheld", creditLimitMinor: nil,
                                      sales: nil, openOrders: nil)
        XCTAssertTrue(withheld.isValid)
        XCTAssertTrue(CustomerDirectory.salesRows(withheld, now: now).isEmpty, "withheld shows no figures, never zero")
        let future = AccountSummary(outletId: "o-a", asOfDate: day, availability: "partial", creditLimitMinor: nil,
                                    sales: summary().sales, openOrders: summary().openOrders)
        XCTAssertTrue(CustomerDirectory.salesRows(future, now: now).isEmpty, "unknown availability is not shown as figures")
        XCTAssertEqual(AccountSummary.peso(-12_345), "-₱123.45")
    }

    func testBuildIsLimitedToSnapshotOutletsAndJoinsRouteAccountPlansAndToday() throws {
        let all = records()
        XCTAssertEqual(all.map(\.outletId), ["o-a", "o-b", "o-c"], "one record per downloaded outlet, nothing else")
        XCTAssertTrue(CustomerDirectory.build(snapshot: nil, today: today(), day: day, history: []).isEmpty,
                      "no partition snapshot (signed out, purged) means an empty directory")
        let a = all[0], b = all[1], c = all[2]
        XCTAssertEqual(a.customerCode, "C-100")
        XCTAssertEqual(a.routeCode, "RT-NORTH", "on the person's downloaded route")
        XCTAssertNil(b.routeCode, "another route's code is never invented")
        XCTAssertEqual(b.routeId, "r2")
        XCTAssertEqual(a.planned.map(\.plannedVisitId), ["v-a", "v-a2"], "past days are dropped, horizon is date-ordered")
        XCTAssertEqual(a.todayPosition, 1)
        XCTAssertEqual(b.todayPosition, 2)
        XCTAssertNil(c.today, "an unplanned row is not today's plan")
        XCTAssertEqual(b.account?.buyerName, "Maria Santos")
        XCTAssertEqual(b.displayAddress, "5 Mabini St", "falls back to the account sheet address")
        XCTAssertEqual(a.codes, "OUT-100 · C-100")
        XCTAssertNotNil(a.directionsURL)
        XCTAssertNil(c.directionsURL, "no pin and no address")
        XCTAssertEqual(b.dialURL?.absoluteString, "tel:+639175550101")
        XCTAssertNil(a.dialURL)
    }

    func testSearchIsAccentAndCaseInsensitiveAndRanksCodesFirst() {
        let all = records()
        XCTAssertEqual(CustomerDirectory.search(all, query: "").map(\.outletId), ["o-a", "o-b", "o-c"],
                       "blank lists everything: today's route order first, then name")
        XCTAssertEqual(CustomerDirectory.search(all, query: "sto nino").map(\.outletId), ["o-a"])
        XCTAssertEqual(CustomerDirectory.search(all, query: "PENA").map(\.outletId), ["o-b"])
        XCTAssertEqual(CustomerDirectory.search(all, query: "maria").map(\.outletId), ["o-b"], "buyer name")
        XCTAssertEqual(CustomerDirectory.search(all, query: "rizal").map(\.outletId), ["o-a"], "address")
        XCTAssertEqual(CustomerDirectory.search(all, query: "rt north").map(\.outletId), ["o-a"], "route code")
        XCTAssertEqual(CustomerDirectory.search(all, query: "c-100").first?.outletId, "o-a", "exact customer code first")
        // "100" is in o-a's codes and o-c's name; the exact code match ranks above the name match.
        XCTAssertEqual(CustomerDirectory.search(all, query: "out 100").map(\.outletId), ["o-a"])
        XCTAssertEqual(CustomerDirectory.search(all, query: "100").map(\.outletId), ["o-a", "o-c"])
        XCTAssertEqual(CustomerDirectory.search(all, query: "grocery mabini").map(\.outletId), ["o-b"], "every word must match")
        XCTAssertTrue(CustomerDirectory.search(all, query: "outlet-not-on-this-phone").isEmpty)
        XCTAssertEqual(CustomerDirectory.normalize("  Sto. NIÑO—Sari  "), "sto nino sari")
    }

    func testHistoryGroupsLocalCallsUnderTheOutletWithSendState() throws {
        let start = try DiagnosticOperation.checkIn(plannedId: "v-a", outletId: "o-a", day: day, intents: ["audit"],
                                                    reason: nil, location: nil, now: now)
        let note = try DiagnosticOperation.note("Shelf restocked", checkIn: start.requestId, visitId: nil,
                                                now: now.addingTimeInterval(300))
        let end = try DiagnosticOperation.checkOut(outcome: "nonproductive", reason: "store_closed", checkIn: start.requestId,
                                                   visitId: nil, now: now.addingTimeInterval(600))
        let other = try DiagnosticOperation.checkIn(plannedId: nil, outletId: "o-c", day: day, intents: ["sell"],
                                                    reason: "Owner called", location: nil, now: now.addingTimeInterval(900))
        let all = records(history: [(start, .sent), (note, .waiting), (end, .review), (other, .held)])
        let a = try XCTUnwrap(all.first { $0.outletId == "o-a" })
        XCTAssertEqual(a.history.map(\.label), ["Call ended · Not productive (store_closed)", "Note added", "Call started"])
        XCTAssertEqual(a.history.map(\.state), ["Needs review", "Waiting to send", "Sent"])
        let c = try XCTUnwrap(all.first { $0.outletId == "o-c" })
        XCTAssertEqual(c.history.map(\.label), ["Unplanned call started"])
        XCTAssertEqual(c.history.map(\.state), ["Held for review"])
        XCTAssertTrue(all.first { $0.outletId == "o-b" }!.history.isEmpty)
    }

    /// A completed End is not evidence of a productive call: only the governed activity rule
    /// (server sfa/productive_call.ts, mirrored by ProductiveCall) may label one productive.
    func testCompletedCallIsProductiveOnlyByTheGovernedActivityRule() throws {
        func activity(_ kind: String, checkIn: UUID, at: Date) throws -> VisitIntent {
            let id = UUID()
            let object: [String: Any] = ["kind": "visit.activity", "clientRequestId": id.uuidString.lowercased(),
                                         "dependsOn": [checkIn.uuidString.lowercased()],
                                         "payload": ["activity": ["kind": kind],
                                                     "deviceTime": Int64(at.timeIntervalSince1970 * 1000)]]
            return VisitIntent(requestId: id, kind: "visit.activity",
                               operationJSON: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
        }
        func endLabel(outlet: String, planned: String?, kinds: [String], reason: String? = nil,
                      rejected: Set<String> = [], rule: String? = nil) throws -> String? {
            let start = try DiagnosticOperation.checkIn(plannedId: planned, outletId: outlet, day: day,
                                                        intents: planned == nil ? ["sell"] : [],
                                                        reason: planned == nil ? "Owner called" : nil, location: nil, now: now)
            var rows: [(VisitIntent, LocalIntentState)] = [(start, .sent)]
            for (i, kind) in kinds.enumerated() {
                let row = kind == "note"
                    ? try DiagnosticOperation.note("Shelf restocked", checkIn: start.requestId, visitId: nil,
                                                   now: now.addingTimeInterval(Double(60 + i)))
                    : try activity(kind, checkIn: start.requestId, at: now.addingTimeInterval(Double(60 + i)))
                rows.append((row, rejected.contains(kind) ? .review : .sent))
            }
            let end = try DiagnosticOperation.checkOut(outcome: "completed", reason: reason, checkIn: start.requestId,
                                                       visitId: nil, now: now.addingTimeInterval(600))
            rows.append((end, .sent))
            return CustomerDirectory.historyByOutlet(rows, rule: rule)[outlet]?.first?.label
        }
        XCTAssertEqual(try endLabel(outlet: "o-a", planned: "v-a", kinds: ["note"]), "Call ended · No productive activity",
                       "a completed note-only call is not productive")
        XCTAssertEqual(try endLabel(outlet: "o-a", planned: "v-a", kinds: []), "Call ended · No productive activity")
        XCTAssertEqual(try endLabel(outlet: "o-a", planned: "v-a", kinds: ["note", "order_intent"]), "Call ended · Productive")
        XCTAssertEqual(try endLabel(outlet: "o-a", planned: "v-a", kinds: ["order_intent"], rejected: ["order_intent"]),
                       "Call ended · No productive activity", "a refused activity is not evidence")
        XCTAssertEqual(try endLabel(outlet: "o-a", planned: "v-a", kinds: ["merchandising"], rule: "truck_seller"),
                       "Call ended · No productive activity", "truck-seller merchandising without the inventory reason")
        XCTAssertEqual(try endLabel(outlet: "o-a", planned: "v-a", kinds: ["price_check"], rule: "truck_seller"),
                       "Call ended · No productive activity")
        XCTAssertEqual(try endLabel(outlet: "o-a", planned: "v-a", kinds: ["merchandising"],
                                    reason: "no_sales_due_to_inventory", rule: "truck_seller"),
                       "Call ended · Productive")
        XCTAssertEqual(try endLabel(outlet: "o-a", planned: "v-a", kinds: ["merchandising"]), "Call ended · Productive",
                       "default rule: merchandising alone qualifies")
        XCTAssertEqual(try endLabel(outlet: "o-c", planned: nil, kinds: ["order_intent"]), "Call ended",
                       "an unplanned call is not a route-plan call, so no productive verdict")
        // The rule reaches the outlet detail from the saved day target.
        let start = try DiagnosticOperation.checkIn(plannedId: "v-a", outletId: "o-a", day: day, intents: [],
                                                    reason: nil, location: nil, now: now)
        let merch = try activity("merchandising", checkIn: start.requestId, at: now.addingTimeInterval(60))
        let end = try DiagnosticOperation.checkOut(outcome: "completed", reason: nil, checkIn: start.requestId,
                                                   visitId: nil, now: now.addingTimeInterval(600))
        var truck = snapshot()
        truck.dayTarget = .init(productiveCallRule: "truck_seller")
        let a = try XCTUnwrap(CustomerDirectory.build(snapshot: truck, today: today(), day: day,
                                                      history: [(start, .sent), (merch, .sent), (end, .sent)]).first)
        XCTAssertEqual(a.history.first?.label, "Call ended · No productive activity")
    }

    func testHistoryIsCappedNewestFirst() throws {
        var rows: [(VisitIntent, LocalIntentState)] = []
        for i in 0..<15 {
            rows.append((try DiagnosticOperation.checkIn(plannedId: nil, outletId: "o-c", day: day, intents: ["sell"],
                                                         reason: "r", location: nil, now: now.addingTimeInterval(Double(i))), .sent))
        }
        let history = CustomerDirectory.historyByOutlet(rows)["o-c"] ?? []
        XCTAssertEqual(history.count, CustomerDirectory.historyLimit)
        XCTAssertEqual(history.first?.at, now.addingTimeInterval(14))
    }

    func testLabelsAndDialValidation() {
        XCTAssertEqual(CustomerDirectory.dayLabel("2026-10-05", now: now), "Today")
        XCTAssertEqual(CustomerDirectory.dayLabel("2026-10-06", now: now), "Tomorrow")
        XCTAssertEqual(CustomerDirectory.dayLabel("2026-10-08", now: now), "Thu, Oct 8")
        XCTAssertEqual(CustomerDirectory.dayLabel("not-a-date", now: now), "not-a-date")
        XCTAssertEqual(CustomerDirectory.timeLabel(now, now: now), "10:00 AM")
        XCTAssertEqual(CustomerDirectory.timeLabel(now.addingTimeInterval(-86_400), now: now), "Oct 4, 10:00 AM")
        XCTAssertEqual(CustomerDirectory.kindLabel("merchandise_check"), "Merchandise check")
        XCTAssertEqual(CustomerDirectory.dialURL("(02) 8123-4567")?.absoluteString, "tel:0281234567")
        XCTAssertNil(CustomerDirectory.dialURL("call the owner"))
        XCTAssertNil(CustomerDirectory.dialURL("12345"))
        XCTAssertNil(CustomerDirectory.dialURL("0917+5550101"), "a plus sign only leads")
        XCTAssertNil(CustomerDirectory.dialURL(nil))
    }
}
