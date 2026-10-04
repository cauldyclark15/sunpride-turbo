import XCTest

final class FieldIOSUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testSignInShellAndTokenPreview() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Sunpride Field"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["outboxStatus"].exists)
        XCTAssertTrue(app.textFields["emailField"].exists)
        XCTAssertTrue(app.secureTextFields["passwordField"].exists)
        XCTAssertFalse(app.buttons["signInButton"].isEnabled, "disabled until email and password are entered")
        XCTAssertFalse(app.buttons["designTokensLink"].exists)
    }

    func testAccessibilityXLAndDarkMode() {
        let app = XCUIApplication()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL", "-calmDarkMode"]
        app.launch()
        XCTAssertFalse(app.buttons["outboxStatus"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["signInButton"].isHittable)
        XCTAssertFalse(app.buttons["designTokensLink"].exists)
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

    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testCalmScreenshots() {
        for mode in ["light", "dark"] {
            let signInApp = XCUIApplication()
            signInApp.launchArguments += [mode == "dark" ? "-calmDarkMode" : "-calmLightMode"]
            signInApp.launch()
            XCTAssertTrue(signInApp.textFields["emailField"].waitForExistence(timeout: 5))
            capture(signInApp, "\(mode)-sign-in")
            signInApp.terminate()

            let waiting = XCUIApplication()
            waiting.launchEnvironment["FIELD_STUB_BACKEND"] = "unregistered"
            waiting.launchArguments += [mode == "dark" ? "-calmDarkMode" : "-calmLightMode"]
            waiting.launch()
            signIn(waiting, password: "correct-horse")
            XCTAssertTrue(waiting.staticTexts["deviceFingerprint"].waitForExistence(timeout: 10))
            XCTAssertTrue(waiting.buttons["checkRegistration"].isHittable)
            XCTAssertTrue(waiting.buttons["copyPublicKey"].isHittable)
            capture(waiting, "\(mode)-waiting-for-admin")
            waiting.terminate()

            let today = XCUIApplication()
            today.launchEnvironment["FIELD_STUB_BACKEND"] = "registers"
            today.launchArguments += [mode == "dark" ? "-calmDarkMode" : "-calmLightMode"]
            today.launch()
            signIn(today, password: "correct-horse")
            XCTAssertTrue(today.staticTexts["Stub Outlet"].waitForExistence(timeout: 20))
            XCTAssertFalse(today.staticTexts["1 visit"].exists)
            capture(today, "\(mode)-today-visits")
            today.buttons["accountButton"].tap()
            XCTAssertTrue(today.staticTexts["Account"].waitForExistence(timeout: 5))
            capture(today, "\(mode)-account")
            today.buttons["Done"].tap()
            today.buttons["outboxStatus"].tap()
            XCTAssertTrue(today.buttons["Done"].waitForExistence(timeout: 5))
            XCTAssertTrue(today.staticTexts["Nothing waiting"].exists)
            capture(today, "\(mode)-sync-details")
            today.terminate()

            let offline = XCUIApplication()
            offline.launchEnvironment["FIELD_STUB_BACKEND"] = "offline"
            offline.launchArguments += [mode == "dark" ? "-calmDarkMode" : "-calmLightMode"]
            offline.launch()
            let row = offline.buttons["visit-planned-stub-1"]
            XCTAssertTrue(row.waitForExistence(timeout: 15))
            row.tap()
            XCTAssertTrue(offline.buttons["diagnosticCheckIn"].waitForExistence(timeout: 5))
            XCTAssertTrue(offline.staticTexts["Planned · Not started"].exists)
            XCTAssertFalse(offline.staticTexts["UNPLANNED VISIT"].exists)
            capture(offline, "\(mode)-visit-before-check-in")
            offline.buttons["diagnosticCheckIn"].tap()
            XCTAssertTrue(offline.buttons["diagnosticCheckOut"].waitForExistence(timeout: 10))
            XCTAssertTrue(offline.staticTexts["Planned · In progress"].exists)
            XCTAssertTrue(offline.textFields["diagnosticNote"].placeholderValue == "Add a note (optional)")
            let note = offline.textFields["diagnosticNote"]
            XCTAssertTrue(note.waitForExistence(timeout: 5))
            note.tap()
            note.typeText("Call note")
            offline.buttons["diagnosticAddNote"].tap()
            XCTAssertTrue(offline.staticTexts["ACTIVITY"].waitForExistence(timeout: 5))
            XCTAssertTrue(offline.staticTexts["Waiting"].firstMatch.exists)
            capture(offline, "\(mode)-visit-queued")
            offline.terminate()

            let removed = XCUIApplication()
            removed.launchEnvironment["FIELD_STUB_BACKEND"] = "revoked"
            removed.launchArguments += [mode == "dark" ? "-calmDarkMode" : "-calmLightMode"]
            removed.launch()
            signIn(removed, password: "correct-horse")
            XCTAssertTrue(removed.staticTexts["phoneRemoved"].waitForExistence(timeout: 10))
            XCTAssertTrue(removed.buttons["signOutButton"].isHittable)
            XCTAssertTrue(removed.buttons["checkRegistration"].isHittable)
            capture(removed, "\(mode)-phone-removed")
            removed.terminate()
        }
    }

    func testWrongPasswordShowsClearError() {
        let app = launchStub("unregistered")
        signIn(app, password: "wrong-stub-password")
        XCTAssertTrue(app.staticTexts["Incorrect email or password."].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["outboxStatus"].exists)
    }

    func testEnrollmentShowsPublicKeyThenBindsWhenAdminRegisters() {
        let app = launchStub("registers")
        signIn(app, password: "correct-horse")
        XCTAssertTrue(app.staticTexts["notRegisteredTitle"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["outboxStatus"].exists)
        app.buttons["Show full code"].tap()
        let publicKey = app.staticTexts["devicePublicKey"]
        XCTAssertTrue(publicKey.exists)
        XCTAssertTrue(publicKey.label.hasPrefix("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE"), "shows SPKI base64")
        XCTAssertEqual(publicKey.label.count, 124)
        XCTAssertTrue(app.staticTexts["deviceFingerprint"].exists)
        XCTAssertTrue(app.buttons["copyPublicKey"].exists)
        // The stub admin registers after the first lookup; auto-poll finds it, challenges and binds.
        XCTAssertTrue(app.staticTexts["todayTitle"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["outboxStatus"].exists)

        app.buttons["accountButton"].tap()
        app.buttons["signOutButton"].tap()
        XCTAssertFalse(app.buttons["outboxStatus"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["emailField"].exists)
    }

    func testRevokedPhoneIsRemoved() {
        let app = launchStub("revoked")
        signIn(app, password: "correct-horse")
        XCTAssertTrue(app.staticTexts["Phone removed"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Phone removed"].exists)
    }

    func testTodayVisitsAndOfflineRelaunchStaysStale() {
        let app = launchStub("registers")
        signIn(app, password: "correct-horse")
        XCTAssertTrue(app.staticTexts["todayTitle"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["todayTitle"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Stub Outlet"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["outboxStatus"].exists)
        app.terminate()
        let offline = launchStub("offline")
        XCTAssertTrue(offline.staticTexts["Stub Outlet"].waitForExistence(timeout: 15))
        XCTAssertFalse(offline.buttons["outboxStatus"].exists)
        XCTAssertFalse(offline.staticTexts["Ready"].exists)
    }

    func testCallSheetOfflineCaptureQueuesAndSurvivesRelaunchThenSends() {
        let app = launchStub("registers")
        signIn(app, password: "correct-horse")
        XCTAssertTrue(app.staticTexts["Stub Outlet"].waitForExistence(timeout: 20))
        app.terminate()
        let offline = launchStub("offline")
        let row = offline.buttons["visit-planned-stub-1"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        offline.buttons["diagnosticCheckIn"].tap()
        XCTAssertTrue(offline.buttons["openCallSheet"].waitForExistence(timeout: 10))
        offline.buttons["openCallSheet"].tap()
        XCTAssertTrue(offline.staticTexts["Stub Buyer"].waitForExistence(timeout: 5))
        offline.buttons["saveCallSheet"].tap()
        XCTAssertTrue(offline.staticTexts["Enter at least one number before saving."].waitForExistence(timeout: 5))
        let order = offline.textFields["callSheet-product-stub-1-order"]
        if !order.isHittable { offline.swipeUp() }
        XCTAssertTrue(order.waitForExistence(timeout: 5))
        order.tap(); order.typeText("24")
        let beginning = offline.textFields["callSheet-product-stub-1-beginningInventory"]
        beginning.tap(); beginning.typeText("0")
        offline.buttons["saveCallSheet"].tap()
        XCTAssertTrue(offline.otherElements["callSheetStatus"].waitForExistence(timeout: 5) || offline.staticTexts["callSheetStatus"].exists)
        XCTAssertTrue(offline.staticTexts["Call sheet · Queued"].exists)
        // A second save is a new durable activity, not an edit of previously queued bytes.
        if !order.isHittable { offline.swipeUp() }
        order.tap(); order.typeText("25")
        offline.buttons["saveCallSheet"].tap()
        XCTAssertTrue(offline.staticTexts["Call sheet · Queued"].exists)
        capture(offline, "call-sheet-offline-queued")
        offline.terminate()
        let retained = launchStub("offline")
        XCTAssertTrue(retained.buttons["visit-planned-stub-1"].waitForExistence(timeout: 15))
        retained.buttons["visit-planned-stub-1"].tap()
        XCTAssertTrue(retained.buttons["openCallSheet"].waitForExistence(timeout: 5))
        retained.buttons["openCallSheet"].tap()
        XCTAssertTrue(retained.staticTexts["Call sheet · Queued"].waitForExistence(timeout: 5))
        retained.terminate()
        let online = launchStub("online")
        XCTAssertTrue(online.buttons["visit-planned-stub-1"].waitForExistence(timeout: 15))
        online.buttons["visit-planned-stub-1"].tap()
        XCTAssertTrue(online.buttons["openCallSheet"].waitForExistence(timeout: 5))
        online.buttons["openCallSheet"].tap()
        XCTAssertTrue(online.staticTexts["Call sheet · Sent"].waitForExistence(timeout: 10))
    }

    func testPlanOrderOpenCallRelaunchAndDeniedGPSStillAllowsStartEnd() {
        let app = launchStub("registers")
        signIn(app, password: "correct-horse")
        XCTAssertTrue(app.buttons["visit-planned-stub-2"].waitForExistence(timeout: 20))
        app.buttons["visit-planned-stub-2"].tap()
        XCTAssertEqual(app.buttons["diagnosticCheckIn"].label, "Start")
        XCTAssertFalse(app.buttons["diagnosticCheckIn"].isEnabled)
        XCTAssertEqual(app.staticTexts["callStartBlocked"].label, "Visit stores in plan order")
        app.buttons["BackButton"].tap()
        app.terminate()
        let offline = XCUIApplication()
        offline.launchEnvironment["FIELD_STUB_BACKEND"] = "offline"
        offline.launchEnvironment["FIELD_STUB_LOCATION"] = "denied"
        offline.launch()
        XCTAssertTrue(offline.buttons["visit-planned-stub-1"].waitForExistence(timeout: 15))
        offline.buttons["visit-planned-stub-1"].tap()
        offline.buttons["diagnosticCheckIn"].tap()
        XCTAssertTrue(offline.buttons["diagnosticCheckOut"].waitForExistence(timeout: 10))
        XCTAssertTrue(offline.staticTexts["diagnosticMessage"].label.contains("Location unavailable"))
        XCTAssertFalse(offline.buttons["diagnosticCheckOut"].isEnabled, "must choose productivity")
        offline.buttons["BackButton"].tap()
        offline.buttons["visit-planned-stub-2"].tap()
        XCTAssertFalse(offline.buttons["diagnosticCheckIn"].isEnabled)
        XCTAssertEqual(offline.staticTexts["callStartBlocked"].label, "Finish the open call first")
        offline.terminate()
        offline.launch()
        XCTAssertTrue(offline.buttons["visit-planned-stub-1"].waitForExistence(timeout: 15))
        offline.buttons["visit-planned-stub-1"].tap()
        XCTAssertTrue(offline.buttons["diagnosticCheckOut"].waitForExistence(timeout: 5), "open call restored")
        offline.buttons["diagnosticOutcome"].tap()
        offline.buttons["Nonproductive"].tap()
        XCTAssertFalse(offline.buttons["diagnosticCheckOut"].isEnabled, "nonproductive requires reason")
        let reason = offline.textFields["nonproductiveReason"]
        reason.tap(); reason.typeText("Store closed")
        offline.buttons["diagnosticCheckOut"].tap()
        XCTAssertTrue(offline.staticTexts["callTimeSpent"].waitForExistence(timeout: 10))
        XCTAssertTrue(offline.staticTexts["callTimeSpent"].label.contains("min"))
        offline.buttons["BackButton"].tap()
        offline.buttons["visit-planned-stub-2"].tap()
        XCTAssertTrue(offline.buttons["diagnosticCheckIn"].isEnabled, "queued End unlocks next plan row")
        offline.terminate()
    }

    func testDiagnosticOfflineCheckInCheckOutThenAcceptedAfterStubSync() {
        let app = launchStub("registers")
        signIn(app, password: "correct-horse")
        XCTAssertTrue(app.staticTexts["Stub Outlet"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["outboxStatus"].waitForExistence(timeout: 5))
        app.buttons["outboxStatus"].tap()
        XCTAssertTrue(app.staticTexts["Last sync"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        app.terminate()
        let offline = launchStub("offline")
        let row = offline.buttons["visit-planned-stub-1"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        XCTAssertTrue(offline.buttons["diagnosticCheckIn"].waitForExistence(timeout: 5))
        XCTAssertEqual(offline.buttons["diagnosticCheckIn"].label, "Start")
        offline.buttons["diagnosticCheckIn"].tap()
        XCTAssertTrue(offline.buttons["diagnosticCheckOut"].waitForExistence(timeout: 10))
        XCTAssertEqual(offline.buttons["diagnosticCheckOut"].label, "End call")
        // GPS check-in: accuracy and distance from the verified pin; a good fix is not flagged.
        let notice = offline.staticTexts["diagnosticMessage"].label
        XCTAssertTrue(notice.contains("Location recorded · ±5 m · 33 m from store"), notice)
        XCTAssertFalse(notice.contains("supervisor will review"), notice)
        XCTAssertFalse(offline.buttons["diagnosticCheckOut"].isEnabled)
        offline.buttons["diagnosticOutcome"].tap()
        offline.buttons["Completed"].tap()
        offline.buttons["diagnosticCheckOut"].tap()
        XCTAssertTrue(offline.staticTexts["callTimeSpent"].waitForExistence(timeout: 5))
        XCTAssertTrue(offline.staticTexts["callTimeSpent"].label.contains("min"))
        XCTAssertTrue(offline.staticTexts["Planned · Done"].exists)
        XCTAssertTrue(offline.staticTexts["Waiting"].firstMatch.exists)
        offline.buttons["BackButton"].tap()
        XCTAssertFalse(offline.buttons["outboxStatus"].exists)
        offline.terminate()
        let online = launchStub("online")
        XCTAssertTrue(online.staticTexts["todayTitle"].waitForExistence(timeout: 15))
        XCTAssertTrue(online.staticTexts["Stub Outlet"].waitForExistence(timeout: 15))
        XCTAssertTrue(online.buttons["visit-planned-stub-1"].label.contains("Done"))
        XCTAssertTrue(online.buttons["outboxStatus"].label.contains("Synced"))
    }
}
