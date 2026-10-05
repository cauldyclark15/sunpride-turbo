import SwiftUI
import UIKit

/// Where a salesperson is going: the outlet's verified pin, else its address text.
/// Turbo never draws a route; it hands this to an installed navigation app (IOS-018).
struct NavigationTarget: Equatable, Identifiable {
    enum Destination: Equatable {
        case pin(StoreSnapshot.Coordinate)
        case address(String)
    }
    let name: String
    let destination: Destination
    var id: String { "\(name)|\(destination)" }

    /// nil when the outlet has neither a valid pin nor a non-blank address.
    init?(name: String, location: StoreSnapshot.Coordinate?, address: String?) {
        self.name = name
        if let location, RouteMath.isValid(location) {
            destination = .pin(location)
        } else if let address = address?.trimmingCharacters(in: .whitespacesAndNewlines), !address.isEmpty {
            destination = .address(address)
        } else {
            return nil
        }
    }
}

/// Navigation apps the phone can hand a destination to. Apple Maps ships with iOS; the others are
/// offered only when installed (their schemes are declared in `LSApplicationQueriesSchemes`).
enum NavigationApp: String, CaseIterable, Identifiable {
    case appleMaps, googleMaps, waze
    var id: String { rawValue }

    var title: String {
        switch self {
        case .appleMaps: "Apple Maps"
        case .googleMaps: "Google Maps"
        case .waze: "Waze"
        }
    }

    /// URL probed with `canOpenURL`; nil for the built-in app.
    var probe: URL? {
        switch self {
        case .appleMaps: nil
        case .googleMaps: URL(string: "comgooglemaps://")
        case .waze: URL(string: "waze://")
        }
    }
}

enum TurnByTurn {
    /// A driving-directions URL that starts navigation to `target` in `app`.
    static func url(_ app: NavigationApp, to target: NavigationTarget) -> URL? {
        var components: URLComponents
        var items: [URLQueryItem]
        switch app {
        case .appleMaps:
            components = URLComponents(string: "https://maps.apple.com/")!
            switch target.destination {
            case .pin(let c):
                items = [URLQueryItem(name: "daddr", value: coordinate(c)), URLQueryItem(name: "q", value: target.name)]
            case .address(let a):
                items = [URLQueryItem(name: "daddr", value: a)]
            }
            items.append(URLQueryItem(name: "dirflg", value: "d"))
        case .googleMaps:
            components = URLComponents(string: "comgooglemaps://")!
            switch target.destination {
            case .pin(let c): items = [URLQueryItem(name: "daddr", value: coordinate(c))]
            case .address(let a): items = [URLQueryItem(name: "daddr", value: a)]
            }
            items.append(URLQueryItem(name: "directionsmode", value: "driving"))
        case .waze:
            components = URLComponents(string: "waze://")!
            switch target.destination {
            case .pin(let c): items = [URLQueryItem(name: "ll", value: coordinate(c))]
            case .address(let a): items = [URLQueryItem(name: "q", value: a)]
            }
            items.append(URLQueryItem(name: "navigate", value: "yes"))
        }
        components.queryItems = items
        return components.url
    }

    /// Apple Maps first (always present), then each third-party app the phone reports as installed.
    static func installed(canOpen: (URL) -> Bool) -> [NavigationApp] {
        NavigationApp.allCases.filter { app in app.probe.map(canOpen) ?? true }
    }

    private static func coordinate(_ c: StoreSnapshot.Coordinate) -> String { "\(c.latitude),\(c.longitude)" }
}

/// Starts turn-by-turn navigation: opens the only navigation app directly, or asks which one when
/// several are installed. Shared by the route list, the stop sheet and the outlet detail.
@MainActor @Observable
final class DirectionsLauncher {
    typealias Opener = (URL, @escaping (Bool) -> Void) -> Void

    /// Set while the "Navigate with" choice is showing.
    var pending: NavigationTarget?
    private(set) var choices: [NavigationApp] = [.appleMaps]
    /// Visible message when the system refused to open the chosen app.
    var failure: String?
    @ObservationIgnored private let canOpen: (URL) -> Bool

    init(canOpen: ((URL) -> Bool)? = nil) {
        self.canOpen = canOpen ?? DirectionsLauncher.systemCanOpen
    }

    func request(_ target: NavigationTarget, open: @escaping Opener) {
        failure = nil
        choices = TurnByTurn.installed(canOpen: canOpen)
        if choices.count == 1 {
            launch(choices[0], target, open: open)
        } else {
            pending = target
        }
    }

    func choose(_ app: NavigationApp, open: @escaping Opener) {
        guard let target = pending else { return }
        pending = nil
        launch(app, target, open: open)
    }

    private func launch(_ app: NavigationApp, _ target: NavigationTarget, open: @escaping Opener) {
        guard let url = TurnByTurn.url(app, to: target) else {
            failure = "Could not open \(app.title)"
            return
        }
        open(url) { [weak self] accepted in
            Task { @MainActor in self?.failure = accepted ? nil : "Could not open \(app.title)" }
        }
    }

    private static func systemCanOpen(_ url: URL) -> Bool {
        #if DEBUG
        // UI tests cannot install Google Maps/Waze on a simulator; they list "installed" apps instead.
        if StubBackend.scenario != nil, let fake = ProcessInfo.processInfo.environment["FIELD_STUB_NAV_APPS"] {
            let installed = fake.split(separator: ",").compactMap { NavigationApp(rawValue: String($0)) }
            return installed.contains { $0.probe == url }
        }
        #endif
        return UIApplication.shared.canOpenURL(url)
    }
}

private struct DirectionsChoice: ViewModifier {
    @Bindable var launcher: DirectionsLauncher
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        content.confirmationDialog(
            "Navigate with",
            isPresented: Binding(get: { launcher.pending != nil }, set: { if !$0 { launcher.pending = nil } }),
            titleVisibility: .visible,
            presenting: launcher.pending
        ) { _ in
            ForEach(launcher.choices) { app in
                Button(app.title) { launcher.choose(app) { url, done in openURL(url, completion: done) } }
                    .accessibilityIdentifier("navigateWith-\(app.rawValue)")
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}

extension View {
    /// Presents the navigation-app choice for `launcher` when more than one app is installed.
    func directionsChoice(_ launcher: DirectionsLauncher) -> some View {
        modifier(DirectionsChoice(launcher: launcher))
    }
}
