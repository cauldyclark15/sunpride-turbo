import Foundation

/// SP-0164 customer gathering: the shared duplicate rules, exactly as written in
/// `packages/domain-contracts/fixtures/mobile-v1/census-duplicates.json` (server JS, Android Kotlin and this
/// Swift copy each check every vector of that file). Runs on the phone against the outlets already
/// downloaded, so a warning works with no signal.
enum CensusDuplicates {
    static let stopwords: Set<String> = ["and", "co", "corp", "enterprise", "enterprises", "general", "groceries",
        "grocery", "inc", "mart", "merchandise", "mini", "minimart", "ng", "sari", "sarisari", "shop", "store",
        "stores", "the", "trading"]
    static let earthRadiusMeters = 6_371_008.8
    static let nearbyMeters = 75.0
    static let veryCloseMeters = 25.0
    static let nameMaxMeters = 2_000.0
    static let nameThreshold = 0.8
    static let maxCandidates = 10

    /// NFKD, drop combining marks, lowercase, every run outside [a-z0-9] becomes one space; drop stopwords
    /// unless nothing would be left. A token set.
    static func nameTokens(_ name: String) -> Set<String> {
        let decomposed = name.decomposedStringWithCompatibilityMapping
        var cleaned = String.UnicodeScalarView()
        for scalar in decomposed.unicodeScalars {
            switch scalar.properties.generalCategory {
            case .nonspacingMark, .spacingMark, .enclosingMark: continue
            default: cleaned.append(scalar)
            }
        }
        let lower = String(cleaned).lowercased()
        var spaced = ""
        for scalar in lower.unicodeScalars {
            let v = scalar.value
            if (0x61...0x7A).contains(v) || (0x30...0x39).contains(v) { spaced.unicodeScalars.append(scalar) } else { spaced.append(" ") }
        }
        let words = spaced.split(separator: " ").map(String.init)
        let kept = words.filter { !stopwords.contains($0) }
        return Set(kept.isEmpty ? words : kept)
    }

    /// Jaccard of the token sets, rounded to 4 decimals; 0 when either is empty.
    static func nameSimilarity(_ a: String, _ b: String) -> Double {
        let x = nameTokens(a), y = nameTokens(b)
        guard !x.isEmpty, !y.isEmpty else { return 0 }
        let union = x.union(y).count
        return (Double(x.intersection(y).count) / Double(union) * 10_000).rounded() / 10_000
    }

    /// Digits only; 12 digits starting 63 become "0" + the last 10; the key is the last 10 digits.
    static func phoneKey(_ phone: String?) -> String? {
        guard let phone else { return nil }
        var digits = phone.filter { $0.isASCII && $0.isNumber }
        if digits.count == 12 && digits.hasPrefix("63") { digits = "0" + digits.suffix(10) }
        guard digits.count >= 10 else { return nil }
        return String(digits.suffix(10))
    }

    /// Haversine, rounded to 0.1 m; nil when either side has no coordinates.
    static func distanceMeters(_ lat1: Double?, _ lng1: Double?, _ lat2: Double?, _ lng2: Double?) -> Double? {
        guard let lat1, let lng1, let lat2, let lng2 else { return nil }
        let rad = Double.pi / 180
        let dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad
        let h = pow(sin(dLat / 2), 2) + cos(lat1 * rad) * cos(lat2 * rad) * pow(sin(dLng / 2), 2)
        let d = 2 * earthRadiusMeters * asin(min(1, h.squareRoot()))
        return (d * 10).rounded() / 10
    }

    struct Query: Equatable, Sendable {
        var name: String
        var phone: String?
        var latitude: Double?
        var longitude: Double?
        var placeId: String?
    }

    struct Existing: Equatable, Sendable {
        var kind: String = "outlet"
        var id: String = ""
        var name: String
        var phone: String?
        var address: String?
        var latitude: Double?
        var longitude: Double?
        var placeId: String?
    }

    struct Match: Equatable, Sendable {
        let reasons: [String]
        let distanceMeters: Double?
        let nameSimilarity: Double
        let score: Int
        var isCandidate: Bool { !reasons.isEmpty }
    }

    static func match(_ q: Query, _ e: Existing) -> Match {
        let distance = distanceMeters(q.latitude, q.longitude, e.latitude, e.longitude)
        let similarity = nameSimilarity(q.name, e.name)
        var reasons: [String] = []
        var score = 0
        if let a = q.placeId, !a.isEmpty, a == e.placeId { reasons.append("place"); score += 100 }
        if let a = phoneKey(q.phone), a == phoneKey(e.phone) { reasons.append("phone"); score += 90 }
        if let distance, distance <= nearbyMeters { reasons.append("nearby"); score += distance <= veryCloseMeters ? 80 : 60 }
        if similarity >= nameThreshold && (distance == nil || distance! <= nameMaxMeters) {
            reasons.append("name"); score += Int((30 * similarity).rounded())
        }
        return Match(reasons: reasons, distanceMeters: distance, nameSimilarity: similarity, score: score)
    }

    /// Candidates sorted by score desc, then distance asc (unknown last), then name; at most 10.
    static func candidates(_ q: Query, among existing: [Existing]) -> [CensusCandidate] {
        let found = existing.compactMap { e -> CensusCandidate? in
            let m = match(q, e)
            guard m.isCandidate else { return nil }
            return CensusCandidate(kind: e.kind, id: e.id, name: e.name, address: e.address, latitude: e.latitude,
                                   longitude: e.longitude, distanceMeters: m.distanceMeters, reasons: m.reasons, score: m.score)
        }
        return Array(sorted(found).prefix(maxCandidates))
    }

    static func sorted(_ list: [CensusCandidate]) -> [CensusCandidate] {
        list.sorted { a, b in
            if a.score != b.score { return a.score > b.score }
            switch (a.distanceMeters, b.distanceMeters) {
            case let (x?, y?) where x != y: return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return a.name < b.name
            }
        }
    }

    /// Local (offline) and server answers together, deduplicated by id (the server's copy wins).
    static func merge(local: [CensusCandidate], server: [CensusCandidate]) -> [CensusCandidate] {
        var seen = Set(server.map(\.id))
        var all = server
        for c in local where seen.insert(c.id).inserted { all.append(c) }
        return Array(sorted(all).prefix(maxCandidates))
    }

    /// Plain words for the duplicate sheet.
    static func reasonText(_ reasons: [String]) -> String {
        reasons.compactMap { r -> String? in
            switch r {
            case "place": "Same place on Google"
            case "phone": "Same phone number"
            case "nearby": "Very close by"
            case "name": "Same name nearby"
            default: nil
            }
        }.joined(separator: " · ")
    }
}

/// One possible duplicate: an outlet on the phone or from the server, or a not-yet-reviewed capture.
struct CensusCandidate: Equatable, Sendable, Identifiable {
    let kind: String
    let id: String
    let name: String
    let address: String?
    let latitude: Double?
    let longitude: Double?
    let distanceMeters: Double?
    let reasons: [String]
    let score: Int

    /// `duplicate-check` wire row; nil when malformed.
    init?(wire: [String: Any]) {
        guard let kind = wire["kind"] as? String, ["outlet", "capture"].contains(kind),
              let id = wire["id"] as? String, !id.isEmpty, let name = wire["name"] as? String,
              let reasons = wire["reasons"] as? [String], !reasons.isEmpty else { return nil }
        self.init(kind: kind, id: id, name: name, address: wire["address"] as? String,
                  latitude: (wire["latitude"] as? NSNumber)?.doubleValue, longitude: (wire["longitude"] as? NSNumber)?.doubleValue,
                  distanceMeters: (wire["distanceMeters"] as? NSNumber)?.doubleValue, reasons: reasons,
                  score: (wire["score"] as? NSNumber)?.intValue ?? 0)
    }
    init(kind: String, id: String, name: String, address: String?, latitude: Double?, longitude: Double?,
         distanceMeters: Double?, reasons: [String], score: Int) {
        self.kind = kind; self.id = id; self.name = name; self.address = address; self.latitude = latitude
        self.longitude = longitude; self.distanceMeters = distanceMeters; self.reasons = reasons; self.score = score
    }

    var distanceText: String? {
        distanceMeters.map { $0 < 1_000 ? "\(Int($0.rounded())) m away" : String(format: "%.1f km away", $0 / 1_000) }
    }
}
