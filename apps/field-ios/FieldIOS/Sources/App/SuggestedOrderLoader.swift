import Foundation

/// Session-only, outlet + Manila-day cache. Account/session resets invalidate in-flight reads too.
@MainActor
@Observable
final class SuggestedOrderLoader {
    struct Request: Encodable, Hashable {
        let outletId: String
        let asOfDate: String
    }
    enum State: Equatable {
        case loading
        case loaded(SuggestedOrder, offlineLoadedAt: Date?)
        case connectionNeeded
        case rejected
        case unreadable

        var order: SuggestedOrder? {
            if case .loaded(let order, _) = self { return order }
            return nil
        }
        var message: String? {
            switch self {
            case .loading: "Loading suggestions…"
            case .loaded(_, let date): date.map { "Offline — showing suggestions loaded at \(Self.time($0))" }
            case .connectionNeeded: "Suggestions need a connection. Enter your order as usual."
            case .rejected: "Suggestions aren't available for your account."
            case .unreadable: "Couldn't read suggestions. Enter your order as usual."
            }
        }
        private static func time(_ date: Date) -> String {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(identifier: "Asia/Manila")!
            formatter.dateFormat = "h:mm a"
            return formatter.string(from: date)
        }
    }
    private struct Cached { let order: SuggestedOrder; let loadedAt: Date }
    private var states: [Request: State] = [:]
    @ObservationIgnored private var cache: [Request: Cached] = [:]
    @ObservationIgnored private var requests: [Request: UUID] = [:]
    @ObservationIgnored private let fetch: (Request) async throws -> SuggestedOrder?
    @ObservationIgnored private let now: () -> Date

    init(now: @escaping () -> Date = { Date() }, fetch: @escaping (Request) async throws -> SuggestedOrder?) {
        self.now = now
        self.fetch = fetch
    }
    func request(outletId: String) -> Request {
        Request(outletId: outletId, asOfDate: BootstrapClient.manilaDay(now()))
    }
    func state(outletId: String) -> State {
        states[request(outletId: outletId)] ?? .loading
    }
    func clear() {
        states = [:]
        cache = [:]
        requests = [:]
    }
    func load(outletId: String, offline: Bool) async {
        let key = request(outletId: outletId)
        let id = UUID()
        requests[key] = id
        if offline {
            showTransportFailure(key)
            requests.removeValue(forKey: key)
            return
        }
        states[key] = .loading
        do {
            guard let response = try await fetch(key) else { throw MobileError.invalidResponse }
            try Task.checkCancellation()
            let order = try response.validated(outletId: key.outletId, asOfDate: key.asOfDate)
            guard requests[key] == id else { return }
            cache[key] = Cached(order: order, loadedAt: now())
            states[key] = .loaded(order, offlineLoadedAt: nil)
        } catch {
            guard requests[key] == id else { return }
            switch error {
            case MobileError.rejected, MobileError.unauthorized, MobileError.notSignedIn, MobileError.sessionExpired:
                cache.removeValue(forKey: key)
                states[key] = .rejected
            case MobileError.invalidResponse, is DecodingError, is SuggestedOrder.Failure:
                // Bad or misaddressed data is not an offline excuse to show old recommendations.
                cache.removeValue(forKey: key)
                states[key] = .unreadable
            default:
                showTransportFailure(key)
            }
        }
        if requests[key] == id { requests.removeValue(forKey: key) }
    }
    private func showTransportFailure(_ key: Request) {
        if let cached = cache[key] {
            states[key] = .loaded(cached.order, offlineLoadedAt: cached.loadedAt)
        } else {
            // Rejection remains a rejection even if the next screen opens without a connection.
            if states[key] != .rejected { states[key] = .connectionNeeded }
        }
    }
}
