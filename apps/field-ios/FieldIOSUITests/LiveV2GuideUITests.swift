import XCTest

/// Opt-in live walk-through on the authorized physical phone against the real Sunpride server.
/// Never types or reads a password: LiveV2ProofTests (unit host) signs in in-process from a private
/// file that it deletes. Biometric unlock is never turned on (the offer is declined), so nothing waits on
/// a fingerprint or face. Every screen is attached as a screenshot named NN-screen for review.
@MainActor
final class LiveV2GuideUITests: XCTestCase {
    private var app: XCUIApplication!
    private var index = 0
    private var walked: [String] = []

    override func setUpWithError() throws {
        guard ProcessInfo.processInfo.environment["SUNPRIDE_V2_LIVE"] == "1" else { throw XCTSkip("Opt-in live device walk-through") }
        continueAfterFailure = true
        app = XCUIApplication()
        addUIInterruptionMonitor(withDescription: "System permission") { alert in
            for label in ["Allow While Using App", "Allow Once", "OK", "Allow", "Don’t Allow"] where alert.buttons[label].exists {
                alert.buttons[label].tap(); return true
            }
            return false
        }
    }

    override func tearDown() {
        let note = XCTAttachment(string: walked.joined(separator: "\n")); note.name = "walked"; note.lifetime = .keepAlways; add(note)
        super.tearDown()
    }

    private func shot(_ name: String) {
        Thread.sleep(forTimeInterval: 1.2) // let animations and spinners settle
        index += 1
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = String(format: "%02d-%@", index, name); image.lifetime = .keepAlways; add(image)
        walked.append(image.name ?? name)
    }
    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    private func reveal(_ element: XCUIElement) {
        for _ in 0..<10 where !(element.exists && element.isHittable) { app.swipeUp() }
    }
    private func tap(_ id: String, timeout: TimeInterval = 15) -> Bool {
        let target = element(id)
        guard target.waitForExistence(timeout: timeout) else { walked.append("MISSING \(id)"); return false }
        reveal(target)
        guard target.isHittable else { walked.append("NOT HITTABLE \(id)"); return false }
        target.tap(); return true
    }
    private func back() {
        let custom = app.buttons["BackButton"].firstMatch
        if custom.exists && custom.isHittable { custom.tap(); return }
        let nav = app.navigationBars.buttons.element(boundBy: 0)
        if nav.exists { nav.tap() }
    }
    private func dismissSheet() {
        for id in ["Done", "Close"] where app.buttons[id].firstMatch.exists { app.buttons[id].firstMatch.tap(); return }
        app.swipeDown(velocity: .fast)
    }
    private func wait(_ seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end { if condition() { return true }; Thread.sleep(forTimeInterval: 0.5) }
        return condition()
    }
    private func declineBiometricOffer() {
        let alert = app.alerts.firstMatch
        if alert.waitForExistence(timeout: 3), alert.label.contains("sign in next time") {
            shot("face-id-offer")
            alert.buttons["Not now"].firstMatch.tap() // Face ID stays OFF for proof accounts
        }
        XCTAssertFalse(element("biometricLocked").exists, "never a Face ID lock screen without opt-in")
    }
    private func settleToday() {
        app.tap() // trigger the interruption monitor for any pending system alert
        let consent = element("liveConsentTitle")
        if consent.waitForExistence(timeout: 4) {
            shot("live-location-consent")
            _ = tap("liveConsentAccept", timeout: 3)
            app.tap()
        }
        declineBiometricOffer()
    }

    /// Signed-out entry screen (run before the in-process sign-in).
    func testWalk01SignInScreen() throws {
        app.launch()
        XCTAssertTrue(element("emailField").waitForExistence(timeout: 20), "sign-in screen")
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'configuration'")).firstMatch.exists)
        shot("sign-in")
        let email = element("emailField"); email.tap(); email.typeText("agent3@trial.sunpride.test")
        shot("sign-in-email-typed")
    }

    /// Before an administrator registers this phone (after sign-in, before registration).
    func testWalk02NotRegistered() throws {
        app.launch()
        settleToday()
        XCTAssertTrue(element("notRegisteredTitle").waitForExistence(timeout: 30), "not-registered screen")
        shot("phone-not-registered")
    }

    /// Agent day: Today, sync, account, route, customers, a full visit, then the sync result.
    func testWalk03AgentDay() throws {
        app.launch()
        settleToday()
        XCTAssertTrue(wait(90) { self.element("nextOutlet").exists || self.element("startDayButton").exists }, "Today loaded from live")
        XCTAssertTrue(wait(60) { self.element("outboxStatus").label.localizedCaseInsensitiveContains("synced") }, element("outboxStatus").label)
        shot("today")
        app.swipeUp(); shot("today-lower"); app.swipeDown(); app.swipeDown()

        if tap("outboxStatus") { shot("sync-status"); dismissSheet() }
        if tap("accountButton") {
            shot("account")
            if tap("supportInfoLink") { shot("support-info"); back() }
            dismissSheet()
        }
        if tap("openRoute") {
            XCTAssertTrue(element("routeTitle").waitForExistence(timeout: 15)); shot("route")
            let stop = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'routeStop-'")).firstMatch
            if stop.waitForExistence(timeout: 5) { reveal(stop); stop.tap(); shot("route-stop"); dismissSheet() }
            back()
        }
        if tap("openCustomers") {
            XCTAssertTrue(element("customersTitle").waitForExistence(timeout: 15)); shot("customers")
            let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'customerResult-'")).firstMatch
            if row.waitForExistence(timeout: 5) { row.tap(); shot("customer-detail"); back() }
            back()
        }
        if tap("openTeam") { _ = wait(20) { !self.element("teamLoading").exists }; shot("team-as-agent"); back() }

        // A full visit at the next planned store.
        XCTAssertTrue(tap("nextOutlet"), "open next planned store")
        XCTAssertTrue(element("diagnosticCheckIn").waitForExistence(timeout: 15)); shot("store")
        element("diagnosticCheckIn").tap()
        XCTAssertTrue(element("diagnosticCheckOut").waitForExistence(timeout: 60), "checked in")
        shot("check-in")
        let note = element("diagnosticNote"); reveal(note)
        if note.exists { note.tap(); note.typeText("iOS transport proof - sample company"); _ = tap("diagnosticAddNote"); shot("activity-note") }
        let activity = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'activity-'")).firstMatch
        if activity.exists { reveal(activity); activity.tap(); shot("activity-form"); back() }
        if tap("openCallSheet", timeout: 3) { shot("call-sheet"); back() }
        if tap("newOrder", timeout: 3) {
            shot("order-draft")
            if tap("reviewOrder", timeout: 3) { shot("order-review"); back() }
            if tap("discardOrderDraft", timeout: 3) { app.buttons["Discard"].firstMatch.tap() } else { back() }
        }
        if tap("openPhotos") {
            let type = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'photoType-'")).firstMatch
            if type.waitForExistence(timeout: 10) { type.tap() }
            shot("photos")
            if tap("photoTake") {
                let shutter = app.buttons["Take Picture"].firstMatch
                if shutter.waitForExistence(timeout: 20) {
                    shutter.tap()
                    let use = app.buttons["Use Photo"].firstMatch
                    if use.waitForExistence(timeout: 20) { use.tap() }
                }
            }
            _ = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'photo-'")).firstMatch.waitForExistence(timeout: 20)
            shot("photo-taken")
            _ = tap("photoBack", timeout: 5)
        }
        if tap("diagnosticOutcome") {
            let nonproductive = app.buttons["Nonproductive"].firstMatch
            if nonproductive.waitForExistence(timeout: 5) { nonproductive.tap() }
            let reason = element("nonproductiveReason")
            if reason.waitForExistence(timeout: 5) { reveal(reason); reason.tap(); reason.typeText("Transport verification visit\n") }
        }
        XCTAssertTrue(tap("diagnosticCheckOut"))
        XCTAssertTrue(element("diagnosticConfirmEnd").waitForExistence(timeout: 15)); shot("check-out-review")
        element("diagnosticConfirmEnd").tap()
        XCTAssertTrue(element("callTimeSpent").waitForExistence(timeout: 30), "call ended"); shot("visit-result")
        back()
        let status = element("outboxStatus")
        XCTAssertTrue(wait(120) { status.label.localizedCaseInsensitiveContains("synced") && !status.label.localizedCaseInsensitiveContains("photo") }, status.label)
        shot("today-after-sync")
        if tap("outboxStatus") { shot("sync-status-after-visit"); dismissSheet() }
    }

    /// Supervisor team view (run after the supervisor sign-in and registration).
    func testWalk04SupervisorTeam() throws {
        app.launch()
        settleToday()
        XCTAssertTrue(tap("openTeam", timeout: 90))
        XCTAssertTrue(element("teamTitle").waitForExistence(timeout: 20))
        _ = wait(30) { !self.element("teamLoading").exists }
        shot("team")
        let person = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'teamPerson-'")).firstMatch
        if person.exists { app.swipeUp(); shot("team-lower") }
    }
}
