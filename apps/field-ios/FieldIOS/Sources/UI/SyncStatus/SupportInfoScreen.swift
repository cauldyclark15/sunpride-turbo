import SwiftUI
import UIKit

struct SupportInfoScreen: View {
    let model: AppModel
    @State private var copied = false
    var body: some View {
        let text = model.supportText
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Support info").font(.title2.bold())
                Text("This report contains no account, device key, location or request body.")
                Text(text).font(.body.monospaced()).textSelection(.enabled)
                    .accessibilityIdentifier("supportInfoText")
                Button(copied ? "Copied" : "Copy support info") {
                    UIPasteboard.general.string = text
                    copied = true
                }.accessibilityIdentifier("copySupportInfo")
            }.padding()
        }.navigationTitle("Support info")
    }
}
