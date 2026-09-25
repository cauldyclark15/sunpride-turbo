import SwiftUI

struct SyncStatusPill: View {
    var body: some View {
        Label("Offline — not signed in", systemImage: "wifi.slash")
            .font(SunprideTokens.TypeStyle.caption.weight(.semibold))
            .foregroundStyle(SunprideTokens.warningText)
            .padding(.horizontal, SunprideTokens.Space.three)
            .padding(.vertical, SunprideTokens.Space.two)
            .background(SunprideTokens.warning, in: Capsule())
            .accessibilityIdentifier("syncStatus")
    }
}

struct SignInShell: View {
    @State private var email = ""
    @State private var password = ""
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: SunprideTokens.Space.six) {
                    SyncStatusPill()
                    VStack(alignment: .leading, spacing: SunprideTokens.Space.two) {
                        RoundedRectangle(cornerRadius: SunprideTokens.Radius.regular)
                            .fill(SunprideTokens.brand)
                            .frame(width: 48, height: 8)
                            .accessibilityHidden(true)
                        Text("Sunpride Field")
                            .font(SunprideTokens.TypeStyle.title)
                            .foregroundStyle(SunprideTokens.text)
                        Text("Your field day, ready when you are.")
                            .font(SunprideTokens.TypeStyle.body)
                            .foregroundStyle(SunprideTokens.secondaryText)
                    }
                    VStack(alignment: .leading, spacing: SunprideTokens.Space.four) {
                        Text("Sign in").font(SunprideTokens.TypeStyle.heading)
                        Text("Email").font(SunprideTokens.TypeStyle.body.weight(.semibold))
                        TextField("Email", text: $email)
                            .textContentType(.username).keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("emailField")
                        Text("Password").font(SunprideTokens.TypeStyle.body.weight(.semibold))
                        SecureField("Password", text: $password)
                            .textContentType(.password)
                            .accessibilityIdentifier("passwordField")
                        Button("Sign in") {}
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(SunprideTokens.adaptive(.init(hex: 0xEBEBEB), .init(hex: 0x272727)), in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.field))
                            .foregroundStyle(SunprideTokens.text)
                            .disabled(true)
                            .accessibilityIdentifier("signInButton")
                        Text("Sign-in arrives in the next build")
                            .font(SunprideTokens.TypeStyle.caption)
                            .foregroundStyle(SunprideTokens.secondaryText)
                    }
                    .textFieldStyle(.roundedBorder)
                    .padding(SunprideTokens.Space.six)
                    .background(SunprideTokens.card, in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.field))
                    #if DEBUG
                    NavigationLink("Design tokens", destination: DesignTokensPreview())
                        .accessibilityIdentifier("designTokensLink")
                    #endif
                }
                .frame(maxWidth: 520, alignment: .leading)
                .padding(SunprideTokens.Space.six)
            }
            .background(SunprideTokens.background)
        }
    }
}

struct ConfigurationScreen: View {
    let message: String
    var body: some View {
        VStack(alignment: .leading, spacing: SunprideTokens.Space.four) {
            SyncStatusPill()
            Label("Configuration required", systemImage: "exclamationmark.triangle")
                .font(SunprideTokens.TypeStyle.heading)
            Text(message).font(SunprideTokens.TypeStyle.body)
        }
        .foregroundStyle(SunprideTokens.text)
        .padding(SunprideTokens.Space.six)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(SunprideTokens.background)
    }
}
