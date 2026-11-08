import XCTest

/// SP-0166: the signed-in app has a bottom bar on iPhone (system tab bar) and iPad (floating glass bar,
/// portrait and landscape); every tab opens its screen and Add a store is one tap from Stores.
@MainActor
final class BottomNavUITests: XCTestCase {
    private let tabs = ["Today": "todayTitle", "Route": "routeTitle", "Stores": "customersTitle", "More": "moreTitle"]

    override func setUp() async throws { continueAfterFailure = false }
    override func tearDown() async throws { XCUIDevice.shared.orientation = .portrait }

    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    private func launchSignedIn(_ scenario: String = "registers") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["FIELD_STUB_BACKEND"] = scenario
        app.launch()
        let email = app.textFields["emailField"]
        XCTAssertTrue(email.waitForExistence(timeout: 5))
        email.tap(); email.typeText("seller@example.test")
        if app.keyboards.buttons["Return"].exists { app.keyboards.buttons["Return"].tap() }
        else if app.keyboards.buttons["return"].exists { app.keyboards.buttons["return"].tap() }
        let password = app.secureTextFields["passwordField"]
        password.tap(); password.typeText("correct-horse")
        app.buttons["signInButton"].tap()
        XCTAssertTrue(app.staticTexts["Stub Outlet"].waitForExistence(timeout: 20))
        return app
    }

    /// The tab button: the system tab bar on iPhone, the floating bar on iPad.
    private func tab(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        isPad ? app.buttons["tab-\(label.lowercased())"] : app.tabBars.buttons[label]
    }

    /// The bar exists, every tab is hittable and sits in the bottom band of the window.
    private func assertBottomBar(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let window = app.windows.firstMatch.frame
        if isPad {
            XCTAssertTrue(app.otherElements["fieldTabBar"].waitForExistence(timeout: 5)
                          || app.buttons["tab-today"].waitForExistence(timeout: 5), "floating bar", file: file, line: line)
        } else {
            XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 5), "system tab bar", file: file, line: line)
        }
        for label in tabs.keys {
            let button = tab(app, label)
            XCTAssertTrue(button.waitForExistence(timeout: 5), "\(label) tab", file: file, line: line)
            XCTAssertTrue(button.isHittable, "\(label) tab hittable", file: file, line: line)
            XCTAssertGreaterThan(button.frame.midY, window.maxY - 140, "\(label) tab is at the bottom", file: file, line: line)
            XCTAssertLessThanOrEqual(button.frame.maxY, window.maxY, file: file, line: line)
        }
    }

    private func visitEveryTab(_ app: XCUIApplication) {
        for label in ["Route", "Stores", "More", "Today"] {
            tab(app, label).tap()
            XCTAssertTrue(app.staticTexts[tabs[label]!].waitForExistence(timeout: 5), "\(label) screen opens")
            XCTAssertTrue(tab(app, label).isSelected, "\(label) tab shows as selected")
        }
    }

    func testBottomBarReachesEveryTab() {
        let app = launchSignedIn()
        assertBottomBar(app)
        visitEveryTab(app)
    }

    func testBottomBarInLandscapeOnPad() throws {
        try XCTSkipUnless(isPad, "iPhone stays portrait")
        let app = launchSignedIn()
        XCUIDevice.shared.orientation = .landscapeLeft
        assertBottomBar(app)
        visitEveryTab(app)
        tab(app, "Stores").tap()
        XCTAssertTrue(app.otherElements["storesDetailPlaceholder"].waitForExistence(timeout: 5)
                      || app.staticTexts["Choose a store"].waitForExistence(timeout: 5), "list and detail side by side")
        XCUIDevice.shared.orientation = .portrait
        // The rotation animates; measure the bar only once the window reports portrait again.
        let portrait = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let f = app.windows.firstMatch.frame; return f.height > f.width }, object: nil)
        _ = XCTWaiter().wait(for: [portrait], timeout: 5)
        sleep(1)
        assertBottomBar(app)
    }

    func testAddStoreFromStoresTabHidesTheBar() {
        let app = launchSignedIn()
        tab(app, "Stores").tap()
        let add = app.buttons["storesAddStore"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        XCTAssertTrue(add.isHittable)
        add.tap()
        XCTAssertTrue(app.staticTexts["addStoreTitle"].waitForExistence(timeout: 5))
        // The form owns the bottom edge (its Save button); the bar steps aside like Android's census page.
        let gone = NSPredicate(format: "exists == false OR hittable == false")
        expectation(for: gone, evaluatedWith: tab(app, "Today"))
        waitForExpectations(timeout: 5)
    }

    func testAddStoreFromMoreTab() {
        let app = launchSignedIn()
        tab(app, "More").tap()
        let add = app.buttons["moreAddStore"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        add.tap()
        XCTAssertTrue(app.staticTexts["addStoreTitle"].waitForExistence(timeout: 5))
    }

    func testMoreOpensAccountAndSync() {
        let app = launchSignedIn()
        tab(app, "More").tap()
        app.buttons["moreSync"].tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        app.buttons["moreAccount"].tap()
        XCTAssertTrue(app.buttons["signOutButton"].waitForExistence(timeout: 5))
    }
}
