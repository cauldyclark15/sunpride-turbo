import Foundation

/// SP-0164: `GET /api/v1/masters/census-config` (batches, channels, sub-channels; new servers add
/// `defaultBatch` and `addressSearch`). Older servers simply lack the new fields.
struct CensusConfig: Equatable, Sendable {
    struct Choice: Equatable, Sendable, Identifiable { let id: String; let label: String; var channelId: String? = nil }
    let batches: [Choice]
    let channels: [Choice]
    let subchannels: [Choice]
    let defaultBatch: Choice?
    /// The server has the Google key configured; false or missing hides "Search address".
    let addressSearch: Bool
    /// The server knows the SP-0162 additions (`defaultBatch` key present, even when null).
    let supportsGathering: Bool

    /// Hidden when the server has a default batch and at most one batch is offered.
    var showsBatchPicker: Bool { !(defaultBatch != nil && batches.count <= 1) }

    init(batches: [Choice], channels: [Choice], subchannels: [Choice], defaultBatch: Choice?, addressSearch: Bool,
         supportsGathering: Bool) {
        self.batches = batches; self.channels = channels; self.subchannels = subchannels
        self.defaultBatch = defaultBatch; self.addressSearch = addressSearch; self.supportsGathering = supportsGathering
    }

    init(json: Data) throws {
        guard let o = try JSONSerialization.jsonObject(with: json) as? [String: Any],
              let batches = o["batches"] as? [[String: Any]], let channels = o["channels"] as? [[String: Any]],
              let subs = o["subchannels"] as? [[String: Any]] else { throw MobileError.invalidResponse }
        func choice(_ row: [String: Any]) -> Choice? {
            guard let id = row["id"] as? String, !id.isEmpty else { return nil }
            let label = (row["label"] as? String) ?? (row["name"] as? String) ?? ""
            return Choice(id: id, label: label.isEmpty ? "Unnamed" : label,
                          channelId: (row["data"] as? [String: Any])?["channelId"] as? String)
        }
        self.batches = batches.compactMap(choice)
        self.channels = channels.compactMap(choice)
        self.subchannels = subs.compactMap(choice)
        defaultBatch = (o["defaultBatch"] as? [String: Any]).flatMap(choice)
        addressSearch = o["addressSearch"] as? Bool ?? false
        supportsGathering = o.keys.contains("defaultBatch")
    }
    func subchannels(of channelId: String?) -> [Choice] { subchannels.filter { $0.channelId == channelId && channelId != nil } }
}

/// Address parts shared by `places/details` and `places/reverse`.
struct PlaceAddress: Equatable, Sendable {
    var formattedAddress: String
    var street: String?, barangay: String?, city: String?, province: String?, region: String?, postalCode: String?

    init(formattedAddress: String, street: String? = nil, barangay: String? = nil, city: String? = nil,
         province: String? = nil, region: String? = nil, postalCode: String? = nil) {
        self.formattedAddress = formattedAddress; self.street = street; self.barangay = barangay; self.city = city
        self.province = province; self.region = region; self.postalCode = postalCode
    }
    init?(wire: [String: Any]) {
        guard let formatted = wire["formattedAddress"] as? String else { return nil }
        let c = wire["components"] as? [String: Any] ?? [:]
        func part(_ k: String) -> String? { (c[k] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(120)) } }
        self.init(formattedAddress: String(formatted.prefix(500)), street: part("street"), barangay: part("barangay"),
                  city: part("city"), province: part("province"), region: part("region"), postalCode: part("postalCode"))
    }
    /// The line agents confirm: street, barangay, city (falls back to Google's formatted address).
    var addressLine: String {
        let parts = [street, barangay, city].compactMap { $0 }
        return parts.isEmpty ? formattedAddress : parts.joined(separator: ", ")
    }
    /// "Barangay, City" shown under the address.
    var areaLine: String? {
        let parts = [barangay, city, province].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
    var components: [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in [("street", street), ("barangay", barangay), ("city", city), ("province", province),
                       ("region", region), ("postalCode", postalCode)] { if let v { out[k] = v } }
        return out
    }
}

struct PlacePrediction: Equatable, Sendable, Identifiable {
    let placeId: String; let primary: String; let secondary: String
    var id: String { placeId }
}

struct PlaceDetails: Equatable, Sendable {
    let placeId: String; let address: PlaceAddress; let latitude: Double; let longitude: Double
}

enum CensusServiceError: Error, Equatable {
    /// No connection.
    case offline
    /// This server does not have the endpoint yet (404) — the feature quietly hides.
    case unsupported
    /// The server answered with a refusal; the text is ours, plain, never the server body.
    case unavailable(String)

    var message: String {
        switch self {
        case .offline: "No internet connection."
        case .unsupported: "Not available on this server yet."
        case .unavailable(let text): text
        }
    }
}

/// The server calls behind "Add a store". Phones never call Google: only our `/api/v1/places/*` proxy.
@MainActor
protocol CensusService: AnyObject {
    func config() async throws -> Data
    func autocomplete(input: String, session: UUID, near: (Double, Double)?) async throws -> [PlacePrediction]
    func details(placeId: String, session: UUID) async throws -> PlaceDetails
    /// nil when Google has no address for the point.
    func reverse(latitude: Double, longitude: Double) async throws -> PlaceAddress?
    func duplicateCheck(_ body: [String: Any]) async throws -> [CensusCandidate]
}

@MainActor
final class ServerCensusService: CensusService {
    let api: ServerAPI
    init(api: ServerAPI) { self.api = api }

    private func send(_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: Any]? = nil,
                      places: Bool) async throws -> [String: Any] {
        let data: Data, status: Int
        do {
            (data, status) = try await api.plain(method, path, query: query,
                                                 body: try body.map { try JSONSerialization.data(withJSONObject: $0) })
        } catch let error as URLError where error.code != .cancelled {
            throw CensusServiceError.offline
        } catch MobileError.offline { throw CensusServiceError.offline }
        if (200..<300).contains(status) {
            guard let object = try? NativeV2.object(data) else { throw CensusServiceError.unavailable("Unexpected answer from the server.") }
            return object
        }
        let code = ((try? NativeV2.object(data))?["error"] as? [String: Any])?["code"] as? String
        switch status {
        case 404 where code == "not_found" && path == "api/v1/places/reverse": return ["notFound": true]
        case 404, 405: throw CensusServiceError.unsupported
        case 429: throw CensusServiceError.unavailable("Too many searches. Wait a minute and try again.")
        case 503 where places: throw CensusServiceError.unavailable("Address search is not set up.")
        case 401: throw MobileError.unauthorized
        default:
            throw CensusServiceError.unavailable(places ? "Address search is not available right now." : "The server could not answer right now.")
        }
    }

    func config() async throws -> Data {
        let object = try await send("GET", "api/v1/masters/census-config", places: false)
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
    func autocomplete(input: String, session: UUID, near: (Double, Double)?) async throws -> [PlacePrediction] {
        var query = [URLQueryItem(name: "input", value: input), URLQueryItem(name: "session", value: session.uuidString.lowercased())]
        if let near { query += [URLQueryItem(name: "lat", value: String(near.0)), URLQueryItem(name: "lng", value: String(near.1))] }
        let object = try await send("GET", "api/v1/places/autocomplete", query: query, places: true)
        return (object["predictions"] as? [[String: Any]] ?? []).prefix(5).compactMap { row in
            guard let id = row["placeId"] as? String, !id.isEmpty else { return nil }
            let primary = row["primary"] as? String ?? row["description"] as? String ?? ""
            return PlacePrediction(placeId: id, primary: primary, secondary: row["secondary"] as? String ?? "")
        }
    }
    func details(placeId: String, session: UUID) async throws -> PlaceDetails {
        let object = try await send("GET", "api/v1/places/details", query: [URLQueryItem(name: "placeId", value: placeId),
            URLQueryItem(name: "session", value: session.uuidString.lowercased())], places: true)
        guard let address = PlaceAddress(wire: object), let lat = (object["latitude"] as? NSNumber)?.doubleValue,
              let lng = (object["longitude"] as? NSNumber)?.doubleValue, abs(lat) <= 90, abs(lng) <= 180 else {
            throw CensusServiceError.unavailable("Address search is not available right now.")
        }
        return PlaceDetails(placeId: object["placeId"] as? String ?? placeId, address: address, latitude: lat, longitude: lng)
    }
    func reverse(latitude: Double, longitude: Double) async throws -> PlaceAddress? {
        let object = try await send("GET", "api/v1/places/reverse", query: [URLQueryItem(name: "lat", value: String(latitude)),
            URLQueryItem(name: "lng", value: String(longitude))], places: true)
        if object["notFound"] as? Bool == true { return nil }
        return PlaceAddress(wire: object)
    }
    func duplicateCheck(_ body: [String: Any]) async throws -> [CensusCandidate] {
        let object = try await send("POST", "api/v1/masters/census/duplicate-check", body: body, places: false)
        return (object["candidates"] as? [[String: Any]] ?? []).compactMap(CensusCandidate.init(wire:))
    }
}

/// The signed `census.capture` operation (same op as Android; `ctx.app` is `field-ios`).
enum CensusCapture {
    static let kind = "census.capture"
    static let maxPhotoBytes = 160 * 1024
    static let maxAccuracyMeters = 50.0
    static let maxFixSkewMs: Int64 = 120_000

    enum Failure: Error, Equatable {
        case details, phone, channel, batch, location, photo, landmark
        var message: String {
            switch self {
            case .details: "Fill in the store name, address, owner name and owner phone."
            case .phone: "Enter the owner's full phone number."
            case .channel: "Choose a channel and sub-channel."
            case .batch: "Choose a gathering batch."
            case .location: "Set the store location: use your location (better than ±50 m) or search the address."
            case .photo: "Take a storefront photo."
            case .landmark: "Keep the landmark under 200 characters."
            }
        }
    }

    enum Location: Equatable, Sendable {
        case gps(VisitLocation)
        case places(PlaceDetails)
    }

    struct Draft: Sendable {
        var captureId = UUID()
        var batchId: String?
        var name = "", address = "", ownerName = "", ownerPhone = ""
        var channelId: String?, subchannelId: String?
        var estimatedClass = "D"
        var landmark = ""
        var location: Location?
        /// The reverse-geocoded or Places address parts; only stored when the agent kept that address.
        var resolved: PlaceAddress?
        var photo: Data?
        var acknowledgedDuplicateIds: [String] = []
    }

    static func isJpeg(_ d: Data) -> Bool {
        d.count >= 4 && d[d.startIndex] == 0xFF && d[d.startIndex + 1] == 0xD8 && d[d.endIndex - 2] == 0xFF && d[d.endIndex - 1] == 0xD9
    }

    static func gpsUsable(_ fix: VisitLocation, at: Int64) -> Bool {
        !fix.mockSignal && fix.accuracyMeters > 0 && fix.accuracyMeters < maxAccuracyMeters && abs(at - fix.fixTime) <= maxFixSkewMs
    }

    private static func isUUID(_ s: String) -> Bool { s.count == 36 && UUID(uuidString: s) != nil }

    /// The wire payload. Throws the first plain-words problem.
    static func payload(_ d: Draft, now: Date) throws -> [String: Any] {
        let t = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines) }
        let name = t(d.name), address = t(d.address), owner = t(d.ownerName), phone = t(d.ownerPhone), landmark = t(d.landmark)
        guard (1...200).contains(name.count), (1...500).contains(address.count), (1...150).contains(owner.count),
              (1...40).contains(phone.count) else { throw Failure.details }
        guard phone.filter({ $0.isASCII && $0.isNumber }).count >= 7 else { throw Failure.phone }
        guard let channel = d.channelId, let sub = d.subchannelId, isUUID(channel), isUUID(sub) else { throw Failure.channel }
        if let batch = d.batchId, !isUUID(batch) { throw Failure.batch }
        guard landmark.count <= 200 else { throw Failure.landmark }
        guard ["A", "B", "C", "D"].contains(d.estimatedClass) else { throw Failure.details }
        guard let photo = d.photo, isJpeg(photo), photo.count <= maxPhotoBytes else { throw Failure.photo }
        let at = Int64(now.timeIntervalSince1970 * 1000)
        var p: [String: Any] = ["captureId": d.captureId.uuidString.lowercased(), "name": name, "address": address,
            "ownerName": owner, "ownerPhone": phone, "channelId": channel, "subchannelId": sub,
            "estimatedClass": d.estimatedClass, "deviceTime": at, "photoJpegBase64": photo.base64EncodedString()]
        if let batch = d.batchId { p["batchId"] = batch }
        switch d.location {
        case .gps(let fix)?:
            guard gpsUsable(fix, at: at) else { throw Failure.location }
            p["locationSource"] = "gps"
            p["location"] = ["latitude": fix.latitude, "longitude": fix.longitude, "accuracyMeters": fix.accuracyMeters,
                             "provider": fix.provider, "mockSignal": false, "fixTime": fix.fixTime]
        case .places(let place)?:
            guard !place.placeId.isEmpty else { throw Failure.location }
            p["locationSource"] = "places"
            p["placeId"] = place.placeId
            p["location"] = ["latitude": place.latitude, "longitude": place.longitude]
        case nil: throw Failure.location
        }
        if let r = d.resolved {
            p["addressComponents"] = r.components
            p["formattedAddress"] = r.formattedAddress
        }
        if !landmark.isEmpty { p["landmark"] = landmark }
        if !d.acknowledgedDuplicateIds.isEmpty { p["acknowledgedDuplicateIds"] = Array(d.acknowledgedDuplicateIds.prefix(10)) }
        return p
    }

    /// The immutable outbox operation (v1 shape; `NativeV2.operation` maps it to the v2 envelope).
    static func intent(_ payload: [String: Any]) throws -> VisitIntent {
        guard let id = (payload["captureId"] as? String).flatMap(UUID.init(uuidString:)) else { throw Failure.details }
        let op: [String: Any] = ["clientRequestId": id.uuidString.lowercased(), "kind": kind, "dependsOn": [], "payload": payload]
        return VisitIntent(requestId: id, kind: kind, operationJSON: try JSONSerialization.data(withJSONObject: op, options: [.sortedKeys]))
    }

    /// Store-side check of a queued capture: the same rules the payload builder applies, read back from JSON.
    static func validStored(_ payload: [String: Any], now: Date) -> Bool {
        guard let id = payload["captureId"] as? String, UUID(uuidString: id) != nil,
              let at = (payload["deviceTime"] as? NSNumber)?.int64Value,
              abs(Int64(now.timeIntervalSince1970 * 1000) - at) <= maxFixSkewMs,
              let photo = (payload["photoJpegBase64"] as? String).flatMap({ Data(base64Encoded: $0) }),
              isJpeg(photo), photo.count <= maxPhotoBytes,
              let l = payload["location"] as? [String: Any],
              let lat = (l["latitude"] as? NSNumber)?.doubleValue, let lng = (l["longitude"] as? NSNumber)?.doubleValue,
              lat.isFinite, abs(lat) <= 90, lng.isFinite, abs(lng) <= 180 else { return false }
        for key in ["name", "address", "ownerName", "ownerPhone", "channelId", "subchannelId"] {
            guard let v = payload[key] as? String, !v.isEmpty else { return false }
        }
        switch payload["locationSource"] as? String {
        case "places": return (payload["placeId"] as? String)?.isEmpty == false
        case "gps", nil:
            guard let acc = (l["accuracyMeters"] as? NSNumber)?.doubleValue, acc > 0, acc < maxAccuracyMeters,
                  l["mockSignal"] as? Bool == false, let fixTime = (l["fixTime"] as? NSNumber)?.int64Value,
                  abs(at - fixTime) <= maxFixSkewMs else { return false }
            return true
        default: return false
        }
    }
}
