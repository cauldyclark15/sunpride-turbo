import SwiftUI
import UIKit

struct SignInShell: View {
    let model: AppModel
    @State private var email = ""
    @State private var password = ""
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
                        } else if model.signedIn && model.enrollment.state.isReady {
                            Text(Date.now.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()))
                                .font(SunprideTokens.TypeStyle.meta)
                                .foregroundStyle(SunprideTokens.secondaryText)
                        }
                    }
                    if !model.signedIn {
                        signInCard
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
                        if !model.signedIn {
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
        if status.needsReview + status.held > 0 || status.otherHeldWork {
            return "\(max(1, status.needsReview + status.held)) to review"
        }
        if status.offline || model.isOffline || status.leaseExpired { return "Offline" }
        if status.sending > 0 || model.syncing { return "Syncing" }
        if status.queued > 0 { return "\(status.queued) waiting" }
        if status.lastErrorCode != nil || status.cacheStale || model.stale { return "Offline" }
        return "Synced"
    }
    private var canSubmit: Bool {
        !model.busy && !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty
    }
    private var signInCard: some View {
        SectionCard(title: "Credentials") {
            VStack(alignment: .leading, spacing: 16) {
                CalmField(label: "Email") {
                    TextField("", text: $email)
                        .textContentType(.username).keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("emailField")
                }
                CalmField(label: "Password") {
                    SecureField("", text: $password)
                        .textContentType(.password)
                        .onSubmit(submit)
                        .accessibilityIdentifier("passwordField")
                }
                if let error = model.signInError {
                    Text(error).font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.dangerText)
                        .accessibilityIdentifier("signInError")
                }
            }.padding(16)
        }
    }
    private func submit() {
        guard canSubmit else { return }
        let submittedPassword = password
        password = ""
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
