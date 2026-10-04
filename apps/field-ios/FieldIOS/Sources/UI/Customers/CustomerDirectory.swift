import Foundation

/// One planned call for an outlet in the downloaded horizon (today and the following days).
struct PlannedCall: Equatable, Sendable {
    let serviceDate: String
    let plannedVisitId: String
    let intents: [String]
}

/// Something this phone recorded at the outlet, newest first. Never office history (not on the wire).
struct HistoryEntry: Equatable, Sendable {
    let at: Date
    let label: String
    let state: String
}

/// Send state of one locally recorded intent, from the encrypted outbox.
enum LocalIntentState: Equatable, Sendable {
    case sent, waiting, review, held
    var label: String {
        switch self {
        case .sent: "Sent"
        case .waiting: "Waiting to send"
        case .review: "Needs review"
        case .held: "Held for review"
        }
    }
}

/// Everything the phone knows about one outlet in the signed-in person's downloaded scope.
/// The server only sends outlets in this person's verified scope partition, so the directory is
/// scoped by construction; nothing here widens it.
struct CustomerRecord: Identifiable {
    let outletId: String
    let name: String
    var outletCode: String? = nil
    var customerCode: String? = nil
    var address: String? = nil
    var location: StoreSnapshot.Coordinate? = nil
    var routeId: String? = nil
    /// Code of the person's downloaded route, only when this outlet is on it.
    var routeCode: String? = nil
    /// Annex C account header, when the office set one up for this account.
    var account: CallSheet.Header? = nil
    var planned: [PlannedCall] = []
    var history: [HistoryEntry] = []
    /// Today's planned call (with its live status) when there is one.
    var today: AppModel.TodayVisit? = nil
    /// 1-based stop number in today's MCP order when planned today.
    var todayPosition: Int? = nil
    var id: String { outletId }

    /// Address from the outlet master, else from the account sheet.
    var displayAddress: String? { address ?? account?.address.flatMap(CustomerDirectory.clean) }
    var directionsURL: URL? { DailyRoute.directionsURL(name: name, location: location, address: displayAddress) }
    var dialURL: URL? { CustomerDirectory.dialURL(account?.contactNumber) }
    var codes: String? {
        let parts = [outletCode, customerCode.flatMap { $0 == outletCode ? nil : $0 }].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// Pure projection of the active cached snapshot plus local outbox, and offline search over it.
enum CustomerDirectory {
    static let historyLimit = 10

    static func clean(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }

    /// `today` is the decorated list Today already shows, so status and order are the values Start enforces.
    static func build(snapshot: StoreSnapshot?, today: [AppModel.TodayVisit], day: String,
                      history: [(VisitIntent, LocalIntentState)]) -> [CustomerRecord] {
        guard let snapshot else { return [] }
        let customers = Dictionary(snapshot.customers.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let accounts = Dictionary(snapshot.callSheets.map { ($0.outletId, $0.header) }, uniquingKeysWith: { first, _ in first })
        let plans = Dictionary(grouping: snapshot.visits.filter { $0.serviceDate >= day }, by: \.outletId)
        let todays = today.filter(\.planned)
        let historyByOutlet = historyByOutlet(history)
        var seen = Set<String>()
        return snapshot.outlets.compactMap { outlet in
            guard !outlet.id.isEmpty, seen.insert(outlet.id).inserted else { return nil }
            let planned = (plans[outlet.id] ?? []).sorted {
                $0.serviceDate == $1.serviceDate ? ($0.sequence ?? .max) < ($1.sequence ?? .max) : $0.serviceDate < $1.serviceDate
            }
            var ids = Set<String>()
            let index = todays.firstIndex { $0.outletId == outlet.id }
            let onRoute = outlet.routeId != nil && outlet.routeId == snapshot.route?.id
            return CustomerRecord(
                outletId: outlet.id, name: clean(outlet.name) ?? "Outlet",
                outletCode: clean(outlet.code),
                customerCode: outlet.customerId.flatMap { customers[$0] }.flatMap { clean($0.code) },
                address: clean(outlet.address),
                location: outlet.location.flatMap { RouteMath.isValid($0) ? $0 : nil },
                routeId: outlet.routeId,
                routeCode: onRoute ? snapshot.route.flatMap { clean($0.code) } : nil,
                account: accounts[outlet.id],
                planned: planned.filter { ids.insert($0.id).inserted }
                    .map { PlannedCall(serviceDate: $0.serviceDate, plannedVisitId: $0.id, intents: $0.intents) },
                history: historyByOutlet[outlet.id] ?? [],
                today: index.map { todays[$0] },
                todayPosition: index.map { $0 + 1 })
        }
    }

    /// Group every local intent under the outlet of its call's check-in, newest first.
    static func historyByOutlet(_ rows: [(VisitIntent, LocalIntentState)]) -> [String: [HistoryEntry]] {
        var outletOfCall: [String: String] = [:]
        for (intent, _) in rows where intent.kind == "visit.checkIn" {
            if let outlet = intent.payload?["outletId"] as? String { outletOfCall[intent.requestId.uuidString.lowercased()] = outlet }
        }
        var grouped: [String: [HistoryEntry]] = [:]
        for (intent, state) in rows {
            let call = intent.kind == "visit.checkIn" ? intent.requestId.uuidString.lowercased() : intent.dependencies.first
            guard let call, let outlet = outletOfCall[call], let at = intent.deviceTime else { continue }
            grouped[outlet, default: []].append(HistoryEntry(at: at, label: label(intent), state: state.label))
        }
        return grouped.mapValues { Array($0.sorted { $0.at > $1.at }.prefix(historyLimit)) }
    }

    static func label(_ intent: VisitIntent) -> String {
        let payload = intent.payload ?? [:]
        switch intent.kind {
        case "visit.checkIn":
            return payload["plannedVisitId"] is String ? "Call started" : "Unplanned call started"
        case "visit.checkOut":
            switch payload["outcome"] as? String {
            case "completed": return "Call ended · Productive"
            case "nonproductive":
                return "Call ended · Not productive" + ((payload["reasonCode"] as? String).flatMap(clean).map { " (\($0))" } ?? "")
            default: return "Call ended"
            }
        default:
            switch (payload["activity"] as? [String: Any])?["kind"] as? String {
            case "call_sheet": return "Call sheet saved"
            case "note": return "Note added"
            default: return "Activity recorded"
            }
        }
    }

    /// Lower-case, accent-free words so "pena" finds "Peña" and "sto nino" finds "Sto. Niño".
    static func normalize(_ value: String) -> String {
        let folded = value.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive],
                                   locale: Locale(identifier: "en_US_POSIX")).lowercased()
        let mapped = folded.unicodeScalars.map { scalar -> Character in
            (("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)) ? Character(scalar) : " "
        }
        return String(mapped).split(separator: " ").joined(separator: " ")
    }

    private static func fields(_ record: CustomerRecord) -> [String] {
        [record.name, record.outletCode, record.customerCode, record.displayAddress,
         record.account?.accountName, record.account?.buyerName, record.routeCode].compactMap { $0 }
    }

    /// Offline search over the cached directory. Every word must appear somewhere (name, codes,
    /// address, account or buyer name, route). Exact code matches rank first, then code/name
    /// prefixes, then word prefixes; ties go to today's stops in route order, then name.
    static func search(_ records: [CustomerRecord], query: String) -> [CustomerRecord] {
        let words = normalize(query).split(separator: " ").map(String.init)
        let phrase = words.joined(separator: " ")
        let ranked: [(CustomerRecord, Int)] = records.compactMap { record in
            let haystack = fields(record).map(normalize).joined(separator: " ")
            guard words.allSatisfy({ haystack.contains($0) }) else { return nil }
            let codes = [record.outletCode, record.customerCode].compactMap { $0 }.map(normalize)
            let name = normalize(record.name)
            let score: Int
            if words.isEmpty { score = 3 }
            else if codes.contains(phrase) { score = 0 }
            else if codes.contains(where: { $0.hasPrefix(phrase) }) || name.hasPrefix(phrase) { score = 1 }
            else if (codes + [name]).flatMap({ $0.split(separator: " ") }).contains(where: { $0.hasPrefix(words[0]) }) { score = 2 }
            else { score = 3 }
            return (record, score)
        }
        return ranked.sorted { a, b in
            if a.1 != b.1 { return a.1 < b.1 }
            let pa = a.0.todayPosition ?? .max, pb = b.0.todayPosition ?? .max
            if pa != pb { return pa < pb }
            let na = normalize(a.0.name), nb = normalize(b.0.name)
            return na == nb ? a.0.outletId < b.0.outletId : na < nb
        }.map(\.0)
    }

    private static func formatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = FieldDay.timeZone
        formatter.dateFormat = format
        return formatter
    }

    /// "Today", "Tomorrow" or "Tue, Oct 6" relative to the Manila service day.
    static func dayLabel(_ serviceDate: String, now: Date) -> String {
        let parse = formatter("yyyy-MM-dd")
        parse.isLenient = false
        guard let date = parse.date(from: serviceDate) else { return serviceDate }
        let today = parse.string(from: now)
        let tomorrow = FieldDay.calendar.date(byAdding: .day, value: 1, to: now).map(parse.string(from:))
        if serviceDate == today { return "Today" }
        if serviceDate == tomorrow { return "Tomorrow" }
        return formatter("EEE, MMM d").string(from: date)
    }

    /// "3:05 PM" today, else "Oct 3, 3:05 PM" (Manila time).
    static func timeLabel(_ at: Date, now: Date) -> String {
        let clock = formatter("h:mm a").string(from: at)
        let day = formatter("yyyy-MM-dd")
        return day.string(from: at) == day.string(from: now) ? clock : "\(formatter("MMM d").string(from: at)), \(clock)"
    }

    /// Human label for a planned activity or task kind such as `merchandise_check`.
    static func kindLabel(_ kind: String) -> String {
        let text = kind.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: ".", with: " ")
            .trimmingCharacters(in: .whitespaces)
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    /// A `tel:` URL for the dialer, or nil when the text is not a phone number.
    static func dialURL(_ contact: String?) -> URL? {
        guard let raw = clean(contact), (7...20).contains(raw.count),
              raw.allSatisfy({ "+0123456789() .-".contains($0) }) else { return nil }
        let digits = raw.filter { $0.isNumber || $0 == "+" }
        guard digits.filter(\.isNumber).count >= 7, digits.lastIndex(of: "+").map({ $0 == digits.startIndex }) ?? true else { return nil }
        return URL(string: "tel:\(digits)")
    }
}
