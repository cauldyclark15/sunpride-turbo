import Foundation

/// SP-0133 launch gate and settings for Face ID / Touch ID sign-in (mirror of Android `BiometricGate`).
/// Main-actor state; the field app's data, held work and sync rules are untouched: the gate only decides
/// whether the stored session is opened before `AppModel.launch` runs.
@MainActor
@Observable
final class BiometricGate {
    enum Step: Equatable {
        /// No biometric session, or it is unlocked: the app runs as before.
        case open
        /// Biometric session waiting for the system prompt.
        case locked
        /// Prompt cancelled/failed: the password screen, optionally with "Use Face ID" again.
        case password
    }

    private(set) var step: Step
    private(set) var message: String?
    /// Offer shown after a password sign-in on a phone with Face ID / Touch ID enrolled.
    private(set) var offer = false
    private(set) var enabled: Bool
    private(set) var busy = false
    /// Bumps on every successful unlock so the app (re)starts with the opened session.
    private(set) var unlocks = 0

    @ObservationIgnored private let vault: LockableSessionStore
    @ObservationIgnored private let crypto: any BiometricCrypto
    /// Generation of the prompt in flight. A result whose generation is no longer current (password sign-in,
    /// sign-out, turning it off, a newer prompt) is ignored; the vault also refuses it when the stored session
    /// changed since the prompt started (`LockableSessionStore.epoch`).
    @ObservationIgnored private var request: UInt64 = 0

    init(vault: LockableSessionStore, crypto: any BiometricCrypto) {
        self.vault = vault
        self.crypto = crypto
        step = vault.isLocked ? .locked : .open
        enabled = vault.biometricOn
    }

    var name: String { crypto.kind.name }
    func availability() -> BiometricAvailability { crypto.availability() }
    /// The password screen may offer the prompt again while the biometric session still exists.
    var canRetry: Bool { step == .password && enabled }

    private func retirePending() { request &+= 1; busy = false }

    /// Shows the system prompt to open the sealed session. Returns once the prompt has answered.
    func unlock() async {
        guard !busy else { return }
        guard vault.biometricOn else { enabled = false; step = .open; return }
        busy = true
        request &+= 1
        let id = request
        let startedAt = vault.epoch
        let prompt = await crypto.authenticate(reason: "Sign in to Sunpride Field")
        // usePassword() keeps the generation: a late success for the SAME session may still open it.
        guard id == request, vault.epoch == startedAt else { return }
        busy = false
        switch prompt {
        case .done(let context):
            switch crypto.read(context: context) {
            case .done(var data):
                let token = String(data: data, encoding: .utf8) ?? ""
                data.resetBytes(in: 0..<data.count)
                switch Result(catching: { try vault.unlock(token, startedAt: startedAt) }) {
                case .success(true): message = nil; step = .open; unlocks += 1
                case .success(false): break // session changed while the prompt was up: stale, ignore
                case .failure: invalidated()
                }
            case .invalidated: invalidated()
            case .failed: message = failedMessage; step = .password
            }
        case .cancelled: message = nil; step = .password
        case .invalidated: invalidated()
        case .lockedOut: message = Self.lockedOut; step = .password
        case .notInteractive: break // cold background launch: stay locked, prompt when the app is opened
        case .failed: message = failedMessage; step = .password
        }
    }

    private func invalidated() {
        try? vault.dropBiometric()
        try? crypto.deleteSealed()
        enabled = false
        message = "\(name) on this phone changed. Sign in with your password, then turn \(name) sign-in on again in Account."
        step = .password
    }

    /// From the lock screen. Always allowed: if a prompt vanished without reporting back, the person must
    /// never be stuck behind it. A late success still unlocks; anything else is ignored.
    func usePassword() {
        busy = false
        message = nil
        if step == .locked { step = .password }
    }

    /// A password sign-in succeeded (the vault already dropped any old biometric session).
    func passwordSignedIn() {
        retirePending()
        enabled = vault.biometricOn
        message = nil
        step = .open
        offer = !enabled && availability() == .available
    }

    /// "Turn on": prompt once, then seal the current session under the biometry-bound Keychain item.
    func enable() async {
        guard !busy else { return }
        offer = false
        guard let token = vault.readSession() else { return }
        busy = true
        request &+= 1
        let id = request
        let startedAt = vault.epoch
        let prompt = await crypto.authenticate(reason: "Turn on \(name) sign-in for Sunpride Field")
        // Stale: the session changed (other account, sign-out) since the prompt opened. Never seal it.
        guard id == request, vault.epoch == startedAt else { return }
        busy = false
        switch prompt {
        case .done(let context):
            do { try crypto.write(Data(token.utf8), context: context) } catch {
                try? crypto.deleteSealed()
                message = enableFailed
                return
            }
            switch Result(catching: { try vault.seal(token, startedAt: startedAt) }) {
            case .success(true): enabled = true; message = nil
            case .success(false): try? crypto.deleteSealed()
            case .failure: try? crypto.deleteSealed(); enabled = vault.biometricOn; message = enableFailed
            }
        case .cancelled, .notInteractive: message = nil
        case .invalidated, .lockedOut, .failed: try? crypto.deleteSealed(); message = enableFailed
        }
    }

    func decline() { offer = false }

    /// Account toggle off: the session returns to the ordinary Keychain copy; the sealed item is deleted.
    func disable() {
        retirePending()
        do { try vault.unseal() } catch {
            enabled = vault.biometricOn
            message = "Couldn't turn off \(name) sign-in. Try again."
            return
        }
        try? crypto.deleteSealed()
        enabled = false
        message = nil
    }

    /// Sign-out (the vault wipe already removed the sealed item) or session expiry.
    func signedOut() {
        retirePending()
        offer = false
        message = nil
        enabled = vault.biometricOn
        step = vault.isLocked ? .locked : .open
    }

    static let lockedOut = "Too many tries. Sign in with your password."
    private var failedMessage: String { "Couldn't use \(name). Sign in with your password." }
    private var enableFailed: String { "Couldn't turn on \(name) sign-in. Try again from Account." }
}
