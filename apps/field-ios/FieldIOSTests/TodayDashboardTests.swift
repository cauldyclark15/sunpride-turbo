import XCTest
@testable import FieldIOS

final class TodayDashboardTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-10-04T23:30:00+08:00")!
    private func row(_ id: String, day: String = "2026-10-04", planned: Bool = true, sequence: Int? = nil,
                     started: Bool = false, ended: Bool = false, outcome: String? = nil,
                     activities: [String] = [], reason: String? = nil) -> AppModel.TodayVisit {
        AppModel.TodayVisit(id: id, outletId: id, outlet: "Outlet \(id)", serviceDate: day, intents: [], planned: planned,
            status: "Planned", sequence: sequence, startedAt: started ? now : nil, endedAt: ended ? now : nil, outcome: outcome,
            activityKinds: activities, reasonCode: reason)
    }

    func testManilaDateMcpOrderAndOnlyPlannedStoresCount() {
        // 23:30 Manila is still Sunday 4 Oct, whatever the handset timezone.
        let board = TodayDashboard.make(visits: [
            row("c", sequence: 2), row("a", sequence: 0, started: true, ended: true, outcome: "completed", activities: ["order_intent"]),
            row("b", sequence: 1), row("x", planned: false, started: true, ended: true, outcome: "completed"),
            row("old", day: "2026-10-03", sequence: 0),
        ], target: nil, now: now)
        XCTAssertEqual(board.dateLabel, "Sun, 4 Oct")
        XCTAssertEqual(board.route.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(board.route.map(\.state), [.done, .next, .upcoming])
        XCTAssertEqual(board.calls, 1, "an unplanned visit is not a route-plan call")
        XCTAssertEqual(board.unplannedCalls, 1)
        XCTAssertEqual(board.callsLabel, "1 · no target set")
        XCTAssertEqual(board.productiveLabel, "1 · 100%")
        XCTAssertEqual(board.salesLabel, "Not available yet")
    }

    func testProductiveFollowsTheGovernedActivityRuleNotTheEndOutcome() {
        let calls = [
            row("note", sequence: 0, started: true, ended: true, outcome: "completed", activities: ["note"]),
            row("sheet", sequence: 1, started: true, ended: true, outcome: "completed", activities: ["call_sheet"]),
            row("merch", sequence: 2, started: true, ended: true, outcome: "completed", activities: ["merchandising"]),
            row("merchMarker", sequence: 3, started: true, ended: true, outcome: "nonproductive",
                activities: ["price_check"], reason: "no_sales_due_to_inventory"),
            row("order", sequence: 4, started: true, ended: true, outcome: "nonproductive", activities: ["order_intent"]),
        ]
        let standard = TodayDashboard.make(visits: calls, target: .init(productivePct: 85), now: now)
        XCTAssertEqual(standard.calls, 5)
        XCTAssertEqual(standard.productive, 3, "note-only and call-sheet-only calls are nonproductive")
        XCTAssertEqual(standard.productiveLabel, "3 · 60% of 85%")
        let truck = TodayDashboard.make(visits: calls, target: .init(productiveCallRule: "truck_seller"), now: now)
        XCTAssertEqual(truck.productive, 2, "truck seller merchandising counts only with the no-sales marker")
        XCTAssertEqual(TodayDashboard.make(visits: calls, target: .init(productiveCallRule: "later_rule"), now: now).productive, 3)
        XCTAssertEqual(ProductiveCall.codes(activityKinds: ["inventory_check", "note", "price_check", "meeting"]),
                       ["merchandising", "inventory_retrieval", "meeting"])
    }

    func testNextIsOnlyAStopTheStartGuardAllows() {
        let board = TodayDashboard.make(visits: [row("a", sequence: 0), row("b", sequence: 1)], target: nil, now: now,
                                        canStart: { $0.id == "b" })
        XCTAssertEqual(board.route.map(\.state), [.upcoming, .next])
        let refused = TodayDashboard.make(visits: [row("a", sequence: 0), row("b", sequence: 1)], target: nil, now: now,
                                          canStart: { _ in false })
        XCTAssertNil(refused.next)
    }

    func testSalesFromTheServerWithTargetAndDownloadTime() {
        let asOf = Int64(ISO8601DateFormatter().date(from: "2026-10-04T09:14:00+08:00")!.timeIntervalSince1970 * 1000)
        let sales = StoreSnapshot.DaySales(amountMinor: 123_456_789, orders: 3, targetMinor: 500_000, asOf: asOf)
        let board = TodayDashboard.make(visits: [], target: nil, sales: sales, now: now)
        XCTAssertTrue(board.salesLabel.hasPrefix("₱1,234,567.89 of ₱5,000.00 · as of "), board.salesLabel)
        let noTarget = TodayDashboard.make(visits: [], target: nil, sales: .init(amountMinor: 0, orders: 0), now: now)
        XCTAssertEqual(noTarget.salesLabel, "₱0.00 · no target set")
        XCTAssertEqual(TodayDashboard.peso(-2_550), "-₱25.50")
    }

    func testAbsentSequenceKeepsSavedOrderAndOpenUnplannedCallHidesNext() {
        let board = TodayDashboard.make(visits: [row("second"), row("first"), row("x", planned: false, started: true)],
                                        target: .init(dailyCalls: 5, productivePct: 87.5), now: now)
        XCTAssertEqual(board.route.map(\.id), ["second", "first"])
        XCTAssertNil(board.next)
        XCTAssertNil(board.current, "the open call is not a planned stop")
        XCTAssertEqual(board.callsLabel, "0 of 5")
        XCTAssertEqual(board.productiveLabel, "0 · target 87.5%")
        XCTAssertEqual(TodayDashboard.make(visits: [], target: nil, now: now).completionLabel, "No planned stores")
    }
}
