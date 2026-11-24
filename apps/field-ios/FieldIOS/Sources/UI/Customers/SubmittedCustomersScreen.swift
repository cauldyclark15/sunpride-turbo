import SwiftUI
import PhotosUI

struct SubmittedCustomersScreen: View {
    let model: AppModel
    var initialId: String?
    @State private var selected: String?
    @State private var profile: SubmittedProfile?
    @State private var rows: [SubmittedCustomerList.Row] = []
    @State private var cursor: String?
    @State private var query = ""
    @State private var waitingOnly = true
    @State private var edits: [String: String] = [:]
    @State private var busy = false
    @State private var message: String?
    @State private var picker: SubmittedProfile.Field?
    @State private var choiceQuery = ""
    @State private var photo: PhotosPickerItem?
    @State private var photoField: String?
    @State private var work: Task<Void, Never>?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SecondaryButton(title: "Back", disabled: busy) {
                    if selected != nil && initialId == nil { selected = nil; profile = nil; edits = [:]; run { try await list() } }
                    else { dismiss() }
                }
                Text(selected == nil ? "Submitted customers" : profile?.customer.customerName ?? "Customer profile")
                    .font(SunprideTokens.TypeStyle.title)
                Text("Needs internet. Saving details does not approve the customer.")
                if let message { Text(message).accessibilityIdentifier("profileMessage") }
                if selected == nil { directory }
                else if let profile { editor(profile) }
                if busy { ProgressView() }
            }
            .frame(maxWidth: 520, alignment: .leading).padding(16).frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(SunprideTokens.background)
        .safeAreaInset(edge: .bottom) {
            if let profile, profile.customer.canEdit, model.signedIn {
                PrimaryBottomButton(title: busy ? "Saving…" : "Save details", disabled: busy || edits.isEmpty) {
                    run {
                        let id = profile.customer.id
                        let body = try SubmittedProfile.body(edits: edits, updatedAt: profile.customer.updatedAt)
                        _ = try await model.customerProfileRequest("POST", "api/v1/customers/\(id)/amend", body: body)
                        let reopened = try await fetch(id)
                        try Task.checkCancellation()
                        self.profile = reopened; edits = [:]
                        message = reopened.customer.waiting ? "Saved. Still waiting for approval." : "Saved."
                    }
                }.padding(16).background(SunprideTokens.background)
            }
        }
        .sheet(item: $picker) { field in
            NavigationStack {
                List {
                    TextField("Search choices", text: $choiceQuery)
                    Button("Not set") { choose(field, "") }
                    ForEach(field.options.filter { choiceQuery.isEmpty || $0.name.localizedCaseInsensitiveContains(choiceQuery) }) { option in
                        Button(option.name) { choose(field, option.code) }
                    }
                }.navigationTitle(field.label).toolbar { Button("Close") { picker = nil } }
            }
        }
        .onChange(of: photo) { _, value in
            guard let value, let key = photoField else { return }
            run {
                guard let data = try await value.loadTransferable(type: Data.self), let image = UIImage(data: data),
                      let jpeg = CensusPhoto.jpeg(image, longEdge: 600), jpeg.count <= 100 * 1024 else {
                    message = "Choose a smaller photo (up to 100 KB)."; return
                }
                try Task.checkCancellation()
                edits[key] = "data:image/jpeg;base64," + jpeg.base64EncodedString()
            }
        }
        .task {
            do { if let initialId { selected = initialId; profile = try await fetch(initialId) } else { try await list() } }
            catch { message = "Connect to open submitted customers." }
        }
        .onDisappear { work?.cancel() }
        .onChange(of: model.signedIn) { _, signedIn in if !signedIn { work?.cancel(); profile = nil; rows = []; edits = [:] } }
        .calmScreenChrome()
    }

    private var directory: some View {
        VStack(alignment: .leading, spacing: 12) {
            CalmField(label: "Search customer") { TextField("Name or number", text: $query) }
            Toggle("Waiting for approval only", isOn: $waitingOnly)
            SecondaryButton(title: "Search / refresh", disabled: busy) { run { try await list() } }
            ForEach(rows) { row in
                Button { run { let result = try await fetch(row.id); profile = result; selected = row.id; edits = [:] } } label: {
                    CalmListRow(symbol: "storefront", title: row.title, meta: row.state, trailing: "chevron.right")
                }.buttonStyle(.plain).disabled(busy)
            }
            if rows.isEmpty && !busy { Text("No customers found.") }
            if cursor != nil { SecondaryButton(title: "Load more", disabled: busy) { run { try await list(more: true) } } }
        }
    }

    @ViewBuilder private func editor(_ profile: SubmittedProfile) -> some View {
        let editable = profile.customer.canEdit && model.signedIn && !busy
        Text(profile.customer.waiting ? "Waiting for approval" : "Approved / closed").accessibilityIdentifier("profileStatus")
        if !profile.customer.canEdit { Text("Read only. After approval only admins can edit.") }
        if !profile.missingFields.isEmpty {
            Text("Still to complete: " + Array(Set(profile.missingFields.map(\.label))).sorted().joined(separator: ", "))
                .foregroundStyle(SunprideTokens.dangerText)
        }
        ForEach(profile.fields) { field in
            VStack(alignment: .leading, spacing: 4) {
                let value = edits[field.key] ?? field.value
                if field.kind == "photo" {
                    PhotosPicker(selection: $photo, matching: .images) {
                        Text(value.isEmpty ? "Choose \(field.label)" : "\(field.label): photo selected")
                    }.simultaneousGesture(TapGesture().onEnded { photoField = field.key }).disabled(!editable)
                } else if ["list", "geo", "choice", "boolean"].contains(field.kind) && field.key != "postalCode" {
                    CalmField(label: field.label) {
                        Button(field.options.first { $0.code == value }?.name ?? (value.isEmpty ? "Choose…" : value)) {
                            picker = field; choiceQuery = ""
                        }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).disabled(!editable)
                    }
                } else {
                    CalmField(label: field.label) {
                        TextField(field.label, text: Binding(get: { edits[field.key] ?? field.value }, set: { edits[field.key] = $0 }))
                            .disabled(!editable).accessibilityIdentifier("profile-\(field.key)")
                    }
                }
                if let error = field.error { Text(error).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.dangerText) }
            }
        }
        if profile.customer.canEdit { SecondaryButton(title: "Check remaining fields", disabled: busy) { preview() } }
        DisclosureGroup("Change history") {
            ForEach(profile.customer.history) { entry in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(entry.actor) · \(Date(timeIntervalSince1970: Double(entry.at) / 1000).formatted())")
                    ForEach(entry.changes) { change in Text("\(change.label): \(change.before?.text ?? "Not set") → \(change.after?.text ?? "Not set")") }
                }.font(SunprideTokens.TypeStyle.meta).padding(.vertical, 8)
            }
            if profile.customer.historyTruncated { Text("Showing the latest 50 changes.") }
        }
    }
    private func choose(_ field: SubmittedProfile.Field, _ value: String) {
        edits = SubmittedProfile.changing(edits, field: field, value: value); picker = nil; preview()
    }
    private func preview() { run {
        guard let profile else { return }
        let data = try await model.customerProfileRequest("POST", "api/v1/customers/\(profile.customer.id)/editor", body: SubmittedProfile.body(edits: edits, updatedAt: profile.customer.updatedAt))
        self.profile = try JSONDecoder().decode(SubmittedProfile.self, from: data)
    } }
    private func fetch(_ id: String) async throws -> SubmittedProfile {
        try await JSONDecoder().decode(SubmittedProfile.self, from: model.customerProfileRequest("GET", "api/v1/customers/\(id)/editor"))
    }
    private func list(more: Bool = false) async throws {
        var params = [URLQueryItem(name: "limit", value: "50"), URLQueryItem(name: "q", value: query), URLQueryItem(name: "awaitingApproval", value: String(waitingOnly))]
        if more, let cursor { params.append(URLQueryItem(name: "cursor", value: cursor)) }
        let data = try await model.customerProfileRequest("GET", "api/v1/customers", query: params)
        let result = try JSONDecoder().decode(SubmittedCustomerList.self, from: data)
        rows = (more ? rows : []) + result.rows; cursor = result.nextCursor
    }
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }; busy = true; message = nil
        work = Task { @MainActor in
            defer { busy = false }
            do { try await action() }
            catch is CancellationError { }
            catch { message = "Could not complete this request. Check your connection and reopen the profile if it changed. Your entries are still here." }
        }
    }
}
