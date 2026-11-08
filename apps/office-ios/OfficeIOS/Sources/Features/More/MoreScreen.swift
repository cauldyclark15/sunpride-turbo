import SwiftUI

enum MoreItem: String, Hashable, CaseIterable, Identifiable {
    case sales, vans, money, coverage, storesPOS, issues, account
    var id: String { rawValue }
    var title: String {
        switch self {
        case .sales: "Sales & targets"
        case .vans: "Vans & cash"
        case .money: "Money"
        case .coverage: "Coverage & people"
        case .storesPOS: "Stores POS"
        case .issues: "Issues"
        case .account: "Account"
        }
    }
    var symbol: String {
        switch self {
        case .sales: "chart.line.uptrend.xyaxis"
        case .vans: "truck.box"
        case .money: "pesosign.circle"
        case .coverage: "person.2"
        case .storesPOS: "cart"
        case .issues: "exclamationmark.bubble"
        case .account: "person.crop.circle"
        }
    }
    var subtitle: String {
        switch self {
        case .sales: "Sales against target by channel"
        case .vans: "Trips, sales and cash handed in"
        case .money: "What customers owe and how old it is"
        case .coverage: "Planned calls done, productive calls"
        case .storesPOS: "Registers, X / Z readings, receipts"
        case .issues: "Problems reported to the team"
        case .account: "Your sign-in"
        }
    }
}

struct MoreScreen: View {
    @Environment(AppModel.self) private var model
    @State private var selection: MoreItem?

    var items: [MoreItem] {
        MoreItem.allCases.filter {
            switch $0 {
            case .sales, .vans, .money, .coverage: model.canReadReports
            case .storesPOS: model.canStorePOS
            case .issues: model.canIssues
            case .account: true
            }
        }
    }

    var body: some View {
        AdaptiveSplit(selection: $selection, emptyTitle: "Choose a report", emptySymbol: "square.grid.2x2") { sel in
            List(selection: sel) {
                Section {
                    ForEach(items.filter { $0 != .account }) { item in
                        NavigationLink(value: item) {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.title)
                                    Text(item.subtitle).font(.caption).foregroundStyle(.secondary)
                                }
                            } icon: { Image(systemName: item.symbol).foregroundStyle(Brand.tint) }
                        }
                        .accessibilityIdentifier("more.\(item.rawValue)")
                    }
                }
                Section {
                    NavigationLink(value: MoreItem.account) {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(model.name)
                                Text(model.role).font(.caption).foregroundStyle(.secondary)
                            }
                        } icon: { Image(systemName: "person.crop.circle.fill").foregroundStyle(Brand.tint) }
                    }
                    .accessibilityIdentifier("more.account")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("More")
        } detail: { item in
            switch item {
            case .sales: SalesView()
            case .vans: VansView()
            case .money: MoneyView()
            case .coverage: CoverageView()
            case .storesPOS: StorePOSView()
            case .issues: IssuesView()
            case .account: AccountView()
            }
        }
    }
}

/// A report screen backed by one endpoint, with the shared loading/empty/error states.
struct Report<Value: Decodable & Sendable, Content: View>: View {
    let title: String
    let path: String
    var query: [String: String?] = [:]
    @ViewBuilder let content: (Value) -> Content
    @Environment(AppModel.self) private var model
    @State private var remote: Remote<Value>?

    var body: some View {
        ZStack {
            Color.clear
            if let remote {
                RemoteView(remote, what: title.lowercased()) { v in content(v) }
                    .refreshable { await remote.load(force: true) }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if remote == nil, let api = model.api {
                let path = path, query = query
                remote = Remote { try await api.get(path, query: query, as: Value.self) }
            }
        }
    }
}

struct KpiSection: View {
    let kpis: [Kpi]
    var body: some View {
        Section {
            KpiGrid(kpis: kpis)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                .listRowBackground(Color.clear)
        }
    }
}

struct SalesView: View {
    var body: some View {
        Report(title: "Sales & targets", path: "api/v1/analytics/sales") { (d: SalesResponse) in
            List {
                Section {
                    Text("\(Format.day(iso: d.period.from)) – \(Format.day(iso: d.period.to))")
                        .font(.subheadline).foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 0))
                }
                KpiSection(kpis: d.kpis)
                Section("By channel") {
                    ForEach(d.rows) { r in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(Format.words(r.label)).font(.body.weight(.medium))
                                Spacer()
                                Text(Format.peso(r.sales)).monospacedDigit()
                            }
                            if let a = r.attainmentPct {
                                ProgressView(value: min(1, max(0, a / 100))).tint(Tone.of(r.status).color)
                            }
                            HStack {
                                Text("Target \(Format.peso(r.target))")
                                Spacer()
                                Text("\(Format.pct(r.attainmentPct)) of target")
                                if let delta = Format.delta(r.deltaPct) { Text("· \(delta) vs before") }
                            }
                            .font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                        .accessibilityElement(children: .combine)
                    }
                }
                Section { FreshnessFooter(asOf: d.freshness.asOf, scope: d.scope.label).listRowBackground(Color.clear) }
            }
            .listStyle(.insetGrouped)
        }
    }
}

struct VansView: View {
    var body: some View {
        Report(title: "Vans & cash", path: "api/v1/analytics/vans") { (d: VansResponse) in
            List {
                KpiSection(kpis: d.kpis)
                Section("Trips") {
                    if d.rows.isEmpty { Text("No van trips in this period.").foregroundStyle(.secondary) }
                    ForEach(d.rows) { r in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(r.truck ?? "Van").font(.body.weight(.medium))
                                Spacer()
                                StatusPill(status: r.status)
                            }
                            Text([r.seller, r.closedAt.map { "closed \(Format.dayTime(ms: $0))" }].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                            HStack {
                                Text("Sold \(Format.peso(r.salesCentavos))")
                                Spacer()
                                Text("Cash in \(Format.peso(r.cashRemitted))")
                                if let v = r.variance, v != 0 {
                                    Text("· short \(Format.peso(abs(v)))").foregroundStyle(Brand.bad)
                                }
                            }
                            .font(.subheadline).monospacedDigit()
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                Section { FreshnessFooter(asOf: d.freshness.asOf, scope: d.scope.label).listRowBackground(Color.clear) }
            }
            .listStyle(.insetGrouped)
        }
    }
}

struct MoneyView: View {
    var body: some View {
        Report(title: "Money", path: "api/v1/analytics/money") { (d: MoneyResponse) in
            List {
                KpiSection(kpis: d.kpis)
                Section("How old the balances are") {
                    Fact("Not yet due", Format.peso(d.aging.current))
                    Fact("1–30 days late", Format.peso(d.aging.d1_30))
                    Fact("31–60 days late", Format.peso(d.aging.d31_60))
                    Fact("61–90 days late", Format.peso(d.aging.d61_90))
                    Fact("Over 90 days late", Format.peso(d.aging.d90p))
                }
                Section("Customers who owe the most") {
                    ForEach(d.rows.sorted { $0.balance > $1.balance }.prefix(30)) { r in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(r.name)
                                Text(r.creditLimit.map { "limit \(Format.peso($0))" } ?? "no credit limit")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(Format.peso(r.balance)).monospacedDigit()
                                if let limit = r.creditLimit, r.balance > limit { StatusPill("Over limit", tone: .bad) }
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                Section { FreshnessFooter(asOf: d.freshness.asOf, scope: d.scope.label).listRowBackground(Color.clear) }
            }
            .listStyle(.insetGrouped)
        }
    }
}

struct CoverageView: View {
    var body: some View {
        Report(title: "Coverage & people", path: "api/v1/analytics/coverage") { (d: CoverageResponse) in
            List {
                KpiSection(kpis: Array(d.kpis.prefix(8)))
                Section("People") {
                    ForEach(d.rows) { r in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(r.label).font(.body.weight(.medium))
                                Spacer()
                                StatusPill(status: r.status)
                            }
                            ProgressView(value: min(1, max(0, (r.compliancePct ?? 0) / 100))).tint(Tone.of(r.status).color)
                            Text("\(r.visited ?? 0) of \(r.planned ?? 0) planned calls · \(Format.pct(r.productiveCallPct)) productive · \(r.missed ?? 0) missed")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                Section { FreshnessFooter(asOf: d.freshness.asOf, scope: d.scope.label).listRowBackground(Color.clear) }
            }
            .listStyle(.insetGrouped)
        }
    }
}

/// Registers and till days, X / Z readings and receipts for the stores that run a till (read-only here).
struct StorePOSView: View {
    @Environment(AppModel.self) private var model
    @State private var part = 0

    var body: some View {
        VStack(spacing: 0) {
            Picker("Show", selection: $part) {
                Text("Registers").tag(0)
                Text("X / Z readings").tag(1)
                Text("Receipts").tag(2)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal).padding(.vertical, 8)
            switch part {
            case 0: RegistersPart()
            case 1: ZPart()
            default: ReceiptsPart()
            }
        }
        .navigationTitle("Stores POS")
        .navigationBarTitleDisplayMode(.inline)
        .background(Color(.systemGroupedBackground))
    }
}

struct RegistersPart: View {
    @Environment(AppModel.self) private var model
    @State private var workspace: Remote<StorePOSWorkspace>?
    @State private var days: Remote<TillDays>?

    var body: some View {
        ZStack {
            Color.clear
            if let workspace, let days {
                RemoteView(workspace, what: "registers") { w in
                    List {
                        Section("Registers") {
                            if w.registers.isEmpty { Text("No registers set up.").foregroundStyle(.secondary) }
                            ForEach(w.registers) { r in LabeledContent(r.name, value: r.store_name ?? "") }
                        }
                        Section("Till days this week") {
                            if let d = days.value {
                                if d.days.isEmpty { Text("No till days this week.").foregroundStyle(.secondary) }
                                ForEach(d.days) { day in
                                    HStack {
                                        VStack(alignment: .leading) {
                                            Text("\(day.registerName ?? "Register") · \(Format.day(iso: day.businessDate))")
                                            Text(day.storeName ?? "").font(.caption).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        VStack(alignment: .trailing) {
                                            Text(Format.peso(day.netSalesCentavos?.value)).monospacedDigit()
                                            StatusPill(status: day.status)
                                        }
                                    }
                                    .accessibilityElement(children: .combine)
                                }
                            } else { ProgressView() }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
                .refreshable { await workspace.load(force: true); await days.load(force: true) }
                .task { await days.load() }
            }
        }
        .onAppear {
            if workspace == nil, let api = model.api {
                workspace = Remote { try await api.get("api/v1/storepos/workspace", as: StorePOSWorkspace.self) }
                days = Remote { try await api.get("api/v1/storepos/days", as: TillDays.self) }
            }
        }
    }
}

struct ZPart: View {
    @Environment(AppModel.self) private var model
    @State private var remote: Remote<ZReadings>?
    var body: some View {
        ZStack {
            Color.clear
            if let remote {
                RemoteView(remote, what: "readings") { z in
                    List {
                        let all = z.readings + z.legacy
                        if all.isEmpty {
                            ContentUnavailableView("No Z readings yet", systemImage: "doc.text",
                                                   description: Text("End-of-day readings show up here after a till closes its day."))
                                .listRowBackground(Color.clear)
                        }
                        ForEach(all) { r in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text("Z \(r.zCounter.map(String.init) ?? "") · \(Format.day(iso: r.businessDate))")
                                    if let doc = r.docNumber { Text(doc).font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer()
                                Text(Format.peso(r.netSalesCentavos?.value)).monospacedDigit()
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
                .refreshable { await remote.load(force: true) }
            }
        }
        .onAppear {
            if remote == nil, let api = model.api {
                remote = Remote { try await api.get("api/v1/storepos/z-readings", as: ZReadings.self) }
            }
        }
    }
}

struct ReceiptsPart: View {
    @Environment(AppModel.self) private var model
    @State private var remote: Remote<ReceiptsList>?
    var body: some View {
        ZStack {
            Color.clear
            if let remote {
                RemoteView(remote, what: "receipts") { list in
                    List {
                        if list.receipts.isEmpty {
                            ContentUnavailableView("No receipts yet", systemImage: "receipt",
                                                   description: Text("Receipts printed at the stores' tills show up here."))
                                .listRowBackground(Color.clear)
                        }
                        ForEach(list.receipts) { r in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(r.documentNumber ?? "Receipt")
                                    Text(r.buyerName ?? "Walk-in").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                VStack(alignment: .trailing) {
                                    Text(Format.peso(r.totalDueMinor?.value, cents: true)).monospacedDigit()
                                    if r.voided == true { StatusPill("Voided", tone: .bad) }
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
                .refreshable { await remote.load(force: true) }
            }
        }
        .onAppear {
            if remote == nil, let api = model.api {
                remote = Remote { try await api.get("api/v1/fiscal/receipts", as: ReceiptsList.self) }
            }
        }
    }
}

struct IssuesView: View {
    var body: some View {
        Report(title: "Issues", path: "api/v1/issues/board") { (b: IssuesBoard) in
            List {
                if let s = b.summary {
                    Section {
                        Fact("Open", "\(s.open)")
                        Fact("Urgent", "\(s.urgent)")
                        Fact("Nobody on it yet", "\(s.unassigned)")
                        Fact("Ready to check again", "\(s.readyForRetest)")
                        Fact("Fixed this week", "\(s.completedThisWeek)")
                    }
                }
                Section("Latest") {
                    if b.issues.isEmpty {
                        ContentUnavailableView("No issues", systemImage: "checkmark.bubble",
                                               description: Text("Problems reported to the team show up here."))
                            .listRowBackground(Color.clear)
                    }
                    ForEach(b.issues.prefix(50)) { i in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(i.title).font(.body.weight(.medium))
                                Spacer()
                                StatusPill(status: i.status)
                            }
                            Text([i.assigneeName.map { "with \($0)" } ?? "nobody on it yet", i.updatedAt.map { "updated \(Format.ago($0))" }]
                                .compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .listStyle(.insetGrouped)
        }
    }
}

struct AccountView: View {
    @Environment(AppModel.self) private var model
    @State private var confirm = false

    var body: some View {
        List {
            Section {
                Fact("Name", model.name)
                Fact("Email", model.email)
                Fact("Role", model.role)
            }
            Section {
                Fact("App version", Bundle.main.object(forInfoDictionaryKey: "OFFICE_VERSION_LABEL") as? String ?? "")
                Fact("Server", model.api?.origin.host() ?? "")
            }
            Section {
                Button("Sign out", role: .destructive) { confirm = true }
                    .accessibilityIdentifier("account.signout")
            } footer: {
                Text("Signing out removes your sign-in from this device.")
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Sign out of Sunpride Office?", isPresented: $confirm, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await model.signOut() } }
        }
    }
}
