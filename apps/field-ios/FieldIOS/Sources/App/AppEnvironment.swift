import Foundation

/// The one Sunpride server this build talks to: sign-in, device registration, sync and photos all
/// share this origin. Read from the `SUNPRIDE_API_ORIGIN` build setting (Info.plist).
struct AppEnvironment {
    static let originKey = "SUNPRIDE_API_ORIGIN"
    let apiOrigin: URL

    enum ConfigurationError: Error, LocalizedError {
        case invalid
        var errorDescription: String? {
            "This build has no valid Sunpride server address. Install the latest Sunpride Field build."
        }
    }

    init(values: [String: String]) throws {
        apiOrigin = try Self.parse(values[Self.originKey])
    }

    /// The address compiled into this app.
    static func bundled(_ bundle: Bundle = .main) throws -> AppEnvironment {
        try AppEnvironment(values: [originKey: bundle.object(forInfoDictionaryKey: originKey) as? String ?? ""])
    }

    private static func parse(_ raw: String?) throws -> URL {
        guard let raw, !raw.isEmpty, raw == raw.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = URL(string: raw), let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased(),
              !host.isEmpty, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1"].contains(host)) else {
            throw ConfigurationError.invalid
        }
        return url
    }
}
