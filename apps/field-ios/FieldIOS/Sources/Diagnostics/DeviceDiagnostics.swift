import Foundation
import UIKit

/// Non-secret facts shown on the enrollment screen and handed to the admin who registers the phone.
struct DeviceDiagnostics: Equatable, Sendable {
    let model: String
    let osVersion: String
    let appVersion: String
    let keyStorage: String

    @MainActor
    static func current(keyStorage: DeviceKeyStorage?) -> DeviceDiagnostics {
        var systemInfo = utsname()
        uname(&systemInfo)
        let machine = withUnsafeBytes(of: &systemInfo.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        let simulatorModel = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"]
        let identifier = simulatorModel.map { "\($0) (Simulator)" } ?? machine
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return DeviceDiagnostics(model: identifier,
                                 osVersion: UIDevice.current.systemVersion,
                                 appVersion: "\(version) (\(build))",
                                 keyStorage: keyStorage?.rawValue ?? "Unavailable")
    }
}

#if DEBUG
/// DEV-only helper: writes the **public** key to `Documents/device-public-key.txt` so the lead can pull it off
/// the simulator (`xcrun simctl get_app_container booted com.sunpride.field.dev data`). Never private material.
enum PublicKeyExport {
    static let fileName = "device-public-key.txt"

    @discardableResult
    static func write(publicKeyBase64: String, directory: URL? = nil) throws -> URL {
        guard let spki = Data(base64Encoded: publicKeyBase64), spki.count == 91 else { throw MobileError.deviceKeyUnavailable }
        let folder = try directory ?? FileManager.default.url(for: .documentDirectory, in: .userDomainMask,
                                                              appropriateFor: nil, create: true)
        let url = folder.appending(path: fileName)
        try Data((publicKeyBase64 + "\n").utf8).write(to: url, options: [.atomic])
        return url
    }
}
#endif
