import Foundation

struct AppEnvironment {
    let siteURL: URL
    let convexURL: URL

    enum ConfigurationError: Error, LocalizedError {
        case invalid(String)
        var errorDescription: String? {
            switch self {
            case .invalid(let key): return "Set a valid HTTPS \(key) in Config/Local.xcconfig. HTTP is allowed only for localhost."
            }
        }
    }

    init(values: [String: String]) throws {
        siteURL = try Self.parse(values["CONVEX_SITE_URL"], key: "CONVEX_SITE_URL")
        convexURL = try Self.parse(values["CONVEX_URL"], key: "CONVEX_URL")
    }

    private static func parse(_ raw: String?, key: String) throws -> URL {
        guard let raw, !raw.isEmpty, raw == raw.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = URL(string: raw), let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased(),
              !host.isEmpty, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              scheme == "https" || (scheme == "http" && host == "localhost") else {
            throw ConfigurationError.invalid(key)
        }
        return url
    }
}
