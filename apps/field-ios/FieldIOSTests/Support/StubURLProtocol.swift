import Foundation
import Synchronization
@testable import FieldIOS

/// URLProtocol stub: every request made through `StubHTTP.client()` is recorded and answered by `handler`.
/// No request ever leaves the process.
final class StubURLProtocol: URLProtocol {
    struct Reply: Sendable {
        var status: Int
        var headers: [String: String] = [:]
        var body: Data = Data()
        static func json(_ status: Int, _ object: Any, headers: [String: String] = [:]) -> Reply {
            Reply(status: status, headers: headers, body: try! JSONSerialization.data(withJSONObject: object))
        }
    }
    enum Outcome: Sendable { case reply(Reply), fail(URLError.Code) }

    struct Recorded: Sendable {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data
    }

    private static let state = Mutex<(handler: (@Sendable (Recorded) -> Outcome)?, requests: [Recorded])>((nil, []))

    static func install(_ handler: @escaping @Sendable (Recorded) -> Outcome) {
        state.withLock { $0 = (handler, []) }
    }
    static var requests: [Recorded] { state.withLock { $0.requests } }
    static func requests(to path: String) -> [Recorded] { requests.filter { $0.path == path } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let recorded = Recorded(method: request.httpMethod ?? "GET", path: request.url?.path ?? "",
                                headers: request.allHTTPHeaderFields ?? [:], body: Self.body(of: request))
        let handler = Self.state.withLock { state -> (@Sendable (Recorded) -> Outcome)? in
            state.requests.append(recorded)
            return state.handler
        }
        switch handler?(recorded) ?? .fail(.notConnectedToInternet) {
        case .fail(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .reply(let reply):
            let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1",
                                           headerFields: reply.headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: reply.body)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    private static func body(of request: URLRequest) -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

enum StubHTTP {
    static let site = URL(string: "https://unit-test.convex.site")!
    static let cloud = URL(string: "https://unit-test.convex.cloud")!

    static func client() -> HTTPClient {
        HTTPClient(session: URLSession(configuration: HTTPClient.makeConfiguration(protocolClasses: [StubURLProtocol.self])))
    }

    /// An unsigned JWT-shaped token with the given `exp` (seconds). Only its public claims are read client-side.
    static func jwt(exp: TimeInterval, marker: String = "a") -> String {
        func segment(_ object: Any) -> String {
            try! JSONSerialization.data(withJSONObject: object, options: .sortedKeys).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return "\(segment(["alg": "ES256"])).\(segment(["aud": "convex", "exp": exp, "m": marker])).sig\(marker)"
    }
}

/// Settable clock for deterministic JWT expiry tests.
final class TestClock: Sendable {
    private let current: Mutex<Date>
    init(_ date: Date = Date(timeIntervalSince1970: 1_800_000_000)) { current = Mutex(date) }
    var now: Date { current.withLock { $0 } }
    func advance(_ seconds: TimeInterval) { current.withLock { $0 = $0.addingTimeInterval(seconds) } }
    var closure: @Sendable () -> Date { { [self] in self.now } }
}
