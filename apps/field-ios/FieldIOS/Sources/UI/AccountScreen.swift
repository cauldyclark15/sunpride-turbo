import SwiftUI

struct AccountScreen: View {
    let model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    private let features = FieldFeatures.current

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Account").font(SunprideTokens.TypeStyle.title)
                    let diagnostics = DeviceDiagnostics.current(keyStorage: model.enrollment.key?.storage)
                    SectionCard(title: "Phone") {
                        DetailRow(label: "Model", value: diagnostics.model)
                        DetailRow(label: "OS", value: diagnostics.osVersion)
                        DetailRow(label: "App version", value: diagnostics.appVersion)
                        // Technical phone-key rows: hidden in the beta (`FieldFeature.phoneKeyDetails`). The phone code
                        // the admin needs stays on "Register phone" and in Support info.
                        if features.contains(.phoneKeyDetails) {
                            DetailRow(label: "Key storage", value: diagnostics.keyStorage)
                                .accessibilityIdentifier("keyStorage")
                            if let key = model.enrollment.key {
                                DetailRow(label: "Fingerprint", value: key.fingerprint)
                            }
                        }
                    }
                    SectionCard(title: "Help") {
                        NavigationLink(destination: SupportInfoScreen(model: model)) {
                            CalmListRow(symbol: "questionmark.circle", title: "Support info", meta: "", trailing: "chevron.right")
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("supportInfoLink")
                        // SP-0132: opens the Sunpride web tracker (`<web>/issues/new`); hidden without a web URL.
                        if let url = features.reportIssueURL {
                            Button { openURL(url) } label: {
                                CalmListRow(symbol: "exclamationmark.bubble", title: "Report an issue",
                                            meta: "Tell the Sunpride team what went wrong", trailing: "arrow.up.right")
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("reportIssueLink")
                        }
                    }
                }
                .padding(16)
                .padding(.bottom, 16)
            }
            .background(SunprideTokens.background)
            .safeAreaInset(edge: .bottom) {
                SecondaryButton(title: "Sign out", destructive: true, fullWidth: true) {
                    dismiss()
                    Task { await model.signOut() }
                }
                .accessibilityIdentifier("signOutButton")
                .padding(16)
                .background(SunprideTokens.background)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }.foregroundStyle(SunprideTokens.text)
                }
            }
        }
    }
}
