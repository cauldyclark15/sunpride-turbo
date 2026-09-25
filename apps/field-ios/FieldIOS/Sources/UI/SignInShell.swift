import SwiftUI
import UIKit

struct SyncStatusPill: View {
    let pill: AppModel.Pill
    init(_ pill: AppModel.Pill = .signedOut) { self.pill = pill }

    private var icon: String {
        switch pill {
        case .signedOut: "wifi.slash"
        case .checking: "arrow.triangle.2.circlepath"
        case .notRegistered: "iphone.slash"
        case .ready: "checkmark.circle.fill"
        case .removed: "xmark.octagon.fill"
        }
    }
    private var background: Color {
        switch pill {
        case .ready: Color(uiColor: SunprideTokens.success.uiColor)
        case .removed: Color(uiColor: SunprideTokens.danger.uiColor)
        default: SunprideTokens.warning
        }
    }
    private var foreground: Color {
        pill == .removed ? Color(uiColor: SunprideTokens.snow.uiColor) : SunprideTokens.warningText
    }

    var body: some View {
        Label(pill.label, systemImage: icon)
            .font(SunprideTokens.TypeStyle.caption.weight(.semibold))
            .foregroundStyle(foreground)
            .padding(.horizontal, SunprideTokens.Space.three)
            .padding(.vertical, SunprideTokens.Space.two)
            .background(background, in: Capsule())
            .accessibilityIdentifier("syncStatus")
    }
}

struct SignInShell: View {
    let model: AppModel
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: SunprideTokens.Space.six) {
                    SyncStatusPill(model.pill)
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
                    if model.signedIn {
                        EnrollmentCard(model: model)
                    } else {
                        signInCard
                    }
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

    private var canSubmit: Bool {
        !model.busy && !email.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
    }

    private var signInCard: some View {
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
                .onSubmit(submit)
                .accessibilityIdentifier("passwordField")
            Button(action: submit) {
                HStack(spacing: SunprideTokens.Space.two) {
                    if model.busy { ProgressView().tint(SunprideTokens.actionText) }
                    Text(model.busy ? "Signing in…" : "Sign in").fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity, minHeight: 48)
                .foregroundStyle(SunprideTokens.actionText)
                .background(SunprideTokens.actionBackground.opacity(canSubmit || model.busy ? 1 : 0.45),
                            in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.field))
            }
            .disabled(!canSubmit)
            .accessibilityIdentifier("signInButton")
            if let error = model.signInError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(SunprideTokens.dangerText)
                    .accessibilityIdentifier("signInError")
            }
        }
        .textFieldStyle(.roundedBorder)
        .padding(SunprideTokens.Space.six)
        .background(SunprideTokens.card, in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.field))
    }

    private func submit() {
        guard canSubmit else { return }
        let submittedPassword = password
        password = "" // Never retained after submission.
        Task { await model.signIn(email: email, password: submittedPassword) }
    }
}

struct EnrollmentCard: View {
    let model: AppModel
    @State private var copied = false
    private var enrollment: Enrollment { model.enrollment }

    var body: some View {
        VStack(alignment: .leading, spacing: SunprideTokens.Space.four) {
            switch enrollment.state {
            case .ready:
                Label("Phone ready", systemImage: "checkmark.seal.fill")
                    .font(SunprideTokens.TypeStyle.heading)
                    .accessibilityIdentifier("phoneReady")
                Text("This phone is registered and bound to your account.")
            case .removed:
                Label("This phone was removed — ask your admin", systemImage: "xmark.octagon.fill")
                    .font(SunprideTokens.TypeStyle.heading)
                    .accessibilityIdentifier("phoneRemoved")
                Text("It can no longer sync. Any unsent work stays on this phone for review.")
            case .binding:
                Label("Securing this phone…", systemImage: "lock.rotation")
                    .font(SunprideTokens.TypeStyle.heading)
            case .checking, .signedOut:
                Label("Checking this phone…", systemImage: "arrow.triangle.2.circlepath")
                    .font(SunprideTokens.TypeStyle.heading)
            case .notRegistered, .unverified:
                registration
            }
            if let message = enrollment.message {
                Text(message)
                    .foregroundStyle(SunprideTokens.dangerText)
                    .accessibilityIdentifier("enrollmentMessage")
            }
            Button("Check again") { Task { await enrollment.check() } }
                .accessibilityIdentifier("checkRegistration")
            Button("Sign out", role: .destructive) { Task { await model.signOut() } }
                .accessibilityIdentifier("signOutButton")
        }
        .padding(SunprideTokens.Space.six)
        .background(SunprideTokens.card, in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.field))
    }

    @ViewBuilder private var registration: some View {
        let diagnostics = DeviceDiagnostics.current(keyStorage: enrollment.key?.storage)
        Text(enrollment.state == .unverified ? "Can't confirm this phone yet" : "This phone isn't registered yet")
            .font(SunprideTokens.TypeStyle.heading)
            .accessibilityIdentifier("notRegisteredTitle")
        Text("Send this public key to your administrator. This screen checks again every 10 seconds.")
            .foregroundStyle(SunprideTokens.secondaryText)
        if let key = enrollment.key {
            Text("Public key (SPKI, base64)").font(SunprideTokens.TypeStyle.body.weight(.semibold))
            Text(key.publicKeyBase64)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .accessibilityIdentifier("devicePublicKey")
            Text("Fingerprint: \(key.fingerprint)")
                .font(.callout.monospaced())
                .accessibilityIdentifier("deviceFingerprint")
            Button(copied ? "Copied" : "Copy public key") {
                UIPasteboard.general.string = key.publicKeyBase64
                #if DEBUG
                // DEV-only: also drop the PUBLIC key in Documents for `xcrun simctl get_app_container`.
                _ = try? PublicKeyExport.write(publicKeyBase64: key.publicKeyBase64)
                #endif
                copied = true
            }
            .accessibilityIdentifier("copyPublicKey")
        }
        VStack(alignment: .leading, spacing: SunprideTokens.Space.one) {
            Text("Model: \(diagnostics.model)")
            Text("iOS \(diagnostics.osVersion) · App \(diagnostics.appVersion)")
            Text("Key storage: \(diagnostics.keyStorage)").accessibilityIdentifier("keyStorage")
        }
        .font(SunprideTokens.TypeStyle.caption)
        .foregroundStyle(SunprideTokens.secondaryText)
    }
}

struct ConfigurationScreen: View {
    let message: String
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SyncStatusPill()
            Label("Configuration required", systemImage: "exclamationmark.triangle")
            Text(message)
        }.padding().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
