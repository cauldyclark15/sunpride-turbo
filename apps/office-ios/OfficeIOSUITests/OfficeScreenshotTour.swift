import XCTest

/// Screenshot tour for the report (run only with TEST_RUNNER_OFFICE_SHOTS=1; orientation from
/// TEST_RUNNER_OFFICE_SHOT_ORIENTATION=landscape). Each shot is an XCTAttachment named `<prefix>-<screen>`.
final class OfficeScreenshotTour: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        try XCTSkipUnless(env["OFFICE_SHOTS"] == "1", "screenshot tour only on request")
        continueAfterFailure = true
        app = XCUIApplication()
        app.launchArguments += ["-officeResetSession"]
        app.launch()
    }

    var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }
    var prefix: String { ProcessInfo.processInfo.environment["OFFICE_SHOT_PREFIX"] ?? (isPad ? "ipad" : "iphone") }

    func shot(_ name: String, wait: TimeInterval = 2.5) {
        Thread.sleep(forTimeInterval: wait)
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "\(prefix)-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    func tab(_ id: String, _ title: String) -> XCUIElement {
        isPad ? app.buttons["tab.\(id)"].firstMatch : app.tabBars.buttons[title].firstMatch
    }

    func any(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }

    func back() {
        let b = app.navigationBars.buttons.element(boundBy: 0)
        if b.exists { b.tap() }
    }

    func testTour() throws {
        let env = ProcessInfo.processInfo.environment
        let landscape = env["OFFICE_SHOT_ORIENTATION"] == "landscape"
        XCUIDevice.shared.orientation = landscape ? .landscapeLeft : .portrait
        let email = app.textFields["signin.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 20))
        if env["OFFICE_SHOT_SIGNIN"] == "1" { shot("signin", wait: 1) }
        email.tap(); email.typeText("\(env["OFFICE_SHOT_USER"] ?? "manager")@sunpride.test")
        let pw = app.secureTextFields["signin.password"]
        pw.tap(); pw.typeText(try XCTUnwrap(env["OFFICE_TEST_PASSWORD"]))
        app.buttons["signin.submit"].tap()
        XCTAssertTrue(tab("today", "Today").waitForExistence(timeout: 30))
        dismissSavePassword(app)
        shot("1-today", wait: 4)

        tab("decide", "Decide").tap()
        _ = any("decide.row").waitForExistence(timeout: 15)
        shot("2-decide")
        if any("decide.row").exists {
            any("decide.row").tap()
            _ = app.buttons["decide.approve"].waitForExistence(timeout: 10)
            shot("2b-decide-item")
            if !(isPad && landscape) { back() }
        }

        tab("stores", "Stores").tap()
        _ = any("store.row").waitForExistence(timeout: 20)
        shot("3-stores", wait: 3)
        if any("store.row").exists {
            any("store.row").tap()
            _ = any("store.map").waitForExistence(timeout: 20)
            shot("3b-store", wait: 4)
            if !(isPad && landscape) { back() }
        }

        tab("stock", "Stock").tap()
        _ = any("stock.onHand").waitForExistence(timeout: 15)
        shot("4-stock")
        if any("stock.onHand").exists {
            any("stock.onHand").tap()
            shot("4b-stock-on-hand", wait: 3)
            if !(isPad && landscape) { back() }
        }

        tab("more", "More").tap()
        _ = any("more.sales").waitForExistence(timeout: 10)
        shot("5-more")
        if any("more.sales").exists {
            any("more.sales").tap()
            shot("5b-sales", wait: 3)
        }
    }
}
