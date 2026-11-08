import SwiftUI

@main
struct OfficeIOSApp: App {
    @State private var model = AppModel.live()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Brand.tint)
        }
    }
}

/// The one Sunpride server this build talks to, from `SUNPRIDE_API_ORIGIN` (Info.plist).
/// HTTPS only, except plain HTTP to this Mac for lane testing.
struct AppEnvironment {
    static let originKey = "SUNPRIDE_API_ORIGIN"
    let apiOrigin: URL

    static func parse(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty, raw == raw.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = URL(string: raw), let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = c.scheme?.lowercased(), let host = c.host?.lowercased(), !host.isEmpty,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/",
              scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1"].contains(host)) else { return nil }
        return url
    }

    static func bundled(_ bundle: Bundle = .main) -> AppEnvironment? {
        parse(bundle.object(forInfoDictionaryKey: originKey) as? String).map(AppEnvironment.init)
    }
}

/// Signed-in state, the person's capabilities and the Decide badge. Screens get the API from here.
@MainActor @Observable
final class AppModel {
    enum State: Equatable { case misconfigured, restoring, signedOut, signedIn }

    private(set) var state: State = .restoring
    private(set) var me: Me?
    private(set) var decideOpen = 0
    var signOutReason: String?
    let api: APIClient?
    let auth: AuthClient?

    init(api: APIClient?, auth: AuthClient?) {
        self.api = api
        self.auth = auth
        if api == nil { state = .misconfigured }
        api?.onSignedOut = { [weak self] in self?.endSession(reason: OfficeError.sessionExpired.localizedDescription) }
    }

    static func live() -> AppModel {
        guard let env = AppEnvironment.bundled() else { return AppModel(api: nil, auth: nil) }
        let http = HTTPTransport()
        let store = KeychainStore()
        if ProcessInfo.processInfo.arguments.contains("-officeResetSession") { try? store.delete(StoreAccount.session) }
        let auth = AuthClient(origin: env.apiOrigin, store: store, http: http)
        return AppModel(api: APIClient(origin: env.apiOrigin, auth: auth, http: http), auth: auth)
    }

    var name: String { me?.profile?.name ?? me?.user.email ?? "" }
    var email: String { me?.user.email ?? "" }
    var role: String { Format.words(me?.profile?.role) }

    func can(_ capability: String) -> Bool { me?.capabilities.contains(capability) ?? false }

    /// The owner reports (web `ownerReaders`): report.read.
    var canReadReports: Bool { can("report.read") }
    var canReadStock: Bool { can("inventory.read") }
    var canReviewCounts: Bool { can("inventory.count.approve") }
    var canStorePOS: Bool { can("van.cash.approve") || can("admin.manage") }
    var canIssues: Bool { can("issues.read") }
    var canLocations: Bool { can("location.read") }
    var canReviewGathering: Bool { can("outlet.verify") }
    /// Anyone holding an approval capability sees Decide; the server marks what they can act on.
    var canDecide: Bool {
        canReadReports || ["inventory.count.approve", "van.cash.approve", "van.load.approve", "van.stock.approve",
                           "inventory.adjustment.approve", "order.approve"].contains(where: can)
    }

    func restore() async {
        guard let auth, state == .restoring else { return }
        guard auth.hasSession else { state = .signedOut; return }
        do {
            try await loadMe()
            state = .signedIn
            await refreshBadge()
        } catch OfficeError.offline {
            // Keep the session; show the signed-in shell with offline states.
            state = me == nil ? .signedOut : .signedIn
            if me == nil { signOutReason = OfficeError.offline.localizedDescription }
        } catch {
            state = .signedOut
        }
    }

    func signIn(email: String, password: String) async throws {
        guard let auth else { throw OfficeError.invalidResponse }
        try await auth.signIn(email: email, password: password)
        do { try await loadMe() } catch { await auth.signOut(); throw error }
        signOutReason = nil
        state = .signedIn
        await refreshBadge()
    }

    private func loadMe() async throws {
        guard let api else { return }
        me = try await api.get("api/me", as: Me.self)
    }

    func refreshBadge() async {
        guard let api, canDecide else { decideOpen = 0; return }
        if let inbox = try? await api.get("api/v1/decide/inbox", as: DecideInbox.self) { decideOpen = inbox.openCount }
    }

    func setDecideOpen(_ n: Int) { decideOpen = n }

    func signOut() async {
        await auth?.signOut()
        endSession(reason: nil)
    }

    private func endSession(reason: String?) {
        me = nil
        decideOpen = 0
        signOutReason = reason
        if state != .misconfigured { state = .signedOut }
    }
}
