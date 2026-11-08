import MapKit
import SwiftUI

/// Every verified store pin the person may see (`/api/v1/location/store-pins`, 100 per page), loaded once.
@MainActor @Observable
final class PinBook {
    private(set) var pins: [String: StorePins.Pin] = [:]
    private(set) var loaded = false
    private var task: Task<Void, Never>?

    func load(api: APIClient) async {
        if loaded { return }
        if let task { return await task.value }
        let t = Task {
            var cursor: String?
            var all: [String: StorePins.Pin] = [:]
            repeat {
                guard let page = try? await api.get("api/v1/location/store-pins", query: ["cursor": cursor], as: StorePins.self) else { break }
                for p in page.items { all[p.outletId] = p }
                cursor = page.nextCursor
            } while cursor != nil && all.count < 20_000
            pins = all
            loaded = true
        }
        task = t
        await t.value
    }
}

struct StoresScreen: View {
    @Environment(AppModel.self) private var model
    @State private var selection: String?
    @State private var query = ""
    @State private var status: String?
    @State private var pages = StorePages()
    @State private var pinBook = PinBook()
    @State private var gathering: Remote<CensusQueue>?

    var body: some View {
        AdaptiveSplit(selection: $selection, emptyTitle: "Choose a store", emptySymbol: "storefront") { sel in
            StoresList(pages: pages, selection: sel, status: $status, pinBook: pinBook, gathering: gathering)
                .navigationTitle("Stores")
                .searchable(text: $query, prompt: "Store name")
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Picker("Show", selection: $status) {
                                Text("All stores").tag(String?.none)
                                Text("Buying").tag(Optional("active"))
                                Text("New").tag(Optional("new"))
                                Text("Gone quiet").tag(Optional("dormant"))
                                Text("Lost").tag(Optional("lost"))
                            }
                        } label: {
                            Label("Show", systemImage: status == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                        }
                    }
                }
                .refreshable { await pages.reload(api: model.api, query: query, status: status) }
        } detail: { id in
            StoreDetail(storeId: id, pinBook: pinBook)
        }
        .task(id: "\(query)|\(status ?? "")") {
            try? await Task.sleep(for: .milliseconds(query.isEmpty ? 0 : 300))
            guard !Task.isCancelled else { return }
            await pages.reload(api: model.api, query: query, status: status)
        }
        .task {
            if let api = model.api {
                if model.canLocations { await pinBook.load(api: api) }
                if model.canReviewGathering, gathering == nil {
                    let g = Remote { try await api.get("api/v1/masters/census-queue", as: CensusQueue.self) }
                    gathering = g
                    await g.load()
                }
            }
        }
    }
}

/// Server-side search and paging over `/api/v1/analytics/stores` (`q`, `status`, `cursor`).
@MainActor @Observable
final class StorePages {
    private(set) var first: StoresResponse?
    private(set) var rows: [StoresResponse.Row] = []
    private(set) var next: String?
    private(set) var error: OfficeError?
    private(set) var loading = false
    private var generation = 0
    private var lastQuery: [String: String?] = [:]

    func reload(api: APIClient?, query: String, status: String?) async {
        guard let api else { return }
        generation += 1
        let g = generation
        loading = true
        lastQuery = ["q": query.trimmingCharacters(in: .whitespaces), "status": status]
        do {
            let page = try await api.get("api/v1/analytics/stores", query: lastQuery, as: StoresResponse.self)
            guard g == generation else { return }
            first = page; rows = page.rows; next = page.next; error = nil
        } catch let e as OfficeError {
            if g == generation { error = e }
        } catch {}
        if g == generation { loading = false }
    }

    func more(api: APIClient?) async {
        guard let api, let cursor = next, !loading else { return }
        loading = true
        var q = lastQuery
        q["cursor"] = cursor
        if let page = try? await api.get("api/v1/analytics/stores", query: q, as: StoresResponse.self) {
            rows += page.rows.filter { r in !rows.contains(where: { $0.storeId == r.storeId }) }
            next = page.next
        }
        loading = false
    }
}

struct StoresList: View {
    let pages: StorePages
    @Binding var selection: String?
    @Binding var status: String?
    let pinBook: PinBook
    let gathering: Remote<CensusQueue>?
    @Environment(AppModel.self) private var model

    var body: some View {
        if pages.first == nil, let error = pages.error {
            ProblemView(error: error, what: "stores") { Task { await pages.reload(api: model.api, query: "", status: status) } }
        } else if pages.first == nil {
            SkeletonList().redacted(reason: .placeholder)
        } else {
            List(selection: $selection) {
                if let first = pages.first {
                    Section {
                        KpiGrid(kpis: Array(first.kpis.prefix(4)))
                            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                            .listRowBackground(Color.clear)
                    }
                    if model.canLocations, pinBook.loaded, let universe = first.kpis.first(where: { $0.key == "universe" })?.value, universe > 0 {
                        Section("Location coverage") {
                            let pinned = Double(pinBook.pins.count)
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text("\(Format.count(pinned)) of \(Format.count(universe)) stores have a checked map pin")
                                    Spacer()
                                    Text(Format.pct(min(100, pinned / universe * 100))).monospacedDigit().foregroundStyle(.secondary)
                                }
                                ProgressView(value: min(1, pinned / universe)).tint(Brand.tint)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                    if let q = gathering?.value, !q.rows.isEmpty {
                        Section {
                            NavigationLink {
                                GatheringReview(queue: q) { Task { await gathering?.load(force: true) } }.padBarSpace()
                            } label: {
                                Label("\(q.rows.count) new stores to review", systemImage: "mappin.and.ellipse")
                            }
                        } header: { Text("Store gathering") }
                    }
                }
                Section {
                    if pages.rows.isEmpty {
                        ContentUnavailableView.search
                    }
                    ForEach(pages.rows) { row in
                        NavigationLink(value: row.storeId) { StoreRow(row: row) }
                            .accessibilityIdentifier("store.row")
                            .onAppear { if row.storeId == pages.rows.last?.storeId { Task { await pages.more(api: model.api) } } }
                    }
                    if pages.next != nil {
                        HStack { Spacer(); ProgressView(); Spacer() }
                    }
                } header: {
                    Text(status.map { "\(Format.words($0)) stores" } ?? "All stores")
                }
            }
            .listStyle(.insetGrouped)
        }
    }
}

struct StoreRow: View {
    let row: StoresResponse.Row
    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                Text(row.name).font(.body)
                Text([row.territory, row.lastOrderAt.map { "last order \(Format.ago($0))" }].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                Text(Format.peso(row.salesPeriod)).monospacedDigit().font(.subheadline.weight(.medium))
                StatusPill(storeStatus, tone: Tone.of(row.status))
            }
        }
        .accessibilityElement(children: .combine)
    }

    var storeStatus: String {
        switch row.status {
        case "active": "Buying"
        case "dormant": "Gone quiet"
        default: Format.words(row.status)
        }
    }
}

struct StoreDetail: View {
    let storeId: String
    let pinBook: PinBook
    @Environment(AppModel.self) private var model
    @State private var remote: Remote<StoreResponse>?

    var body: some View {
        // Read the pin here so this view follows the pin book as it fills in.
        let pin = pinBook.pins[storeId]
        ZStack {
            Color.clear
            if let remote {
                RemoteView(remote, what: "this store") { data in StoreDetailContent(data: data, pin: pin) }
                    .refreshable { await remote.load(force: true) }
            }
        }
        .navigationTitle(remote?.value?.store.name ?? "Store")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if remote == nil, let api = model.api {
                remote = Remote { try await api.get("api/v1/analytics/store", query: ["storeId": storeId], as: StoreResponse.self) }
            }
        }
        .task { if let api = model.api, model.canLocations { await pinBook.load(api: api) } }
    }
}

struct StoreDetailContent: View {
    let data: StoreResponse
    let pin: StorePins.Pin?
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(data.store.name).font(.title2.weight(.bold)).accessibilityIdentifier("store.name")
                    if let a = data.store.address { Text(a).font(.subheadline).foregroundStyle(.secondary) }
                    HStack(spacing: 8) {
                        if let t = data.store.territory { Text(t) }
                        if let c = data.store.channel { Text("· \(Format.words(c))") }
                        if let cls = data.context?.classification?.label { Text("· \(cls)") }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }
            Section {
                if let pin {
                    let coordinate = CLLocationCoordinate2D(latitude: pin.latitude, longitude: pin.longitude)
                    Map(initialPosition: .region(MKCoordinateRegion(center: coordinate, latitudinalMeters: 600, longitudinalMeters: 600))) {
                        Marker(data.store.name, systemImage: "storefront", coordinate: coordinate).tint(Brand.red)
                    }
                    .frame(height: 220)
                    .clipShape(.rect(cornerRadius: 14, style: .continuous))
                    .listRowInsets(EdgeInsets())
                    .accessibilityLabel("Map with the store's pin")
                    .accessibilityIdentifier("store.map")
                    Button {
                        let item = MKMapItem(location: CLLocation(latitude: pin.latitude, longitude: pin.longitude), address: nil)
                        item.name = data.store.name
                        item.openInMaps()
                    } label: { Label("Open in Maps", systemImage: "map") }
                } else if model.canLocations {
                    Label("No checked map pin for this store yet.", systemImage: "mappin.slash")
                        .foregroundStyle(.secondary)
                } else {
                    Label("Store locations are not shared with your account.", systemImage: "lock")
                        .foregroundStyle(.secondary)
                }
            } header: { Text("Location") }

            Section {
                KpiGrid(kpis: data.kpis)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                    .listRowBackground(Color.clear)
            }
            if let c = data.context?.coverage {
                Section("Visits this period") {
                    Fact("Planned", "\(c.planned ?? 0)")
                    Fact("Visited", "\(c.visited ?? 0)")
                    Fact("Missed", "\(c.missed ?? 0)")
                }
            }
            if !data.salesTrend.isEmpty {
                Section("Weekly sales") {
                    TrendBars(points: data.salesTrend.map { (label: $0.weekStart, value: $0.sales, target: nil) })
                        .padding(.vertical, 6)
                }
            }
            if !data.orders.isEmpty {
                Section("Recent orders") {
                    ForEach(data.orders.prefix(8)) { o in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(Format.dayTime(ms: o.at)).font(.subheadline)
                                Text("\(o.lines ?? 0) lines").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing) {
                                Text(Format.peso(o.totalCentavos)).monospacedDigit()
                                StatusPill(status: o.status)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            if !data.visits.isEmpty {
                Section("Recent visits") {
                    ForEach(data.visits.prefix(8)) { v in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(Format.dayTime(ms: v.at)).font(.subheadline)
                                Text(v.agent ?? "").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            StatusPill(v.productive == true ? "Productive" : "No order", tone: v.productive == true ? .good : .neutral)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            if let items = data.assortment, !items.isEmpty {
                let missing = items.filter { $0.onShelf == false }
                Section("Products") {
                    Fact("On the shelf", "\(items.count - missing.count) of \(items.count)")
                    ForEach(missing.prefix(10)) { Text($0.name).foregroundStyle(Brand.watch) }
                }
            }
            Section { FreshnessFooter(asOf: data.freshness.asOf).listRowBackground(Color.clear) }
        }
        .listStyle(.insetGrouped)
    }
}

/// New stores gathered in the field, waiting for an office decision (same command as the web review).
struct GatheringReview: View {
    let queue: CensusQueue
    let onChange: () -> Void
    @Environment(AppModel.self) private var model
    @State private var open: CensusQueue.Capture?

    var body: some View {
        List {
            if !queue.batches.isEmpty {
                Section("Gathering rounds") {
                    ForEach(queue.batches) { b in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(b.name)
                            Text("\(b.accepted ?? 0) accepted · \(b.pending ?? 0) waiting · \(Format.pct(b.coveragePct)) of target \(Format.pct(b.targetPct))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Section("Waiting for review") {
                ForEach(queue.rows) { row in
                    Button { open = row } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(row.name).foregroundStyle(.primary)
                            Text([row.address, row.agent.map { "by \($0)" }].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("Store gathering")
        .sheet(item: $open) { capture in
            GatheringDecision(capture: capture) { open = nil; onChange() }.presentationDetents([.medium, .large])
        }
    }
}

struct GatheringDecision: View {
    let capture: CensusQueue.Capture
    let onDone: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var decision = "accept"
    @State private var code = ""
    @State private var reason = ""
    @State private var busy = false
    @State private var error: String?
    @State private var key = UUID().uuidString.lowercased()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Fact("Store", capture.name)
                    if let a = capture.address { Fact("Address", a) }
                    if let o = capture.owner_name { Fact("Owner", o) }
                    if let c = capture.estimated_class { Fact("Looks like", c) }
                    if let m = capture.accuracy_meters { Fact("Location accuracy", "\(Int(m)) m") }
                }
                Picker("Decision", selection: $decision) {
                    Text("Accept as new store").tag("accept")
                    Text("Reject").tag("reject")
                }
                .pickerStyle(.segmented)
                if decision == "accept" {
                    TextField("New store code", text: $code).textInputAutocapitalization(.characters)
                }
                TextField(decision == "reject" ? "Why reject it?" : "Note (optional)", text: $reason, axis: .vertical)
                if let error { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(Brand.bad) }
            }
            .navigationTitle("Review new store")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(busy || (decision == "accept" && code.isEmpty) || (decision == "reject" && reason.count < 3))
                }
            }
        }
    }

    private func save() {
        guard let api = model.api else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                struct Ok: Decodable {}
                _ = try await api.post("api/v1/masters/census/review", body: [
                    "captureId": capture.id, "decision": decision, "code": code, "outletId": NSNull(), "reason": reason,
                ], idempotencyKey: key, as: Ok.self)
                Haptics.success()
                onDone()
            } catch let e as OfficeError { error = e.localizedDescription } catch {}
        }
    }
}
