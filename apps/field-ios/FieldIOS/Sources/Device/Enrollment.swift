import Foundation

/// Shapes from `packages/backend/convex/mobile/devices.ts`.
struct MineArgs: Encodable, Equatable { let publicKey: String; let app: String }
struct MineResult: Decodable, Equatable, Sendable {
    let deviceId: String
    let status: String
    let bound: Bool
    let allowedApp: String
}
struct ChallengeArgs: Encodable, Equatable { let deviceId: String }
struct ChallengeResult: Decodable, Equatable, Sendable { let nonce: String; let expiresAt: Double }
struct Attestation: Encodable, Equatable { let format: String; let keyId: String? }
struct BindArgs: Encodable, Equatable {
    let deviceId: String
    let credentialId: String
    let attestation: Attestation
    let nonce: String
    let timestamp: Int64
    let proof: String
}
struct BindResult: Decodable, Equatable, Sendable { let bindingStatus: String }

/// Employee-side device calls, all under the employee's own Convex JWT.
@MainActor
protocol DeviceRegistry: AnyObject {
    func mine(publicKey: String) async throws -> MineResult?
    func challenge(deviceId: String) async throws -> ChallengeResult
    func bind(_ args: BindArgs) async throws -> BindResult
}

@MainActor
final class ConvexDeviceRegistry: DeviceRegistry {
    private let functions: ConvexFunctions
    init(functions: ConvexFunctions) { self.functions = functions }

    func mine(publicKey: String) async throws -> MineResult? {
        try await functions.query("mobile/devices:mine", MineArgs(publicKey: publicKey, app: RequestSigner.app), as: MineResult.self)
    }
    func challenge(deviceId: String) async throws -> ChallengeResult {
        guard let value = try await functions.mutation("mobile/devices:challenge", ChallengeArgs(deviceId: deviceId),
                                                       as: ChallengeResult.self) else { throw MobileError.invalidResponse }
        return value
    }
    func bind(_ args: BindArgs) async throws -> BindResult {
        guard let value = try await functions.mutation("mobile/devices:bind", args, as: BindResult.self) else {
            throw MobileError.invalidResponse
        }
        return value
    }
}

/// Enrollment state machine: not registered → (admin registers) → registered/unbound → bound = ready;
/// revoked (or a previously known device disappearing) = removed. Persisted `deviceId` is non-secret and is
/// re-verified against the server on every launch; nothing is "ready" from local state alone.
@MainActor
@Observable
final class Enrollment {
    enum State: Equatable, Sendable {
        case signedOut
        /// Signed in; the server has not answered yet (first check, or offline since launch).
        case checking
        case unverified
        case notRegistered
        case binding(deviceId: String)
        case ready(deviceId: String)
        case removed
    }

    private(set) var state: State = .signedOut
    private(set) var message: String?
    private(set) var key: (any DeviceSigningKey)?

    private let registry: DeviceRegistry
    private let store: SecretStore
    private let now: @Sendable () -> Date
    private let pollInterval: Duration
    /// Invoked when the server no longer accepts the session (the app must return to sign-in).
    @ObservationIgnored var onSessionEnded: (() -> Void)?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var checkInFlight = false

    init(registry: DeviceRegistry, store: SecretStore, pollInterval: Duration = .seconds(10),
         now: @escaping @Sendable () -> Date = Date.init) {
        self.registry = registry
        self.store = store
        self.pollInterval = pollInterval
        self.now = now
    }

    var persistedDeviceId: String? {
        (try? store.read(StoreAccount.deviceId)).flatMap { $0 }.flatMap { String(data: $0, encoding: .utf8) }
    }

    /// Call after sign-in or on launch with a stored session.
    func start(loadKey: () throws -> any DeviceSigningKey) async {
        do {
            key = try loadKey()
        } catch {
            key = nil
            message = MobileError.deviceKeyUnavailable.description
            state = .notRegistered
            return
        }
        await check()
    }

    /// One `mine` lookup and, when registered but unbound, challenge + bind. Errors keep the current state.
    func check() async {
        guard let key, !checkInFlight else { return }
        checkInFlight = true
        defer { checkInFlight = false; updatePolling() }
        if state == .signedOut || state == .unverified { state = .checking }
        do {
            let found = try await registry.mine(publicKey: key.publicKeyBase64)
            message = nil
            guard let found else {
                // A phone that was known to the server and now isn't must not keep looking usable.
                state = persistedDeviceId == nil ? .notRegistered : .removed
                return
            }
            guard found.allowedApp == RequestSigner.app else { throw MobileError.invalidResponse }
            guard found.status == "active" else {
                try? store.save(Data(found.deviceId.utf8), for: StoreAccount.deviceId)
                state = .removed
                return
            }
            try? store.save(Data(found.deviceId.utf8), for: StoreAccount.deviceId)
            if found.bound {
                state = .ready(deviceId: found.deviceId)
            } else {
                state = .binding(deviceId: found.deviceId)
                try await bind(deviceId: found.deviceId, key: key)
                state = .ready(deviceId: found.deviceId)
            }
        } catch let error as MobileError {
            switch error {
            case .sessionExpired, .notSignedIn, .unauthorized:
                message = error.description
                state = .signedOut
                onSessionEnded?()
            default:
                message = error.description
                demoteAfterFailure()
            }
        } catch is CancellationError {
            demoteAfterFailure()
        } catch {
            message = MobileError.invalidResponse.description
            demoteAfterFailure()
        }
    }

    /// A failed check never promotes; `ready`/`removed`/`notRegistered` keep their last server answer.
    private func demoteAfterFailure() {
        switch state {
        case .checking, .binding: state = .unverified
        default: break
        }
    }

    private func bind(deviceId: String, key: any DeviceSigningKey) async throws {
        let credentialId = try credentialId()
        let challenge = try await registry.challenge(deviceId: deviceId)
        // The challenge expires 60 seconds after issuance; its midpoint is a server-derived
        // timestamp inside the proof window even when the handset clock is badly skewed.
        guard challenge.expiresAt.isFinite, challenge.expiresAt > 30_000,
              challenge.expiresAt < 9_007_199_254_740_991 else { throw MobileError.invalidResponse }
        let timestamp = Int64(challenge.expiresAt) - 30_000
        guard timestamp > 0 else { throw MobileError.invalidResponse }
        let proof = try key.sign(RequestSigner.bindMessage(deviceId: deviceId, credentialId: credentialId,
                                                          nonce: challenge.nonce, timestamp: timestamp))
        let result = try await registry.bind(BindArgs(
            deviceId: deviceId, credentialId: credentialId,
            attestation: Attestation(format: key.storage.attestationFormat, keyId: nil),
            nonce: challenge.nonce, timestamp: timestamp, proof: proof))
        guard result.bindingStatus == "bound" else { throw MobileError.invalidResponse }
    }

    /// Stable per-install credential ID (a failed bind rolls back server-side, so reuse is safe).
    private func credentialId() throws -> String {
        if let data = try store.read(StoreAccount.credentialId), let value = String(data: data, encoding: .utf8), !value.isEmpty {
            return value
        }
        let value = UUID().uuidString.lowercased()
        try store.save(Data(value.utf8), for: StoreAccount.credentialId)
        return value
    }

    /// Auto-poll only while waiting for the admin to register this phone (or for the server to answer).
    private var shouldPoll: Bool { key != nil && (state == .notRegistered || state == .unverified) }
    private func updatePolling() {
        guard shouldPoll else {
            pollTask?.cancel()
            pollTask = nil
            return
        }
        guard pollTask == nil else { return }
        let interval = pollInterval
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled, let self else { return }
                await self.check()
                if !self.shouldPoll { return }
            }
        }
    }

    var isPolling: Bool { pollTask != nil }

    /// An explicit device-revoked gateway response locks this enrollment immediately.
    func markRemoved() {
        state = .removed
        updatePolling()
    }

    /// Sign-out: forget the in-memory key handle and this person's enrollment progress. The device key itself
    /// stays in the Keychain so the same registered phone is found again after the next sign-in.
    func signedOut() {
        try? store.delete(StoreAccount.deviceId)
        try? store.delete(StoreAccount.credentialId)
        pollTask?.cancel()
        pollTask = nil
        key = nil
        message = nil
        state = .signedOut
    }
}
