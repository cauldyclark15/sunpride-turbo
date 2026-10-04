import XCTest
@testable import FieldIOS

final class TodayDashboardTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-10-04T23:30:00+08:00")!
    private func row(_ id: String, day: String = "2026-10-04", planned: Bool = true, sequence: Int? = nil,
                     started: Bool = false, ended: Bool = false, outcome: String? = nil) -> AppModel.TodayVisit {
        AppModel.TodayVisit(id: id, outletId: id, outlet: "Outlet \(id)", serviceDate: day, intents: [], planned: planned,
            status: "Planned", sequence: sequence, startedAt: started ? now : nil, endedAt: ended ? now : nil, outcome: outcome)
    }

    func testManilaDateMcpOrderAndOnlyPlannedStoresCount() {
        // 23:30 Manila is still Sunday 4 Oct, whatever the handset timezone.
        let board = TodayDashboard.make(visits: [
            row("c", sequence: 2), row("a", sequence: 0, started: true, ended: true, outcome: "completed"),
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
        XCTAssertEqual(TodayDashboard.salesLabel, "Not on this phone yet")
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
