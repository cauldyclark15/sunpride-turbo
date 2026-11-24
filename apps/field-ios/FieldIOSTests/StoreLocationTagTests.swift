import XCTest
@testable import FieldIOS

final class StoreLocationTagTests: XCTestCase {
    let at: Int64 = 1_800_000_000_000
    func fix(_ accuracy: Double = 70, latitude: Double = 10, time: Int64? = nil, mock: Bool = false) throws -> VisitLocation {
        try VisitLocation(latitude: latitude, longitude: 123, accuracyMeters: accuracy, fixTime: time ?? at, mockSignal: mock)
    }
    func testBoundedBestFixAndDurableSession() throws {
        var s = StoreLocationTag(captureId: UUID().uuidString.lowercased(), startedAt: at)
        XCTAssertNil(s.best)
        XCTAssertTrue(s.accept(try fix(), speed: nil, at: at))
        XCTAssertFalse(s.accept(try fix(100), speed: nil, at: at))
        XCTAssertFalse(s.accept(try fix(20, mock: true), speed: nil, at: at))
        XCTAssertFalse(s.accept(try fix(20, time: at - 120_001), speed: nil, at: at))
        s = try JSONDecoder().decode(StoreLocationTag.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(s.best?.accuracyMeters, 70)
        XCTAssertTrue(s.accept(try fix(30), speed: nil, at: at))
        XCTAssertFalse(s.active(at: at + StoreLocationTag.window))
    }
    func testNoTagAfterLeavingOrDriving() throws {
        let initial = try fix()
        var s = StoreLocationTag(outletId: UUID().uuidString.lowercased(), startedAt: at, anchor: initial, best: initial)
        XCTAssertFalse(s.accept(try fix(20, latitude: 10.01), speed: 0, at: at))
        XCTAssertTrue(s.stopped)
        var driving = StoreLocationTag(outletId: UUID().uuidString.lowercased(), startedAt: at)
        XCTAssertFalse(driving.accept(try fix(), speed: 9, at: at))
        XCTAssertTrue(driving.stopped)
    }
    func testFollowUpIsIndependentAndDependsOnOriginalSave() throws {
        let capture = UUID().uuidString.lowercased()
        let s = StoreLocationTag(captureId: capture, startedAt: at)
        let intent = try s.intent(fix(), at: at)
        XCTAssertNotEqual(intent.requestId.uuidString.lowercased(), capture)
        XCTAssertEqual(intent.kind, StoreLocationTag.kind)
        XCTAssertEqual(intent.dependencies, [capture])
        XCTAssertTrue(StoreLocationTag.valid(try XCTUnwrap(intent.payload), at: at))
    }
}
