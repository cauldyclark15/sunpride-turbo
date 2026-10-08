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

    // MARK: SP-0132 beta parity (logo, password eye, Report an issue, beta feature list)

    func testPasswordEyeShowsAndHidesThenSignsIn() {
        let app = launchStub("unregistered")
        XCTAssertTrue(app.images["sunprideLogo"].waitForExistence(timeout: 5), "logo above Sign in")
        let email = app.textFields["emailField"]
        email.tap()
        email.typeText("seller@example.test")
        let secure = app.secureTextFields["passwordField"]
        secure.tap()
        secure.typeText("correct-horse")
        let eye = app.buttons["passwordVisibility"]
        XCTAssertEqual(eye.label, "Show password")
        eye.tap()
        let plain = app.textFields["passwordField"]
        XCTAssertTrue(plain.waitForExistence(timeout: 3))
        XCTAssertEqual(plain.value as? String, "correct-horse", "the typed password is shown")
        XCTAssertEqual(app.buttons["passwordVisibility"].label, "Hide password")
        app.buttons["passwordVisibility"].tap()
        XCTAssertTrue(app.secureTextFields["passwordField"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.textFields["passwordField"].exists, "hidden again")
        app.buttons["passwordVisibility"].tap()
        XCTAssertTrue(app.textFields["passwordField"].waitForExistence(timeout: 3))
        app.buttons["signInButton"].tap()
        XCTAssertTrue(app.staticTexts["deviceFingerprint"].waitForExistence(timeout: 10), "signs in with the shown password")
    }

    func testAccountReportAnIssueIsShownWithTheTrackerLink() {
        let app = launchStub("registers")
        signIn(app, password: "correct-horse")
        XCTAssertTrue(app.staticTexts["todayTitle"].waitForExistence(timeout: 20))
        app.buttons["accountButton"].tap()
        let report = app.buttons["reportIssueLink"]
        XCTAssertTrue(report.waitForExistence(timeout: 5))
        XCTAssertTrue(report.label.contains("Report an issue"), report.label)
        XCTAssertTrue(report.isHittable)
        // DEV (DEBUG) shows the technical key rows; the beta hides them (see the beta test below).
        XCTAssertTrue(app.staticTexts["Key storage"].exists)
    }

    func testBetaFeatureListHidesUnplannedVisitsAndKeyRowsButKeepsVisits() {
        let setup = launchStub("registers")
        signIn(setup, password: "correct-horse")
        XCTAssertTrue(setup.staticTexts["Stub Outlet"].waitForExistence(timeout: 20))
        setup.terminate()

        let beta = XCUIApplication()
        beta.launchEnvironment["FIELD_STUB_BACKEND"] = "offline"
        beta.launchArguments += ["-fieldBetaFeatures"]
        beta.launch()
        let planned = beta.buttons["visit-planned-stub-1"]
        XCTAssertTrue(planned.waitForExistence(timeout: 15))
        XCTAssertFalse(beta.buttons["visit-unplanned-outlet-stub-extra"].exists, "unplanned visits hidden in the beta")
        XCTAssertFalse(beta.staticTexts["OTHER OUTLETS"].exists)

        beta.buttons["accountButton"].tap()
        XCTAssertTrue(beta.buttons["reportIssueLink"].waitForExistence(timeout: 5))
        XCTAssertFalse(beta.staticTexts["Key storage"].exists, "phone-key rows hidden in the beta")
        XCTAssertFalse(beta.staticTexts["Fingerprint"].exists)
        beta.buttons["Done"].tap()

        // Off-plan outlet: no visit button. Planned stop: the visit flow is a real beta feature.
        beta.buttons["openCustomers"].tap()
        let search = beta.textFields["customerSearch"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("extra")
        let extra = beta.buttons["customerResult-outlet-stub-extra"]
        XCTAssertTrue(extra.waitForExistence(timeout: 5))
        extra.tap()
        XCTAssertTrue(beta.staticTexts["customerTitle"].waitForExistence(timeout: 5))
        XCTAssertFalse(beta.buttons["customerVisit"].exists, "no unplanned visit in the beta")
        beta.terminate()

        beta.launch()
        XCTAssertTrue(beta.buttons["visit-planned-stub-1"].waitForExistence(timeout: 15))
        beta.buttons["visit-planned-stub-1"].tap()
        XCTAssertTrue(beta.buttons["diagnosticCheckIn"].waitForExistence(timeout: 5), "visits open in the beta")
    }

    /// Screenshots of every screen SP-0132 changed, light and dark (safe areas: notch, home indicator).
    func testBetaScreenshots() {
        for mode in ["light", "dark"] {
            let flag = mode == "dark" ? "-calmDarkMode" : "-calmLightMode"
            let signIn = XCUIApplication()
            signIn.launchEnvironment["FIELD_STUB_BACKEND"] = "registers"
            signIn.launchArguments += [flag]
            signIn.launch()
            XCTAssertTrue(signIn.images["sunprideLogo"].waitForExistence(timeout: 5))
            XCTAssertTrue(signIn.buttons["signInButton"].isHittable)
            capture(signIn, "\(mode)-sp0132-sign-in")
            let email = signIn.textFields["emailField"]
            email.tap()
            email.typeText("seller@example.test")
            let password = signIn.secureTextFields["passwordField"]
            password.tap()
            password.typeText("correct-horse")
            signIn.buttons["passwordVisibility"].tap()
            XCTAssertTrue(signIn.textFields["passwordField"].waitForExistence(timeout: 3))
            capture(signIn, "\(mode)-sp0132-sign-in-password-shown")
            signIn.buttons["signInButton"].tap()
            XCTAssertTrue(signIn.staticTexts["Stub Outlet"].waitForExistence(timeout: 20))
            signIn.terminate()

            let beta = XCUIApplication()
            beta.launchEnvironment["FIELD_STUB_BACKEND"] = "offline"
            beta.launchArguments += [flag, "-fieldBetaFeatures"]
            beta.launch()
            XCTAssertTrue(beta.buttons["visit-planned-stub-1"].waitForExistence(timeout: 15))
            capture(beta, "\(mode)-sp0132-beta-today")
            beta.buttons["accountButton"].tap()
            let report = beta.buttons["reportIssueLink"]
            XCTAssertTrue(report.waitForExistence(timeout: 5))
            XCTAssertTrue(beta.buttons["signOutButton"].isHittable)
            capture(beta, "\(mode)-sp0132-beta-account")
            beta.buttons["Done"].tap()
            beta.buttons["visit-planned-stub-1"].tap()
            XCTAssertTrue(beta.buttons["diagnosticCheckIn"].waitForExistence(timeout: 5))
            XCTAssertTrue(beta.buttons["diagnosticCheckIn"].isHittable)
            capture(beta, "\(mode)-sp0132-beta-visit")
            beta.terminate()
        }
    }

    // MARK: Stubbed backend (DEBUG `FIELD_STUB_BACKEND`; no network, no real account)

    private func launchStub(_ scenario: String, environment: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["FIELD_STUB_BACKEND"] = scenario
        for (key, value) in environment { app.launchEnvironment[key] = value }
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
            if !element.exists { app.swipeUp(); continue }
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
        XCTAssertFalse(app.buttons["openTeam"].exists, "IOS-020: a field seller has no Team page")
        app.terminate()
        let offline = launchStub("offline")
        XCTAssertTrue(offline.staticTexts["Stub Outlet"].waitForExistence(timeout: 15))
        XCTAssertTrue(offline.staticTexts["0 of 30"].exists, "saved target shown offline")
        XCTAssertTrue(offline.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "₱1,750.50 of ₱5,000.00")).firstMatch.exists,
                      "saved sales shown offline")
        XCTAssertFalse(offline.buttons["outboxStatus"].exists)
        XCTAssertFalse(offline.staticTexts["Ready"].exists)
    }

    @MainActor
    func testSuggestedOrderAcceptEditNeverQueuesUntilSave() {
        let app = launchStub("registers")
        signIn(app, password: "correct-horse")
        XCTAssertTrue(app.buttons["visit-planned-stub-1"].waitForExistence(timeout: 20))
        app.buttons["visit-planned-stub-1"].tap()
        app.buttons["diagnosticCheckIn"].tap()
        XCTAssertTrue(app.buttons["openCallSheet"].waitForExistence(timeout: 10))
        app.buttons["openCallSheet"].tap()
        // A physical phone can take longer than a simulator to push the sheet and load the stub answer.
        XCTAssertTrue(app.otherElements["suggestedOrder"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["useAllSuggestions"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Suggestions only. Nothing is ordered until you save the call sheet."].exists)
        let use = app.buttons["useSuggestion-product-stub-1"]
        // SwiftUI can report a clipped button as hittable beneath the sticky Save footer.
        for _ in 0..<4 where !use.isHittable || use.frame.maxY >= app.buttons["saveCallSheet"].frame.minY { app.swipeUp() }
        XCTAssertTrue(use.isHittable)
        XCTAssertEqual(use.label, "Use 8")
        XCTAssertEqual(app.staticTexts["suggestion-product-stub-1"].label, "Suggested: 8 PC")
        XCTAssertFalse(app.otherElements["callSheetStatus"].exists || app.staticTexts["callSheetStatus"].exists)
        use.tap()
        let order = app.textFields["callSheet-product-stub-1-order"]
        for _ in 0..<4 where !order.isHittable || order.frame.maxY >= app.buttons["saveCallSheet"].frame.minY { app.swipeUp() }
        XCTAssertEqual(order.value as? String, "8")
        XCTAssertFalse(app.otherElements["callSheetStatus"].exists || app.staticTexts["callSheetStatus"].exists)
        order.tap(); order.typeText("2")
        XCTAssertEqual(order.value as? String, "82", "accepted quantity is an ordinary editable field")
        XCTAssertFalse(app.otherElements["callSheetStatus"].exists || app.staticTexts["callSheetStatus"].exists)
        // On a physical phone a Save tap made while the number pad is still settling can land on a key
        // ("82" became "820"). Let the keyboard settle, then tap the centre of the button's current frame.
        let save = app.buttons["saveCallSheet"]
        let keyboard = app.keyboards.firstMatch
        var settled = save.frame
        for _ in 0..<20 {
            Thread.sleep(forTimeInterval: 0.15)
            let now = save.frame
            if now == settled, !keyboard.exists || now.maxY <= keyboard.frame.minY { break }
            settled = now
        }
        XCTAssertTrue(!keyboard.exists || save.frame.maxY <= keyboard.frame.minY,
                      "save \(save.frame) keyboard \(keyboard.frame)")
        save.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.otherElements["callSheetStatus"].waitForExistence(timeout: 5) || app.staticTexts["callSheetStatus"].exists,
                      "order \(String(describing: order.value)) save \(save.frame) keyboard \(keyboard.frame)")
        capture(app, "suggested-order-accepted-and-edited")
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
        XCTAssertTrue(order.waitForExistence(timeout: 5))
        // The Suggested order card sits above the products, so the row can start beneath the sticky Save
        // footer (and its validation message) while SwiftUI still reports it hittable.
        for _ in 0..<4 where !order.isHittable || order.frame.maxY > offline.frame.height / 2 {
            offline.swipeUp()
        }
        order.tap(); order.typeText("24")
        let beginning = offline.textFields["callSheet-product-stub-1-beginningInventory"]
        beginning.tap(); beginning.typeText("0")
        offline.buttons["saveCallSheet"].tap()
        XCTAssertTrue(offline.otherElements["callSheetStatus"].waitForExistence(timeout: 5) || offline.staticTexts["callSheetStatus"].exists)
        XCTAssertTrue(offline.staticTexts["Call sheet · Queued"].exists)
        // A second save is a new durable activity, not an edit of previously queued bytes.
        for _ in 0..<4 where !order.isHittable || order.frame.maxY > offline.frame.height / 2 {
            offline.swipeUp()
        }
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

    /// SP-0043: review an order offline, send it (queued behind the call start), then see it
    /// received after the next online sync.
    func testOrderReviewSendOfflineThenReceivedAfterSync() {
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
        offline.swipeUp()
        newOrder.tap()
        let quantity = offline.textFields["orderQty-product-stub-1"]
        XCTAssertTrue(quantity.waitForExistence(timeout: 5))
        XCTAssertEqual(offline.staticTexts["orderPrice-product-stub-1"].label, "₱189.00 / PC")
        offline.buttons["orderUnit-product-stub-1"].tap()
        offline.buttons["CS"].tap()
        XCTAssertEqual(offline.staticTexts["orderPrice-product-stub-1"].label, "₱1,053.25 / CS")
        quantity.tap(); quantity.typeText("60")
        offline.buttons["reviewOrder"].tap()
        XCTAssertTrue(offline.staticTexts["orderReviewTitle"].waitForExistence(timeout: 5))
        XCTAssertEqual(offline.staticTexts["orderStatus"].label, "Draft · not sent")
        XCTAssertTrue(offline.staticTexts["₱63,195.00"].exists)
        XCTAssertTrue(offline.staticTexts["Sample prices"].exists)
        capture(offline, "order-priced-total-offline")
        let credit = offline.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Over the store's credit limit by ₱17,295.00")).firstMatch
        reveal(credit, in: offline)
        XCTAssertTrue(credit.exists)
        XCTAssertTrue(credit.label.contains("You can still send it; the office must approve."))
        XCTAssertTrue(offline.buttons["orderSubmit"].isEnabled)
        XCTAssertFalse(offline.otherElements["orderCheckProblem"].exists || offline.staticTexts["orderCheckProblem"].exists)
        capture(offline, "order-review-offline")
        XCTAssertTrue(offline.buttons["orderSubmit"].isEnabled, "Credit warnings never block sending")
        capture(offline, "order-credit-warning-offline")
        offline.buttons["orderSubmit"].tap()
        let confirm = offline.buttons["Send now"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(offline.staticTexts["Waiting to send"].waitForExistence(timeout: 5))
        XCTAssertFalse(offline.buttons["orderSubmit"].exists, "a sent order can't be sent or edited again")
        capture(offline, "order-sent-offline-queued")
        offline.terminate()
        let online = launchStub("online")
        XCTAssertTrue(online.buttons["visit-planned-stub-1"].waitForExistence(timeout: 15))
        online.buttons["visit-planned-stub-1"].tap()
        let order = online.buttons["orderDraft"]
        XCTAssertTrue(order.waitForExistence(timeout: 10))
        let received = online.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Received by office")).firstMatch
        XCTAssertTrue(received.waitForExistence(timeout: 20))
        online.swipeUp()
        order.tap()
        XCTAssertTrue(online.staticTexts["Received by office"].waitForExistence(timeout: 5))
        capture(online, "order-received")
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
        // IOS-017: End shows what will be recorded; nothing is queued until Confirm end.
        XCTAssertTrue(offline.buttons["diagnosticConfirmEnd"].waitForExistence(timeout: 5))
        XCTAssertTrue(offline.descendants(matching: .any)["endReviewOutcome"].label.contains("Not productive · Store closed"))
        offline.buttons["diagnosticConfirmEnd"].tap()
        XCTAssertTrue(offline.staticTexts["callTimeSpent"].waitForExistence(timeout: 10))
        let endLocation = offline.descendants(matching: .any)["resultLocationReview"]
        reveal(endLocation, in: offline)
        XCTAssertTrue(endLocation.label.contains("End location unavailable"), "denied GPS is flagged, not refused")
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
        XCTAssertTrue(offline.buttons["diagnosticConfirmEnd"].waitForExistence(timeout: 5))
        offline.buttons["diagnosticConfirmEnd"].tap()
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
        // GPS check-in: accuracy and distance from the verified pin (~500 m away); beyond every
        // store radius, so the fix is flagged for supervisor review but Start is never blocked.
        let message = offline.staticTexts["diagnosticMessage"]
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        let notice = message.label
        XCTAssertTrue(notice.contains("Location recorded · ±5 m · 500 m from store"), notice)
        XCTAssertTrue(notice.contains("supervisor will review: far from store"), notice)
        XCTAssertFalse(offline.buttons["diagnosticCheckOut"].isEnabled)
        reveal(offline.buttons["diagnosticOutcome"], in: offline)
        offline.buttons["diagnosticOutcome"].tap()
        offline.buttons["Completed"].tap()
        offline.buttons["diagnosticCheckOut"].tap()
        // IOS-017: Back keeps the call open and editable; Confirm end queues the immutable End.
        XCTAssertTrue(offline.buttons["endReviewBack"].waitForExistence(timeout: 5))
        capture(offline, "end-review")
        offline.buttons["endReviewBack"].tap()
        XCTAssertTrue(offline.buttons["diagnosticCheckOut"].waitForExistence(timeout: 5))
        offline.buttons["diagnosticCheckOut"].tap()
        XCTAssertTrue(offline.buttons["diagnosticConfirmEnd"].waitForExistence(timeout: 5))
        offline.buttons["diagnosticConfirmEnd"].tap()
        XCTAssertTrue(offline.staticTexts["callTimeSpent"].waitForExistence(timeout: 5))
        let sync = offline.descendants(matching: .any)["resultSync"]
        XCTAssertTrue(sync.waitForExistence(timeout: 5))
        XCTAssertTrue(sync.label.contains("Waiting to send"))
        XCTAssertTrue(offline.descendants(matching: .any)["resultOutcome"].label.contains("Completed"))
        XCTAssertFalse(offline.buttons["diagnosticCheckOut"].exists, "no End after End")
        XCTAssertFalse(offline.textFields["diagnosticNote"].exists, "no edits after End")
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

    /// IOS-016: an offline photo is sealed on the phone, never blocks End, and uploads after reconnecting.
    func testVisitPhotoSavedOfflineDoesNotBlockEndAndUploadsAfterSync() {
        let app = launchStub("registers")
        signIn(app, password: "correct-horse")
        XCTAssertTrue(app.staticTexts["Stub Outlet"].waitForExistence(timeout: 20))
        app.terminate()
        let offline = launchStub("offline")
        let row = offline.buttons["visit-planned-stub-1"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        offline.buttons["diagnosticCheckIn"].tap()
        let photos = offline.buttons["openPhotos"]
        XCTAssertTrue(photos.waitForExistence(timeout: 10))
        reveal(photos, in: offline)
        photos.tap()
        let take = offline.buttons["photoTake"]
        XCTAssertTrue(take.waitForExistence(timeout: 5))
        XCTAssertFalse(take.isEnabled, "choose a photo type first")
        // The bootstrap's configured list, not the phone's defaults.
        XCTAssertTrue(offline.buttons["photoType-shelf_display"].exists)
        XCTAssertFalse(offline.buttons["photoType-price_tag"].exists)
        offline.buttons["photoType-storefront"].tap()
        take.tap()
        let saved = offline.descendants(matching: .any)["photo-storefront"]
        XCTAssertTrue(saved.waitForExistence(timeout: 5))
        XCTAssertTrue(saved.label.contains("Saved on phone"), saved.label)
        capture(offline, "visit-photo-saved-offline")
        offline.buttons["photoBack"].tap()
        XCTAssertTrue(offline.buttons["openPhotos"].label.contains("1 waiting to upload"))
        reveal(offline.buttons["diagnosticOutcome"], in: offline)
        offline.buttons["diagnosticOutcome"].tap()
        offline.buttons["Completed"].tap()
        offline.buttons["diagnosticCheckOut"].tap()
        // IOS-017 End review: a waiting photo never blocks Confirm end.
        XCTAssertTrue(offline.buttons["diagnosticConfirmEnd"].waitForExistence(timeout: 5))
        offline.buttons["diagnosticConfirmEnd"].tap()
        XCTAssertTrue(offline.staticTexts["callTimeSpent"].waitForExistence(timeout: 10))
        let done = offline.descendants(matching: .any)["donePhotos"]
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        XCTAssertTrue(done.label.contains("1 waiting to upload"), done.label)
        offline.terminate()
        let online = launchStub("online")
        XCTAssertTrue(online.buttons["visit-planned-stub-1"].waitForExistence(timeout: 15))
        XCTAssertTrue(online.buttons["outboxStatus"].waitForExistence(timeout: 15))
        let status = online.buttons["outboxStatus"]
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline && !(status.label.contains("Synced") && !status.label.contains("photos")) {
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(status.label.contains("Synced") && !status.label.contains("photos"), status.label)
        online.buttons["visit-planned-stub-1"].tap()
        let uploaded = online.descendants(matching: .any)["donePhotos"]
        XCTAssertTrue(uploaded.waitForExistence(timeout: 10))
        XCTAssertEqual(uploaded.label.contains("waiting"), false, uploaded.label)
        XCTAssertTrue(uploaded.label.contains("1 photo"), uploaded.label)
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

    /// IOS-020: a supervisor (manager role) opens Team, sees direct reports' coverage and exceptions,
    /// switches to the whole area, and offline sees today's saved copy with its saved time.
    func testSupervisorTeamShowsDirectReportsWholeAreaAndSavedCopyOffline() {
        let app = launchStub("supervisor")
        signIn(app, password: "correct-horse")
        let open = app.buttons["openTeam"]
        XCTAssertTrue(open.waitForExistence(timeout: 20))
        open.tap()
        XCTAssertTrue(app.staticTexts["teamTitle"].waitForExistence(timeout: 5))
        let ana = app.descendants(matching: .any)["teamPerson-profile-ana"]
        XCTAssertTrue(ana.waitForExistence(timeout: 10))
        XCTAssertTrue(ana.label.contains("In a call"), ana.label)
        XCTAssertTrue(ana.label.contains("3 of 6 planned"), ana.label)
        XCTAssertTrue(app.descendants(matching: .any)["teamPerson-profile-ben"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["teamPerson-profile-cara"].exists, "direct reports only by default")
        let summary = app.staticTexts["teamSummary"]
        XCTAssertTrue(summary.label.hasPrefix("2 people · 3 of 11 planned calls done · 1 to review"), summary.label)
        let location = app.descendants(matching: .any)["teamExceptionOpen-location:ex-1"]
        reveal(location, in: app)
        XCTAssertTrue(location.label.contains("Outside the store radius"), location.label)
        XCTAssertTrue(location.label.contains("412 m away"), location.label)
        XCTAssertTrue(app.descendants(matching: .any)["teamException-sequence:ex-2"].exists)
        capture(app, "team-direct")
        app.swipeDown(); app.swipeDown()
        app.buttons["teamAll"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["teamPerson-profile-cara"].waitForExistence(timeout: 10))
        app.buttons["teamDirect"].tap()
        XCTAssertTrue(ana.waitForExistence(timeout: 10))
        let deadline = Date().addingTimeInterval(5)
        while app.descendants(matching: .any)["teamPerson-profile-cara"].exists && Date() < deadline { usleep(200_000) }
        XCTAssertFalse(app.descendants(matching: .any)["teamPerson-profile-cara"].exists)
        app.terminate()

        let offline = launchStub("offline")
        let reopen = offline.buttons["openTeam"]
        XCTAssertTrue(reopen.waitForExistence(timeout: 15), "role hint survives from the saved snapshot")
        reopen.tap()
        let message = offline.staticTexts["teamMessage"]
        XCTAssertTrue(message.waitForExistence(timeout: 15))
        XCTAssertTrue(message.label.contains("showing team saved at"), message.label)
        XCTAssertTrue(offline.descendants(matching: .any)["teamPerson-profile-ana"].exists)
        XCTAssertTrue(offline.staticTexts["teamSummary"].label.hasSuffix("Saved on this phone"))
        capture(offline, "team-saved-offline")
    }

    /// IOS-020 release counterexample: both filters are saved, then the server refuses. Neither saved copy
    /// may come back in-session, after an offline relaunch, or on switching filters.
    func testSupervisorTeamRefusalErasesBothSavedFilters() {
        assertTeamRefusalWithdrawsBothSavedFilters(eraseFails: false)
    }

    /// Release counterexample: erasing the saved team fails while it stays readable; the refusal must still
    /// withdraw both filters in session and after an offline relaunch.
    func testSupervisorTeamRefusalWithdrawsSavedFiltersEvenWhenEraseFails() {
        assertTeamRefusalWithdrawsBothSavedFilters(eraseFails: true)
    }

    private func assertTeamRefusalWithdrawsBothSavedFilters(eraseFails: Bool) {
        let erase = eraseFails ? ["FIELD_STUB_TEAM_ERASE_FAILS": "1"] : [:]
        let app = launchStub("supervisor", environment: erase.merging(["FIELD_STUB_TEAM_REFUSE_AFTER": "2"]) { a, _ in a })
        signIn(app, password: "correct-horse")
        let open = app.buttons["openTeam"]
        XCTAssertTrue(open.waitForExistence(timeout: 20))
        open.tap()
        XCTAssertTrue(app.descendants(matching: .any)["teamPerson-profile-ana"].waitForExistence(timeout: 10))
        app.buttons["teamAll"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["teamPerson-profile-cara"].waitForExistence(timeout: 10))
        app.buttons["teamDirect"].tap() // third read: refused
        let message = app.staticTexts["teamMessage"]
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        XCTAssertEqual(message.label, "Team view isn't available for your account.")
        XCTAssertFalse(app.descendants(matching: .any)["teamPerson-profile-ana"].exists)
        app.buttons["teamAll"].tap()
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        XCTAssertEqual(message.label, "Team view isn't available for your account.")
        XCTAssertFalse(app.descendants(matching: .any)["teamPerson-profile-cara"].exists)
        app.terminate()

        let offline = launchStub("offline", environment: erase)
        let reopen = offline.buttons["openTeam"]
        XCTAssertTrue(reopen.waitForExistence(timeout: 15))
        reopen.tap()
        for filter in ["teamDirect", "teamAll", "teamDirect"] {
            offline.buttons[filter].tap()
            let text = offline.staticTexts["teamMessage"]
            XCTAssertTrue(text.waitForExistence(timeout: 10))
            // "Offline" or "Phone not verified yet" depending on launch timing; either way, nothing saved.
            XCTAssertTrue(text.label.hasSuffix(". Connect and try again."), "\(filter): \(text.label)")
            XCTAssertFalse(offline.staticTexts["teamSummary"].exists, filter)
            XCTAssertFalse(offline.descendants(matching: .any)["teamPerson-profile-ana"].exists, filter)
            XCTAssertFalse(offline.descendants(matching: .any)["teamPerson-profile-cara"].exists, filter)
        }
    }

    /// IOS-018: with several navigation apps installed, Directions asks which one to hand the pin to.
    func testDirectionsOffersEachInstalledNavigationApp() {
        let app = launchStub("registers", environment: ["FIELD_STUB_NAV_APPS": "googleMaps,waze"])
        signIn(app, password: "correct-horse")
        let open = app.buttons["openRoute"]
        XCTAssertTrue(open.waitForExistence(timeout: 20))
        open.tap()
        let directions = app.buttons["routeDirections-planned-stub-1"]
        XCTAssertTrue(directions.waitForExistence(timeout: 5))
        directions.tap()
        XCTAssertTrue(app.buttons["navigateWith-appleMaps"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["navigateWith-googleMaps"].exists)
        XCTAssertTrue(app.buttons["navigateWith-waze"].exists)
        // Waze is only pretended installed here, so the system refuses it and the route says so.
        app.buttons["navigateWith-waze"].firstMatch.tap()
        let failure = app.staticTexts["routeDirectionsError"]
        XCTAssertTrue(failure.waitForExistence(timeout: 5))
        XCTAssertEqual(failure.label, "Could not open Waze")
        XCTAssertTrue(app.staticTexts["routeTitle"].exists, "a refused app leaves the seller on the route")
        // The stop sheet offers the same choice; Apple Maps really opens with the stop.
        app.buttons["routeStop-planned-stub-1"].tap()
        let sheetDirections = app.buttons["routeCustomerDirections"]
        XCTAssertTrue(sheetDirections.waitForExistence(timeout: 5))
        sheetDirections.tap()
        let apple = app.buttons["navigateWith-appleMaps"].firstMatch
        XCTAssertTrue(apple.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["navigateWith-googleMaps"].exists)
        apple.tap()
        let maps = XCUIApplication(bundleIdentifier: "com.apple.Maps")
        XCTAssertTrue(maps.wait(for: .runningForeground, timeout: 15), "Apple Maps takes over navigation")
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
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
