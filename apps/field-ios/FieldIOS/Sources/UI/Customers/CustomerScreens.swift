import SwiftUI

/// Customer search (IOS-011): searches only the outlets downloaded for this person's verified scope,
/// so it works with no signal and can never reveal an outlet outside that scope.
struct CustomerSearchScreen: View {
    let model: AppModel
    @State private var query = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let all = model.customers
        let results = CustomerDirectory.search(all, query: query)
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left")
                            .foregroundStyle(SunprideTokens.text)
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Back")
                    .accessibilityIdentifier("BackButton")
                    Text("Today").font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.secondaryText)
                    Spacer()
                }
                Text("Customers").font(SunprideTokens.TypeStyle.title)
                    .foregroundStyle(SunprideTokens.text)
                    .accessibilityIdentifier("customersTitle")
                CalmField(label: nil) {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(SunprideTokens.secondaryText)
                            .accessibilityHidden(true)
                        TextField("Search name, code or address", text: $query)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.search)
                            .onChange(of: query) { _, value in if value.count > 80 { query = String(value.prefix(80)) } }
                            .accessibilityIdentifier("customerSearch")
                    }
                }
                Text(countLabel(all: all.count, shown: results.count))
                    .font(SunprideTokens.TypeStyle.meta)
                    .foregroundStyle(SunprideTokens.secondaryText)
                    .accessibilityIdentifier("customerCount")
                if all.isEmpty {
                    Text("Sync to download the outlets on your plan")
                        .font(SunprideTokens.TypeStyle.body).foregroundStyle(SunprideTokens.text)
                        .accessibilityIdentifier("customerEmpty")
                } else if results.isEmpty {
                    Text("No outlet matches \"\(query.trimmingCharacters(in: .whitespaces))\". Only outlets on your plan are on this phone.")
                        .font(SunprideTokens.TypeStyle.body).foregroundStyle(SunprideTokens.text)
                        .accessibilityIdentifier("customerNoMatch")
                } else {
                    SectionCard(title: "Outlets") {
                        ForEach(results) { record in
                            NavigationLink { CustomerDetailScreen(model: model, outletId: record.outletId) } label: {
                                CalmListRow(symbol: "storefront", title: record.name, meta: meta(record), trailing: "chevron.right")
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("customerResult-\(record.outletId)")
                        }
                    }
                }
            }
            .frame(maxWidth: 520, alignment: .leading)
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(SunprideTokens.background)
        .toolbar(.hidden, for: .navigationBar)
    }

    private func countLabel(all: Int, shown: Int) -> String {
        let count: String
        if all == 0 { count = "No outlets on this phone" }
        else if query.trimmingCharacters(in: .whitespaces).isEmpty { count = "\(all) \(all == 1 ? "outlet" : "outlets")" }
        else { count = "\(shown) of \(all) outlets" }
        return model.isOffline || model.stale ? "\(count) · Saved on this phone" : count
    }

    private func meta(_ record: CustomerRecord) -> String {
        let when: String? = record.today != nil ? "Today"
            : record.planned.first.map { CustomerDirectory.dayLabel($0.serviceDate, now: Date()) }
        return [record.codes, when, record.displayAddress].compactMap { $0 }.joined(separator: " · ")
    }
}

/// Outlet detail: account summary, route, planned calls and tasks, this phone's recent history and
/// the actions a salesperson takes from here (directions, call the buyer, open the visit).
struct CustomerDetailScreen: View {
    let model: AppModel
    let outletId: String
    @State private var actionError: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left")
                            .foregroundStyle(SunprideTokens.text)
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Back")
                    .accessibilityIdentifier("BackButton")
                    Text("Customers").font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.secondaryText)
                    Spacer()
                }
                if let record = model.customers.first(where: { $0.outletId == outletId }) {
                    content(record)
                } else {
                    // Sign-out, revocation or a scope change removed this outlet from the phone.
                    Text("This outlet is no longer on this phone")
                        .font(SunprideTokens.TypeStyle.body).foregroundStyle(SunprideTokens.text)
                        .accessibilityIdentifier("customerGone")
                }
            }
            .frame(maxWidth: 520, alignment: .leading)
            .padding(16)
        }
        .background(SunprideTokens.background)
        .toolbar(.hidden, for: .navigationBar)
    }

    @ViewBuilder private func content(_ record: CustomerRecord) -> some View {
        let now = Date()
        VStack(alignment: .leading, spacing: 4) {
            Text(record.name).font(SunprideTokens.TypeStyle.title)
                .foregroundStyle(SunprideTokens.text)
                .accessibilityIdentifier("customerTitle")
            let sub = [record.codes, model.stale ? "Saved on this phone" : nil].compactMap { $0 }.joined(separator: " · ")
            if !sub.isEmpty {
                Text(sub).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                    .accessibilityIdentifier("customerSubtitle")
            }
        }
        HStack(spacing: 8) {
            SecondaryButton(title: "Directions", disabled: record.directionsURL == nil, fullWidth: true) {
                guard let url = record.directionsURL else { return }
                openURL(url) { accepted in actionError = accepted ? nil : "No maps app on this phone" }
            }
            .accessibilityIdentifier("customerDirections")
            SecondaryButton(title: "Call", disabled: record.dialURL == nil, fullWidth: true) {
                guard let url = record.dialURL else { return }
                openURL(url) { accepted in actionError = accepted ? nil : "This device cannot place calls" }
            }
            .accessibilityIdentifier("customerCall")
        }
        #if DEBUG
        if let visit = record.today ?? model.visits.first(where: { !$0.planned && $0.outletId == record.outletId }) {
            NavigationLink { DiagnosticVisitScreen(model: model, visit: visit) } label: {
                Text(visitTitle(record)).font(SunprideTokens.TypeStyle.row)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .foregroundStyle(SunprideTokens.actionText)
                    .background(SunprideTokens.actionBackground, in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.control))
            }
            .accessibilityIdentifier("customerVisit")
        }
        #endif
        if let actionError {
            Text(actionError).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.dangerText)
                .accessibilityIdentifier("customerActionError")
        }

        SectionCard(title: "Summary") {
            DetailRows {
                DetailRow(label: "Outlet code", value: record.outletCode ?? "Not sent")
                if let code = record.customerCode { DetailRow(label: "Customer code", value: code) }
                DetailRow(label: "Address", value: record.displayAddress ?? "No address yet")
                DetailRow(label: "Location", value: record.location != nil ? "Verified pin"
                          : record.directionsURL != nil ? "Address only, no verified pin" : "No pin or address yet")
                if let account = record.account {
                    if account.accountName != record.name { DetailRow(label: "Account", value: account.accountName) }
                    optional("Buyer", account.buyerName)
                    optional("Contact", account.contactNumber)
                    optional("Account in charge", account.accountInCharge)
                    optional("Receiving", account.receivingInCharge)
                    optional("Distributor", account.distributorName)
                    optional("Delivery schedule", account.distributorSchedule)
                    optional("FOC", account.foc)
                } else {
                    note("No account sheet set up by the office yet")
                }
            }
        }

        SectionCard(title: "Route") {
            DetailRows {
                DetailRow(label: "Route", value: record.routeCode ?? (record.routeId == nil ? "Not on a route" : "Another route"))
                if let today = record.today, let position = record.todayPosition {
                    DetailRow(label: "Today", value: "Stop \(position) of \(model.visits.filter(\.planned).count) · \(todayState(today))")
                        .accessibilityIdentifier("customerToday")
                    if let spent = today.timeSpent { DetailRow(label: "Time spent", value: spent) }
                } else {
                    DetailRow(label: "Today", value: "Not on today's plan").accessibilityIdentifier("customerToday")
                }
            }
        }

        SectionCard(title: "Planned visits") {
            DetailRows {
                if record.planned.isEmpty { note("No planned visits in the downloaded days") }
                ForEach(record.planned, id: \.plannedVisitId) { plan in
                    DetailRow(label: CustomerDirectory.dayLabel(plan.serviceDate, now: now),
                              value: plan.intents.isEmpty ? "Visit" : plan.intents.map(CustomerDirectory.kindLabel).joined(separator: ", "))
                }
            }
        }

        SectionCard(title: "Tasks") {
            DetailRows {
                let todays = record.today?.intents ?? []
                ForEach(todays, id: \.self) { DetailRow(label: CustomerDirectory.kindLabel($0), value: "This outlet today") }
                ForEach(model.dayTasks, id: \.id) { task in
                    DetailRow(label: CustomerDirectory.kindLabel(task.kind), value: task.required ? "Required · your day" : "Your day")
                }
                if todays.isEmpty && model.dayTasks.isEmpty { note("No tasks for this outlet today") }
            }
        }

        SectionCard(title: "Sales and orders") {
            DetailRows {
                let rows = CustomerDirectory.salesRows(record.summary, now: now)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    DetailRow(label: row.label, value: row.value)
                }
                if let summary = record.summary, summary.isAvailable {
                    let when = CustomerDirectory.dayLabel(summary.asOfDate, now: now)
                    note("Office orders as of \(when == "Today" ? "today" : when). Open orders are not delivered yet; unpaid invoices are not shown.")
                        .accessibilityIdentifier("customerSalesNote")
                } else if record.summary != nil {
                    note("This account is shared with outlets outside your plan, so its figures are not on this phone")
                        .accessibilityIdentifier("customerSalesWithheld")
                } else {
                    note(record.customerCode == nil ? "No customer account linked to this outlet"
                         : "Sync to download this account's sales")
                        .accessibilityIdentifier("customerSalesMissing")
                }
            }
        }

        SectionCard(title: "Recent history") {
            DetailRows {
                if record.history.isEmpty { note("Nothing recorded here from this phone yet") }
                ForEach(Array(record.history.enumerated()), id: \.offset) { _, entry in
                    DetailRow(label: entry.label, value: "\(CustomerDirectory.timeLabel(entry.at, now: now)) · \(entry.state)")
                }
                note("Visits recorded on this phone")
            }
        }
    }

    @ViewBuilder private func optional(_ label: String, _ value: String?) -> some View {
        if let value = CustomerDirectory.clean(value) { DetailRow(label: label, value: value) }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.vertical, 12)
    }

    private func todayState(_ visit: AppModel.TodayVisit) -> String {
        switch DailyRoute.baseState(visit) {
        case .needsReview: "To review"
        case .done: "Done"
        case .inProgress: "In progress"
        case .next, .notStarted: "Not started"
        }
    }

    private func visitTitle(_ record: CustomerRecord) -> String {
        guard let today = record.today else { return "Unplanned visit" }
        return DailyRoute.baseState(today) == .inProgress ? "Continue visit" : "Open visit"
    }
}
