import SwiftUI

/// One screen's remote data: loading (first time), loaded, or failed — with the last good copy kept
/// while a refresh runs or fails, so pull-to-refresh never blanks the screen.
@MainActor @Observable
final class Remote<Value> {
    enum Phase { case idle, loading, loaded, failed }
    private(set) var value: Value?
    private(set) var error: OfficeError?
    private(set) var phase: Phase = .idle
    private(set) var loadedAt: Date?
    private let fetch: () async throws -> Value

    init(_ fetch: @escaping () async throws -> Value) { self.fetch = fetch }

    func load(force: Bool = false) async {
        if !force, phase == .loaded || phase == .loading { return }
        phase = .loading
        do {
            value = try await fetch()
            error = nil
            loadedAt = .now
            phase = .loaded
        } catch is CancellationError {
            phase = value == nil ? .idle : .loaded
        } catch let e as OfficeError {
            error = e
            phase = .failed
        } catch {
            self.error = .invalidResponse
            phase = .failed
        }
    }

    func replace(_ value: Value) { self.value = value; phase = .loaded; loadedAt = .now }
}

/// Renders a `Remote`: a skeleton the first time, the content after, a plain-words problem with Try again,
/// and a slim banner when a refresh failed but an older copy is still shown.
struct RemoteView<Value, Content: View, Placeholder: View>: View {
    let remote: Remote<Value>
    let what: String
    @ViewBuilder let content: (Value) -> Content
    @ViewBuilder let placeholder: () -> Placeholder

    var body: some View {
        Group {
            if let value = remote.value {
                content(value)
                    .safeAreaInset(edge: .top, spacing: 0) {
                        if remote.phase == .failed, let error = remote.error { StaleBanner(error: error) }
                    }
            } else if remote.phase == .failed, let error = remote.error {
                ProblemView(error: error, what: what) { Task { await remote.load(force: true) } }
            } else {
                placeholder().redacted(reason: .placeholder).allowsHitTesting(false)
                    .accessibilityLabel("Loading \(what)")
            }
        }
        .task { await remote.load() }
    }
}

extension RemoteView where Placeholder == SkeletonList {
    init(_ remote: Remote<Value>, what: String, @ViewBuilder content: @escaping (Value) -> Content) {
        self.init(remote: remote, what: what, content: content, placeholder: { SkeletonList() })
    }
}

/// Generic loading skeleton in the shape of a grouped list.
struct SkeletonList: View {
    var body: some View {
        List {
            Section {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                    ForEach(0..<4, id: \.self) { _ in
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Sales today").font(.subheadline)
                            Text("₱1,234,567").font(.title2.bold())
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            Section {
                ForEach(0..<6, id: \.self) { _ in
                    VStack(alignment: .leading) {
                        Text("Sample store name here").font(.body)
                        Text("Territory · last order").font(.subheadline)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }
}

struct ProblemView: View {
    let error: OfficeError
    let what: String
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(error == .offline ? "You're offline" : "Couldn't load \(what)",
                  systemImage: error == .offline ? "wifi.slash" : "exclamationmark.icloud")
        } description: {
            Text(error.localizedDescription)
        } actions: {
            Button("Try again", action: retry).buttonStyle(.glassProminent)
                .tint(Brand.action)
        }
    }
}

struct StaleBanner: View {
    let error: OfficeError
    var body: some View {
        Label(error == .offline ? "Offline — showing the last copy" : "Couldn't refresh — showing the last copy",
              systemImage: error == .offline ? "wifi.slash" : "arrow.clockwise.circle")
            .font(.footnote.weight(.medium))
            .padding(.horizontal, 14).padding(.vertical, 8)
            .glassEffect(.regular, in: .capsule)
            .padding(.top, 4)
            .accessibilityAddTraits(.isStaticText)
    }
}

/// Words + symbol + color, never color alone.
struct StatusPill: View {
    let text: String
    let tone: Tone

    init(_ text: String, tone: Tone) { self.text = text; self.tone = tone }
    init(status: String?) { self.text = Format.words(status); self.tone = Tone.of(status) }

    var body: some View {
        Label(text, systemImage: tone.symbol)
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tone.color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tone.color.opacity(0.12), in: .capsule)
            .fixedSize()
    }
}

/// One figure: label, value, target/prior and change. Used in the KPI grid on every report.
struct KpiTile: View {
    let kpi: Kpi

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(kpi.label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2, reservesSpace: true)
            Text(Format.kpi(kpi.value, unit: kpi.unit))
                .font(.title2.weight(.semibold))
                .monospacedDigit()
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                .foregroundStyle(.primary)
            HStack(spacing: 6) {
                if let delta = Format.delta(kpi.deltaPct) {
                    Text(delta)
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle((kpi.deltaPct ?? 0) >= 0 ? Brand.good : Brand.bad)
                }
                if let target = kpi.target, target != 0 {
                    Text("target \(Format.kpi(target, unit: kpi.unit))")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                } else if kpi.deltaPct != nil {
                    Text("vs before").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityHint(kpi.definition ?? "")
    }
}

struct KpiGrid: View {
    let kpis: [Kpi]
    @Environment(\.horizontalSizeClass) private var hSize
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let columns = typeSize.isAccessibilitySize ? 1 : (hSize == .regular ? 4 : 2)
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: columns), spacing: 12) {
            ForEach(kpis) { KpiTile(kpi: $0) }
        }
    }
}

/// "Updated 3:05 PM · Sample Visayas" footer line for a report.
struct FreshnessFooter: View {
    let asOf: Double
    var scope: String?
    var demo: Bool = false
    var body: some View {
        HStack(spacing: 4) {
            Text("Updated \(Format.time(ms: asOf))")
            if let scope { Text("· \(scope)") }
            if demo { Text("· sample data") }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
}

/// A two-column fact row that reads well with VoiceOver.
struct Fact: View {
    let label: String
    let value: String
    init(_ label: String, _ value: String) { self.label = label; self.value = value }
    var body: some View {
        LabeledContent(label) { Text(value).monospacedDigit().multilineTextAlignment(.trailing) }
    }
}

/// Simple sales bars without Charts boilerplate for small trends.
struct TrendBars: View {
    let points: [(label: String, value: Double, target: Double?)]
    var body: some View {
        let top = max(points.map { max($0.value, $0.target ?? 0) }.max() ?? 1, 1)
        HStack(alignment: .bottom, spacing: 4) {
            ForEach(Array(points.enumerated()), id: \.offset) { _, p in
                ZStack(alignment: .bottom) {
                    if let t = p.target, t > 0 {
                        UnevenRoundedRectangle(topLeadingRadius: 4, topTrailingRadius: 4, style: .continuous)
                            .fill(.quaternary).frame(height: max(4, 96 * t / top))
                    }
                    UnevenRoundedRectangle(topLeadingRadius: 4, topTrailingRadius: 4, style: .continuous)
                        .fill(Brand.tint.gradient).frame(height: max(3, 96 * p.value / top))
                        .padding(.horizontal, 3)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(height: 100)
        .accessibilityElement()
        .accessibilityLabel("Sales trend")
        .accessibilityValue(points.last.map { "Latest \(Format.peso($0.value))" } ?? "")
    }
}
