import SwiftUI

struct CallSheetScreen: View {
    let model: AppModel
    let visit: AppModel.TodayVisit
    @State private var drafts: [String: CallSheetDraft] = [:]
    @State private var message: String?
    @FocusState private var focusedField: String?

    private var suggestions: SuggestedOrderLoader.State {
        model.suggestedOrders.state(outletId: visit.outletId)
    }
    private var rules: SuggestedOrderRules? {
        suggestions.order.map { SuggestedOrderRules(order: $0) }
    }
    private var status: String? {
        _ = model.visits // Observe durable outbox refreshes, including background acknowledgements.
        return model.callSheetStatus(for: visit)
    }
    private func value(_ productId: String, _ measure: CallSheetMeasure) -> Binding<String> {
        Binding(get: { drafts[productId]?.values[measure] ?? "" }, set: { text in
            var draft = drafts[productId] ?? CallSheetDraft()
            draft.values[measure] = text
            drafts[productId] = draft
        })
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let sheet = model.callSheet(for: visit) {
                    header(sheet.header)
                    Text("Record whole numbers. Leave a field blank if not captured. The week follows this visit’s service date.")
                        .font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                    suggestedOrder(sheet)
                    ForEach(sheet.lines, id: \.productId) { product in
                        SectionCard(title: product.code) {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(product.name).font(SunprideTokens.TypeStyle.row)
                                Text(product.uom).font(SunprideTokens.TypeStyle.meta)
                                    .foregroundStyle(SunprideTokens.secondaryText)
                                if let pricing = product.pricing {
                                    Text(pricing).font(SunprideTokens.TypeStyle.meta)
                                        .foregroundStyle(SunprideTokens.secondaryText)
                                }
                                if let rules, let line = rules.suggestion(for: product.productId) {
                                    Text(SuggestedOrderRules.statusText(line))
                                        .font(SunprideTokens.TypeStyle.meta)
                                        .accessibilityIdentifier("suggestion-\(product.productId)")
                                    ForEach(Array(line.reasons.enumerated()), id: \.offset) { _, reason in
                                        Text(reason).font(SunprideTokens.TypeStyle.caption)
                                            .foregroundStyle(SunprideTokens.secondaryText)
                                    }
                                    if line.canUse {
                                        SecondaryButton(title: "Use \(line.quantityText)") {
                                            drafts = rules.useSuggestion(drafts, productId: product.productId)
                                        }
                                        .accessibilityIdentifier("useSuggestion-\(product.productId)")
                                    }
                                }
                                LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 12)], spacing: 12) {
                                    ForEach(CallSheetMeasure.allCases, id: \.self) { measure in
                                        CalmField(label: measure.label) {
                                            TextField("Not captured", text: value(product.productId, measure))
                                                .keyboardType(.numberPad)
                                                .focused($focusedField, equals: "\(product.productId)-\(measure.rawValue)")
                                                .accessibilityLabel("\(product.name), \(measure.label)")
                                                .accessibilityIdentifier("callSheet-\(product.productId)-\(measure.rawValue)")
                                        }
                                    }
                                }
                            }.padding(16)
                        }
                    }
                } else {
                    Text("No call sheet set up for this account yet. Ask your office.")
                        .font(SunprideTokens.TypeStyle.row)
                }
            }.padding(16)
        }
        .background(SunprideTokens.background)
        .foregroundStyle(SunprideTokens.text)
        .navigationTitle("Call sheet")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .scrollDismissesKeyboard(.interactively)
        .task {
            if let sheet = model.callSheet(for: visit) {
                await model.suggestedOrders.load(outletId: sheet.outletId, offline: model.isOffline)
            }
        }
        .safeAreaInset(edge: .bottom) {
            if model.callSheet(for: visit) != nil {
                VStack(alignment: .leading, spacing: 12) {
                    if let status {
                        StatusPill(label: "Call sheet · \(status)")
                            .accessibilityIdentifier("callSheetStatus")
                    }
                    if let message {
                        Text(message).font(SunprideTokens.TypeStyle.meta)
                            .foregroundStyle(SunprideTokens.secondaryText)
                            .accessibilityIdentifier("callSheetMessage")
                    }
                    PrimaryBottomButton(title: "Save call sheet", action: save)
                        .accessibilityIdentifier("saveCallSheet")
                }
                .padding(16)
                .background(SunprideTokens.background)
            }
        }
    }
    private func suggestedOrder(_ sheet: CallSheet) -> some View {
        SectionCard(title: "Suggested order") {
            VStack(alignment: .leading, spacing: 12) {
                if let message = suggestions.message {
                    Text(message).font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.secondaryText)
                }
                if let rules {
                    Text(rules.summary).font(SunprideTokens.TypeStyle.meta)
                    if rules.hasApplicableLine(sheet: sheet) {
                        SecondaryButton(title: "Use all suggestions") {
                            drafts = rules.useAll(drafts, sheet: sheet)
                        }
                        .accessibilityIdentifier("useAllSuggestions")
                    }
                    let missing = rules.notOnSheet(sheet)
                    if !missing.isEmpty {
                        Text("Not on this call sheet").font(SunprideTokens.TypeStyle.meta.weight(.medium))
                        ForEach(Array(missing.enumerated()), id: \.offset) { _, line in
                            Text("\(line.code) \(line.name) — \(line.quantityText) \(line.unit)")
                                .font(SunprideTokens.TypeStyle.meta)
                                .foregroundStyle(SunprideTokens.secondaryText)
                        }
                    }
                }
                Text(SuggestedOrderRules.note).font(SunprideTokens.TypeStyle.meta)
                    .foregroundStyle(SunprideTokens.secondaryText)
            }.padding(16)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("suggestedOrder")
    }
    private func save() {
        do {
            try model.queueCallSheet(drafts, for: visit)
            focusedField = nil
            drafts = [:]
            message = nil
        } catch CallSheetPayload.Failure.empty { message = "Enter at least one number before saving." }
        catch CallSheetPayload.Failure.invalidNumber { message = "Use whole numbers from 0 to 1,000,000." }
        catch StoreError.leaseExpired { message = "Reconnect before saving. Your entries are still here." }
        catch StoreError.heldForReview { message = "Work held for review. Contact your supervisor." }
        catch StoreError.alreadyResolved { message = "This visit has already checked out." }
        catch { message = "Could not save. Check in first or sync and try again." }
    }
    private func header(_ header: CallSheet.Header) -> some View {
        SectionCard(title: "Account") {
            DetailRows {
                DetailRow(label: "Account name", value: header.accountName)
                if let v = header.address { DetailRow(label: "Address", value: v) }
                if let v = header.buyerName { DetailRow(label: "Buyer", value: v) }
                if let v = header.contactNumber { DetailRow(label: "Contact #", value: v) }
                if let v = header.accountInCharge { DetailRow(label: "Acct in-charge", value: v) }
                if let v = header.receivingInCharge { DetailRow(label: "Receiving in-charge", value: v) }
                if let v = header.distributorName { DetailRow(label: "Distributor", value: v) }
                if let v = header.distributorSchedule { DetailRow(label: "Sched & cont #", value: v) }
                if let v = header.foc { DetailRow(label: "FOC", value: v) }
                if let v = header.pricing { DetailRow(label: "Pricing", value: v) }
            }
        }
    }
}
