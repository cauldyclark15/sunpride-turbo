import SwiftUI
import UIKit

enum OfficeTab: String, CaseIterable, Identifiable, Hashable {
    case today, decide, stores, stock, more
    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: "Today"
        case .decide: "Decide"
        case .stores: "Stores"
        case .stock: "Stock"
        case .more: "More"
        }
    }

    var symbol: String {
        switch self {
        case .today: "sun.max"
        case .decide: "checkmark.seal"
        case .stores: "storefront"
        case .stock: "shippingbox"
        case .more: "ellipsis.circle"
        }
    }

    var shortcut: KeyEquivalent {
        switch self {
        case .today: "1"
        case .decide: "2"
        case .stores: "3"
        case .stock: "4"
        case .more: "5"
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch model.state {
            case .misconfigured: MisconfiguredView()
            case .restoring: ProgressView("Opening Sunpride Office").task { await model.restore() }
            case .signedOut: SignInView()
            case .signedIn: MainTabs()
            }
        }
        .animation(.smooth, value: model.state)
    }
}

/// The five sections. iPhone: the system tab bar (Liquid Glass). iPad: the same five sections in a
/// bottom-anchored floating glass bar (jc: bottom navigation on every device), not the system's top bar.
struct MainTabs: View {
    @Environment(AppModel.self) private var model
    @State private var selection: OfficeTab = .today

    var tabs: [OfficeTab] {
        OfficeTab.allCases.filter { tab in
            switch tab {
            case .decide: model.canDecide
            case .stores: model.canReadReports
            case .stock: model.canReadStock
            default: true
            }
        }
    }

    var body: some View {
        Group {
            if UIDevice.current.userInterfaceIdiom == .pad {
                PadTabs(selection: $selection, tabs: tabs)
            } else {
                TabView(selection: $selection) {
                    ForEach(tabs) { tab in
                        Tab(tab.title, systemImage: tab.symbol, value: tab) {
                            TabContent(tab: tab)
                        }
                        .badge(tab == .decide ? model.decideOpen : 0)
                        .accessibilityIdentifier("tab.\(tab.rawValue)")
                    }
                }
            }
        }
        .onChange(of: selection) { Haptics.tap() }
    }
}

struct TabContent: View {
    let tab: OfficeTab
    var body: some View {
        switch tab {
        case .today: TodayScreen()
        case .decide: DecideScreen()
        case .stores: StoresScreen()
        case .stock: StockScreen()
        case .more: MoreScreen()
        }
    }
}

/// iPad: every section stays alive (scroll position and navigation kept, like system tabs), and the glass
/// bar floats above the home indicator. The bar's height is added to the content's safe area, so nothing
/// sits under it; it steps aside while the keyboard is up.
struct PadTabs: View {
    @Binding var selection: OfficeTab
    let tabs: [OfficeTab]
    @Environment(AppModel.self) private var model
    @State private var keyboardUp = false

    var body: some View {
        ZStack {
            ForEach(tabs) { tab in
                TabContent(tab: tab)
                    .opacity(selection == tab ? 1 : 0)
                    .allowsHitTesting(selection == tab)
                    .accessibilityHidden(selection != tab)
            }
        }
        // Every screen (roots and pushed details, which live in their own navigation controllers) reserves the
        // bar's height through `.padBarSpace()`, so content and bottom actions are never under the bar.
        .environment(\.padBarInset, keyboardUp ? 0 : GlassTabBar.reserve)
        .overlay(alignment: .bottom) {
            if !keyboardUp {
                GlassTabBar(selection: $selection, tabs: tabs, badges: [.decide: model.decideOpen])
                    .padding(.bottom, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            withAnimation(.smooth) { keyboardUp = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            withAnimation(.smooth) { keyboardUp = false }
        }
    }
}

/// A floating Liquid Glass tab bar: one glass capsule holding the sections, the selected one in a tinted glass
/// lens that morphs between items. Buttons are 44pt+ targets with pointer hover, ⌘1–⌘5 shortcuts,
/// VoiceOver tab traits and badges.
struct GlassTabBar: View {
    /// Height the bar takes above the home indicator (62pt bar + 8pt gap + breathing room).
    static let reserve: CGFloat = 76
    @Binding var selection: OfficeTab
    let tabs: [OfficeTab]
    let badges: [OfficeTab: Int]
    @Namespace private var glass
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        GlassEffectContainer(spacing: 12) {
            HStack(spacing: 4) {
                ForEach(tabs) { tab in
                    let selected = selection == tab
                    Button {
                        withAnimation(.bouncy(duration: 0.35)) { selection = tab }
                    } label: {
                        VStack(spacing: 2) {
                            Image(systemName: tab.symbol)
                                .symbolVariant(selected ? .fill : .none)
                                .font(.system(size: 20, weight: .medium))
                                .frame(height: 24)
                                .overlay(alignment: .topTrailing) {
                                    if let n = badges[tab], n > 0 {
                                        Text(n > 99 ? "99+" : "\(n)")
                                            .font(.caption2.weight(.bold)).monospacedDigit()
                                            .foregroundStyle(.white)
                                            .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18)
                                            .background(Brand.red, in: .capsule)
                                            .offset(x: 12, y: -6)
                                            .accessibilityHidden(true)
                                    }
                                }
                            if !typeSize.isAccessibilitySize {
                                Text(tab.title).font(.caption.weight(selected ? .semibold : .medium))
                            }
                        }
                        .foregroundStyle(selected ? Brand.tint : Color.primary)
                        .frame(minWidth: 84, minHeight: 50)
                        .padding(.horizontal, 6)
                        .contentShape(.capsule)
                        .background {
                            if selected {
                                Capsule().fill(.clear)
                                    .glassEffect(.regular.tint(Brand.tint.opacity(0.14)).interactive(), in: .capsule)
                                    .glassEffectID("selection", in: glass)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .hoverEffect(.highlight)
                    .keyboardShortcut(tab.shortcut, modifiers: .command)
                    .accessibilityLabel(tab.title)
                    .accessibilityValue(badges[tab].map { $0 > 0 ? "\($0) waiting" : "" } ?? "")
                    .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
                    .accessibilityIdentifier("tab.\(tab.rawValue)")
                }
            }
            .padding(6)
            .glassEffect(.regular.interactive(), in: .capsule)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sections")
        .accessibilityIdentifier("padTabBar")
    }
}

extension EnvironmentValues {
    /// The iPad floating tab bar's height (0 on iPhone, where the system tab bar owns its safe area).
    @Entry var padBarInset: CGFloat = 0
}

struct PadBarSpace: ViewModifier {
    @Environment(\.padBarInset) private var inset
    func body(content: Content) -> some View { content.safeAreaPadding(.bottom, inset) }
}

extension View {
    /// Keep content and bottom actions clear of the iPad glass tab bar.
    func padBarSpace() -> some View { modifier(PadBarSpace()) }
}

/// List + detail that fits the space: two columns on a landscape iPad (NavigationSplitView), a pushed
/// detail everywhere else (iPhone, iPad portrait). Lists are `List(selection:)` with `NavigationLink(value:)`
/// rows: in two columns the selection drives the detail column; in one column choosing a row pushes it.
struct AdaptiveSplit<ID: Hashable, ListContent: View, Detail: View>: View {
    @Binding var selection: ID?
    let emptyTitle: String
    let emptySymbol: String
    /// Bump to return a one-column stack to its list (e.g. after a decision).
    var popSignal: Int = 0
    @ViewBuilder let list: (Binding<ID?>) -> ListContent
    @ViewBuilder let detail: (ID) -> Detail
    @Environment(\.horizontalSizeClass) private var hSize
    @State private var path: [ID] = []

    var body: some View {
        GeometryReader { geo in
            if hSize == .regular && geo.size.width > geo.size.height {
                NavigationSplitView {
                    list($selection).padBarSpace().navigationSplitViewColumnWidth(min: 320, ideal: 380, max: 460)
                } detail: {
                    NavigationStack {
                        if let selection { detail(selection).id(selection).padBarSpace() } else {
                            ContentUnavailableView(emptyTitle, systemImage: emptySymbol).padBarSpace()
                        }
                    }
                }
                .navigationSplitViewStyle(.balanced)
            } else {
                NavigationStack(path: $path) {
                    list(Binding(get: { nil }, set: { if let id = $0 { path.append(id) } }))
                        .padBarSpace()
                        .navigationDestination(for: ID.self) { detail($0).padBarSpace() }
                }
                .onChange(of: popSignal) { path.removeAll() }
            }
        }
    }
}
