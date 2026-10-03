import XCTest
@testable import FieldIOS

@MainActor
final class CallSheetTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "json")))
    }
    private func sheet() throws -> CallSheet {
        try XCTUnwrap(JSONDecoder().decode(BootstrapV1.Page.self, from: fixture("bootstrap-call-sheet-response")).callSheets.first)
    }
    func testDecodeAdditiveCallSheetsAndOldServerOmission() throws {
        let page = try JSONDecoder().decode(BootstrapV1.Page.self, from: fixture("bootstrap-call-sheet-response"))
        XCTAssertEqual(page.callSheets.count, 1)
        XCTAssertEqual(page.callSheets.first?.header.accountName, "Puregold Example")
        XCTAssertNil(page.callSheets.first?.header.receivingInCharge)
        XCTAssertEqual(page.callSheets.first?.lines.count, 2)
        XCTAssertEqual(try JSONDecoder().decode(BootstrapV1.Page.self, from: JSONEncoder().encode(page)).callSheets, page.callSheets)
        XCTAssertTrue(try JSONDecoder().decode(BootstrapV1.Page.self, from: fixture("bootstrap-response")).callSheets.isEmpty)
    }
    func testRejectMalformedProjectionAndMissingNullableKeys() throws {
        let original = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("bootstrap-call-sheet-response")) as? [String: Any])
        for mutation in 0..<7 {
            var object = original
            var sheets = try XCTUnwrap(object["callSheets"] as? [[String: Any]])
            var header = try XCTUnwrap(sheets[0]["header"] as? [String: Any])
            var lines = try XCTUnwrap(sheets[0]["lines"] as? [[String: Any]])
            switch mutation {
            case 0: header.removeValue(forKey: "receivingInCharge")
            case 1: header["accountName"] = ""
            case 2: sheets[0]["revision"] = 0
            case 3: sheets[0]["outletId"] = "outside-page"
            case 4: lines[0].removeValue(forKey: "barcode")
            case 5: lines = Array(repeating: lines[0], count: 101)
            default: lines[1]["productId"] = lines[0]["productId"]
            }
            sheets[0]["header"] = header; sheets[0]["lines"] = lines
            object["callSheets"] = sheets
            XCTAssertThrowsError(try JSONDecoder().decode(BootstrapV1.Page.self, from: JSONSerialization.data(withJSONObject: object)))
        }
        var object = original; object["callSheets"] = NSNull()
        XCTAssertThrowsError(try JSONDecoder().decode(BootstrapV1.Page.self, from: JSONSerialization.data(withJSONObject: object)))
    }
    func testOnlyTouchedProductsAndExplicitNullMeasures() throws {
        let lines = try CallSheetPayload.lines(sheet: sheet(), drafts: [
            "product-1": .init(values: [.order: "24", .beginningInventory: "  "]),
            "product-2": .init(values: [.order: ""])
        ])
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(lines[0]["productId"] as? String, "product-1")
        XCTAssertEqual(lines[0]["order"] as? Int, 24)
        XCTAssertEqual(Set(lines[0].keys), Set(["productId", "order", "beginningInventory", "take", "delivered", "offtake", "endInventory"]))
        for measure in CallSheetMeasure.allCases where measure != .order {
            XCTAssertTrue(lines[0][measure.rawValue] is NSNull)
        }
    }
    func testRejectNegativeFractionOverflowAndNonIntegerInput() throws {
        for value in ["-1", "1.5", "1,000", "1e3", "+1", "NaN", "1000001", "999999999999999999999999999999999999", "１２"] {
            XCTAssertThrowsError(try CallSheetPayload.lines(sheet: sheet(), drafts: ["product-1": .init(values: [.order: value])])) {
                XCTAssertEqual($0 as? CallSheetPayload.Failure, .invalidNumber)
            }
        }
    }
    func testZeroAndUpperBoundAreCaptured() throws {
        let lines = try CallSheetPayload.lines(sheet: sheet(), drafts: ["product-2": .init(values: [.beginningInventory: "0", .endInventory: "1000000"])])
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(lines[0]["beginningInventory"] as? Int, 0)
        XCTAssertEqual(lines[0]["endInventory"] as? Int, 1_000_000)
    }
    func testEmptyAndUnknownProductsAreRejected() throws {
        let candidates: [[String: CallSheetDraft]] = [[:], ["product-1": .init(values: [.order: "\n "])]]
        for drafts in candidates {
            XCTAssertThrowsError(try CallSheetPayload.lines(sheet: sheet(), drafts: drafts)) {
                XCTAssertEqual($0 as? CallSheetPayload.Failure, .empty)
            }
        }
        XCTAssertThrowsError(try CallSheetPayload.lines(sheet: sheet(), drafts: ["other-product": .init(values: [.order: "1"])])) {
            XCTAssertEqual($0 as? CallSheetPayload.Failure, .unknownProduct)
        }
    }
    func testPayloadMatchesSharedFixtureAndNeverSendsWeek() throws {
        let expected = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("push-call-sheet-request")) as? [String: Any])
        let operation = try XCTUnwrap((expected["operations"] as? [[String: Any]])?.first)
        let payload = try XCTUnwrap(operation["payload"] as? [String: Any])
        let activity = try XCTUnwrap(payload["activity"] as? [String: Any])
        let dependency = try XCTUnwrap(UUID(uuidString: (operation["dependsOn"] as? [String])!.first!))
        let intent = try DiagnosticOperation.callSheet(sheet(), drafts: [
            "product-1": .init(values: [.order: "24", .beginningInventory: "10", .take: "8", .delivered: "24", .offtake: "26", .endInventory: "8"]),
            "product-2": .init(values: [.beginningInventory: "0", .endInventory: "0"])
        ], checkIn: dependency, visitId: "visit-1", now: Date(timeIntervalSince1970: 1_790_380_800.005))
        let actual = try XCTUnwrap(JSONSerialization.jsonObject(with: intent.operationJSON) as? [String: Any])
        let actualPayload = try XCTUnwrap(actual["payload"] as? [String: Any])
        XCTAssertEqual(actualPayload["activity"] as? NSDictionary, activity as NSDictionary)
        XCTAssertEqual(actual["dependsOn"] as? [String], operation["dependsOn"] as? [String])
        XCTAssertEqual(Set(actualPayload.keys), Set(["visitId", "deviceTime", "activity"]))
        XCTAssertEqual(Set(activity.keys), Set(["kind", "lines"]))
    }
}
