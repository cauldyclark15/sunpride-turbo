import Foundation

/// SP-0138: decides when the field app shares its location and turns fixes into buffered pings.
/// Sharing runs ONLY during the work day — from "Start day" or the day's first call Start until
/// "End day", sign-out or the 10 PM Manila close — and only after the one-time consent notice is accepted.
/// Pings wait in the encrypted store and upload in signed batches; the server re-checks work hours.
@MainActor
@Observable
final class LiveLocationController {
    /// What Today shows.
    enum Status: Equatable {
        /// Sharing is on (the indicator). `alwaysAllowed` false = While Using only (hint to allow Always).
        case sharing(alwaysAllowed: Bool)
        /// Consent given and the day is open, but iPhone location is off or refused for this app.
        case permissionOff
        case off(LiveSharingDecision.Reason)
    }
    struct Context {
        var signedIn: Bool
        var ready: Bool
        var partition: StorePartition?
        var store: (any LiveLocationStore)?
    }

    private(set) var status: Status = .off(.notSignedIn)
    private(set) var consent: LocationConsent = .unanswered
    private(set) var day: WorkDay?
    private(set) var waiting = 0
    private(set) var lastPingAt: Date?
    /// Today presents the consent notice while this is true.
    var consentRequested = false

    @ObservationIgnored private let source: any LiveLocationSource
    @ObservationIgnored private let consents: any LocationConsentStore
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private var context = Context(signedIn: false, ready: false)
    @ObservationIgnored private var last: PingSampler.Last?
    @ObservationIgnored private var lastUploadAt: Date?
    @ObservationIgnored private var startAfterConsent = false
    @ObservationIgnored private var askedPermission = false
    @ObservationIgnored private var ticker: Timer?
    @ObservationIgnored private var closer: Timer?
    /// Upload the buffer (the AppModel signs and sends it when the phone is ready and online).
    @ObservationIgnored var upload: (() async -> Void)?
    /// The open call's server visit ID, attached to pings taken during the call.
    @ObservationIgnored var openVisitId: (() -> String?)?
    /// Work hours (5 AM–10 PM Manila). DEBUG UI tests may widen it so they pass at any hour.
    @ObservationIgnored var withinHours: (Date) -> Bool = LiveLocationPolicy.withinWorkHours

    init(source: any LiveLocationSource, consents: any LocationConsentStore, now: @escaping () -> Date = { Date() }) {
        self.source = source
        self.consents = consents
        self.now = now
        source.onFix = { [weak self] fix in self?.handle(fix) }
        source.onAuthorization = { [weak self] _ in self?.evaluate() }
    }

    private var today: String { BootstrapClient.manilaDay(now()) }
    private var nowMs: Int64 { Int64(now().timeIntervalSince1970 * 1000) }

    /// Re-read account, phone state, consent and today's work day; start or stop accordingly.
    func update(_ context: Context) {
        if context.partition != self.context.partition { last = nil }
        self.context = context
        evaluate()
    }

    /// "Start day": shows the notice first if it has not been answered (or was declined).
    func startDay() {
        guard let (store, partition) = target else { return }
        guard consent == .accepted else { startAfterConsent = true; consentRequested = true; return }
        do { day = try store.startWorkDay(today, at: nowMs, for: partition) } catch { return }
        source.requestPermission()
        evaluate()
    }

    /// A call Start: opens the work day if it is not open yet. Asks for consent once if never answered.
    func callStarted() {
        guard let (store, partition) = target else { return }
        // Already open, or ended today (only Start day reopens an ended day).
        if (try? store.workDay(today, for: partition)) != nil { return }
        switch consent {
        case .accepted: startDay()
        case .unanswered: startAfterConsent = true; consentRequested = true
        case .declined: break
        }
    }

    func answerConsent(_ accepted: Bool) {
        consentRequested = false
        guard let partition = context.partition else { return }
        consent = accepted ? .accepted : .declined
        consents.setConsent(consent, subject: partition.subject, at: now())
        let start = startAfterConsent
        startAfterConsent = false
        if accepted {
            source.requestPermission()
            if start { startDay() }
        }
        evaluate()
    }

    /// "End day" (or sign-out): a final `stop` ping inside work hours, then sharing stops and the buffer uploads.
    /// Sign-out does not wait for the network: the stop ping stays encrypted in the account's partition.
    func endDay(_ reason: WorkDay.EndReason = .endDay, upload uploadNow: Bool = true) async {
        guard let (store, partition) = target, let open = try? store.workDay(today, for: partition), open.isOpen else {
            stopSource(); return
        }
        if source.running, let fix = source.lastFix ?? last?.fix, withinHours(now()) {
            record(fix, trigger: .stop, store: store, partition: partition)
        }
        try? store.endWorkDay(open.serviceDate, at: nowMs, reason: reason, for: partition)
        stopSource()
        evaluate()
        if uploadNow { await upload?() }
        refreshCount()
    }

    /// Signing out ends sharing before the session goes.
    func signingOut() async {
        await endDay(.signOut, upload: false)
        stopSource()
        status = .off(.notSignedIn)
        day = nil
        consent = .unanswered
        context = Context(signedIn: false, ready: false)
        last = nil
    }

    // MARK: Internals

    private var target: (any LiveLocationStore, StorePartition)? {
        guard context.signedIn, let store = context.store, let partition = context.partition else { return nil }
        return (store, partition)
    }

    private func evaluate() {
        guard let (store, partition) = target else {
            stopSource(); status = .off(context.signedIn ? .phoneNotReady : .notSignedIn); return
        }
        consent = consents.consent(subject: partition.subject)
        // A day left open past its close (app not running at 10 PM) is closed at that close.
        if let stale = try? store.workDay(today, for: partition), stale.isOpen, !withinHours(now()),
           FieldDay.calendar.component(.hour, from: now()) >= LiveLocationPolicy.dailyCloseHour,
           let close = FieldDay.close(serviceDay: stale.serviceDate) {
            try? store.endWorkDay(stale.serviceDate, at: Int64(close.timeIntervalSince1970 * 1000), reason: .dailyClose, for: partition)
        }
        day = try? store.workDay(today, for: partition)
        let held = (try? store.isHeld(partition)) ?? true
        let decision = LiveSharingDecision.decide(signedIn: context.signedIn, ready: context.ready, held: held,
                                                  consent: consent, day: day, now: now(), withinHours: withinHours(now()))
        refreshCount()
        guard decision == .share else {
            stopSource()
            if case .off(let reason) = decision { status = .off(reason) }
            return
        }
        switch source.authorization {
        case .always, .whenInUse:
            // Status first: a source may deliver its first fix synchronously from `start()`.
            status = .sharing(alwaysAllowed: source.authorization == .always)
            if !source.running { source.start(); startTimers() }
        case .notDetermined:
            if !askedPermission { askedPermission = true; source.requestPermission() }
            status = .permissionOff
        case .denied, .servicesOff:
            stopSource()
            status = .permissionOff
        }
    }

    private func handle(_ fix: LiveFix) {
        guard case .sharing = status, let (store, partition) = target else { return }
        guard withinHours(now()) else { evaluate(); return }
        let moved = last.map { $0.fix.distance(to: fix) >= LiveLocationPolicy.movingDistanceMeters } ?? true
        if moved || (fix.speedMetersPerSecond ?? 0) >= LiveLocationPolicy.movingSpeed { source.setLowPower(false) }
        guard let trigger = PingSampler.trigger(last: last, fix: fix, now: now()) else { return }
        record(fix, trigger: trigger, store: store, partition: partition)
        uploadIfDue()
    }

    /// Every minute while sharing: the 5-minute still ping, low-power mode and the close check.
    func tick() {
        guard case .sharing = status, let (store, partition) = target else { evaluate(); return }
        guard withinHours(now()) else { evaluate(); return }
        guard let fix = source.lastFix ?? last?.fix else { return }
        guard let last else { record(fix, trigger: .start, store: store, partition: partition); uploadIfDue(); return }
        // No new fix for a while: the person is still. Coarse low-power fixes until they move again.
        let idle = now().timeIntervalSince(last.at)
        if idle >= 120 { source.setLowPower(true) }
        if idle >= LiveLocationPolicy.stillInterval { record(fix, trigger: .still, store: store, partition: partition) }
        uploadIfDue()
    }

    private func record(_ fix: LiveFix, trigger: LivePing.Trigger, store: any LiveLocationStore, partition: StorePartition) {
        let at = now()
        let ping = LivePing(fix: fix, at: at, trigger: trigger, batteryPercent: source.batteryPercent(),
                            visitId: openVisitId?())
        do { try store.enqueuePing(ping, for: partition) } catch { return }
        last = .init(fix: fix, at: at)
        lastPingAt = at
        refreshCount()
    }

    private func uploadIfDue() {
        let due = waiting >= LiveLocationPolicy.uploadBatchSize ||
            lastUploadAt.map { now().timeIntervalSince($0) >= LiveLocationPolicy.uploadInterval } ?? true
        guard due, waiting > 0, let upload else { return }
        lastUploadAt = now()
        Task { await upload(); refreshCount() }
    }

    func refreshCount() {
        guard let (store, partition) = target else { waiting = 0; return }
        waiting = (try? store.pingCount(for: partition)) ?? 0
    }

    private func startTimers() {
        ticker?.invalidate()
        ticker = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        // Stop just before the 10 PM close so the final `stop` ping is still inside work hours.
        closer?.invalidate()
        let close = FieldDay.nextClose(after: now()).addingTimeInterval(-30)
        let delay = close.timeIntervalSince(now())
        if delay > 0 {
            closer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
                Task { @MainActor in await self?.endDay(.dailyClose) }
            }
        }
    }

    private func stopSource() {
        ticker?.invalidate(); ticker = nil
        closer?.invalidate(); closer = nil
        if source.running { source.stop() }
    }
}
