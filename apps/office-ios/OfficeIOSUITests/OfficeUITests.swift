import XCTest

/// Live UI tests against a lane API (Config/Local.xcconfig points the Debug build at it).
/// The seed password comes from the environment only: run xcodebuild with
/// `TEST_RUNNER_OFFICE_TEST_PASSWORD=...` (never committed, never printed).
final class OfficeUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-officeResetSession"]
        app.launch()
    }

    var password: String {
        get throws {
            try XCTUnwrap(ProcessInfo.processInfo.environment["OFFICE_TEST_PASSWORD"], "set TEST_RUNNER_OFFICE_TEST_PASSWORD")
        }
    }

    var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    func signIn(_ who: String = "manager") throws {
        let email = app.textFields["signin.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 20))
        email.tap()
        email.typeText("\(who)@sunpride.test")
        let pw = app.secureTextFields["signin.password"]
        pw.tap()
        pw.typeText(try password)
        app.buttons["signin.submit"].tap()
        XCTAssertTrue(tab(.today).waitForExistence(timeout: 30), "signed in shell")
        dismissSavePassword(app)
        _ = who
    }

    enum T: String { case today, decide, stores, stock, more }
    var titles: [T: String] { [.today: "Today", .decide: "Decide", .stores: "Stores", .stock: "Stock", .more: "More"] }

    func tab(_ t: T) -> XCUIElement {
        isPad ? app.buttons["tab.\(t.rawValue)"].firstMatch : app.tabBars.buttons[titles[t]!].firstMatch
    }

    func testWrongPasswordIsRefusedInPlainWords() throws {
        let email = app.textFields["signin.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 20))
        email.tap(); email.typeText("manager@sunpride.test")
        let pw = app.secureTextFields["signin.password"]
        pw.tap(); pw.typeText("not-the-password")
        app.buttons["signin.submit"].tap()
        XCTAssertTrue(app.staticTexts["That email or password is not right."].waitForExistence(timeout: 15))
    }

    /// Bottom navigation on every device: five sections, the bar's buttons sit in the bottom part of the
    /// screen on iPhone (system tab bar) and on iPad (floating glass bar), and each opens its screen.
    func testTabsAreAtTheBottomAndOpenEachSection() throws {
        try signIn()
        let screen = app.windows.firstMatch.frame
        for t in [T.today, .decide, .stores, .stock, .more] {
            let button = tab(t)
            XCTAssertTrue(button.waitForExistence(timeout: 10), "\(t) tab")
            XCTAssertGreaterThan(button.frame.midY, screen.height * 0.82, "\(t) tab is at the bottom")
            button.tap()
            XCTAssertTrue(app.navigationBars[titles[t]!].waitForExistence(timeout: 20), "\(t) screen")
        }
        if isPad {
            XCUIDevice.shared.orientation = .landscapeLeft
            defer { XCUIDevice.shared.orientation = .portrait }
            let landscape = app.windows.firstMatch.frame
            XCTAssertGreaterThan(landscape.width, landscape.height)
            let bar = tab(.today)
            XCTAssertTrue(bar.waitForExistence(timeout: 5))
            XCTAssertGreaterThan(bar.frame.midY, landscape.height * 0.82, "bar stays at the bottom in landscape")
            bar.tap()
            XCTAssertTrue(app.navigationBars["Today"].waitForExistence(timeout: 10))
        }
    }

    /// Decide: open the first item someone else counted, approve it, see it confirmed and the count drop.
    /// Lane setup: counts planned by manager@ (seed-counts.js with SEED_AS=manager) and a stock authority band
    /// that lets the approver role decide them; approver@ decides.
    func testDecideApprove() throws {
        try signIn("approver")
        tab(.decide).tap()
        XCTAssertTrue(app.navigationBars["Decide"].waitForExistence(timeout: 20))
        let rows = app.descendants(matching: .any).matching(identifier: "decide.row")
        if !rows.firstMatch.waitForExistence(timeout: 20) {
            // A slow first load: pull to refresh once.
            app.swipeDown()
        }
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 30), "an item waits (scripts/lane-seed-decide.js)")
        let before = rows.count
        rows.firstMatch.tap()
        let approve = app.buttons["decide.approve"]
        XCTAssertTrue(approve.waitForExistence(timeout: 10))
        approve.tap()
        let confirm = app.buttons["decide.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()
        let confirmed = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", ": Approved")).firstMatch
        XCTAssertTrue(confirmed.waitForExistence(timeout: 20), "decision confirmed in the server's words")
        let fewer = NSPredicate { _, _ in rows.count == before - 1 }
        wait(for: [XCTNSPredicateExpectation(predicate: fewer, object: nil)], timeout: 15)
    }

    /// Stores: open the first store; its name and its map pin show.
    func testStoreDetailShowsNameAndMap() throws {
        try signIn()
        tab(.stores).tap()
        let row = app.descendants(matching: .any)["store.row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["store.name"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.descendants(matching: .any)["store.map"].waitForExistence(timeout: 30), "map pin")
    }

    func testSignOut() throws {
        try signIn("viewer")
        tab(.more).tap()
        let account = app.descendants(matching: .any)["more.account"].firstMatch
        XCTAssertTrue(account.waitForExistence(timeout: 10))
        account.tap()
        app.buttons["account.signout"].tap()
        app.sheets.buttons["Sign out"].firstMatch.tap()
        XCTAssertTrue(app.textFields["signin.email"].waitForExistence(timeout: 10))
    }
}

extension XCTestCase {
    /// iOS offers to save the typed password (a system alert outside the app); answer "Not Now".
    func dismissSavePassword(_ app: XCUIApplication) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<2 {
            for candidate in [app.buttons["Not Now"], springboard.buttons["Not Now"]] where candidate.waitForExistence(timeout: 3) {
                candidate.tap()
                return
            }
        }
    }
}
