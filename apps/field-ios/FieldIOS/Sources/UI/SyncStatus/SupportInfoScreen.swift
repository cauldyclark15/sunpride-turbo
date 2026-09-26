import SwiftUI
import UIKit

struct SupportInfoScreen: View {
    let model: AppModel
    @State private var copied = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        let text = model.supportText
        let diagnostics = DeviceDiagnostics.current(keyStorage: model.enrollment.key?.storage)
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left")
                            .foregroundStyle(SunprideTokens.text)
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityIdentifier("BackButton")
                    Text("Account").font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.secondaryText)
                    Spacer()
                }
                Text("Support").font(SunprideTokens.TypeStyle.title)
                SectionCard(title: "Phone") {
                    DetailRow(label: "Model", value: diagnostics.model)
                    DetailRow(label: "iOS", value: diagnostics.osVersion)
                    DetailRow(label: "App", value: diagnostics.appVersion)
                    DetailRow(label: "Key storage", value: diagnostics.keyStorage)
                        .accessibilityIdentifier("keyStorage")
                }
                SectionCard(title: "Report") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(text).font(.footnote.monospaced()).textSelection(.enabled)
                            .accessibilityIdentifier("supportInfoText")
                        SecondaryButton(title: copied ? "Copied" : "Copy info") {
                            UIPasteboard.general.string = text
                            copied = true
                        }.accessibilityIdentifier("copySupportInfo")
                    }.padding(16)
                }
            }.padding(16)
        }
        .background(SunprideTokens.background)
        .toolbar(.hidden, for: .navigationBar)
    }
}
