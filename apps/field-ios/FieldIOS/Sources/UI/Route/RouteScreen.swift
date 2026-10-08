import SwiftUI

/// Today's planned stops in MCP order, read only from the encrypted store (offline-safe).
struct RouteScreen: View {
    let model: AppModel
    @State private var location = LocationCapture()
    @State private var here: StoreSnapshot.Coordinate?
    @State private var locating = true
    @State private var selected: RouteStop?
    @State private var directions = DirectionsLauncher()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    private var stops: [RouteStop] {
        DailyRoute.stops(visits: model.visits, outlets: model.outletDetails,
                         customers: model.customerDetails, here: here,
                         canStart: { model.startFailure(for: $0) == nil })
    }

    var body: some View {
        let stops = stops
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
                VStack(alignment: .leading, spacing: 4) {
                    Text("Route").font(SunprideTokens.TypeStyle.title)
                        .foregroundStyle(SunprideTokens.text)
                        .accessibilityIdentifier("routeTitle")
                    Text(summary(stops)).font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.secondaryText)
                        .accessibilityIdentifier("routeSummary")
                    if let note = distanceNote(stops) {
                        Text(note).font(SunprideTokens.TypeStyle.meta)
                            .foregroundStyle(SunprideTokens.secondaryText)
                            .accessibilityIdentifier("routeDistanceNote")
                    }
                    if let failure = directions.failure {
                        Text(failure).font(SunprideTokens.TypeStyle.meta)
                            .foregroundStyle(SunprideTokens.dangerText)
                            .accessibilityIdentifier("routeDirectionsError")
                    }
                }
                SectionCard(title: "Stops · \(stops.count)") {
                    if stops.isEmpty {
                        CalmListRow(symbol: "calendar", title: "No visits today", meta: "")
                    } else {
                        ForEach(stops) { stop in row(stop) }
                    }
                }
            }
            .frame(maxWidth: 520, alignment: .leading)
            .padding(16)
        }
        .background(SunprideTokens.background)
        .toolbar(.hidden, for: .navigationBar)
        .directionsChoice(directions)
        .sheet(item: $selected) { stop in RouteStopSheet(model: model, stop: stop) }
        .task {
            // Best effort: no permission or no fix simply means no distance.
            if let fix = await location.captureIfAvailable() {
                here = StoreSnapshot.Coordinate(latitude: fix.latitude, longitude: fix.longitude)
            }
            locating = false
        }
    }

    @ViewBuilder private func row(_ stop: RouteStop) -> some View {
        HStack(spacing: 12) {
            Button { selected = stop } label: {
                HStack(spacing: 12) {
                    Text("\(stop.position)")
                        .font(SunprideTokens.TypeStyle.row.monospacedDigit())
                        .foregroundStyle(stop.state == .next ? SunprideTokens.actionText : SunprideTokens.text)
                        .frame(width: 36, height: 36)
                        .background(stop.state == .next ? SunprideTokens.actionBackground : SunprideTokens.background,
                                    in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.control))
                        .accessibilityLabel("Stop \(stop.position)")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(stop.visit.outlet).font(SunprideTokens.TypeStyle.row)
                            .foregroundStyle(SunprideTokens.text)
                        Text(stop.stateLabel).font(SunprideTokens.TypeStyle.meta)
                            .foregroundStyle(stop.state == .needsReview ? SunprideTokens.dangerText : SunprideTokens.secondaryText)
                            .accessibilityIdentifier("routeState-\(stop.id)")
                        if let meta = meta(stop) {
                            Text(meta).font(SunprideTokens.TypeStyle.meta)
                                .foregroundStyle(SunprideTokens.secondaryText)
                                .accessibilityIdentifier("routeMeta-\(stop.id)")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityHint("Shows customer details")
            .accessibilityIdentifier("routeStop-\(stop.id)")
            if let target = stop.navigationTarget {
                Button { directions.request(target) { url, done in openURL(url, completion: done) } } label: {
                    Image(systemName: "arrow.triangle.turn.up.right.diamond")
                        .font(.system(size: 18))
                        .foregroundStyle(SunprideTokens.text)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Directions to \(stop.visit.outlet)")
                .accessibilityIdentifier("routeDirections-\(stop.id)")
            }
        }
        .frame(minHeight: 64)
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }

    private func meta(_ stop: RouteStop) -> String? {
        let parts = [stop.distanceLabel, stop.customerLabel].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func summary(_ stops: [RouteStop]) -> String {
        let done = stops.filter { $0.state == .done }.count
        let head = model.routeCode.map { "Route \($0) · " } ?? ""
        return "\(head)\(done) of \(stops.count) done"
    }

    private func distanceNote(_ stops: [RouteStop]) -> String? {
        guard !locating, here == nil, stops.contains(where: { model.outletDetails[$0.visit.outletId]?.location != nil }) else { return nil }
        return "Turn on location to see distances"
    }
}

/// Quick customer/store access for one stop: codes, address, objectives and directions.
struct RouteStopSheet: View {
    let model: AppModel
    let stop: RouteStop
    @State private var directions = DirectionsLauncher()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(stop.visit.outlet).font(SunprideTokens.TypeStyle.title)
                            .foregroundStyle(SunprideTokens.text)
                            .accessibilityIdentifier("routeCustomerTitle")
                        Text("Stop \(stop.position) · \(stop.stateLabel)").font(SunprideTokens.TypeStyle.meta)
                            .foregroundStyle(SunprideTokens.secondaryText)
                    }
                    SectionCard(title: "Customer") {
                        DetailRows {
                            if let code = stop.outletCode { DetailRow(label: "Store code", value: code) }
                            DetailRow(label: "Customer", value: stop.customerLabel ?? "Not linked")
                                .accessibilityIdentifier("routeCustomerCode")
                            if let address = stop.address { DetailRow(label: "Address", value: address) }
                            if let distance = stop.distanceLabel { DetailRow(label: "Distance", value: distance) }
                            if !stop.visit.intents.isEmpty {
                                DetailRow(label: "Objectives", value: stop.visit.intents.joined(separator: ", "))
                            }
                        }
                    }
                    if let target = stop.navigationTarget {
                        SecondaryButton(title: "Directions", fullWidth: true) {
                            directions.request(target) { url, done in openURL(url, completion: done) }
                        }
                        .accessibilityIdentifier("routeCustomerDirections")
                        if let failure = directions.failure {
                            Text(failure).font(SunprideTokens.TypeStyle.meta)
                                .foregroundStyle(SunprideTokens.dangerText)
                                .accessibilityIdentifier("routeDirectionsError")
                        }
                    } else {
                        Text("No map pin or address for this store yet")
                            .font(SunprideTokens.TypeStyle.meta)
                            .foregroundStyle(SunprideTokens.secondaryText)
                            .accessibilityIdentifier("routeNoDirections")
                    }
                    if FieldFeatures.current.contains(.visits) {
                        NavigationLink {
                            DiagnosticVisitScreen(model: model, visit: stop.visit)
                        } label: {
                            Text("Open visit").font(SunprideTokens.TypeStyle.row)
                                .frame(maxWidth: .infinity, minHeight: 48)
                                .foregroundStyle(SunprideTokens.actionText)
                                .background(SunprideTokens.actionBackground,
                                            in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.control))
                        }
                        .accessibilityIdentifier("routeOpenVisit")
                    }
                }
                .padding(16)
            }
            .background(SunprideTokens.background)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .directionsChoice(directions)
        }
    }
}
