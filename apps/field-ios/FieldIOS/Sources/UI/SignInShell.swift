import SwiftUI
import UIKit

struct SignInShell: View {
    let model: AppModel
    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    private enum PasswordFocus { case secure, plain }
    @FocusState private var passwordFocus: PasswordFocus?
    @State private var showSyncStatus = false
    @State private var showAccount = false
    @State private var copiedCode = false
    @State private var showFullCode = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 8) {
                        Spacer()
                        if model.signedIn {
                            if case .sharing = model.liveLocation.status {
                                LocationSharingPill().accessibilityIdentifier("locationSharingPill")
                            }
                            if model.enrollment.state.isReady {
                                Button { showSyncStatus = true } label: { StatusPill(label: compactSyncLabel) }
                                    .accessibilityIdentifier("outboxStatus")
                            }
                            Button { showAccount = true } label: {
                                Image(systemName: "person.crop.circle")
                                    .font(.system(size: 20))
                                    .foregroundStyle(SunprideTokens.text)
                                    .frame(width: 44, height: 44)
                            }
                            .accessibilityLabel("Account")
                            .accessibilityIdentifier("accountButton")
                        }
                    }
                    .frame(height: 44)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(screenTitle)
                            .font(SunprideTokens.TypeStyle.title)
                            .foregroundStyle(SunprideTokens.text)
                            .accessibilityIdentifier(titleIdentifier)
                        if model.enrollment.state == .removed && model.signedIn {
                            Text("Ask your admin to re-add this phone")
                                .font(SunprideTokens.TypeStyle.body)
                                .foregroundStyle(SunprideTokens.secondaryText)
                            if let status = model.syncStatus, status.held + status.queued + status.needsReview > 0 {
                                Text("\(status.held + status.queued + status.needsReview) unsent on this phone")
                                    .font(SunprideTokens.TypeStyle.meta)
                                    .foregroundStyle(SunprideTokens.secondaryText)
                            }
                            if let message = model.enrollment.message {
                                Text(message).font(SunprideTokens.TypeStyle.meta)
                                    .foregroundStyle(SunprideTokens.dangerText)
                                    .accessibilityIdentifier("enrollmentMessage")
                            }
                        }
                    }
                    if !model.signedIn {
                        if locked { lockCard } else { signInCard }
                    } else if model.enrollment.state != .removed {
                        if model.enrollment.state.isReady || !model.visits.isEmpty {
                            TodayScreen(model: model)
                        } else {
                            EnrollmentCard(model: model, showFullCode: $showFullCode)
                        }
                    }
                }
                .frame(maxWidth: 520, alignment: .leading)
                .padding(16)
                .padding(.bottom, pinnedAction ? 64 : 16)
            }
            .background(SunprideTokens.background)
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .bottom) {
                if pinnedAction {
                    Group {
                        if !model.signedIn && locked, let gate = model.biometrics {
                            VStack(spacing: 8) {
                                SecondaryButton(title: "Use password", fullWidth: true) { gate.usePassword() }
                                    .accessibilityIdentifier("biometricUsePassword")
                                PrimaryBottomButton(title: "Use \(gate.name)", disabled: gate.busy) {
                                    Task { await model.unlockWithBiometrics() }
                                }
                                .accessibilityIdentifier("biometricUnlock")
                            }
                        } else if !model.signedIn {
                            PrimaryBottomButton(title: model.busy ? "Signing in…" : "Sign in", disabled: !canSubmit, action: submit)
                                .accessibilityIdentifier("signInButton")
                        } else if model.enrollment.state == .removed {
                            VStack(spacing: 8) {
                                SecondaryButton(title: "Sign out", destructive: true, fullWidth: true) { Task { await model.signOut() } }
                                    .accessibilityIdentifier("signOutButton")
                                PrimaryBottomButton(title: "Check again") { Task { await model.enrollment.check() } }
                                    .accessibilityIdentifier("checkRegistration")
                            }
                        } else if let key = model.enrollment.key {
                            VStack(spacing: 8) {
                                SecondaryButton(title: "Check again", fullWidth: true) { Task { await model.enrollment.check() } }
                                    .accessibilityIdentifier("checkRegistration")
                                PrimaryBottomButton(title: copiedCode ? "Copied" : "Copy code") {
                                    UIPasteboard.general.string = key.publicKeyBase64
                                    #if DEBUG
                                    _ = try? PublicKeyExport.write(publicKeyBase64: key.publicKeyBase64)
                                    #endif
                                    copiedCode = true
                                }
                                .accessibilityIdentifier("copyPublicKey")
                            }
                        }
                    }
                    .padding(16)
                    .background(SunprideTokens.background)
                }
            }
            .sheet(isPresented: $showSyncStatus) { SyncStatusDetail(model: model) }
            .sheet(isPresented: $showAccount) { AccountScreen(model: model) }
            .sheet(isPresented: Binding(get: { model.liveLocation.consentRequested && model.signedIn },
                                        set: { if !$0 { model.liveLocation.consentRequested = false } })) {
                LocationConsentScreen(model: model)
            }
            .alert("Use \(model.biometrics?.name ?? "Face ID") to sign in next time?", isPresented: offerShown) {
                Button("Not now", role: .cancel) { model.biometrics?.decline() }
                    .accessibilityIdentifier("biometricOfferNotNow")
                Button("Turn on") { Task { await model.biometrics?.enable() } }
                    .accessibilityIdentifier("biometricOfferTurnOn")
            } message: {
                Text("Your password is never saved. If a face or finger is added to this phone, you'll sign in with your password again.")
            }
            .refreshable { if model.signedIn { await model.syncNow() } }
            .onChange(of: model.enrollment.state) { _, state in
                Task { await model.phoneStateChanged(state) }
            }
        }
        #if DEBUG
        .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("-calmDarkMode") ? .dark :
                              ProcessInfo.processInfo.arguments.contains("-calmLightMode") ? .light : nil)
        #endif
    }

    /// SP-0133: a Face ID-protected session waits for the system prompt.
    private var locked: Bool { model.biometrics?.step == .locked }
    private var offerShown: Binding<Bool> {
        Binding(get: { model.signedIn && model.biometrics?.offer == true },
                set: { if !$0 { model.biometrics?.decline() } })
    }
    private var lockCard: some View {
        SectionCard(title: "Signed in") {
            VStack(alignment: .leading, spacing: 8) {
                Text("Unlock with \(model.biometrics?.name ?? "Face ID") to open today's work.")
                    .font(SunprideTokens.TypeStyle.body)
                    .foregroundStyle(SunprideTokens.text)
                    .accessibilityIdentifier("biometricLocked")
                Text("Or sign in with your password.")
                    .font(SunprideTokens.TypeStyle.meta)
                    .foregroundStyle(SunprideTokens.secondaryText)
            }.padding(16)
        }
    }

    private var pinnedAction: Bool {
        !model.signedIn || model.enrollment.state == .removed ||
        (!model.enrollment.state.isReady && model.visits.isEmpty && model.enrollment.key != nil)
    }
    private var screenTitle: String {
        if !model.signedIn { return "Sunpride Field" }
        if model.enrollment.state == .removed { return "Phone removed" }
        if model.enrollment.state.isReady || !model.visits.isEmpty { return "Today" }
        return "Register phone"
    }
    private var titleIdentifier: String {
        if !model.signedIn { return "signInTitle" }
        if model.enrollment.state == .removed { return "phoneRemoved" }
        if model.enrollment.state.isReady || !model.visits.isEmpty { return "todayTitle" }
        return "phoneTitle"
    }
    private var compactSyncLabel: String {
        guard let status = model.syncStatus else { return "Offline" }
        if status.needsReview + status.held + status.photosHeld + status.photosForReview > 0 || status.otherHeldWork {
            return status.label
        }
        if status.queued + status.sending > 0 { return status.label }
        if status.offline || model.isOffline || status.leaseExpired { return "Offline" }
        if status.sending > 0 || model.syncing { return "Syncing" }
        if status.queued > 0 { return "\(status.queued) waiting" }
        if status.lastErrorCode != nil || status.cacheStale || model.stale { return "Offline" }
        if status.photosWaiting > 0 { return "Synced · photos uploading" }
        return "Synced"
    }
    private var canSubmit: Bool {
        !model.busy && !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty
    }
    /// The client's logo (packages/ui/assets/sunpride-logo.jpg, resized only) above the sign-in form.
    private var brandLogo: some View {
        Image("SunprideLogo")
            .resizable()
            .interpolation(.high)
            .scaledToFit()
            .frame(width: 96, height: 96)
            .clipShape(RoundedRectangle(cornerRadius: SunprideTokens.Radius.card))
            .accessibilityLabel("Sunpride")
            .accessibilityIdentifier("sunprideLogo")
    }
    private var signInCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            brandLogo
            credentialsCard
        }
    }
    private var credentialsCard: some View {
        SectionCard(title: "Credentials") {
            VStack(alignment: .leading, spacing: 16) {
                CalmField(label: "Email") {
                    TextField("", text: $email)
                        .textContentType(.username).keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("emailField")
                }
                CalmField(label: "Password") {
                    HStack(spacing: 8) {
                        // Both fields stay on screen (one transparent) so toggling never removes the secure
                        // field: iOS treats a secure field leaving the window as a submitted form and pops
                        // "Save Password?" (seen on jc's iPhone). AutoFill targets the secure field only.
                        ZStack {
                            SecureField("", text: $password)
                                .textContentType(.password)
                                .focused($passwordFocus, equals: .secure)
                                .opacity(showPassword ? 0 : 1)
                                .allowsHitTesting(!showPassword)
                                .accessibilityHidden(showPassword)
                                .onSubmit(submit)
                                .accessibilityIdentifier("passwordField")
                            TextField("", text: $password)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .focused($passwordFocus, equals: .plain)
                                .opacity(showPassword ? 1 : 0)
                                .allowsHitTesting(showPassword)
                                .accessibilityHidden(!showPassword)
                                .onSubmit(submit)
                                .accessibilityIdentifier("passwordField")
                        }
                        // SP-0132: show/hide the typed password (same as Android's eye button).
                        Button {
                            let typing = passwordFocus != nil
                            showPassword.toggle()
                            if typing { passwordFocus = showPassword ? .plain : .secure }
                        } label: {
                            Image(systemName: showPassword ? "eye.slash" : "eye")
                                .font(.system(size: 17))
                                .foregroundStyle(SunprideTokens.secondaryText)
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(showPassword ? "Hide password" : "Show password")
                        .accessibilityIdentifier("passwordVisibility")
                    }
                }
                if let error = model.signInError {
                    Text(error).font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.dangerText)
                        .accessibilityIdentifier("signInError")
                }
                if let gate = model.biometrics, let message = gate.message {
                    Text(message).font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.dangerText)
                        .accessibilityIdentifier("biometricMessage")
                }
                if let gate = model.biometrics, gate.canRetry {
                    SecondaryButton(title: "Use \(gate.name)", disabled: gate.busy, fullWidth: true) {
                        Task { await model.unlockWithBiometrics() }
                    }
                    .accessibilityIdentifier("biometricRetry")
                }
            }.padding(16)
        }
    }
    private func submit() {
        guard canSubmit else { return }
        let submittedPassword = password
        password = ""
        showPassword = false
        Task { await model.signIn(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: submittedPassword) }
    }
}

struct EnrollmentCard: View {
    let model: AppModel
    @Binding var showFullCode: Bool
    private var enrollment: Enrollment { model.enrollment }

    var body: some View {
        SectionCard(title: "Phone code") {
            VStack(alignment: .leading, spacing: 12) {
                if let key = enrollment.key {
                    Text(key.fingerprint.replacingOccurrences(of: "·", with: " "))
                        .font(.system(.title2, design: .monospaced, weight: .semibold))
                        .foregroundStyle(SunprideTokens.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("deviceFingerprint")
                    Text("Send this code to your admin")
                        .font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.secondaryText)
                        .accessibilityIdentifier("notRegisteredTitle")
                    Button(showFullCode ? "Hide full code" : "Show full code") { showFullCode.toggle() }
                        .font(SunprideTokens.TypeStyle.meta.weight(.medium))
                        .foregroundStyle(SunprideTokens.secondaryText)
                        .frame(minHeight: 48)
                    if showFullCode {
                        Text(key.publicKeyBase64)
                            .font(.footnote.monospaced())
                            .foregroundStyle(SunprideTokens.secondaryText)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("devicePublicKey")
                    }
                }
                if let message = enrollment.message {
                    Text(message).font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.dangerText)
                        .accessibilityIdentifier("enrollmentMessage")
                }
            }.padding(16)
        }
    }
}

struct ConfigurationScreen: View {
    let message: String
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Configuration needed").font(SunprideTokens.TypeStyle.title)
            Text(message).font(SunprideTokens.TypeStyle.meta)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(SunprideTokens.background)
    }
}
