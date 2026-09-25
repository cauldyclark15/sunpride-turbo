import XCTest

final class FieldIOSUITests: XCTestCase {
    func testSignInShellAndTokenPreview() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Sunpride Field"].exists)
        XCTAssertTrue(app.staticTexts["Offline — not signed in"].exists)
        XCTAssertTrue(app.textFields["emailField"].exists)
        XCTAssertTrue(app.secureTextFields["passwordField"].exists)
        XCTAssertFalse(app.buttons["signInButton"].isEnabled)
        XCTAssertTrue(app.staticTexts["Sign-in arrives in the next build"].exists)
        app.buttons["designTokensLink"].tap()
        XCTAssertTrue(app.staticTexts["designTokensTitle"].waitForExistence(timeout: 5))
    }

    func testAccessibilityXLAndDarkMode() {
        let app = XCUIApplication()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL", "-uiuserinterfacestyle", "dark"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Offline — not signed in"].exists)
        let link = app.buttons["designTokensLink"]
        if !link.isHittable { app.swipeUp() }
        XCTAssertTrue(link.isHittable)
        link.tap()
        XCTAssertTrue(app.staticTexts["designTokensTitle"].exists)
    }
}
