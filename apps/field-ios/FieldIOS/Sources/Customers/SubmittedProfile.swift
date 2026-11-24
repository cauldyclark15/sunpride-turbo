import Foundation

/// SP-0250 online profile editing uses the canonical customer writer, never cached approval rights.
struct SubmittedProfile: Decodable {
    let customer: Customer
    let fields: [Field]
    let missingFields: [Missing]
    struct Customer: Decodable {
        let id: String
        let customerName: String?
        let canEdit: Bool
        let updatedAt: Int64
        let status: String
        let enrolmentStatus: String?
        let history: [History]
        let historyTruncated: Bool
        var waiting: Bool { status == "prospect" || (status == "active" && enrolmentStatus == "provisional") }
    }
    struct Field: Decodable, Identifiable {
        let key: String
        let label: String
        let section: String
        let kind: String
        let value: String
        let options: [Option]
        let clears: [String]
        let error: String?
        var id: String { key }
    }
    struct Option: Decodable, Identifiable { let code: String; let name: String; var id: String { code } }
    struct Missing: Decodable { let field: String; let label: String; let message: String }
    struct History: Decodable, Identifiable {
        let id: String; let at: Int64; let actor: String; let changes: [Change]
    }
    struct Change: Decodable, Identifiable {
        let field: String; let label: String; let before: Fact?; let after: Fact?
        var id: String { field }
    }
    enum Fact: Decodable {
        case text(String), number(Double), boolean(Bool)
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self) { self = .text(s) }
            else if let b = try? c.decode(Bool.self) { self = .boolean(b) }
            else { self = .number(try c.decode(Double.self)) }
        }
        var text: String {
            switch self { case .text(let s): s.isEmpty ? "Not set" : s
            case .number(let n): String(n)
            case .boolean(let b): b ? "Yes" : "No" }
        }
    }
    static func body(edits: [String: String], updatedAt: Int64) throws -> Data {
        let values: [String: Any] = edits.mapValues { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? NSNull() : $0 as Any }
        return try JSONSerialization.data(withJSONObject: ["edits": values, "expectedUpdatedAt": updatedAt], options: [.sortedKeys])
    }
    static func changing(_ edits: [String: String], field: Field, value: String) -> [String: String] {
        var result = edits; result[field.key] = value
        for key in field.clears { result[key] = "" }
        return result
    }
}

struct SubmittedCustomerList: Decodable {
    let rows: [Row]; let nextCursor: String?
    struct Row: Decodable, Identifiable {
        let id: String; let customerName: String; let registeredName: String?; let status: String; let enrolmentStatus: String?
        var title: String { registeredName?.isEmpty == false ? registeredName! : customerName }
        var state: String { status == "prospect" || enrolmentStatus == "provisional" ? "Waiting for approval" : status == "inactive" ? "Closed" : "Approved" }
    }
}
