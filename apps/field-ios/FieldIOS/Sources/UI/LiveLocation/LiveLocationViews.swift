import SwiftUI
import UIKit

/// SP-0138 Today card: Start day / End day and whether location sharing is on.
struct WorkDayCard: View {
    let model: AppModel
    @Environment(\.openURL) private var openURL
    private var live: LiveLocationController { model.liveLocation }

    var body: some View {
        SectionCard(title: "Work day") {
            VStack(alignment: .leading, spacing: 0) {
                CalmListRow(symbol: symbol, title: title, meta: meta)
                    .accessibilityIdentifier("liveLocationStatus")
                if let action {
                    action.padding(.horizontal, 16).padding(.bottom, 16)
                }
            }
        }
    }

    static func title(_ status: LiveLocationController.Status) -> String {
        switch status {
        case .sharing: "Location sharing on"
        case .permissionOff: "Location sharing off"
        case .off(.dayEnded): "Day ended"
        case .off(.outsideHours): "Outside work hours"
        case .off: "Location sharing off"
        }
    }

    private var title: String { Self.title(live.status) }
    private var symbol: String {
        if case .sharing = live.status { return "location.fill" }
        return "location.slash"
    }
    private var meta: String {
        switch live.status {
        case .sharing(let always):
            var parts = ["Until End day or 10 PM"]
            if let at = live.lastPingAt { parts.append("last \(FieldDay.closeTimeLabel(at))") }
            if live.waiting > 0 { parts.append("\(live.waiting) waiting to send") }
            if !always { parts.append("allow Always to share while the phone is locked") }
            return parts.joined(separator: " · ")
        case .permissionOff: return "Allow location for Sunpride Field in Settings"
        case .off(.noConsent):
            return live.consent == .declined ? "You chose not to share. Your supervisor sees location off." : "Starts with your day"
        case .off(.dayNotStarted): return "Starts with Start day or your first call"
        case .off(.dayEnded): return "Sharing stopped. Start day again if you are still working."
        case .off(.outsideHours): return "Sharing runs 5 AM to 10 PM only"
        case .off(.held): return "Unsent work is held for review"
        case .off(.phoneNotReady), .off(.notSignedIn): return "Starts when this phone is verified"
        }
    }
    private var action: AnyView? {
        switch live.status {
        case .sharing:
            return AnyView(SecondaryButton(title: "End day", fullWidth: true) { Task { await live.endDay() } }
                .accessibilityIdentifier("endDayButton"))
        case .permissionOff:
            return AnyView(SecondaryButton(title: "Open Settings", fullWidth: true) {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }.accessibilityIdentifier("liveLocationSettings"))
        case .off(.noConsent), .off(.dayNotStarted), .off(.dayEnded):
            return AnyView(SecondaryButton(title: "Start day", fullWidth: true) { live.startDay() }
                .accessibilityIdentifier("startDayButton"))
        default: return nil
        }
    }
}

/// Small always-visible indicator in the top bar while sharing is on.
struct LocationSharingPill: View {
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "location.fill").font(.system(size: 11, weight: .semibold))
            Text("Location on")
        }
        .font(SunprideTokens.TypeStyle.caption.weight(.medium))
        .foregroundStyle(SunprideTokens.text)
        .padding(.horizontal, 10)
        .frame(minHeight: 28)
        .background(SunprideTokens.card, in: Capsule())
        .overlay(Capsule().strokeBorder(SunprideTokens.secondaryText.opacity(0.2), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Location sharing on")
    }
}

/// One-time plain-language notice before sharing starts (Data Privacy Act: what, when, who, how long).
struct LocationConsentScreen: View {
    let model: AppModel
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(LocationConsentText.title).font(SunprideTokens.TypeStyle.title)
                        .foregroundStyle(SunprideTokens.text)
                        .accessibilityIdentifier("liveConsentTitle")
                    SectionCard(title: "What is shared") { paragraph(LocationConsentText.what) }
                    SectionCard(title: "When") { paragraph(LocationConsentText.when) }
                    SectionCard(title: "Who sees it") { paragraph(LocationConsentText.who) }
                    SectionCard(title: "Your choice") {
                        VStack(alignment: .leading, spacing: 0) {
                            paragraph(LocationConsentText.choice)
                            paragraph(LocationConsentText.always)
                        }
                    }
                }
                .padding(16)
                .padding(.bottom, 16)
            }
            .background(SunprideTokens.background)
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    SecondaryButton(title: "Not now", fullWidth: true) { model.liveLocation.answerConsent(false) }
                        .accessibilityIdentifier("liveConsentDecline")
                    PrimaryBottomButton(title: "Agree and continue") { model.liveLocation.answerConsent(true) }
                        .accessibilityIdentifier("liveConsentAccept")
                }
                .padding(16)
                .background(SunprideTokens.background)
            }
        }
        .interactiveDismissDisabled()
    }
    private func paragraph(_ text: String) -> some View {
        Text(text).font(SunprideTokens.TypeStyle.body).foregroundStyle(SunprideTokens.text)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
    }
}
