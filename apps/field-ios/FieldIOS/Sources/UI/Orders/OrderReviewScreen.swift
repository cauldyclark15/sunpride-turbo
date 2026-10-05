import SwiftUI

/// SP-0043 (IOS-015) review step: the lines, totals (units per UOM; never an amount while prices are
/// unavailable), the rules the phone can check offline, then Send. After sending, the same screen
/// shows the order's sync status from the durable outbox.
struct OrderReviewScreen: View {
    let model: AppModel
    let draftId: String
    @State private var message: String?
    @State private var confirming = false
    @Environment(\.dismiss) private var dismiss

    private var draft: OrderDraft? { model.orderDrafts.first { $0.draftId == draftId } }

    var body: some View {
        ScrollView {
            if let draft { content(draft) } else {
                Text(OrderDraftFailure.unknownDraft.message).font(SunprideTokens.TypeStyle.row).padding(16)
            }
        }
        .background(SunprideTokens.background)
        .foregroundStyle(SunprideTokens.text)
        .navigationTitle("Order")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .safeAreaInset(edge: .bottom) {
            if let draft, !model.orderStatus(draft).sent, model.orderStatus(draft) != .notSent {
                let ready = model.orderChecks(draft).allSatisfy { $0.ok || !$0.blocking }
                HStack(spacing: 12) {
                    SecondaryButton(title: "Edit") { dismiss() }
                        .accessibilityIdentifier("orderEdit")
                    PrimaryBottomButton(title: "Send order", disabled: !ready) { confirming = true }
                        .accessibilityIdentifier("orderSubmit")
                }
                .padding(16)
                .background(SunprideTokens.background)
            }
        }
        .confirmationDialog("Send this order?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Send now") { submit() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A sent order can't be changed on the phone.")
        }
    }

    @ViewBuilder private func content(_ draft: OrderDraft) -> some View {
        let status = model.orderStatus(draft)
        let totals = OrderSubmission.totals(draft)
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(status.sent ? "Sent order" : "Review order").font(SunprideTokens.TypeStyle.title)
                    .accessibilityIdentifier("orderReviewTitle")
                Text(association(draft)).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(status.label).font(SunprideTokens.TypeStyle.row)
                    .foregroundStyle(isReview(status) ? SunprideTokens.dangerText : SunprideTokens.text)
                    .accessibilityIdentifier("orderStatus")
                if case .needsReview(let code) = status {
                    Text(OrderSubmission.reviewReason(code)).font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.secondaryText)
                }
            }
            SectionCard(title: "Products") {
                VStack(spacing: 0) {
                    ForEach(draft.lines, id: \.productId) { line in
                        CalmListRow(symbol: "shippingbox", title: line.name,
                                    meta: "\(line.code) · \(OrderSubmission.grouped(line.quantity)) \(line.uom)")
                            .accessibilityIdentifier("orderLine-\(line.productId)")
                    }
                }
            }
            SectionCard(title: "Total") {
                DetailRows {
                    DetailRow(label: "Quantity", value: totals.text)
                    DetailRow(label: "Amount", value: "Priced by the office")
                }
                .accessibilityIdentifier("orderTotals")
            }
            if !status.sent {
                SectionCard(title: "Checks") {
                    VStack(spacing: 0) {
                        ForEach(model.orderChecks(draft), id: \.label) { check in
                            CalmListRow(symbol: check.ok ? (check.blocking ? "checkmark.circle" : "info.circle") : "exclamationmark.triangle",
                                        title: check.label, meta: check.problem ?? check.note ?? "OK")
                                .accessibilityIdentifier(check.ok ? "orderCheckOk" : "orderCheckProblem")
                        }
                    }
                }
            }
            Text(footnote(status)).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
            if let message {
                Text(message).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.dangerText)
                    .accessibilityIdentifier("orderMessage")
            }
        }
        .padding(16)
    }

    private func isReview(_ status: OrderSubmission.Status) -> Bool {
        if case .needsReview = status { return true }
        return status == .held
    }

    private func association(_ draft: OrderDraft) -> String {
        let outlet = model.outletDetails[draft.outletId]?.name ?? "Outlet"
        return ([outlet, draft.customerCode.map { "Account \($0)" }, draft.serviceDate] as [String?])
            .compactMap { $0 }.joined(separator: " · ")
    }

    private func footnote(_ status: OrderSubmission.Status) -> String {
        switch status {
        case .received: "The office has this order. Sent orders can't be changed."
        case .notSent: "The call ended before this order was sent. It stays on this phone and is not sent."
        case .draft: "Sending queues this order on the phone. It reaches the office the next time this phone syncs, even if you are offline now."
        default: "Sent orders can't be changed. It reaches the office the next time this phone syncs."
        }
    }

    private func submit() {
        do { try model.submitOrderDraft(draftId); message = nil }
        catch let failure as OrderDraftFailure { message = failure.message }
        catch StoreError.leaseExpired { message = OrderDraftFailure.offlineExpired.message }
        catch StoreError.heldForReview { message = OrderDraftFailure.held.message }
        catch { message = "Could not send the order. Check it and try again." }
    }
}
