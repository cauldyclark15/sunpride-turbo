import XCTest

final class FieldIOSUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testSignInShellAndTokenPreview() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Sunpride Field"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Offline — not signed in"].exists)
        XCTAssertTrue(app.textFields["emailField"].exists)
        XCTAssertTrue(app.secureTextFields["passwordField"].exists)
        XCTAssertFalse(app.buttons["signInButton"].isEnabled, "disabled until email and password are entered")
        app.buttons["designTokensLink"].tap()
        XCTAssertTrue(app.staticTexts["designTokensTitle"].waitForExistence(timeout: 5))
    }

    func testAccessibilityXLAndDarkMode() {
        let app = XCUIApplication()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL", "-uiuserinterfacestyle", "dark"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Offline — not signed in"].waitForExistence(timeout: 5))
        let link = app.buttons["designTokensLink"]
        if !link.isHittable { app.swipeUp() }
        XCTAssertTrue(link.isHittable)
        link.tap()
        XCTAssertTrue(app.staticTexts["designTokensTitle"].exists)
    }

    // MARK: Stubbed backend (DEBUG `FIELD_STUB_BACKEND`; no network, no real account)

    private func launchStub(_ scenario: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["FIELD_STUB_BACKEND"] = scenario
        app.launch()
        return app
    }

    private func signIn(_ app: XCUIApplication, password: String) {
        let email = app.textFields["emailField"]
        XCTAssertTrue(email.waitForExistence(timeout: 5))
        email.tap()
        email.typeText("seller@example.test")
        let passwordField = app.secureTextFields["passwordField"]
        passwordField.tap()
        passwordField.typeText(password)
        let button = app.buttons["signInButton"]
        XCTAssertTrue(button.isEnabled, "sign-in is enabled once both fields are filled")
        button.tap()
    }

    func testWrongPasswordShowsClearError() {
        let app = launchStub("unregistered")
        signIn(app, password: "wrong-stub-password")
        XCTAssertTrue(app.staticTexts["Incorrect email or password."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Offline — not signed in"].exists)
    }

    func testEnrollmentShowsPublicKeyThenBindsWhenAdminRegisters() {
        let app = launchStub("registers")
        signIn(app, password: "correct-horse")
        XCTAssertTrue(app.staticTexts["This phone isn't registered yet"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Signed in — phone not registered"].exists)
        let publicKey = app.staticTexts["devicePublicKey"]
        XCTAssertTrue(publicKey.exists)
        XCTAssertTrue(publicKey.label.hasPrefix("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE"), "shows SPKI base64")
        XCTAssertEqual(publicKey.label.count, 124)
        XCTAssertTrue(app.staticTexts["deviceFingerprint"].exists)
        XCTAssertTrue(app.buttons["copyPublicKey"].exists)
        // The stub admin registers after the first lookup; auto-poll finds it, challenges and binds.
        XCTAssertTrue(app.staticTexts["Phone ready"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Ready"].exists)

        app.buttons["signOutButton"].tap()
        XCTAssertTrue(app.staticTexts["Offline — not signed in"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["emailField"].exists)
    }

    func testRevokedPhoneIsRemoved() {
        let app = launchStub("revoked")
        signIn(app, password: "correct-horse")
        XCTAssertTrue(app.staticTexts["This phone was removed — ask your admin"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Phone removed"].exists)
    }
}
