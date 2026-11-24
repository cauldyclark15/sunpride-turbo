import XCTest

/// SP-0164 "Add a store" against the DEBUG stub backend (our `/api/v1/places/*` proxy and duplicate check
/// are stubbed in-process; nothing reaches Google or a real server).
@MainActor
final class AddStoreUITests: XCTestCase {
    override func setUp() async throws { continueAfterFailure = false }

    private func launch(_ scenario: String, _ env: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["FIELD_STUB_BACKEND"] = scenario
        for (k, v) in env { app.launchEnvironment[k] = v }
        app.launch()
        return app
    }
    private func signIn(_ app: XCUIApplication) {
        let email = app.textFields["emailField"]
        XCTAssertTrue(email.waitForExistence(timeout: 5))
        focus(app, email); email.typeText("seller@example.test")
        // Small phones (SE): the keyboard covers the password field; close it first.
        if app.keyboards.buttons["Return"].exists { app.keyboards.buttons["Return"].tap() }
        else if app.keyboards.buttons["return"].exists { app.keyboards.buttons["return"].tap() }
        let password = app.secureTextFields["passwordField"]
        focus(app, password); password.typeText("correct-horse")
        app.buttons["signInButton"].tap()
        XCTAssertTrue(app.staticTexts["Stub Outlet"].waitForExistence(timeout: 20))
    }
    private func openAddStore(_ app: XCUIApplication) {
        let open = app.buttons["openAddStore"]
        XCTAssertTrue(open.waitForExistence(timeout: 10))
        // Scroll until the whole row is on screen (above the iPad floating bar, which content now clears).
        let bar = app.buttons["tab-today"]
        let floor = bar.exists ? bar.frame.minY : app.windows.firstMatch.frame.maxY
        for _ in 0..<6 where !open.isHittable || open.frame.maxY > floor { app.swipeUp() }
        open.tap()
        XCTAssertTrue(app.staticTexts["addStoreTitle"].waitForExistence(timeout: 5))
    }
    /// Tap until the field really has keyboard focus (a tap during a keyboard/scroll animation can miss).
    private func focus(_ app: XCUIApplication, _ field: XCUIElement) {
        for _ in 0..<4 {
            field.tap()
            let deadline = Date().addingTimeInterval(2)
            while Date() < deadline {
                if field.value(forKey: "hasKeyboardFocus") as? Bool == true { return }
                usleep(100_000)
            }
        }
    }
    /// Bring the element into the middle of the screen: clear of the keyboard and of the pinned Save bar.
    private func reveal(_ app: XCUIApplication, _ element: XCUIElement) {
        let window = app.windows.firstMatch
        for _ in 0..<8 {
            if !element.exists { app.swipeUp(velocity: .slow); continue }
            let frame = element.frame, height = window.frame.height
            let bottomLimit = app.keyboards.count > 0 ? height * 0.5 : height - 180
            if frame.minY > 110 && frame.maxY < bottomLimit && element.isHittable { return }
            let from = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            let to = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: frame.midY > height / 2 ? 0.3 : 0.7))
            from.press(forDuration: 0.05, thenDragTo: to)
        }
    }
    private func type(_ app: XCUIApplication, _ id: String, _ text: String) {
        let field = app.textFields[id]
        XCTAssertTrue(field.waitForExistence(timeout: 5), id)
        reveal(app, field)
        focus(app, field); field.typeText(text)
    }
    private func tapButton(_ app: XCUIApplication, _ id: String) {
        let button = app.buttons[id]
        XCTAssertTrue(button.waitForExistence(timeout: 5), id)
        reveal(app, button)
        button.tap()
    }
    private func choose(_ app: XCUIApplication, _ menu: String, _ option: String) {
        tapButton(app, menu)
        let item = app.buttons[option]
        XCTAssertTrue(item.waitForExistence(timeout: 5), option)
        item.tap()
    }
    private func dismissKeyboard(_ app: XCUIApplication) {
        guard app.keyboards.count > 0 else { return }
        // Scrolling the form dismisses the keyboard (scrollDismissesKeyboard(.immediately)).
        let window = app.windows.firstMatch
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
            .press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)))
    }
    private func fillDetails(_ app: XCUIApplication, name: String) {
        type(app, "addStoreName", name)
        type(app, "addStoreOwner", "Nena Cruz")
        type(app, "addStorePhone", "09171234567")
        dismissKeyboard(app)
        choose(app, "addStoreChannel", "General trade")
        choose(app, "addStoreSubchannel", "Sari-sari store")
    }
    /// Saves a PNG for the lane report when the runner has `CG_SHOTS` (TEST_RUNNER_CG_SHOTS).
    private func shot(_ app: XCUIApplication, _ name: String) {
        let image = app.screenshot()
        let attachment = XCTAttachment(screenshot: image); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        if let dir = ProcessInfo.processInfo.environment["CG_SHOTS"], !dir.isEmpty {
            try? image.pngRepresentation.write(to: URL(fileURLWithPath: dir).appending(path: "ios-\(name).png"))
        }
    }

    func testSeveralIncompleteDraftsSurviveOfflineRelaunchAndFinalSaveStillChecksFields() {
        let app = launch("registers")
        signIn(app); openAddStore(app)
        type(app, "addStoreName", "First customer draft")
        dismissKeyboard(app)
        app.buttons["customerSaveDraft"].tap()
        XCTAssertTrue(app.buttons["customerDraftNew"].waitForExistence(timeout: 5))
        app.buttons["customerDraftNew"].tap()
        type(app, "addStoreName", "Second customer draft")
        dismissKeyboard(app)
        app.buttons["customerSaveDraft"].tap()
        XCTAssertTrue(app.buttons["customerDraftNew"].waitForExistence(timeout: 5))
        app.terminate()
        app.launchEnvironment["FIELD_STUB_BACKEND"] = "offline"
        app.launch()
        openAddStore(app)
        let first = app.buttons["First customer draft"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Second customer draft"].exists)
        first.tap()
        XCTAssertEqual(app.textFields["addStoreName"].value as? String, "First customer draft")
        app.buttons["addStoreSave"].tap()
        XCTAssertTrue(app.staticTexts["addStoreMissing-owner"].waitForExistence(timeout: 5))
        reveal(app, app.staticTexts["addStoreMissing-location"])
        XCTAssertTrue(app.staticTexts["addStoreMissing-location"].exists)
        reveal(app, app.staticTexts["addStoreMissing-photo"])
        XCTAssertTrue(app.staticTexts["addStoreMissing-photo"].exists)
        app.buttons["customerSaveDraft"].tap()
        XCTAssertTrue(app.buttons["customerDraftNew"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["First customer draft"].exists)
        XCTAssertTrue(app.buttons["Second customer draft"].exists)
    }

    func testUseMyLocationFillsTheAddressAndWarnsAboutAStoreOnThePhone() {
        let app = launch("registers")
        signIn(app)
        openAddStore(app)
        XCTAssertFalse(app.buttons["addStoreBatch"].exists, "default batch and one batch: no picker")
        shot(app, "add-store-empty")
        fillDetails(app, name: "Stub Outlet")
        tapButton(app, "addStoreUseLocation")
        XCTAssertTrue(app.staticTexts["Your location · ±5 m"].waitForExistence(timeout: 10), "accuracy shown")
        let address = app.textFields["addStoreAddress"]
        let filled = Date().addingTimeInterval(10)
        while (address.value as? String)?.contains("Osmeña") != true && Date() < filled { usleep(200_000) }
        XCTAssertEqual(address.value as? String, "8 Osmeña Boulevard, Barangay Dos, Cebu City", "reverse-geocoded prefill")
        XCTAssertTrue(app.staticTexts["addStoreArea"].exists)
        type(app, "addStoreLandmark", "beside the chapel")
        dismissKeyboard(app)
        tapButton(app, "addStorePhoto")
        XCTAssertTrue(app.images["addStorePhotoPreview"].waitForExistence(timeout: 5))
        shot(app, "add-store-gps")
        app.buttons["addStoreSave"].tap()
        XCTAssertTrue(app.staticTexts["duplicateTitle"].waitForExistence(timeout: 10), "local duplicate from the phone's outlets")
        let candidate = app.descendants(matching: .any)["duplicateCandidate"].firstMatch
        XCTAssertTrue(candidate.label.contains("Stub Outlet"), candidate.label)
        XCTAssertTrue(candidate.label.contains("Same name nearby"), candidate.label)
        XCTAssertFalse(candidate.label.contains("outlet-stub"), "no ids on screen")
        shot(app, "duplicate-sheet")
        app.buttons["duplicateDifferent"].tap()
        let message = app.staticTexts["addStoreMessage"]
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        XCTAssertTrue(message.label.contains("saved on this phone"), message.label)
        XCTAssertTrue(app.descendants(matching: .any)["addStoreSaved"].firstMatch.waitForExistence(timeout: 5))
        shot(app, "add-store-saved")
    }

    func testSearchAddressPicksAPlaceAndItsThisStoreCancels() {
        let app = launch("registers")
        signIn(app)
        openAddStore(app)
        fillDetails(app, name: "Aling Nena")
        tapButton(app, "addStoreSearchAddress")
        type(app, "addStoreSearchField", "Riz")
        let suggestion = app.buttons["addStoreSuggestion"].firstMatch
        XCTAssertTrue(suggestion.waitForExistence(timeout: 5), "suggestions after 3 letters")
        shot(app, "search-address")
        dismissKeyboard(app)
        reveal(app, suggestion)
        suggestion.tap()
        XCTAssertTrue(app.staticTexts["Pin from address"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["addStoreAddress"].value as? String, "12 Rizal Street, Barangay Uno, Cebu City")
        dismissKeyboard(app)
        tapButton(app, "addStorePhoto")
        app.buttons["addStoreSave"].tap()
        XCTAssertTrue(app.staticTexts["duplicateTitle"].waitForExistence(timeout: 10), "server duplicate check")
        let candidate = app.descendants(matching: .any)["duplicateCandidate"].firstMatch
        XCTAssertTrue(candidate.label.contains("Aling Nena Store"), candidate.label)
        XCTAssertTrue(candidate.label.contains("Very close by"), candidate.label)
        app.buttons["duplicateSame"].tap()
        let message = app.staticTexts["addStoreMessage"]
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        XCTAssertTrue(message.label.contains("Not added"), message.label)
        XCTAssertFalse(app.descendants(matching: .any)["addStoreSaved"].firstMatch.exists, "nothing queued")
    }

    func testWeakSignalIsKeptAndTheCustomerCanBeSaved() {
        let app = launch("registers", ["FIELD_STUB_LOCATION": "weak"])
        signIn(app)
        openAddStore(app)
        fillDetails(app, name: "Weak signal store")
        tapButton(app, "addStoreUseLocation")
        XCTAssertTrue(app.staticTexts["Your location · ±120 m"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["addStoreGpsProblem"].exists)
        dismissKeyboard(app)
        tapButton(app, "addStorePhoto")
        shot(app, "weak-signal-kept")
        saveAndExpectQueued(app)
    }

    func testNoLocationStillSavesForSendingLater() {
        let app = launch("registers", ["FIELD_STUB_LOCATION": "off"])
        signIn(app)
        openAddStore(app)
        fillDetails(app, name: "No signal store")
        tapButton(app, "addStoreUseLocation")
        XCTAssertTrue(app.staticTexts["addStoreGpsProblem"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["addStoreGpsProblem"].label.contains("Location not confirmed"))
        type(app, "addStoreAddress", "12 Sample Street")
        dismissKeyboard(app)
        tapButton(app, "addStorePhoto")
        saveAndExpectQueued(app)
    }

    func testOfflineUsesTheSavedSetupAndQueuesTheStore() {
        let setup = launch("registers")
        signIn(setup)
        openAddStore(setup)
        XCTAssertTrue(setup.buttons["addStoreUseLocation"].waitForExistence(timeout: 10), "setup downloaded once")
        setup.terminate()

        let app = launch("offline")
        XCTAssertTrue(app.staticTexts["Stub Outlet"].waitForExistence(timeout: 15))
        openAddStore(app)
        XCTAssertTrue(app.staticTexts["addStoreSavedSetup"].waitForExistence(timeout: 10))
        fillDetails(app, name: "Bebot Grocery")
        tapButton(app, "addStoreSearchAddress")
        type(app, "addStoreSearchField", "Rizal")
        let note = app.staticTexts["addStoreSearchNote"]
        XCTAssertTrue(note.waitForExistence(timeout: 5))
        XCTAssertEqual(note.label, "Address search needs internet. Use my location instead.")
        dismissKeyboard(app)
        let pill = app.staticTexts["Your location · ±5 m"]
        for _ in 0..<3 where !pill.exists {
            tapButton(app, "addStoreUseLocation")
            _ = pill.waitForExistence(timeout: 6)
        }
        XCTAssertTrue(pill.exists)
        let saved = app.staticTexts["addStoreAddressNote"]
        XCTAssertTrue(saved.waitForExistence(timeout: 10))
        XCTAssertTrue(saved.label.contains("Saved with your location; the address can be fixed later"), saved.label)
        type(app, "addStoreAddress", "Purok 3, Barangay Tres")
        dismissKeyboard(app)
        tapButton(app, "addStorePhoto")
        shot(app, "offline")
        app.buttons["addStoreSave"].tap()
        let message = app.staticTexts["addStoreMessage"]
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        XCTAssertTrue(message.label.contains("Bebot Grocery saved on this phone"), message.label)
        let row = app.descendants(matching: .any)["addStoreSaved"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.label.contains("waiting to send"), row.label)
    }

    func testOlderServerHidesAddressSearchAndShowsTheBatchPicker() {
        let app = launch("registers", ["FIELD_STUB_PLACES": "off"])
        signIn(app)
        openAddStore(app)
        XCTAssertTrue(app.buttons["addStoreUseLocation"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["addStoreSearchAddress"].exists, "no address search on an older server")
        XCTAssertTrue(app.buttons["addStoreBatch"].exists, "no default batch: picker shown as today")
    }

    func testCustomersNoMatchOffersAddAStore() {
        let app = launch("registers")
        signIn(app)
        app.buttons["openCustomers"].tap()
        let search = app.textFields["customerSearch"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        focus(app, search); search.typeText("Tindahan ni Josefa")
        let add = app.buttons["customerAddStore"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        add.tap()
        XCTAssertTrue(app.staticTexts["addStoreTitle"].waitForExistence(timeout: 5))
        let name = app.textFields["addStoreName"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        XCTAssertEqual(name.value as? String, "Tindahan ni Josefa", "the search words become the store name")
    }

    func testBetaBuildShowsAddAStore() {
        let setup = launch("registers")
        signIn(setup)
        setup.terminate()
        let beta = XCUIApplication()
        beta.launchEnvironment["FIELD_STUB_BACKEND"] = "offline"
        beta.launchArguments += ["-fieldBetaFeatures"]
        beta.launch()
        XCTAssertTrue(beta.staticTexts["Stub Outlet"].waitForExistence(timeout: 15))
        let open = beta.buttons["openAddStore"]
        for _ in 0..<6 where !open.exists { beta.swipeUp() }
        XCTAssertTrue(open.exists, "store gathering is on in the beta")
    }

    /// jc (seen on Android): the bottom Save button must stay clear of the home indicator and above the keyboard.
    func testSaveButtonStaysAboveTheHomeIndicatorAndTheKeyboard() {
        let app = launch("registers")
        signIn(app)
        openAddStore(app)
        let save = app.buttons["addStoreSave"]
        XCTAssertTrue(save.waitForExistence(timeout: 10))
        let window = app.windows.firstMatch.frame
        // Keep the button fully above the home-indicator safe area: 34 pt on Face ID phones, 20 pt on
        // Face ID iPads (the iPad indicator area is shorter; measuring 34 there demanded 14 pt that is not
        // the indicator), none on home-button phones (SE).
        let pad = UIDevice.current.userInterfaceIdiom == .pad
        let indicator: CGFloat = pad ? 20 : (window.height >= 800 ? 34 : 0)
        XCTAssertLessThanOrEqual(save.frame.maxY, window.maxY - indicator - 8, "Save clear of the home indicator: \(save.frame) in \(window)")
        XCTAssertTrue(save.isHittable)
        shot(app, "save-above-home-indicator")
        type(app, "addStoreName", "Keyboard check")
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(save.frame.maxY, keyboard.frame.minY + 1, "Save moves above the keyboard: \(save.frame) vs \(keyboard.frame)")
        XCTAssertTrue(save.isHittable)
        shot(app, "save-above-keyboard")
    }

    // MARK: Live test 2026-11-09

    func testSaveWithMissingFieldsMarksEachOneAndScrollsToTheFirst() {
        let app = launch("registers")
        signIn(app)
        openAddStore(app)
        type(app, "addStoreName", "Bebot Grocery")
        type(app, "addStorePhone", "09177654321")
        dismissKeyboard(app)
        tapButton(app, "addStorePhoto") // scrolled down near Save
        app.buttons["addStoreSave"].tap()
        let owner = app.staticTexts["addStoreMissing-owner"]
        XCTAssertTrue(owner.waitForExistence(timeout: 5), "first missing field marked")
        for f in ["channel", "subchannel", "address"] {
            XCTAssertTrue(app.staticTexts["addStoreMissing-\(f)"].exists, f)
        }
        XCTAssertFalse(app.staticTexts["addStoreMissing-name"].exists)
        XCTAssertFalse(app.staticTexts["addStoreMissing-photo"].exists)
        XCTAssertEqual(app.staticTexts["addStoreMissing-channel"].label, "Choose a channel")
        XCTAssertEqual(app.staticTexts["addStoreSaveNote"].label, "Fill in the 4 fields marked above")
        // Scrolled up to the owner field: on screen, above the Save bar.
        let deadline = Date().addingTimeInterval(3)
        while !owner.isHittable && Date() < deadline { usleep(100_000) }
        XCTAssertTrue(owner.isHittable, "scrolled to the first missing field")
        XCTAssertLessThan(owner.frame.maxY, app.buttons["addStoreSave"].frame.minY)
        shot(app, "ux-missing-fields")
        type(app, "addStoreOwner", "Bebot Reyes")
        let gone = Date().addingTimeInterval(3)
        while owner.exists && Date() < gone { usleep(100_000) }
        XCTAssertFalse(owner.exists, "filling a field clears its mark")
        XCTAssertEqual(app.staticTexts["addStoreSaveNote"].label, "Fill in the 3 fields marked above")
    }

    /// Wait until the stub's 115-s-old fix passes the two-minute rule, then Save.
    private func staleSetup(_ mode: String, doubleTap: Bool = false) -> XCUIApplication {
        var env = ["FIELD_STUB_LOCATION": mode]
        if doubleTap { env["FIELD_TEST_DOUBLE_TAP"] = "1" } // each tap runs the button action twice in one frame
        let app = launch("registers", env)
        signIn(app)
        openAddStore(app)
        fillDetails(app, name: "Bebot Grocery")
        tapButton(app, "addStoreUseLocation")
        XCTAssertTrue(app.staticTexts["Your location · ±5 m"].waitForExistence(timeout: 10))
        let field = app.textFields["addStoreAddress"]
        let filled = Date().addingTimeInterval(10)
        while (field.value as? String)?.contains("Osmeña") != true && Date() < filled { usleep(200_000) }
        XCTAssertEqual(field.value as? String, "8 Osmeña Boulevard, Barangay Dos, Cebu City", "the address the agent confirmed")
        dismissKeyboard(app)
        tapButton(app, "addStorePhoto")
        sleep(7)
        return app
    }

    private func saveAndExpectQueued(_ app: XCUIApplication) {
        app.buttons["addStoreSave"].tap()
        if app.buttons["duplicateDifferent"].waitForExistence(timeout: 5) { app.buttons["duplicateDifferent"].tap() }
        let message = app.staticTexts["addStoreMessage"]
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        XCTAssertTrue(message.label.contains("saved on this phone"), message.label)
        XCTAssertFalse(app.buttons["addStoreSaveRetry"].exists)
        XCTAssertFalse(app.staticTexts["movedTitle"].exists)
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "addStoreSaved").count, 1)
    }

    func testOlderReadingSavesWithoutRefreshingOrChangingTheAddress() {
        let app = staleSetup("stale")
        saveAndExpectQueued(app)
        XCTAssertFalse(app.buttons["Checking your location…"].exists)
    }

    func testSaveKeepsTheReadingRatherThanRequestingADifferentSpot() {
        let app = staleSetup("stale-moved")
        saveAndExpectQueued(app)
        XCTAssertFalse(app.staticTexts["movedAddress"].exists)
    }

    func testSaveDoesNotNeedAnotherReadingWhenTheNextAttemptWouldFail() {
        let app = staleSetup("stale-fail")
        saveAndExpectQueued(app)
        XCTAssertFalse(app.staticTexts["addStoreSaveNote"].exists)
    }

    func testDoubleTapWithAnOlderReadingQueuesOnce() {
        let app = staleSetup("stale", doubleTap: true)
        saveAndExpectQueued(app)
        XCTAssertFalse(app.staticTexts["addStoreSaveNote"].exists)
    }

    func testLeavingBeforeSaveQueuesNothing() {
        let app = staleSetup("stale")
        app.buttons["BackButton"].tap()
        XCTAssertTrue(app.buttons["openAddStore"].waitForExistence(timeout: 5))
        openAddStore(app)
        XCTAssertFalse(app.descendants(matching: .any)["addStoreSaved"].firstMatch.exists)
    }

    func testDoubleTapNeverRequiresAMovedLocationDecision() {
        let app = staleSetup("stale-moved", doubleTap: true)
        saveAndExpectQueued(app)
        XCTAssertFalse(app.staticTexts["movedTitle"].exists)
    }
}
