import SwiftUI

struct AccountScreen: View {
    let model: AppModel
    @Environment(\.dismiss) private var dismiss

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
                        DetailRow(label: "Key storage", value: diagnostics.keyStorage)
                            .accessibilityIdentifier("keyStorage")
                        if let key = model.enrollment.key {
                            DetailRow(label: "Fingerprint", value: key.fingerprint)
                        }
                    }
                    SectionCard(title: "Help") {
                        NavigationLink(destination: SupportInfoScreen(model: model)) {
                            CalmListRow(symbol: "questionmark.circle", title: "Support info", meta: "", trailing: "chevron.right")
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("supportInfoLink")
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
