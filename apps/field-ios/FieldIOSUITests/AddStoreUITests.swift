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
        for _ in 0..<6 where !open.isHittable { app.swipeUp() }
        XCTAssertTrue(open.waitForExistence(timeout: 10))
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

    func testWeakSignalAsksToMoveOutside() {
        let app = launch("registers", ["FIELD_STUB_LOCATION": "weak"])
        signIn(app)
        openAddStore(app)
        tapButton(app, "addStoreUseLocation")
        let problem = app.staticTexts["addStoreGpsProblem"]
        XCTAssertTrue(problem.waitForExistence(timeout: 10))
        XCTAssertTrue(problem.label.contains("±120 m"), problem.label)
        XCTAssertTrue(problem.label.contains("Move outside or wait for a better signal"), problem.label)
        XCTAssertTrue(app.buttons["addStoreGpsRetry"].exists)
        shot(app, "weak-signal")
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
        // The home indicator area is the bottom ~34 pt on Face ID phones; keep the button fully above it.
        let indicator: CGFloat = window.height >= 800 ? 34 : 0 // Home-button phones (SE) have none.
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
}
