import Foundation

/// The beta feature list (SP-0132, mirrors Android SP-0124). Anything not used in the beta yet is hidden
/// here, never deleted: its code, screens and tests stay, and removing it from `FieldFeatures.hiddenInBeta`
/// switches it back on. `apps/field-ios/docs/BETA_FEATURES.md` lists every entry and why.
enum FieldFeature: String, CaseIterable, Sendable {
    /// Start/End call, activities, call sheet, orders and visit photos (from Today, Route and Customers).
    case visits
    /// The "Unplanned visit" list on Today and the visit button on an off-plan outlet (needs `visits`).
    case unplannedVisits
    /// The supervisor-only Team page.
    case team
    /// Key storage and fingerprint rows on Account: technical phone-key details.
    case phoneKeyDetails
    /// Developer tools (public-key file, design-token preview, stub backends). Never in a non-DEBUG build.
    case developerTools
}

struct FieldFeatures: Equatable, Sendable {
    let enabled: Set<FieldFeature>
    /// `<web>/issues/new` for "Report an issue" on Account; nil hides the link.
    let reportIssueURL: URL?

    func contains(_ feature: FieldFeature) -> Bool { enabled.contains(feature) }

    /// Switched off in every non-DEBUG build (the beta). Remove an entry (and rebuild) to switch it back on.
    static let hiddenInBeta: Set<FieldFeature> = [.unplannedVisits, .phoneKeyDetails]
    /// Only a DEBUG (DEV) build carries these, whatever the beta list says.
    static let developerOnly: Set<FieldFeature> = [.developerTools]

    /// What a build shows. `debug` is the DEBUG compilation condition (Debug configuration only).
    static func forBuild(debug: Bool, webURL: String) -> FieldFeatures {
        let all = Set(FieldFeature.allCases)
        return FieldFeatures(enabled: debug ? all : all.subtracting(developerOnly).subtracting(hiddenInBeta),
                             reportIssueURL: reportIssueURL(webURL))
    }

    /// `<web>/issues/new`, or nil (link hidden) when the web URL is blank or not a plain http(s) address.
    /// Trailing slashes are dropped. Same rules as Android `FieldFeatures.reportIssueUrl`.
    static func reportIssueURL(_ webURL: String) -> URL? {
        var base = webURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while base.hasSuffix("/") { base.removeLast() }
        guard !base.isEmpty, !base.contains(where: \.isWhitespace), !base.contains("$("),
              let components = URLComponents(string: base),
              let scheme = components.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = components.host, !host.isEmpty,
              components.query == nil, components.fragment == nil,
              components.user == nil, components.password == nil else { return nil }
        return URL(string: base + "/issues/new")
    }

    /// The running app's features: DEBUG builds show everything; Beta/Release show the beta list.
    /// DEBUG UI tests can pass `-fieldBetaFeatures` to see exactly what the beta build shows.
    static let current: FieldFeatures = {
        let webURL = Bundle.main.object(forInfoDictionaryKey: "FIELD_WEB_URL") as? String ?? ""
        #if DEBUG
        let debug = !ProcessInfo.processInfo.arguments.contains("-fieldBetaFeatures")
        #else
        let debug = false
        #endif
        return forBuild(debug: debug, webURL: webURL)
    }()
}

/// The version people see: `1.0.0-beta.N (N)` in the beta build, `1.0 (1)` in DEV.
enum AppVersion {
    static func label(info: [String: Any]?) -> String {
        let marketing = info?["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = info?["CFBundleVersion"] as? String ?? "unknown"
        let custom = (info?["FIELD_VERSION_LABEL"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        let version = custom.isEmpty || custom.contains("$(") ? marketing : custom
        return "\(version) (\(build))"
    }
}
