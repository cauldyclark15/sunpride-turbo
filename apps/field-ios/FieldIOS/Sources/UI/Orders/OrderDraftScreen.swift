import SwiftUI

/// SP-0044 (IOS-014): take an order offline during an open call. Searches only this account's
/// product setup; quantities are whole numbers in the setup UOM. No prices on the phone yet.
struct OrderDraftScreen: View {
    let model: AppModel
    let visit: AppModel.TodayVisit
    /// nil while composing a new draft; set after its first save.
    @State private var draftId: String?
    @State private var quantities: [String: String] = [:]
    @State private var query = ""
    @State private var message: String?
    @State private var seeded = false
    @FocusState private var focusedField: String?
    @Environment(\.dismiss) private var dismiss

    init(model: AppModel, visit: AppModel.TodayVisit, draftId: String? = nil) {
        self.model = model; self.visit = visit
        _draftId = State(initialValue: draftId)
    }

    private var draft: OrderDraft? { draftId.flatMap { id in model.orderDrafts.first { $0.draftId == id } } }
    private var catalog: [OrderCatalog.Item] { model.orderCatalog(for: visit) }
    private var editable: Bool {
        _ = model.visits
        let progress = model.visitProgress(for: visit)
        return progress.checkedIn && !progress.checkedOut && draft?.submittedRequestId == nil
    }
    private var stale: [OrderDraft.Line] {
        guard let draft else { return [] }
        return OrderDraftRules.staleLines(draft, sheet: model.callSheet(for: visit))
    }
    private var enteredCount: Int {
        catalog.filter { !(quantities[$0.productId] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }.count
    }
    private func value(_ productId: String) -> Binding<String> {
        Binding(get: { quantities[productId] ?? "" }, set: { quantities[productId] = $0 })
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(visit.outlet).font(SunprideTokens.TypeStyle.title)
                    Text(draft == nil ? "New order · saved on this phone only" : "Order draft · saved on this phone only")
                        .font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                        .accessibilityIdentifier("orderDraftState")
                }
                Text("Enter whole quantities in each product's unit. Prices are not set on the phone; pricing notes are for reference and the office prices the order.")
                    .font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                if let note = model.callSheet(for: visit)?.header.pricing {
                    SectionCard(title: "Account pricing note") {
                        DetailRows { DetailRow(label: "Reference only", value: note) }
                    }
                }
                if !stale.isEmpty {
                    SectionCard(title: "No longer set up") {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(stale, id: \.productId) { line in
                                CalmListRow(symbol: "exclamationmark.triangle", title: "\(line.code) · \(line.name)",
                                            meta: "\(line.quantity) \(line.uom) · removed when you save")
                            }
                        }
                    }
                    .accessibilityIdentifier("orderStaleLines")
                }
                if catalog.isEmpty {
                    Text(OrderDraftFailure.noCatalog.message).font(SunprideTokens.TypeStyle.row)
                        .accessibilityIdentifier("orderNoCatalog")
                } else if editable {
                    CalmField(label: nil) {
                        HStack(spacing: 8) {
                            Image(systemName: "magnifyingglass").foregroundStyle(SunprideTokens.secondaryText)
                                .accessibilityHidden(true)
                            TextField("Search code, name or barcode", text: $query)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .accessibilityIdentifier("orderSearch")
                        }
                    }
                    let results = OrderCatalog.search(catalog, query)
                    if results.isEmpty {
                        Text("No product in this account's setup matches.")
                            .font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                            .accessibilityIdentifier("orderNoMatch")
                    }
                    ForEach(results, id: \.productId) { item in productRow(item) }
                } else if let draft {
                    SectionCard(title: "Lines") {
                        VStack(spacing: 0) {
                            ForEach(draft.lines, id: \.productId) { line in
                                CalmListRow(symbol: "shippingbox", title: "\(line.code) · \(line.name)", meta: "\(line.quantity) \(line.uom)")
                            }
                        }
                    }
                    Text("The call has ended. Review and sending come next.")
                        .font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                }
            }
            .padding(16)
        }
        .background(SunprideTokens.background)
        .foregroundStyle(SunprideTokens.text)
        .navigationTitle("Order")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .scrollDismissesKeyboard(.interactively)
        .onAppear(perform: seed)
        .safeAreaInset(edge: .bottom) {
            if editable && !catalog.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    if let message {
                        Text(message).font(SunprideTokens.TypeStyle.meta)
                            .foregroundStyle(SunprideTokens.secondaryText)
                            .accessibilityIdentifier("orderMessage")
                    } else {
                        Text(enteredCount == 1 ? "1 product" : "\(enteredCount) products")
                            .font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                            .accessibilityIdentifier("orderCount")
                    }
                    HStack(spacing: 12) {
                        if draftId != nil {
                            SecondaryButton(title: "Discard", destructive: true, action: discard)
                                .accessibilityIdentifier("discardOrderDraft")
                        }
                        PrimaryBottomButton(title: "Save draft", action: save)
                            .accessibilityIdentifier("saveOrderDraft")
                    }
                }
                .padding(16)
                .background(SunprideTokens.background)
            }
        }
    }

    private func productRow(_ item: OrderCatalog.Item) -> some View {
        SectionCard(title: item.code) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.name).font(SunprideTokens.TypeStyle.row)
                    Text(item.uom).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                    if let note = item.priceNote {
                        Text("Pricing note · \(note)").font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                CalmField(label: nil) {
                    TextField("Qty", text: value(item.productId))
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .focused($focusedField, equals: item.productId)
                        .accessibilityLabel("\(item.name), quantity in \(item.uom)")
                        .accessibilityIdentifier("orderQty-\(item.productId)")
                }
                .frame(width: 112)
            }
            .padding(16)
        }
    }

    /// Reopening a draft fills its saved quantities; lines no longer in the setup are shown apart.
    private func seed() {
        guard !seeded else { return }
        seeded = true
        guard let draft else { return }
        let current = Set(catalog.map(\.productId))
        for line in draft.lines where current.contains(line.productId) { quantities[line.productId] = String(line.quantity) }
    }

    private func save() {
        do {
            // Setup order; products that left the setup are dropped (shown above as stale).
            let entries = try catalog.compactMap { item -> (productId: String, quantity: Int)? in
                try OrderDraftRules.quantity(quantities[item.productId] ?? "").map { (item.productId, $0) }
            }
            let saved = try model.saveOrderDraft(draftId: draftId, quantities: entries, for: visit)
            draftId = saved.draftId
            focusedField = nil
            message = "Draft saved on this phone."
        } catch let failure as OrderDraftFailure { message = failure.message }
        catch StoreError.leaseExpired { message = OrderDraftFailure.offlineExpired.message }
        catch StoreError.heldForReview { message = OrderDraftFailure.held.message }
        catch { message = "Could not save the order draft. Check the quantities and try again." }
    }

    private func discard() {
        guard let id = draftId else { dismiss(); return }
        do { try model.discardOrderDraft(id); dismiss() }
        catch let failure as OrderDraftFailure { message = failure.message }
        catch { message = "Could not discard the order draft." }
    }
}
