import XCTest
@testable import FieldIOS

/// Every closed server refusal code (apps/api/src/core/sync.js OP_CODES) reads as plain words, and the
/// list never shows operation names such as "visit.checkIn" to the salesperson.
final class ReviewTextTests: XCTestCase {
    private let serverCodes = ["mock_location_refused", "invalid_request", "invalid_plan", "out_of_scope", "dependency_missing", "invalid_transition",
                               "call_open", "mcp_order", "wrong_date", "idempotency_conflict", "evidence_pending_review",
                               "unsupported_operation", "load_not_posted", "stock_conflict", "place_mismatch", "places_unavailable"]

    func testEveryServerCodeHasPlainWords() {
        for code in serverCodes + ["unknown_code", "unknown_status", "conflict"] {
            XCTAssertNotNil(ReviewText.reasons[code], code)
            let line = ReviewText.line(kind: "visit.checkIn", code: code)
            XCTAssertFalse(line.contains("Unknown outcome"), line)
            XCTAssertNil(line.range(of: #"[A-Za-z]\.[A-Za-z]"#, options: .regularExpression), "no operation name or code in \(line)")
            XCTAssertFalse(line.contains("_"), line)
        }
    }

    func testAlreadyVisitedStoreSaysSoInPlainWords() {
        XCTAssertEqual(ReviewText.line(kind: "visit.checkIn", code: "idempotency_conflict"),
                       "Start of visit · Already recorded for this store today")
        XCTAssertEqual(ReviewText.line(kind: "visit.activity", code: "dependency_missing"),
                       "Visit activity · The start of this visit was not accepted")
    }

    func testAddressReasonsAreTwoSentences() {
        XCTAssertEqual(ReviewText.reasons["place_mismatch"],
                       "The address you picked is far from where you are. Check the address or use your location.")
        XCTAssertEqual(ReviewText.reasons["places_unavailable"],
                       "Address search is not available right now. Use your location or try again later.")
    }

    @MainActor func testFaceIDStaysOff() {
        XCTAssertFalse(AppModel.biometricsEnabled)
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "FieldBiometricsEnabled") as? Bool, false)
    }

    func testUnrecognisedCodeAndKindStayPlain() {
        let line = ReviewText.line(kind: "future.op", code: "brand_new_code")
        XCTAssertEqual(line, "Phone update · The office gave a reason this app does not know")
    }

    func testServerCodeListMatchesTheServerWhenReadable() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        guard let sync = try? String(contentsOf: root.appending(path: "apps/api/src/core/sync.js"), encoding: .utf8)
        else { throw XCTSkip("server sources are not readable from the device sandbox") }
        let block = sync.components(separatedBy: "OP_CODES = Object.freeze([")[1].components(separatedBy: "]")[0]
        let codes = block.components(separatedBy: "\"").enumerated().filter { $0.offset % 2 == 1 }.map(\.element)
        XCTAssertEqual(Set(codes), Set(serverCodes))
    }
}
