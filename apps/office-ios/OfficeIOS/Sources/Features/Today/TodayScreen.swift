import SwiftUI

/// The owner's day: the web Today page's figures (sales against target, coverage, collections, vans),
/// what needs attention first, the field team's state and the vans on the road.
struct TodayScreen: View {
    @Environment(AppModel.self) private var model
    @State private var remote: Remote<TodayResponse>?

    var subtitle: String {
        let day = Format.day(.now)
        guard let scope = remote?.value?.scope.label else { return day }
        return "\(day) · \(scope)"
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.clear
                if let remote {
                    RemoteView(remote, what: "today's figures") { data in TodayContent(data: data) }
                        .refreshable { await remote.load(force: true); await model.refreshBadge() }
                }
            }
            .padBarSpace()
            .navigationTitle("Today")
            .navigationSubtitle(subtitle)
        }
        .onAppear {
            if remote == nil, let api = model.api {
                remote = Remote { try await api.get("api/v1/analytics/today", as: TodayResponse.self) }
            }
        }
    }
}

struct TodayContent: View {
    let data: TodayResponse
    @Environment(\.horizontalSizeClass) private var hSize

    var body: some View {
        List {
            Section {
                KpiGrid(kpis: data.kpis)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                .listRowBackground(Color.clear)
            }

            Section {
                if data.exceptions.isEmpty {
                    Label("Nothing needs you right now.", systemImage: "checkmark.circle")
                        .foregroundStyle(Brand.good)
                } else {
                    ForEach(data.exceptions.prefix(hSize == .regular ? 8 : 5)) { ExceptionRow(item: $0) }
                }
            } header: {
                Text("Needs attention")
            }

            if hSize == .regular {
                Section("Sales, last two weeks") { SalesTrend(points: data.trend) }
            }

            Section {
                FieldSummary(counts: data.field.counts)
                ForEach(data.field.people.prefix(hSize == .regular ? 12 : 6)) { PersonRow(person: $0) }
            } header: {
                Text("People in the field")
            } footer: {
                if data.field.people.count > 6, hSize != .regular {
                    Text("\(data.field.people.count) people in your area. See them all in More → Coverage & people.")
                }
            }

            if !data.vans.isEmpty {
                Section("Vans on the road") { ForEach(data.vans) { VanRow(van: $0) } }
            }

            if hSize != .regular {
                Section("Sales, last two weeks") { SalesTrend(points: data.trend) }
            }

            Section {
                FreshnessFooter(asOf: data.freshness.asOf, scope: data.scope.label, demo: data.demo == true)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.horizontal, hSize == .regular ? 24 : 16, for: .scrollContent)
    }
}

struct ExceptionRow: View {
    let item: ExceptionItem
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(item.title).font(.body.weight(.medium))
                Spacer(minLength: 8)
                StatusPill(severityWord, tone: Tone.of(item.severity))
            }
            if let detail = item.detail { Text(detail).font(.subheadline).foregroundStyle(.secondary) }
            HStack(spacing: 6) {
                if let owner = item.owner?.name { Label(owner, systemImage: "person").labelStyle(.titleOnly) }
                if item.openedAt != nil { Text("· open \(Format.age(since: item.openedAt))") }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    var severityWord: String {
        switch item.severity {
        case "high": "Urgent"
        case "medium": "Soon"
        default: "When you can"
        }
    }
}

struct FieldSummary: View {
    let counts: TodayResponse.Field.Counts
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 0) { cells }
            VStack(alignment: .leading, spacing: 8) { cells }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder var cells: some View {
        cell("In a call", counts.inCall, Brand.good)
        cell("Done", counts.done, .primary)
        cell("Not started", counts.notStarted, Brand.watch)
        cell("No plan", counts.noPlan, .secondary)
    }

    func cell(_ label: String, _ value: Int, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(value)").font(.title3.weight(.semibold)).monospacedDigit().foregroundStyle(color)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

struct PersonRow: View {
    let person: TodayResponse.Field.Person
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(person.name)
                Text(person.territory ?? "").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("\(person.visited) of \(person.planned) calls").font(.subheadline).monospacedDigit()
                StatusPill(status: person.status)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct VanRow: View {
    let van: TodayResponse.Van
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(van.truck ?? "Van")
                Text(van.seller ?? "").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.peso(van.salesCentavos)).monospacedDigit()
                StatusPill(status: van.status)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct SalesTrend: View {
    let points: [TodayResponse.TrendPoint]
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TrendBars(points: points.map { (label: $0.date, value: $0.sales, target: $0.target) })
            HStack {
                Text(points.first.map { Format.day(iso: $0.date) } ?? "")
                Spacer()
                HStack(spacing: 10) {
                    Label("Sales", systemImage: "circle.fill").foregroundStyle(Brand.tint)
                    Label("Target", systemImage: "circle.fill").foregroundStyle(.tertiary)
                }
                .labelStyle(.titleAndIcon).imageScale(.small)
                Spacer()
                Text(points.last.map { Format.day(iso: $0.date) } ?? "")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
    }
}
