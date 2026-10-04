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

    /// Scroll until the element sits clear of the pinned bottom button (the visit screen grows with
    /// its activity checklist, so cards below it can start off screen).
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<5 {
            let frame = element.frame, window = app.windows.firstMatch.frame
            if element.isHittable && frame.minY > window.minY + 100 && frame.maxY < window.maxY - 140 { return }
            if frame.midY > window.midY { app.swipeUp() } else { app.swipeDown() }
        }
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
        // Today dashboard: target, completion, sales and the next outlet in plan order.
        XCTAssertTrue(app.staticTexts["0 of 30"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["0 of 2 stores"].exists)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "₱1,750.50 of ₱5,000.00")).firstMatch.exists)
        XCTAssertTrue(app.buttons["nextOutlet"].exists)
        XCTAssertTrue(app.buttons["nextOutlet"].label.contains("Stub Outlet"))
        XCTAssertTrue(app.buttons["visit-planned-stub-2"].exists)
        app.terminate()
        let offline = launchStub("offline")
        XCTAssertTrue(offline.staticTexts["Stub Outlet"].waitForExistence(timeout: 15))
        XCTAssertTrue(offline.staticTexts["0 of 30"].exists, "saved target shown offline")
        XCTAssertTrue(offline.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "₱1,750.50 of ₱5,000.00")).firstMatch.exists,
                      "saved sales shown offline")
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

    /// SP-0044: an order draft is taken offline from the account's setup and survives a relaunch.
    func testOrderDraftOfflineFromAccountCatalogSurvivesRelaunch() {
        let app = launchStub("registers")
        signIn(app, password: "correct-horse")
        XCTAssertTrue(app.staticTexts["Stub Outlet"].waitForExistence(timeout: 20))
        app.terminate()
        let offline = launchStub("offline")
        XCTAssertTrue(offline.buttons["visit-planned-stub-1"].waitForExistence(timeout: 15))
        offline.buttons["visit-planned-stub-1"].tap()
        offline.buttons["diagnosticCheckIn"].tap()
        let newOrder = offline.buttons["newOrder"]
        XCTAssertTrue(newOrder.waitForExistence(timeout: 10))
        offline.swipeUp() // Clear the pinned End call button.
        newOrder.tap()
        let search = offline.textFields["orderSearch"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("hotdog")
        let quantity = offline.textFields["orderQty-product-stub-1"]
        XCTAssertTrue(quantity.waitForExistence(timeout: 5))
        offline.buttons["saveOrderDraft"].tap()
        XCTAssertTrue(offline.staticTexts["Add at least one product."].waitForExistence(timeout: 5))
        quantity.tap(); quantity.typeText("12")
        offline.buttons["saveOrderDraft"].tap()
        XCTAssertTrue(offline.staticTexts["Draft saved on this phone."].waitForExistence(timeout: 5))
        capture(offline, "order-draft-offline-saved")
        offline.terminate()
        let retained = launchStub("offline")
        XCTAssertTrue(retained.buttons["visit-planned-stub-1"].waitForExistence(timeout: 15))
        retained.buttons["visit-planned-stub-1"].tap()
        let draft = retained.buttons["orderDraft"]
        XCTAssertTrue(draft.waitForExistence(timeout: 10))
        retained.swipeUp()
        draft.tap()
        XCTAssertEqual(retained.textFields["orderQty-product-stub-1"].value as? String, "12")
        XCTAssertTrue(retained.buttons["discardOrderDraft"].exists)
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
        reveal(offline.buttons["diagnosticOutcome"], in: offline)
        offline.buttons["diagnosticOutcome"].tap()
        offline.buttons["Nonproductive"].tap()
        XCTAssertFalse(offline.buttons["diagnosticCheckOut"].isEnabled, "nonproductive requires reason")
        let reason = offline.textFields["nonproductiveReason"]
        reveal(reason, in: offline)
        reason.tap(); reason.typeText("Store closed")
        offline.buttons["diagnosticCheckOut"].tap()
        XCTAssertTrue(offline.staticTexts["callTimeSpent"].waitForExistence(timeout: 10))
        XCTAssertTrue(offline.staticTexts["callTimeSpent"].label.contains("min"))
        offline.buttons["BackButton"].tap()
        offline.buttons["visit-planned-stub-2"].tap()
        XCTAssertTrue(offline.buttons["diagnosticCheckIn"].isEnabled, "queued End unlocks next plan row")
        offline.terminate()
    }

    /// IOS-013: an unplanned visit's purpose decides the required form; a completed End waits for it.
    func testUnplannedPurposeRequiresItsActivityFormBeforeCompletedEnd() {
        let app = launchStub("registers")
        signIn(app, password: "correct-horse")
        XCTAssertTrue(app.staticTexts["Stub Outlet"].waitForExistence(timeout: 20))
        app.terminate()
        let offline = launchStub("offline")
        let row = offline.buttons["visit-unplanned-outlet-stub-extra"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        if !row.isHittable { offline.swipeUp() }
        row.tap()
        let merchandise = offline.buttons["intent-merchandise"]
        XCTAssertTrue(merchandise.waitForExistence(timeout: 5))
        let reason = offline.textFields["unplannedReason"]
        reveal(reason, in: offline)
        reason.tap(); reason.typeText("Walk-in\n")
        XCTAssertFalse(offline.buttons["diagnosticCheckIn"].isEnabled, "needs a purpose")
        reveal(merchandise, in: offline)
        merchandise.tap()
        XCTAssertTrue(merchandise.isSelected)
        XCTAssertTrue(offline.buttons["diagnosticCheckIn"].isEnabled)
        offline.buttons["diagnosticCheckIn"].tap()
        XCTAssertTrue(offline.staticTexts["visitIntents"].waitForExistence(timeout: 10))
        XCTAssertEqual(offline.staticTexts["visitIntents"].label, "Purpose · Merchandise")
        let form = offline.buttons["activity-merchandising"]
        XCTAssertTrue(form.exists)
        XCTAssertTrue(form.label.contains("Required"))
        reveal(offline.buttons["diagnosticOutcome"], in: offline)
        offline.buttons["diagnosticOutcome"].tap()
        offline.buttons["Completed"].tap()
        XCTAssertTrue(offline.staticTexts["activitiesMissing"].waitForExistence(timeout: 5))
        XCTAssertFalse(offline.buttons["diagnosticCheckOut"].isEnabled, "required form missing")
        capture(offline, "activity-required")
        reveal(form, in: offline)
        form.tap()
        let display = offline.buttons["activityDisplay-needs_action"]
        XCTAssertTrue(display.waitForExistence(timeout: 5))
        XCTAssertFalse(offline.buttons["activitySave"].isEnabled)
        display.tap()
        offline.buttons["activitySave"].tap()
        XCTAssertTrue(offline.buttons["diagnosticCheckOut"].waitForExistence(timeout: 5))
        XCTAssertTrue(offline.buttons["activity-merchandising"].label.contains("Recorded"))
        XCTAssertFalse(offline.staticTexts["activitiesMissing"].exists)
        XCTAssertTrue(offline.buttons["diagnosticCheckOut"].isEnabled)
        offline.buttons["diagnosticCheckOut"].tap()
        XCTAssertTrue(offline.staticTexts["callTimeSpent"].waitForExistence(timeout: 10))
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
        reveal(offline.buttons["diagnosticOutcome"], in: offline)
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
}
