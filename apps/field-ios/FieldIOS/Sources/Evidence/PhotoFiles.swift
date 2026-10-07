import CryptoKit
import Foundation
import Security

/// Photo bytes at rest, addressed by the photo's local ID.
@MainActor
protocol PhotoFiles: AnyObject {
    /// Durable before return: a crash afterwards leaves a complete file, never a partial one.
    func write(_ localId: UUID, _ bytes: Data) throws
    func read(_ localId: UUID) throws -> Data
    func delete(_ localId: UUID)
}

enum PhotoFileError: Error, Equatable { case invalidKey, damaged }

/// IOS-016: each JPEG is sealed with AES-256-GCM under a random key kept in the Keychain
/// (after first unlock, this device only, never synchronized) and written to backup-excluded,
/// file-protected app storage, so a backup, a copied file or another app never sees a store photo.
/// The local ID is bound as associated data: one photo's file cannot be swapped for another's.
/// Nothing is written to the photo library.
@MainActor
final class SealedPhotoFiles: PhotoFiles {
    static let keyAccount = "evidence.photos.aesgcm.v1"
    let directory: URL
    private let secrets: SecretStore
    private let keyAccount: String
    private var cachedKey: SymmetricKey?

    init(directory: URL, secrets: SecretStore, keyAccount: String = SealedPhotoFiles.keyAccount) throws {
        self.directory = directory
        self.secrets = secrets
        self.keyAccount = keyAccount
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Self.protect(directory)
    }

    /// The live folder beside the encrypted store (`FieldStore` or the DEBUG stub folder).
    static func live(folder: String, secrets: SecretStore) throws -> SealedPhotoFiles {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                  appropriateFor: nil, create: true)
        return try SealedPhotoFiles(directory: support.appending(path: folder, directoryHint: .isDirectory)
            .appending(path: "evidence", directoryHint: .isDirectory), secrets: secrets)
    }

    private static func protect(_ url: URL) throws {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var target = url
        try target.setResourceValues(values)
        // Background upload runs after first unlock, so the bytes must stay readable while locked.
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                              ofItemAtPath: url.path)
    }

    private func key() throws -> SymmetricKey {
        if let cachedKey { return cachedKey }
        if let saved = try secrets.read(keyAccount) {
            guard saved.count == 32 else { throw PhotoFileError.invalidKey }
            cachedKey = SymmetricKey(data: saved)
            return cachedKey!
        }
        // A missing key with sealed files present means those files can never be opened: never
        // silently start a new key over them (they stay for review as damaged).
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw PhotoFileError.invalidKey }
        try secrets.save(Data(bytes), for: keyAccount)
        cachedKey = SymmetricKey(data: Data(bytes))
        return cachedKey!
    }
    func file(_ localId: UUID) -> URL {
        directory.appending(path: "\(localId.uuidString.lowercased()).jpg.sealed")
    }
    private static func aad(_ localId: UUID) -> Data {
        Data("sunpride.field.evidence.v1|\(localId.uuidString.lowercased())".utf8)
    }

    func write(_ localId: UUID, _ bytes: Data) throws {
        let sealed = try AES.GCM.seal(bytes, using: key(), authenticating: Self.aad(localId))
        guard let combined = sealed.combined else { throw PhotoFileError.damaged }
        let target = file(localId)
        // `.atomic` writes a temporary file and renames it; the protection class applies to the result.
        try combined.write(to: target, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try Self.protect(target)
    }
    func read(_ localId: UUID) throws -> Data {
        let combined = try Data(contentsOf: file(localId))
        guard combined.count > 12 + 16 else { throw PhotoFileError.damaged }
        do {
            return try AES.GCM.open(AES.GCM.SealedBox(combined: combined), using: key(), authenticating: Self.aad(localId))
        } catch { throw PhotoFileError.damaged }
    }
    func delete(_ localId: UUID) { try? FileManager.default.removeItem(at: file(localId)) }
}
