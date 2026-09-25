import Foundation

/// User-facing failures. Descriptions never contain response bodies, headers, credentials or tokens;
/// `rejected` carries only a redacted, bounded server reason.
enum MobileError: Error, Equatable, LocalizedError, CustomStringConvertible {
    case invalidCredentials
    case signInRefused
    case rateLimited
    case offline
    case server
    case notSignedIn
    case sessionExpired
    case unauthorized
    case invalidResponse
    case rejected(String)
    case deviceKeyUnavailable
    case storage

    var errorDescription: String? {
        switch self {
        case .invalidCredentials: "Incorrect email or password."
        case .signInRefused: "Sign-in was refused for this app. Contact your administrator."
        case .rateLimited: "Too many attempts. Wait a minute and try again."
        case .offline: "You're offline. Connect to the internet and try again."
        case .server: "The server is unavailable. Try again later."
        case .notSignedIn: "Sign in to continue."
        case .sessionExpired: "Your session has ended. Sign in again."
        case .unauthorized: "The server did not accept your sign-in. Sign in again."
        case .invalidResponse: "Unexpected server response. Try again later."
        case .rejected(let reason): "Request refused: \(reason)"
        case .deviceKeyUnavailable: "This phone's security key is unavailable. Contact support."
        case .storage: "Secure storage is unavailable on this phone."
        }
    }
    var description: String { errorDescription ?? "Request failed." }
}

/// URLSession wrapper with a cookie-less, cache-less ephemeral configuration so the Better Auth
/// session never lands in the shared cookie jar or URL cache — only the Keychain holds it.
struct HTTPClient: Sendable {
    let session: URLSession

    static func makeConfiguration(protocolClasses: [AnyClass]? = nil) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        if let protocolClasses { configuration.protocolClasses = protocolClasses }
        return configuration
    }

    init(session: URLSession = URLSession(configuration: HTTPClient.makeConfiguration())) {
        self.session = session
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw MobileError.invalidResponse }
            return (data, http)
        } catch let error as MobileError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            // Any transport failure (no route, DNS, TLS, timeout) is presented as offline.
            throw MobileError.offline
        }
    }
}
