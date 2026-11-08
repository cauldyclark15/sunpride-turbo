import SwiftUI

/// Sign in with the office email and password. The session goes to the Keychain; the password is never kept.
struct SignInView: View {
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var problem: String?
    @FocusState private var focus: Field?
    enum Field { case email, password }

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                VStack(spacing: 14) {
                    Image("SunprideLogo")
                        .resizable().scaledToFit()
                        .frame(width: 88, height: 88)
                        .clipShape(.rect(cornerRadius: 20, style: .continuous))
                        .accessibilityHidden(true)
                    Text("Sunpride Office")
                        .font(.largeTitle.weight(.bold))
                    Text("Sales, stock, cash and approvals for the office, wherever you are.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 48)

                VStack(spacing: 12) {
                    TextField("Work email", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .focused($focus, equals: .email)
                        .onSubmit { focus = .password }
                        .padding(14)
                        .background(.background.secondary, in: .rect(cornerRadius: 14, style: .continuous))
                        .accessibilityIdentifier("signin.email")
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .submitLabel(.go)
                        .focused($focus, equals: .password)
                        .onSubmit(submit)
                        .padding(14)
                        .background(.background.secondary, in: .rect(cornerRadius: 14, style: .continuous))
                        .accessibilityIdentifier("signin.password")
                }

                if let message = problem ?? model.signOutReason {
                    Label(message, systemImage: "exclamationmark.circle")
                        .font(.callout)
                        .foregroundStyle(Brand.bad)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("signin.problem")
                }

                Button(action: submit) {
                    Group {
                        if busy { ProgressView().tint(.white) } else { Text("Sign in").fontWeight(.semibold) }
                    }
                    .frame(maxWidth: .infinity, minHeight: 30)
                }
                .buttonStyle(.glassProminent)
                .tint(Brand.action)
                .controlSize(.large)
                .disabled(busy || email.isEmpty || password.isEmpty)
                .accessibilityIdentifier("signin.submit")

                Text("Use the same email and password as the Sunpride office website.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: 440)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color(.systemGroupedBackground))
    }

    private func submit() {
        guard !busy, !email.isEmpty, !password.isEmpty else { return }
        busy = true
        problem = nil
        Task {
            defer { busy = false }
            do {
                try await model.signIn(email: email, password: password)
                password = ""
                Haptics.success()
            } catch let e as OfficeError {
                problem = e.localizedDescription
                Haptics.warning()
            } catch {
                problem = OfficeError.invalidResponse.localizedDescription
            }
        }
    }
}

struct MisconfiguredView: View {
    var body: some View {
        ContentUnavailableView("No Sunpride server address",
                               systemImage: "server.rack",
                               description: Text("This build has no valid Sunpride server address. Install the latest Sunpride Office build."))
    }
}
