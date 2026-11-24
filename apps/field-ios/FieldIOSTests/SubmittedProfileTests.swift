import XCTest
@testable import FieldIOS

final class SubmittedProfileTests: XCTestCase {
    func testPartialEditsPreserveShipToKeysBlanksAndExpectedVersion() throws {
        let data = try SubmittedProfile.body(edits: ["street1": "Sample Road", "shipTos[0].contactPerson": "Sample Owner", "email": " "], updatedAt: 123)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body["expectedUpdatedAt"] as? Int, 123)
        let edits = try XCTUnwrap(body["edits"] as? [String: Any])
        XCTAssertEqual(edits["shipTos[0].contactPerson"] as? String, "Sample Owner")
        XCTAssertTrue(edits["email"] is NSNull)
        XCTAssertNil(body["code"]); XCTAssertNil(body["status"])
    }
    func testParentChangesClearChildrenAndKeepOtherEdits() throws {
        let field = try JSONDecoder().decode(SubmittedProfile.Field.self, from: Data(#"{"key":"regionCode","label":"Region","section":"Location","kind":"geo","value":"old","options":[],"clears":["provinceCode","barangayCode"],"error":null}"#.utf8))
        let edits = SubmittedProfile.changing(["registeredName": "Sample Shop", "provinceCode": "old"], field: field, value: "new")
        XCTAssertEqual(edits["regionCode"], "new"); XCTAssertEqual(edits["provinceCode"], "")
        XCTAssertEqual(edits["barangayCode"], ""); XCTAssertEqual(edits["registeredName"], "Sample Shop")
    }
    func testApprovedProfileCarriesReadOnlyAndReadableChangeFacts() throws {
        let profile = try JSONDecoder().decode(SubmittedProfile.self, from: Data(#"{"customer":{"id":"sample","customerName":"Sample Owner","canEdit":false,"updatedAt":123,"status":"active","enrolmentStatus":"approved","history":[{"id":"entry","actor":"Sample salesman","at":100,"changes":[{"field":"street1","label":"Street 1","before":null,"after":"Sample Road"}]}],"historyTruncated":false},"fields":[],"missingFields":[]}"#.utf8))
        XCTAssertFalse(profile.customer.canEdit); XCTAssertFalse(profile.customer.waiting)
        XCTAssertEqual(profile.customer.history[0].changes[0].after?.text, "Sample Road")
        XCTAssertNil(profile.customer.history[0].changes[0].before)
    }
}
