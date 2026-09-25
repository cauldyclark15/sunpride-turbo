import Foundation

/// Wraps a secret (session token, Convex JWT) so string interpolation, `dump`, `print` and debugger
/// descriptions never reveal it. Read `.value` only at the point the header is written.
struct Redacted<Value: Sendable>: Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    let value: Value
    init(_ value: Value) { self.value = value }
    var description: String { "<redacted>" }
    var debugDescription: String { "<redacted>" }
    var customMirror: Mirror { Mirror(self, children: [], displayStyle: .struct) }
}

enum Redactor {
    // JWT-shaped text (three base64url segments), bearer credentials and long opaque tokens.
    private static let patterns: [NSRegularExpression] = [
        #"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"#,
        #"(?i)bearer\s+[^\s,;]+"#,
        #"(?i)(token|password|secret|session)(["']?\s*[:=]\s*["']?)[^\s,;"'}]+"#,
        #"[A-Za-z0-9_\-+/=]{32,}"#
    ].map { try! NSRegularExpression(pattern: $0) }

    /// Returns text safe for display or logs; bounded to 200 characters.
    static func redact(_ text: String) -> String {
        var output = text
        for (index, pattern) in patterns.enumerated() {
            let range = NSRange(output.startIndex..., in: output)
            let template = index == 2 ? "$1$2<redacted>" : "<redacted>"
            output = pattern.stringByReplacingMatches(in: output, range: range, withTemplate: template)
        }
        output = output.replacingOccurrences(of: "\n", with: " ")
        return output.count > 200 ? String(output.prefix(200)) + "…" : output
    }
}
