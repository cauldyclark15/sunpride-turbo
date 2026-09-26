import Foundation
import OSLog
import UIKit

/// Only static, allowlisted event codes are logged. Untrusted strings are never OSLog metadata.
enum DiagnosticEvent: String, Codable {
    case syncStarted, syncSucceeded, syncFailed, syncCancelled, workQueued, workHeld, reviewRequired
}

enum DiagnosticRedactor {
    static func redact(_ input: String) -> String {
        var text = input
        // A serialized request, including nested JSON, is never useful in a support export.
        if text.contains("{") || text.contains("[") { return "[request body redacted]" }
        let patterns = [
            #"(?i)\bBearer\s+\S+"#,
            #"\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"#,
            #"[A-Z0-9a-z._%+-]+@[A-Z0-9a-z.-]+\.[A-Za-z]{2,}"#,
            #"(?<!\d)(?:\+63|0)\s?9\d{2}[\s-]?\d{3}[\s-]?\d{4}(?!\d)"#,
            #"(?i)(?:latitude|longitude|lat|lng|lon)\s*[:=]\s*-?\d+(?:\.\d+)?"#,
            #"(?<!\d)-?\d{1,2}\.\d{4,}\s*[,/]\s*-?\d{1,3}\.\d{4,}(?!\d)"#,
            #"(?i)(?:signature|sig|token|password|name)\s*[:=]\s*\S+"#,
            #"\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b"#,
            #"\b[A-Za-z0-9+/_-]{40,}={0,2}\b"#
        ]
        for pattern in patterns {
            text = text.replacingOccurrences(of: pattern, with: "[redacted]", options: .regularExpression)
        }
        return text
    }
}

/// Bounded, redacted, protected app-support breadcrumbs; no payloads or identities.
@MainActor
final class DiagnosticBreadcrumbs {
    private let url: URL
    private(set) var entries: [String] = []
    private let logger = Logger(subsystem: "com.sunpride.field", category: "sync")
    init(url: URL) {
        self.url = url
        if let data = try? Data(contentsOf: url), let saved = try? JSONDecoder().decode([String].self, from: data) {
            entries = Array(saved.map(DiagnosticRedactor.redact).suffix(50))
        }
    }
    func add(_ event: DiagnosticEvent) {
        let code = event.rawValue
        logger.info("Field event: \(code, privacy: .private)")
        entries.append(code)
        entries = Array(entries.suffix(50))
        guard let data = try? JSONEncoder().encode(entries) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: [.atomic, .completeFileProtection])
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var protectedURL = url
        try? protectedURL.setResourceValues(values)
    }
}

@MainActor
final class SupportInfo {
    private let secrets: SecretStore
    private let account = "field.support.handle"
    init(secrets: SecretStore) { self.secrets = secrets }
    var handle: String {
        if let data = try? secrets.read(account), let value = String(data: data, encoding: .utf8),
           UUID(uuidString: value) != nil { return value }
        let value = UUID().uuidString.lowercased()
        try? secrets.save(Data(value.utf8), for: account)
        return value
    }
    func text(status: FieldSyncStatus?) -> String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = info["CFBundleVersion"] as? String ?? "unknown"
        let value = "App \(version) (\(build))\nOS iOS \(UIDevice.current.systemVersion)\nSupport handle \(handle)\nQueued \(status?.queued ?? 0), sending \(status?.sending ?? 0), review \(status?.needsReview ?? 0), held \(status?.held ?? 0)\nLast outcome \(status?.lastErrorCode.flatMap { Self.safeCode($0) } ?? "none")"
        return DiagnosticRedactor.redact(value)
    }
    private static func safeCode(_ code: String) -> String? {
        // Older health rows stored presentation text. Do not export it.
        let allowed: Set<String> = ["retryable", "unauthorized", "revoked", "rebootstrap", "invalid_response", "cancelled"]
        return allowed.contains(code) ? code : nil
    }
}
