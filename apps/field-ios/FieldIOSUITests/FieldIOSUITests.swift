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

    func testDailyRouteListsStopsInOrderWithDistanceCustomerAndDirections() {
        let app = launchStub("registers")
        signIn(app, password: "correct-horse")
        let open = app.buttons["openRoute"]
        XCTAssertTrue(open.waitForExistence(timeout: 20))
        XCTAssertTrue(open.label.contains("2 stops"))
        XCTAssertTrue(open.label.contains("Next: Stub Outlet"))
        open.tap()
        XCTAssertTrue(app.staticTexts["routeTitle"].waitForExistence(timeout: 5))
        let first = app.buttons["routeStop-planned-stub-1"], second = app.buttons["routeStop-planned-stub-2"]
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertLessThan(first.frame.minY, second.frame.minY, "MCP order")
        XCTAssertTrue(first.label.contains("Next"))
        XCTAssertTrue(second.label.contains("Not started"))
        // Stub fix (0, 0) to the stub pin is ~500 m; once the fix lands the row shows it.
        let deadline = Date().addingTimeInterval(15)
        while !first.label.contains("500 m away") && Date() < deadline { _ = first.waitForExistence(timeout: 0.5); usleep(300_000) }
        XCTAssertTrue(first.label.contains("500 m away"), first.label)
        XCTAssertTrue(first.label.contains("C-STUB-1"))
        XCTAssertTrue(app.buttons["routeDirections-planned-stub-1"].exists)
        XCTAssertFalse(app.buttons["routeDirections-planned-stub-2"].exists, "no pin and no address")
        first.tap()
        XCTAssertTrue(app.staticTexts["routeCustomerTitle"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["1 Stub Street"].exists)
        XCTAssertTrue(app.staticTexts["STUB-1"].exists)
        XCTAssertTrue(app.buttons["routeCustomerDirections"].exists)
        app.buttons["routeOpenVisit"].tap()
        XCTAssertTrue(app.buttons["diagnosticCheckIn"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["diagnosticCheckIn"].isEnabled)
    }

    /// IOS-011: search only the downloaded (scoped) outlets, offline, and open an outlet's detail.
    func testCustomerSearchAndOutletDetailWorkOfflineFromSavedScope() {
        let app = launchStub("registers")
        signIn(app, password: "correct-horse")
        let open = app.buttons["openCustomers"]
        XCTAssertTrue(open.waitForExistence(timeout: 20))
        let loaded = Date().addingTimeInterval(15)
        while !open.label.contains("3 outlets") && Date() < loaded { usleep(300_000) }
        XCTAssertTrue(open.label.contains("3 outlets on this phone"), open.label)
        open.tap()
        XCTAssertTrue(app.staticTexts["customersTitle"].waitForExistence(timeout: 5))
        let search = app.textFields["customerSearch"]
        search.tap()
        search.typeText("zzz")
        XCTAssertTrue(app.staticTexts["customerNoMatch"].waitForExistence(timeout: 5))
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3) + "c stub")
        let result = app.buttons["customerResult-outlet-stub-1"]
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["customerResult-outlet-stub-2"].exists, "every word must match")
        XCTAssertTrue(app.staticTexts["customerCount"].label.hasPrefix("1 of 3 outlets"))
        result.tap()
        XCTAssertTrue(app.staticTexts["customerTitle"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["customerTitle"].label, "Stub Outlet")
        XCTAssertTrue(app.staticTexts["Stub Buyer"].exists)
        XCTAssertTrue(app.staticTexts["0917 555 0101"].exists)
        XCTAssertTrue(app.buttons["customerCall"].isEnabled)
        XCTAssertTrue(app.buttons["customerDirections"].isEnabled)
        XCTAssertTrue(app.staticTexts["Tomorrow"].exists, "planned visits beyond today")
        XCTAssertTrue(app.staticTexts["Merchandise check"].exists)
        XCTAssertTrue(app.staticTexts["Price survey"].exists, "day task")
        XCTAssertTrue(app.staticTexts["Stop 1 of 2 · Not started"].exists)
        XCTAssertTrue(app.staticTexts["Nothing recorded here from this phone yet"].exists)
        // Office figures cached at bootstrap: sales history, open orders, credit limit.
        XCTAssertTrue(app.staticTexts["₱48,250.50 · 9 orders"].exists, "13-week sales")
        XCTAssertTrue(app.staticTexts["₱15,900.00 · 3 orders"].exists, "4-week sales")
        XCTAssertTrue(app.staticTexts["1 order · ₱4,100.00"].exists, "open orders")
        XCTAssertTrue(app.staticTexts["₱50,000.00"].exists, "credit limit")
        app.buttons["customerVisit"].tap()
        XCTAssertTrue(app.buttons["diagnosticCheckIn"].waitForExistence(timeout: 5))
        app.buttons["diagnosticCheckIn"].tap()
        XCTAssertTrue(app.buttons["diagnosticCheckOut"].waitForExistence(timeout: 10))
        app.buttons["BackButton"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["customerTitle"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Call started"].waitForExistence(timeout: 5), "this phone's history")
        XCTAssertTrue(app.buttons["customerVisit"].label.contains("Continue visit"))
        app.terminate()

        let offline = launchStub("offline")
        let saved = offline.buttons["openCustomers"]
        XCTAssertTrue(saved.waitForExistence(timeout: 15))
        saved.tap()
        XCTAssertTrue(offline.staticTexts["customerCount"].waitForExistence(timeout: 5))
        XCTAssertTrue(offline.staticTexts["customerCount"].label.contains("Saved on this phone"))
        let field = offline.textFields["customerSearch"]
        field.tap()
        field.typeText("next")
        XCTAssertTrue(offline.buttons["customerResult-outlet-stub-2"].waitForExistence(timeout: 5))
        XCTAssertFalse(offline.buttons["customerResult-outlet-stub-1"].exists)
        // A shared account's figures never reach the phone; offline it says so instead of showing zero.
        offline.buttons["customerResult-outlet-stub-2"].tap()
        XCTAssertTrue(offline.staticTexts["customerSalesWithheld"].waitForExistence(timeout: 5))
        offline.buttons["BackButton"].firstMatch.tap()
        let again = offline.textFields["customerSearch"]
        XCTAssertTrue(again.waitForExistence(timeout: 5))
        again.tap()
        again.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4) + "STUB-1")
        XCTAssertTrue(offline.buttons["customerResult-outlet-stub-1"].waitForExistence(timeout: 5))
        offline.buttons["customerResult-outlet-stub-1"].tap()
        XCTAssertTrue(offline.staticTexts["customerSalesNote"].waitForExistence(timeout: 5), "cached figures offline")
        XCTAssertTrue(offline.staticTexts["1 order · ₱4,100.00"].exists)
    }
}
