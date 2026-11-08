import SwiftUI
import UIKit

/// Sunpride on iOS: system materials and semantic colors carry the UI (Liquid Glass bars, grouped lists,
/// Dynamic Type); the brand lives in one tint and a few precise status colors. Values mirror
/// packages/ui (accent red #EE1C25; text-safe action red #B4151D; success #2E9D59; warning yellow #FEF200).
enum Brand {
    /// The one tint. Light: #B4151D (6.85:1 on white). Dark: #FF5A60 (5.4:1 on #000) — the raw brand red is too dark there.
    static let tint = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 1.0, green: 0.353, blue: 0.376, alpha: 1)
        : UIColor(red: 0.706, green: 0.082, blue: 0.114, alpha: 1) })
    static let red = Color(red: 0.933, green: 0.110, blue: 0.145)
    /// Fill for prominent action buttons (white text on it): #B4151D light (6.85:1), #C9222B dark (5.6:1).
    static let action = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0.788, green: 0.133, blue: 0.169, alpha: 1)
        : UIColor(red: 0.706, green: 0.082, blue: 0.114, alpha: 1) })
    static let good = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0.369, green: 0.804, blue: 0.533, alpha: 1)
        : UIColor(red: 0.137, green: 0.478, blue: 0.267, alpha: 1) })
    static let watch = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 1.0, green: 0.82, blue: 0.30, alpha: 1)
        : UIColor(red: 0.62, green: 0.40, blue: 0.0, alpha: 1) })
    static let bad = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 1.0, green: 0.42, blue: 0.42, alpha: 1)
        : UIColor(red: 0.784, green: 0.063, blue: 0.180, alpha: 1) })
}

/// Status words the server uses → one tone. Never color alone: every pill also carries words and a symbol.
enum Tone {
    case good, watch, bad, neutral

    var color: Color {
        switch self {
        case .good: Brand.good
        case .watch: Brand.watch
        case .bad: Brand.bad
        case .neutral: .secondary
        }
    }

    var symbol: String {
        switch self {
        case .good: "checkmark.circle.fill"
        case .watch: "exclamationmark.circle.fill"
        case .bad: "exclamationmark.triangle.fill"
        case .neutral: "circle.dashed"
        }
    }

    static func of(_ status: String?) -> Tone {
        switch status {
        case "ok", "ahead", "on_track", "good", "active", "settled", "done", "approved", "z_done", "completed", "posted", "received", "closed": .good
        case "behind", "watch", "medium", "dormant", "new", "on_route", "in_call", "open", "closing", "submitted", "low": .watch
        case "high", "critical", "lost", "bad", "over_limit", "rejected", "review_needed", "overdue": .bad
        default: .neutral
        }
    }
}

/// Plain-word formatting: Philippine pesos, Manila time, en-PH digits.
enum Format {
    static let manila = TimeZone(identifier: "Asia/Manila")!
    static let locale = Locale(identifier: "en_PH")
    static let minus = "\u{2212}"

    private static func number(_ fraction: Int) -> NumberFormatter {
        let f = NumberFormatter()
        f.locale = locale
        f.numberStyle = .decimal
        f.minimumFractionDigits = fraction
        f.maximumFractionDigits = fraction
        return f
    }
    private static let whole = number(0)
    private static let cents = number(2)
    private static let oneDecimal = number(1)

    /// Integer centavos → `₱1,248,350` (or with centavos: `₱1,248,350.25`). Nil → an em dash.
    static func peso(_ centavos: Double?, cents withCents: Bool = false) -> String {
        guard let centavos, centavos.isFinite else { return "—" }
        let pesos = abs(centavos) / 100
        let body = (withCents ? cents : whole).string(from: NSNumber(value: withCents ? pesos : pesos.rounded())) ?? "0"
        let negative = centavos < 0 && body != "0" && body != "0.00"
        return "\(negative ? minus : "")₱\(body)"
    }

    /// Compact pesos for tight tiles: `₱2.9M`, `₱850K`, `₱900`.
    static func pesoCompact(_ centavos: Double?) -> String {
        guard let centavos, centavos.isFinite else { return "—" }
        let pesos = centavos / 100
        let a = abs(pesos)
        let sign = pesos < 0 ? minus : ""
        func trim(_ s: String) -> String { s.hasSuffix(".0") ? String(s.dropLast(2)) : s }
        if a >= 1_000_000 { return "\(sign)₱\(trim(String(format: a >= 10_000_000 ? "%.0f" : "%.1f", a / 1_000_000)))M" }
        if a >= 1_000 { return "\(sign)₱\(trim(String(format: a >= 100_000 ? "%.0f" : "%.1f", a / 1_000)))K" }
        return "\(sign)₱\(Int(a.rounded()))"
    }

    static func count(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        if value == value.rounded() { return whole.string(from: NSNumber(value: value)) ?? "—" }
        return oneDecimal.string(from: NSNumber(value: (value * 10).rounded() / 10)) ?? "—"
    }

    static func pct(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return "\(oneDecimal.string(from: NSNumber(value: value)) ?? "—")%"
    }

    /// Signed change against the prior period: `+12.5%`, `−3.0%`.
    static func delta(_ value: Double?) -> String? {
        guard let value, value.isFinite else { return nil }
        let body = oneDecimal.string(from: NSNumber(value: abs(value))) ?? "0"
        return value > 0 ? "+\(body)%" : value < 0 ? "\(minus)\(body)%" : "0.0%"
    }

    /// A KPI value in its unit.
    static func kpi(_ value: Double?, unit: String) -> String {
        switch unit {
        case "php": peso(value)
        case "pct": pct(value)
        case "cases": value.map { "\(count($0)) cs" } ?? "—"
        case "days": value.map { "\(count($0)) days" } ?? "—"
        case "min": value.map { "\(count($0)) min" } ?? "—"
        default: count(value)
        }
    }

    private static func dateFormatter(_ template: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = locale
        f.timeZone = manila
        f.setLocalizedDateFormatFromTemplate(template)
        return f
    }
    private static let dayFormatter = dateFormatter("EEE d MMM")
    private static let dayTimeFormatter = dateFormatter("EEE d MMM h:mm a")
    private static let timeFormatter = dateFormatter("h:mm a")
    private static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = manila
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func date(ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    /// `Sun 8 Nov`, in Manila.
    static func day(_ date: Date) -> String { dayFormatter.string(from: date) }
    /// A `yyyy-MM-dd` Manila business date → `Sun 8 Nov`.
    static func day(iso: String) -> String { isoDay.date(from: iso).map(day) ?? iso }
    /// `Sun 8 Nov 3:05 PM`, in Manila.
    static func dayTime(ms: Double?) -> String { ms.map { dayTimeFormatter.string(from: date(ms: $0)) } ?? "—" }
    /// `3:05 PM`, in Manila.
    static func time(ms: Double) -> String { timeFormatter.string(from: date(ms: ms)) }
    /// Today's Manila date as `yyyy-MM-dd`.
    static func manilaToday(_ now: Date = .now) -> String { isoDay.string(from: now) }

    /// "just now", "5 min", "3 h", "2 days": how long something has waited.
    static func age(since ms: Double?, now: Date = .now) -> String {
        guard let ms else { return "—" }
        let minutes = max(0, Int((now.timeIntervalSince1970 * 1000 - ms) / 60000))
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        if hours < 48 { return "\(hours) h" }
        return "\(hours / 24) days"
    }

    static func ago(_ ms: Double?, now: Date = .now) -> String {
        let a = age(since: ms, now: now)
        return a == "just now" || a == "—" ? a : "\(a) ago"
    }

    /// Server status words → sentence case (`on_route` → `On route`). No codes on screen.
    static func words(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "—" }
        let special: [String: String] = [
            "no_plan": "No plan today", "not_started": "Not started", "in_call": "In a call", "on_route": "On the road",
            "z_done": "Closed with Z", "closed_no_z": "Closed, no Z", "gt": "General trade", "mt": "Modern trade",
            "ok": "On track", "unknown": "No target", "review_needed": "Needs a decision", "partially_received": "Partly received",
            "credit_breach": "Over credit limit",
        ]
        if let s = special[raw] { return s }
        let spaced = raw.replacingOccurrences(of: "_", with: " ")
        return spaced.prefix(1).uppercased() + spaced.dropFirst()
    }
}

/// Light haptics for decisions and refreshes.
enum Haptics {
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func tap() { UISelectionFeedbackGenerator().selectionChanged() }
}
