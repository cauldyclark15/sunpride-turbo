import SwiftUI

enum StockSection: String, Hashable, CaseIterable, Identifiable {
    case onHand, transfers, counts
    var id: String { rawValue }
    var title: String {
        switch self {
        case .onHand: "Stock on hand"
        case .transfers: "Transfers"
        case .counts: "Counts to review"
        }
    }
    var symbol: String {
        switch self {
        case .onHand: "shippingbox"
        case .transfers: "arrow.left.arrow.right"
        case .counts: "list.clipboard"
        }
    }
}

struct StockScreen: View {
    @Environment(AppModel.self) private var model
    @State private var selection: StockSection?
    @State private var stock: Remote<Valuation>?
    @State private var locations: Remote<[InventoryLocation]>?

    var sections: [StockSection] {
        StockSection.allCases.filter { $0 != .counts || model.canReviewCounts }
    }

    var body: some View {
        AdaptiveSplit(selection: $selection, emptyTitle: "Choose what to look at", emptySymbol: "shippingbox") { sel in
            List(selection: sel) {
                if let v = stock?.value {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Stock value").font(.subheadline).foregroundStyle(.secondary)
                            Text(Format.peso(v.totals.costValueCentavos)).font(.largeTitle.weight(.bold)).monospacedDigit()
                            Text("At cost, across \(locations?.value?.count ?? 0) places · updated \(Format.time(ms: v.asOf))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 6)
                        .accessibilityElement(children: .combine)
                    }
                }
                Section {
                    ForEach(sections) { s in
                        NavigationLink(value: s) { Label(s.title, systemImage: s.symbol) }
                            .accessibilityIdentifier("stock.\(s.rawValue)")
                    }
                }
                if let places = locations?.value, !places.isEmpty {
                    Section("Places") {
                        ForEach(places) { p in
                            NavigationLink { OnHandView(location: p).padBarSpace() } label: {
                                LabeledContent(p.name, value: Format.words(p.type))
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Stock")
            .refreshable { await stock?.load(force: true); await locations?.load(force: true) }
        } detail: { section in
            switch section {
            case .onHand: OnHandView(location: nil)
            case .transfers: TransfersView()
            case .counts: CountsReviewView()
            }
        }
        .task {
            guard let api = model.api else { return }
            if stock == nil {
                let s = Remote { try await api.get("api/v1/inventory/valuation", query: ["basis": "cost", "groupBy": "product"], as: Valuation.self) }
                let l = Remote { try await api.get("api/v1/inventory/locations", as: [InventoryLocation].self) }
                stock = s; locations = l
                async let a: Void = s.load()
                async let b: Void = l.load()
                _ = await (a, b)
            }
        }
    }
}

/// Stock on hand by product, for everywhere or one place (`/api/v1/inventory/valuation`, cost basis).
struct OnHandView: View {
    let location: InventoryLocation?
    @Environment(AppModel.self) private var model
    @State private var remote: Remote<Valuation>?
    @State private var query = ""

    var body: some View {
        ZStack {
            Color.clear
            if let remote {
                RemoteView(remote, what: "stock") { v in
                    let rows = v.rows.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
                    List {
                        Section {
                            Fact("Value at cost", Format.peso(v.totals.costValueCentavos))
                            if let missing = v.totals.rowsWithoutCost, missing > 0 { Fact("Lines with no cost yet", "\(missing)") }
                        }
                        Section("\(rows.count) products") {
                            if rows.isEmpty { ContentUnavailableView.search }
                            ForEach(rows) { r in
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text(r.name)
                                        Spacer()
                                        Text(r.onHand.display).monospacedDigit().font(.subheadline.weight(.semibold))
                                    }
                                    HStack(spacing: 8) {
                                        if location == nil, let l = r.locationName { Text(l) }
                                        if let a = r.available, a.base != r.onHand.base { Text("· \(a.display) free") }
                                        if let d = r.damaged, d.base > 0 { Text("· \(d.display) damaged").foregroundStyle(Brand.watch) }
                                        Spacer()
                                        Text(Format.peso(r.costValueCentavos)).monospacedDigit()
                                    }
                                    .font(.caption).foregroundStyle(.secondary)
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                    .searchable(text: $query, prompt: "Product")
                }
                .refreshable { await remote.load(force: true) }
            }
        }
        .navigationTitle(location?.name ?? "Stock on hand")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if remote == nil, let api = model.api {
                let id = location?.id
                remote = Remote { try await api.get("api/v1/inventory/valuation", query: ["basis": "cost", "groupBy": "product", "locationId": id], as: Valuation.self) }
            }
        }
    }
}

struct TransfersView: View {
    @Environment(AppModel.self) private var model
    @State private var remote: Remote<TransferList>?

    var body: some View {
        ZStack {
            Color.clear
            if let remote {
                RemoteView(remote, what: "transfers") { list in
                    List {
                        if list.transfers.isEmpty {
                            ContentUnavailableView("No transfers", systemImage: "arrow.left.arrow.right",
                                                   description: Text("Stock moving between the depot, stores and vans shows up here."))
                                .listRowBackground(Color.clear)
                        }
                        ForEach(list.transfers) { t in
                            NavigationLink { TransferDetail(id: t.id, title: t.typeLabel ?? "Transfer").padBarSpace() } label: { TransferRow(t: t) }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
                .refreshable { await remote.load(force: true) }
            }
        }
        .navigationTitle("Transfers")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if remote == nil, let api = model.api {
                remote = Remote { try await api.get("api/v1/inventory/transfers/list", as: TransferList.self) }
            }
        }
    }
}

struct TransferRow: View {
    let t: TransferSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("\(t.source?.name ?? "—") → \(t.destination?.name ?? "—")").lineLimit(2)
                Spacer()
                StatusPill(status: t.status)
            }
            HStack {
                Text(t.typeLabel ?? "Transfer")
                if let n = t.lineCount { Text("· \(n) products") }
                Spacer()
                if let v = t.varianceValueCentavos, v != 0 { Text("Difference \(Format.peso(v))").foregroundStyle(Brand.watch) }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

struct TransferDetail: View {
    let id: String
    let title: String
    @Environment(AppModel.self) private var model
    @State private var remote: Remote<TransferSummary>?

    var body: some View {
        ZStack {
            Color.clear
            if let remote {
                RemoteView(remote, what: "this transfer") { t in
                    List {
                        Section {
                            Fact("From", t.source?.name ?? "—")
                            Fact("To", t.destination?.name ?? "—")
                            LabeledContent("Status") { StatusPill(status: t.status) }
                            if let n = t.number { Fact("Document", n) }
                            if let v = t.varianceValueCentavos, v != 0 { Fact("Difference", Format.peso(v)) }
                        }
                        if let lines = t.lines, !lines.isEmpty {
                            Section("Products") { ForEach(lines) { Text($0.label) } }
                        }
                        if t.status == "review_needed" {
                            Section { Label("The difference is decided in the Decide tab.", systemImage: "checkmark.seal") }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if remote == nil, let api = model.api {
                remote = Remote { try await api.get("api/v1/inventory/transfers/detail", query: ["id": id], as: TransferSummary.self) }
            }
        }
    }
}

/// Counts that are counted and waiting for a reviewer. Approving or sending back happens in Decide,
/// the one inbox for every approval (as on the web).
struct CountsReviewView: View {
    @Environment(AppModel.self) private var model
    @State private var remote: Remote<CountsMine>?

    var body: some View {
        ZStack {
            Color.clear
            if let remote {
                RemoteView(remote, what: "counts") { data in
                    List {
                        Section {
                            if data.toReview.isEmpty {
                                ContentUnavailableView("No counts waiting", systemImage: "list.clipboard",
                                                       description: Text("Submitted counts that need a reviewer show up here."))
                                    .listRowBackground(Color.clear)
                            }
                            ForEach(data.toReview) { c in
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(c.title ?? "Stock count").font(.body.weight(.medium))
                                        Spacer()
                                        StatusPill(status: c.status)
                                    }
                                    Text([c.location, c.scope].compactMap { $0 }.joined(separator: " · "))
                                        .font(.caption).foregroundStyle(.secondary)
                                    if let p = c.progress {
                                        Text("\(p.counted) of \(p.total) lines counted · \(p.needsReview ?? 0) with a difference")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    if let at = c.submittedAt { Text("Submitted \(Format.ago(at))").font(.caption).foregroundStyle(.secondary) }
                                }
                                .accessibilityElement(children: .combine)
                            }
                        } footer: {
                            if !data.toReview.isEmpty { Text("Approve a count or send it back for a recount in Decide.") }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
                .refreshable { await remote.load(force: true) }
            }
        }
        .navigationTitle("Counts to review")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if remote == nil, let api = model.api {
                remote = Remote { try await api.get("api/v1/inventory/counts/mine", as: CountsMine.self) }
            }
        }
    }
}
