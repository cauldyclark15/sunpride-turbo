import Foundation

/// Great-circle distance with the same Earth radius the server uses for visit location evidence.
enum RouteMath {
    static func isValid(_ c: StoreSnapshot.Coordinate) -> Bool {
        c.latitude.isFinite && c.longitude.isFinite && abs(c.latitude) <= 90 && abs(c.longitude) <= 180
    }

    static func meters(from a: StoreSnapshot.Coordinate, to b: StoreSnapshot.Coordinate) -> Double {
        let rad = Double.pi / 180
        let dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad
        let h = pow(sin(dLat / 2), 2) + cos(a.latitude * rad) * cos(b.latitude * rad) * pow(sin(dLon / 2), 2)
        return 2 * 6_371_000 * asin(sqrt(min(1, h)))
    }

    /// "350 m", "1.2 km", "14 km": rounded so a phone fix never reads as survey precision.
    static func label(meters: Double) -> String {
        let tens = Int((meters / 10).rounded()) * 10
        if tens < 1_000 { return "\(tens) m" }
        let km = meters / 1_000
        if km < 9.95 { return String(format: "%.1f km", locale: Locale(identifier: "en_US_POSIX"), km) }
        return "\(Int(km.rounded())) km"
    }
}

struct RouteStop: Identifiable {
    enum State: Equatable { case next, notStarted, inProgress, done, needsReview }
    let visit: AppModel.TodayVisit
    /// 1-based position in today's MCP order.
    let position: Int
    let state: State
    let outletCode: String?
    let customer: StoreSnapshot.Customer?
    let address: String?
    let distanceMeters: Double?
    let directionsURL: URL?
    var id: String { visit.id }

    var waitingToSend: Bool { visit.status == "Queued" || visit.status == "Sending" }
    var stateLabel: String {
        let base: String
        switch state {
        case .next: base = "Next"
        case .notStarted: base = "Not started"
        case .inProgress: base = "In progress"
        case .done: base = visit.timeSpent.map { "Done · \($0)" } ?? "Done"
        case .needsReview: base = "To review"
        }
        return waitingToSend && state != .needsReview ? "\(base) · waiting to send" : base
    }
    var distanceLabel: String? { distanceMeters.map { "\(RouteMath.label(meters: $0)) away" } }
    var customerLabel: String? { customer?.code }
}

/// Today's planned visits as a route: MCP order, call state, distance and map/customer access.
/// Pure so the order/state/distance rules are unit-tested without a simulator.
enum DailyRoute {
    static func stops(visits: [AppModel.TodayVisit], outlets: [String: StoreSnapshot.Outlet],
                      customers: [String: StoreSnapshot.Customer],
                      here: StoreSnapshot.Coordinate?,
                      canStart: ((AppModel.TodayVisit) -> Bool)? = nil) -> [RouteStop] {
        // `visits` arrive in stored MCP order (StoreSnapshot.Visit.ordered); unplanned stores are not route stops.
        let planned = visits.filter(\.planned)
        let states = planned.map(baseState)
        let callOpen = states.contains(.inProgress)
        var nextAssigned = false
        let validHere = here.flatMap { RouteMath.isValid($0) ? $0 : nil }
        return planned.enumerated().map { index, visit in
            var state = states[index]
            // "Next" is the stop the seller may Start now: the model's MCP/open-call guard when given.
            if state == .notStarted && !callOpen && !nextAssigned && canStart?(visit) != false {
                state = .next
                nextAssigned = true
            }
            let outlet = outlets[visit.outletId]
            let location = outlet?.location.flatMap { RouteMath.isValid($0) ? $0 : nil }
            return RouteStop(
                visit: visit, position: index + 1, state: state,
                outletCode: outlet?.code,
                customer: outlet?.customerId.flatMap { customers[$0] },
                address: outlet?.address.flatMap { $0.isEmpty ? nil : $0 },
                distanceMeters: both(validHere, location).map { RouteMath.meters(from: $0, to: $1) },
                directionsURL: directionsURL(name: visit.outlet, location: location, address: outlet?.address))
        }
    }

    /// Mirrors the Today/visit screens: a review hold wins, then the local Start/End call record.
    static func baseState(_ visit: AppModel.TodayVisit) -> RouteStop.State {
        if visit.status == "Needs review" { return .needsReview }
        if visit.endedAt != nil { return .done }
        if visit.startedAt != nil { return .inProgress }
        if visit.status == "Accepted" { return .done }
        return .notStarted
    }

    /// Apple Maps driving directions to the verified pin, else to the address text; nil when neither exists.
    static func directionsURL(name: String, location: StoreSnapshot.Coordinate?, address: String?) -> URL? {
        var components = URLComponents(string: "https://maps.apple.com/")!
        if let location, RouteMath.isValid(location) {
            components.queryItems = [
                URLQueryItem(name: "daddr", value: "\(location.latitude),\(location.longitude)"),
                URLQueryItem(name: "q", value: name),
                URLQueryItem(name: "dirflg", value: "d")
            ]
        } else if let address = address?.trimmingCharacters(in: .whitespacesAndNewlines), !address.isEmpty {
            components.queryItems = [URLQueryItem(name: "daddr", value: address), URLQueryItem(name: "dirflg", value: "d")]
        } else {
            return nil
        }
        return components.url
    }
}

private func both<A, B>(_ a: A?, _ b: B?) -> (A, B)? {
    guard let a, let b else { return nil }
    return (a, b)
}
