import SwiftUI
import UIKit

/// SP-0166: the places a seller works from, mirroring the Android field app's bottom bar
/// (`FieldNav.kt`: Today, Route, Stores, Messages, More). iOS has no Messages screen yet, so it is left
/// out rather than shown empty; every other screen belongs to one of these four.
enum FieldTab: String, CaseIterable, Identifiable {
    case today, route, stores, more
    var id: String { rawValue }
    var label: String {
        switch self {
        case .today: "Today"
        case .route: "Route"
        case .stores: "Stores"
        case .more: "More"
        }
    }
    var symbol: String {
        switch self {
        case .today: "sun.max"
        case .route: "map"
        case .stores: "storefront"
        case .more: "ellipsis.circle"
        }
    }
    var identifier: String { "tab-\(rawValue)" }
}

/// Shared chrome state: forms and an open visit hide the bottom bar so it cannot pull the seller out
/// mid-entry (Android `FieldNav.noBarPages`). A screen holds a lease while it is anywhere in a stack,
/// so screens pushed on top of a visit keep the bar hidden too.
@MainActor @Observable
final class FieldChrome {
    private(set) var hiddenBy: Set<UUID> = []
    var barHidden: Bool { !hiddenBy.isEmpty }
    func hide(_ id: UUID) { hiddenBy.insert(id) }
    func release(_ id: UUID) { hiddenBy.remove(id) }
}

private final class BarLease {
    let id = UUID()
    weak var chrome: FieldChrome?
    deinit {
        let id = id
        if let chrome { Task { @MainActor in chrome.release(id) } }
    }
}

private struct FieldTabBarHiddenModifier: ViewModifier {
    @Environment(FieldChrome.self) private var chrome: FieldChrome?
    @State private var lease = BarLease()
    func body(content: Content) -> some View {
        content
            .toolbar(.hidden, for: .tabBar)
            .onAppear {
                guard let chrome else { return }
                lease.chrome = chrome
                chrome.hide(lease.id)
            }
    }
}

extension View {
    /// Hide the bottom bar while this screen (or anything pushed over it) is open.
    func fieldTabBarHidden() -> some View { modifier(FieldTabBarHiddenModifier()) }
}

/// The signed-in app: a bottom bar on every device. iPhone uses the system tab bar (Liquid Glass);
/// iPad gets the same tabs in a floating Liquid Glass bar anchored to the bottom, because the system
/// iPad tab bar sits at the top and sellers hold the tablet by its lower edge.
struct FieldTabShell<Today: View>: View {
    let model: AppModel
    @ViewBuilder let today: () -> Today
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var selection: FieldTab = .today
    @State private var chrome = FieldChrome()

    var body: some View {
        Group {
            if sizeClass == .regular {
                FloatingTabLayout(model: model, selection: $selection, chrome: chrome, today: today)
            } else {
                TabView(selection: $selection) {
                    ForEach(FieldTab.allCases) { tab in
                        Tab(tab.label, systemImage: tab.symbol, value: tab) {
                            FieldTabRoot(tab: tab, model: model, wide: false, today: today)
                        }
                    }
                }
                .tint(SunprideTokens.actionBackground)
            }
        }
        .environment(chrome)
    }
}

/// One tab's content with its own navigation stack (iPad landscape Stores: list beside detail).
private struct FieldTabRoot<Today: View>: View {
    let tab: FieldTab
    let model: AppModel
    let wide: Bool
    let today: () -> Today

    var body: some View {
        switch tab {
        case .today:
            NavigationStack { today() }
        case .route:
            NavigationStack { RouteScreen(model: model, showsBack: false) }
        case .stores:
            if wide {
                NavigationSplitView(columnVisibility: .constant(.all)) {
                    CustomerSearchScreen(model: model, showsBack: false)
                        .navigationSplitViewColumnWidth(min: 340, ideal: 420, max: 520)
                } detail: {
                    StoresDetailPlaceholder()
                }
                .navigationSplitViewStyle(.balanced)
            } else {
                NavigationStack { CustomerSearchScreen(model: model, showsBack: false) }
            }
        case .more:
            NavigationStack { MoreScreen(model: model) }
        }
    }
}

private struct StoresDetailPlaceholder: View {
    var body: some View {
        ContentUnavailableView("Choose a store", systemImage: "storefront",
                               description: Text("Its account, route, calls and history open here."))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(SunprideTokens.background)
            .calmScreenChrome()
            .accessibilityIdentifier("storesDetailPlaceholder")
    }
}

/// iPad: tab content plus a bottom-anchored floating glass bar. Every tab stays alive (state kept, like
/// the system TabView); every tab's scroll content gets bottom margins equal to the bar so nothing sits under it.
private struct FloatingTabLayout<Today: View>: View {
    let model: AppModel
    @Binding var selection: FieldTab
    let chrome: FieldChrome
    let today: () -> Today
    @State private var keyboardUp = false
    /// Measured height of the bar (plus its bottom gap above the home indicator).
    @State private var barHeight: CGFloat = 76
    private var barShown: Bool { !chrome.barHidden && !keyboardUp }

    var body: some View {
        GeometryReader { proxy in
            let wide = proxy.size.width > proxy.size.height
            ZStack {
                ForEach(FieldTab.allCases) { tab in
                    FieldTabRoot(tab: tab, model: model, wide: wide, today: today)
                        .opacity(tab == selection ? 1 : 0)
                        .allowsHitTesting(tab == selection)
                        .accessibilityHidden(tab != selection)
                }
            }
            // Every scroll view in every tab ends above the bar. A safe-area inset on this ZStack did not
            // reach the hosted NavigationStacks once the bar had been removed and re-added (keyboard at
            // sign-in), so the last rows sat under the bar; content margins flow through the environment.
            .contentMargins(.bottom, barShown ? barHeight + 12 : 0, for: .scrollContent)
            .overlay(alignment: .bottom) {
                if barShown {
                    FloatingTabBar(selection: $selection)
                        .padding(.bottom, 8)
                        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { barHeight = $0 }
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.smooth(duration: 0.25), value: chrome.barHidden)
            .animation(.smooth(duration: 0.25), value: keyboardUp)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboardUp = true }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboardUp = false }
    }
}

struct FloatingTabBar: View {
    @Binding var selection: FieldTab
    @Namespace private var glass

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 4) {
                ForEach(FieldTab.allCases) { tab in
                    let on = tab == selection
                    Button {
                        selection = tab
                    } label: {
                        VStack(spacing: 3) {
                            Image(systemName: tab.symbol)
                                .font(.system(size: 20, weight: on ? .semibold : .regular))
                                .symbolVariant(on ? .fill : .none)
                            Text(tab.label).font(.system(.caption, weight: on ? .semibold : .medium))
                        }
                        .foregroundStyle(on ? SunprideTokens.actionBackground : SunprideTokens.text)
                        .frame(minWidth: 96, minHeight: 56)
                        .padding(.horizontal, 6)
                        .contentShape(Capsule())
                        .background {
                            if on {
                                Capsule().fill(SunprideTokens.brand.opacity(0.13))
                                    .matchedGeometryEffect(id: "selected", in: glass)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(tab.label)
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .accessibilityIdentifier(tab.identifier)
                }
            }
            .padding(6)
            // A light tint keeps labels legible over scrolled content in bright light.
            .glassEffect(.regular.tint(SunprideTokens.card.opacity(0.55)).interactive(), in: Capsule())
        }
        .animation(.snappy(duration: 0.28), value: selection)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fieldTabBar")
    }
}

/// More: everything that is not a daily place, the same as Android's More tab.
struct MoreScreen: View {
    let model: AppModel
    @State private var showAccount = false
    @State private var showSync = false
    private let features = FieldFeatures.current

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("More").font(SunprideTokens.TypeStyle.title)
                    .foregroundStyle(SunprideTokens.text)
                    .accessibilityIdentifier("moreTitle")
                SectionCard(title: "You") {
                    Button { showAccount = true } label: {
                        CalmListRow(symbol: "person.crop.circle", title: "Account",
                                    meta: "Phone, sign-in and sign out", trailing: "chevron.right")
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("moreAccount")
                    Button { showSync = true } label: {
                        CalmListRow(symbol: "arrow.triangle.2.circlepath", title: "Sync",
                                    meta: model.syncStatus?.label ?? (model.isOffline ? "Offline" : "Not synced yet"),
                                    trailing: "chevron.right")
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("moreSync")
                    NavigationLink { SupportInfoScreen(model: model) } label: {
                        CalmListRow(symbol: "lifepreserver", title: "Support info",
                                    meta: "Details to send when something is wrong", trailing: "chevron.right")
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("moreSupport")
                }
                if features.contains(.storeGathering) || (model.supervisor && features.contains(.team)) {
                    SectionCard(title: "Tools") {
                        if features.contains(.storeGathering) {
                            NavigationLink { AddStoreScreen(model: model).fieldTabBarHidden() } label: {
                                CalmListRow(symbol: "plus.circle", title: "Add a store",
                                            meta: "A store that is not in the list yet", trailing: "chevron.right")
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("moreAddStore")
                        }
                        if model.supervisor && features.contains(.team) {
                            NavigationLink { TeamScreen(model: model) } label: {
                                CalmListRow(symbol: "person.2", title: "Your team today",
                                            meta: "Coverage and exceptions for your direct reports", trailing: "chevron.right")
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("moreTeam")
                        }
                    }
                }
            }
            .frame(maxWidth: 520, alignment: .leading)
            .padding(16)
            .frame(maxWidth: .infinity)
        }
        .background(SunprideTokens.background)
        .calmScreenChrome()
        .refreshable { await model.syncNow() }
        .sheet(isPresented: $showAccount) { AccountScreen(model: model) }
        .sheet(isPresented: $showSync) { SyncStatusDetail(model: model) }
    }
}
