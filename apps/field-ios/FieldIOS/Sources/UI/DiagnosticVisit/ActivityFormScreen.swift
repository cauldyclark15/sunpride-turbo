import SwiftUI

/// One selectable row; selection is exposed to VoiceOver and UI tests.
struct ChoiceRow: View {
    let label: String
    let selected: Bool
    var disabled = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack {
                Text(label).font(SunprideTokens.TypeStyle.row).foregroundStyle(SunprideTokens.text)
                Spacer()
                if selected {
                    Image(systemName: "checkmark").font(.system(size: 13, weight: .medium))
                        .foregroundStyle(SunprideTokens.text).accessibilityHidden(true)
                }
            }
            .frame(minHeight: 48)
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// IOS-013 structured activity form for the open call; the backend rule decided it is needed.
struct ActivityFormScreen: View {
    let model: AppModel
    let visit: AppModel.TodayVisit
    let kind: String
    @State private var choice: String?
    @State private var product: String?
    @State private var text = ""
    @State private var compliant: Bool?
    @State private var message: String?
    @FocusState private var textFocused: Bool
    @Environment(\.dismiss) private var dismiss

    private var sheet: CallSheet? { model.callSheet(for: visit) }
    private var needsProduct: Bool { kind == "inventory_check" || kind == "price_check" }
    private func build() throws -> [String: Any] {
        switch kind {
        case "merchandising": try ActivityForms.merchandising(displayCondition: choice, actionTaken: text)
        case "promotion": try ActivityForms.promotion(programRef: text, finding: choice)
        case "inventory_check": try ActivityForms.inventoryCheck(sheet: sheet, productId: product, finding: choice, quantity: text)
        case "price_check": try ActivityForms.priceCheck(sheet: sheet, productId: product, price: text, compliant: compliant)
        default: throw ActivityForms.Failure(message: "This activity can't be recorded on this phone")
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("For \(visit.outlet)").font(SunprideTokens.TypeStyle.meta)
                    .foregroundStyle(SunprideTokens.secondaryText)
                if needsProduct {
                    if let sheet, !sheet.lines.isEmpty {
                        choices("Product", sheet.lines.map { ($0.productId, "\($0.code) · \($0.name)") }, product, "activityProduct") { product = $0 }
                    } else {
                        Text("No products set up for this account yet. Ask your office.")
                            .font(SunprideTokens.TypeStyle.row).accessibilityIdentifier("activityNoProducts")
                    }
                }
                switch kind {
                case "merchandising":
                    choices("Display", ActivityForms.display, choice, "activityDisplay") { choice = $0 }
                    field("Action taken", "What you fixed (optional)")
                case "promotion":
                    field("Program", "Promotion or program")
                    choices("Finding", ActivityForms.promotionFindings, choice, "activityFinding") { choice = $0 }
                case "inventory_check":
                    choices("Stock", ActivityForms.stock, choice, "activityStock") { choice = $0 }
                    field("Quantity", "Units on shelf (optional)", keyboard: .numberPad)
                case "price_check":
                    field("Shelf price", "Price in pesos", keyboard: .decimalPad)
                    choices("Matches the agreed price?", [("yes", "Yes"), ("no", "No")],
                            compliant.map { $0 ? "yes" : "no" }, "activityCompliant") { compliant = $0 == "yes" }
                default:
                    Text("This activity can't be recorded on this phone. Ask your office.")
                        .font(SunprideTokens.TypeStyle.row)
                }
            }
            .padding(16)
        }
        .background(SunprideTokens.background)
        .foregroundStyle(SunprideTokens.text)
        .navigationTitle(ActivityRules.kindLabel(kind))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: 12) {
                if let message {
                    Text(message).font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.secondaryText)
                        .accessibilityIdentifier("activityMessage")
                }
                PrimaryBottomButton(title: "Save", disabled: (try? build()) == nil, action: save)
                    .accessibilityIdentifier("activitySave")
            }
            .padding(16)
            .background(SunprideTokens.background)
        }
    }

    private func save() {
        do {
            try model.queueActivity(try build(), for: visit)
            textFocused = false
            dismiss()
        } catch let error as ActivityForms.Failure { message = error.message }
        catch let error as AppModel.CallFailure { message = error.message }
        catch StoreError.leaseExpired { message = "Reconnect before saving. Your entries are still here." }
        catch StoreError.heldForReview { message = "Work held for review. Contact your supervisor." }
        catch { message = "Could not save this activity. Check the fields and sync." }
    }

    private func choices(_ title: String, _ options: [(code: String, label: String)], _ value: String?,
                         _ id: String, choose: @escaping (String) -> Void) -> some View {
        SectionCard(title: title) {
            VStack(spacing: 0) {
                ForEach(options, id: \.code) { option in
                    ChoiceRow(label: option.label, selected: value == option.code) { choose(option.code) }
                        .accessibilityIdentifier("\(id)-\(option.code)")
                }
            }
        }
    }
    private func field(_ title: String, _ placeholder: String, keyboard: UIKeyboardType = .default) -> some View {
        SectionCard(title: title) {
            CalmField(label: nil) {
                TextField(placeholder, text: $text)
                    .keyboardType(keyboard)
                    .focused($textFocused)
                    .accessibilityIdentifier("activityText")
            }.padding(16)
        }
    }
}
