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
                                   lines: [])])
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
        let other = try DiagnosticOperation.checkIn(plannedId: nil, outletId: "o-c", day: day, intents: [],
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

    func testHistoryIsCappedNewestFirst() throws {
        var rows: [(VisitIntent, LocalIntentState)] = []
        for i in 0..<15 {
            rows.append((try DiagnosticOperation.checkIn(plannedId: nil, outletId: "o-c", day: day, intents: [],
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
