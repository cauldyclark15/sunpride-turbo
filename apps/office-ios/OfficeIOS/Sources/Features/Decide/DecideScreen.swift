import SwiftUI

/// The Decide inbox rules, the same as the web (`components/ops/decide/decide-model.ts`).
enum DecideRules {
    static let chargeChoices: [(value: String, label: String)] = [
        ("dispatch_side", "Sending side (the depot)"),
        ("receive_side", "Receiving side"),
        ("carrier", "Carrier"),
        ("driver", "Driver"),
    ]

    /// What is wrong with the form, before the server is asked. Empty means it can be sent.
    static func problems(item: DecideItem, verdict: String, reason: String, chargeTo: String) -> [String] {
        var out: [String] = []
        if verdict == "reject", reason.trimmingCharacters(in: .whitespacesAndNewlines).count < 3 {
            out.append("Say why you are rejecting this, in a few words.")
        }
        if verdict == "approve", item.needs.chargeTo == true, chargeTo.isEmpty {
            out.append("Say who carries the difference: sending side, receiving side, carrier or driver.")
        }
        return out
    }

    /// The body the server takes. The key makes a double tap decide once.
    static func body(item: DecideItem, verdict: String, reason: String, chargeTo: String, key: String) -> [String: Any] {
        var b: [String: Any] = ["id": item.id, "verdict": verdict,
                                "reason": reason.trimmingCharacters(in: .whitespacesAndNewlines), "idempotencyKey": key]
        if verdict == "approve", item.needs.chargeTo == true { b["chargeTo"] = chargeTo }
        return b
    }

    static func labels(kind: String, forced: Bool = false) -> (approve: String, reject: String) {
        switch kind {
        case "transfer_variance", "reload_difference", "load_in_difference": ("Write it off", "Send back for a recount")
        case "count_review": ("Approve count", "Send back for a recount")
        case "cash_variance": forced ? ("Accept the close", "Investigate") : ("Accept the difference", "Investigate")
        case "override_review": ("Looks fine", "Flag it")
        case "privilege_cap": ("Customer keeps it", "Flag it")
        default: ("Approve", "Reject")
        }
    }

    static func symbol(kind: String) -> String {
        switch kind {
        case "count_review": "list.clipboard"
        case "transfer_variance", "reload_difference", "load_in_difference", "load_difference": "shippingbox.and.arrow.backward"
        case "cash_variance": "banknote"
        case "disposition": "xmark.bin"
        case "override_review": "person.badge.key"
        case "privilege_cap": "person.2.badge.gearshape"
        default: "checkmark.seal"
        }
    }
}

struct DecideScreen: View {
    @Environment(AppModel.self) private var model
    @State private var remote: Remote<DecideInbox>?
    @State private var selection: String?
    @State private var kind: String?
    @State private var done: String?
    @State private var finished = 0

    var body: some View {
        AdaptiveSplit(selection: $selection, emptyTitle: "Choose an item to decide", emptySymbol: "checkmark.seal", popSignal: finished) { sel in
            ZStack {
                Color.clear
                if let remote {
                    RemoteView(remote, what: "the Decide list") { inbox in
                        DecideList(inbox: inbox, kind: $kind, selection: sel, done: done)
                    }
                    .refreshable { await reload() }
                }
            }
            .navigationTitle("Decide")
            .toolbar {
                if let inbox = remote?.value, !inbox.counts.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) { KindMenu(inbox: inbox, kind: $kind) }
                }
            }
        } detail: { id in
            if let item = remote?.value?.items.first(where: { $0.id == id }) {
                DecideDetail(item: item, now: remote?.value?.asOf ?? Date.now.timeIntervalSince1970 * 1000) { message in
                    done = message
                    selection = nil
                    finished += 1
                    Task { await reload() }
                }
            } else {
                ContentUnavailableView("Already decided", systemImage: "checkmark.circle",
                                       description: Text("This item is no longer waiting."))
            }
        }
        .onAppear {
            if remote == nil, let api = model.api {
                remote = Remote { try await api.get("api/v1/decide/inbox", as: DecideInbox.self) }
            }
        }
        .onChange(of: remote?.value?.openCount) { _, n in if let n { model.setDecideOpen(n) } }
    }

    private func reload() async {
        await remote?.load(force: true)
    }
}

struct KindMenu: View {
    let inbox: DecideInbox
    @Binding var kind: String?
    var body: some View {
        Menu {
            Picker("Show", selection: $kind) {
                Text("Everything (\(inbox.total))").tag(String?.none)
                ForEach(inbox.counts.keys.sorted(), id: \.self) { k in
                    Text("\(inbox.kinds[k] ?? Format.words(k)) (\(inbox.counts[k] ?? 0))").tag(Optional(k))
                }
            }
        } label: {
            Label("Show", systemImage: kind == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
        }
        .accessibilityLabel("Filter by kind")
    }
}

struct DecideList: View {
    let inbox: DecideInbox
    @Binding var kind: String?
    @Binding var selection: String?
    let done: String?

    var body: some View {
        let shown = kind.map { k in inbox.items.filter { $0.kind == k } } ?? inbox.items
        List(selection: $selection) {
            if let done {
                Label(done, systemImage: "checkmark.circle.fill")
                    .foregroundStyle(Brand.good)
                    .accessibilityIdentifier("decide.done")
            }
            if !inbox.warnings.isEmpty {
                Label("Some lists could not be read just now. \(inbox.warnings.map(\.message).joined(separator: " "))",
                      systemImage: "exclamationmark.triangle")
                    .font(.subheadline).foregroundStyle(Brand.watch)
            }
            Section {
                if shown.isEmpty {
                    ContentUnavailableView(kind == nil ? "All clear" : "Nothing of this kind",
                                           systemImage: "checkmark.seal",
                                           description: Text(kind == nil ? "Approvals show up here the moment someone asks." : "Nothing of this kind is waiting."))
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(shown) { item in
                        NavigationLink(value: item.id) { DecideRow(item: item, now: inbox.asOf) }
                            .accessibilityIdentifier("decide.row")
                    }
                }
            } header: {
                Text(inbox.total == 0 ? "Nothing is waiting for you" : "\(inbox.total) waiting · \(inbox.openCount) for you")
            }
            if !inbox.recent.isEmpty {
                Section("Decided recently") {
                    ForEach(inbox.recent) { r in
                        HStack {
                            Image(systemName: r.verdict == "approved" ? "checkmark.circle.fill" : "arrow.uturn.backward.circle.fill")
                                .foregroundStyle(r.verdict == "approved" ? Brand.good : Brand.watch)
                            VStack(alignment: .leading) {
                                Text(r.verdict == "approved" ? "Approved" : "Rejected").font(.subheadline.weight(.medium))
                                Text(r.reason.isEmpty ? (r.documentNumber ?? "") : r.reason).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("\(r.by) · \(Format.ago(r.at))").font(.caption).foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }
}

struct DecideRow: View {
    let item: DecideItem
    let now: Double
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: DecideRules.symbol(kind: item.kind))
                .font(.title3)
                .foregroundStyle(Brand.tint)
                .frame(width: 32, height: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(item.kindLabel).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Text("waiting \(Format.age(since: item.askedAt, now: Format.date(ms: now)))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text(item.title).font(.body.weight(.medium)).lineLimit(3)
                HStack(spacing: 6) {
                    if let v = item.valueCentavos { Text(Format.peso(v)).monospacedDigit().fontWeight(.semibold) }
                    Text("· \(item.askedBy ?? "the system")").foregroundStyle(.secondary)
                }
                .font(.subheadline)
                if !item.canDecide, item.openOnly != true {
                    Text(item.blockedReason ?? item.makerChecker).font(.caption).foregroundStyle(Brand.watch)
                }
                if item.sentBack != nil { StatusPill("Sent back", tone: .watch) }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

struct DecideDetail: View {
    let item: DecideItem
    let now: Double
    let onDone: (String) -> Void
    @State private var verdict: String?

    var body: some View {
        let labels = DecideRules.labels(kind: item.kind, forced: item.extra?.forced == true)
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Label(item.kindLabel, systemImage: DecideRules.symbol(kind: item.kind))
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Brand.tint)
                    Text(item.title).font(.title3.weight(.semibold))
                    if let v = item.valueCentavos {
                        Text("Worth \(Format.peso(v))").font(.headline).monospacedDigit()
                    }
                }
                .padding(.vertical, 4)
            }
            Section("Details") {
                Fact("Asked by", item.askedBy ?? "the system")
                Fact("Waiting", Format.age(since: item.askedAt, now: Format.date(ms: now)))
                if let doc = item.documentNumber { Fact("Document", doc) }
                ForEach(item.lines, id: \.label) { Fact($0.label, $0.value) }
            }
            if let rule = item.rule {
                Section("Why it is here") { Text(rule).font(.subheadline) }
            }
            if let sent = item.sentBack {
                Section("Sent back") {
                    Text("\(sent.by.map { "By \($0): " } ?? "")\(sent.reason)").font(.subheadline).foregroundStyle(Brand.watch)
                }
            }
            Section {
                Text(item.canDecide || item.openOnly == true ? item.makerChecker : (item.blockedReason ?? item.makerChecker))
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(item.kindLabel)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            if item.canDecide {
                GlassEffectContainer(spacing: 12) {
                    HStack(spacing: 12) {
                        Button { verdict = "reject" } label: {
                            Text(labels.reject).lineLimit(2).multilineTextAlignment(.center).frame(maxWidth: .infinity, minHeight: 28)
                        }
                        .buttonStyle(.glass)
                        .accessibilityIdentifier("decide.reject")
                        Button { verdict = "approve" } label: {
                            Text(labels.approve).fontWeight(.semibold).lineLimit(2).multilineTextAlignment(.center).frame(maxWidth: .infinity, minHeight: 28)
                        }
                        .buttonStyle(.glassProminent)
                        .tint(Brand.action)
                        .accessibilityIdentifier("decide.approve")
                    }
                    .controlSize(.large)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
        }
        .sheet(item: Binding(get: { verdict.map { VerdictChoice(verdict: $0) } }, set: { verdict = $0?.verdict })) { choice in
            DecideForm(item: item, verdict: choice.verdict, labels: labels) { message in
                verdict = nil
                onDone(message)
            }
            .presentationDetents([.medium, .large])
        }
    }
}

struct VerdictChoice: Identifiable { let verdict: String; var id: String { verdict } }

/// The confirm step: reason (required to reject), who carries a difference when the kind needs it.
struct DecideForm: View {
    let item: DecideItem
    let verdict: String
    let labels: (approve: String, reject: String)
    let onDone: (String) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""
    @State private var chargeTo = ""
    @State private var sending = false
    @State private var error: String?
    /// One key per distinct request, kept across retries of the same request (the web's useIntent).
    @State private var key = UUID().uuidString.lowercased()
    @State private var keyFor = ""

    var body: some View {
        let problems = DecideRules.problems(item: item, verdict: verdict, reason: reason, chargeTo: chargeTo)
        NavigationStack {
            Form {
                Section {
                    Text(item.title).font(.headline)
                    if let v = item.valueCentavos { Fact("Worth", Format.peso(v)) }
                }
                if verdict == "approve", item.needs.chargeTo == true {
                    Picker("Who carries the difference", selection: $chargeTo) {
                        Text("Choose").tag("")
                        ForEach(DecideRules.chargeChoices, id: \.value) { Text($0.label).tag($0.value) }
                    }
                }
                Section {
                    TextField(verdict == "reject" ? "Why are you rejecting this?" : "Note (optional)", text: $reason, axis: .vertical)
                        .lineLimit(2...5)
                        .onChange(of: reason) { _, v in if v.count > 300 { reason = String(v.prefix(300)) } }
                        .accessibilityIdentifier("decide.reason")
                } footer: {
                    if let first = problems.first, !reason.isEmpty || verdict == "approve" {
                        Text(first).foregroundStyle(Brand.bad)
                    } else if verdict == "reject" {
                        Text("A few words, so the person who asked knows what to fix.")
                    }
                }
                if let error {
                    Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(Brand.bad) }
                }
            }
            .navigationTitle(verdict == "approve" ? labels.approve : labels.reject)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        send()
                    } label: {
                        if sending { ProgressView() } else { Text(verdict == "approve" ? "Approve" : "Send") }
                    }
                    .disabled(sending || !problems.isEmpty)
                    .accessibilityIdentifier("decide.confirm")
                }
            }
        }
    }

    private func send() {
        guard let api = model.api else { return }
        let signature = "\(verdict)|\(reason.trimmingCharacters(in: .whitespacesAndNewlines))|\(chargeTo)"
        if signature != keyFor { key = UUID().uuidString.lowercased(); keyFor = signature }
        sending = true
        error = nil
        Task {
            defer { sending = false }
            do {
                let body = DecideRules.body(item: item, verdict: verdict, reason: reason, chargeTo: chargeTo, key: key)
                let res = try await api.post("api/v1/decide/act", body: body, as: DecideActResult.self)
                Haptics.success()
                await model.refreshBadge()
                onDone("\(item.documentNumber ?? item.kindLabel): \(res.status ?? "Done.")")
            } catch let e as OfficeError {
                Haptics.warning()
                error = e.localizedDescription
            } catch {
                self.error = OfficeError.invalidResponse.localizedDescription
            }
        }
    }
}
