import XCTest

/// SP-0166 evidence only: captures each tab (and dark mode) into `FIELD_SHOT_DIR` (pass it as
/// `TEST_RUNNER_FIELD_SHOT_DIR`). Skipped in normal runs. Works on the old one-stack app too (falls back
/// to the Today links) so before/after shots come from the same script.
@MainActor
final class ScreenshotTourUITests: XCTestCase {
    private var dir: String? { ProcessInfo.processInfo.environment["FIELD_SHOT_DIR"] }
    private var prefix: String { ProcessInfo.processInfo.environment["FIELD_SHOT_PREFIX"] ?? "shot" }
    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    override func tearDown() async throws { XCUIDevice.shared.orientation = .portrait }

    private func launch(dark: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["FIELD_STUB_BACKEND"] = "registers"
        app.launchArguments += [dark ? "-calmDarkMode" : "-calmLightMode"]
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
        if app.buttons["liveConsentDecline"].waitForExistence(timeout: 2) { app.buttons["liveConsentDecline"].tap() }
        return app
    }

    private func open(_ app: XCUIApplication, _ label: String) {
        let tab = isPad ? app.buttons["tab-\(label.lowercased())"] : app.tabBars.buttons[label]
        if tab.exists { tab.tap(); sleep(1); return }
        // Old app: one stack under Today.
        if app.buttons["BackButton"].exists { app.buttons["BackButton"].tap(); sleep(1) }
        if app.buttons["Done"].exists { app.buttons["Done"].tap(); sleep(1) }
        let link = ["Route": "openRoute", "Stores": "openCustomers", "More": "accountButton"][label]
        if let link {
            let element = app.buttons[link]
            for _ in 0..<5 where !element.isHittable { app.swipeUp() }
            element.tap()
        }
        sleep(1)
    }

    private func shot(_ name: String) throws {
        guard let dir else { return }
        sleep(1)
        let png = XCUIScreen.main.screenshot().pngRepresentation
        try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(prefix)-\(name).png"))
    }

    func testTour() throws {
        try XCTSkipIf(dir == nil, "evidence only")
        let orientations: [(String, UIDeviceOrientation)] = isPad ? [("portrait", .portrait), ("landscape", .landscapeLeft)]
                                                                  : [("portrait", .portrait)]
        for (name, orientation) in orientations {
            let app = launch(dark: false)
            XCUIDevice.shared.orientation = orientation
            sleep(1)
            for label in ["Today", "Route", "Stores", "More"] {
                open(app, label)
                try shot("\(name)-\(label.lowercased())")
            }
            app.terminate()
        }
        let app = launch(dark: true)
        try shot("dark-today")
        open(app, "Stores")
        try shot("dark-stores")
    }

    /// Add a store (top and bottom with Save) and Account (no Face ID toggle while biometrics are off).
    func testAddStoreAndAccountTour() throws {
        try XCTSkipIf(dir == nil, "evidence only")
        let app = launch(dark: false)
        open(app, "Stores")
        app.buttons["storesAddStore"].tap()
        XCTAssertTrue(app.staticTexts["addStoreTitle"].waitForExistence(timeout: 5))
        try shot("addstore-top")
        for _ in 0..<4 { app.swipeUp() }
        try shot("addstore-bottom")
        app.buttons["BackButton"].tap()
        open(app, "More")
        app.buttons["moreAccount"].tap()
        XCTAssertTrue(app.buttons["signOutButton"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.switches["biometricToggle"].exists)
        try shot("account")
    }

    /// iPad: Today scrolled to the end (last row above the floating bar), landscape Stores, and
    /// Add a store at the bottom with the keyboard up.
    func testPadLayoutTour() throws {
        try XCTSkipIf(dir == nil || !isPad, "evidence only, iPad")
        let app = launch(dark: false)
        XCUIDevice.shared.orientation = .portrait
        sleep(1)
        for _ in 0..<5 { app.swipeUp() }
        try shot("ipad-portrait-today-bottom")
        app.buttons["openAddStore"].tap()
        XCTAssertTrue(app.staticTexts["addStoreTitle"].waitForExistence(timeout: 5))
        let name = app.textFields["addStoreName"]
        XCTAssertTrue(name.waitForExistence(timeout: 15))
        name.tap(); name.typeText("Keyboard check")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        sleep(1)
        try shot("ipad-addstore-keyboard")
        app.buttons["BackButton"].tap()
        sleep(1)
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        open(app, "Stores")
        try shot("ipad-landscape-stores")
    }
}
