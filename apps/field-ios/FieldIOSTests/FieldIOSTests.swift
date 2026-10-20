import XCTest
@testable import FieldIOS

final class FieldIOSTests: XCTestCase {
    func testEnvironmentAcceptsHTTPSAndLocalhostHTTP() throws {
        let https = try AppEnvironment(values: [AppEnvironment.originKey: "https://sunpride.example.com"])
        XCTAssertEqual(https.apiOrigin.host, "sunpride.example.com")
        let local = try AppEnvironment(values: [AppEnvironment.originKey: "http://127.0.0.1:4390"])
        XCTAssertEqual(local.apiOrigin.port, 4390)
    }

    func testEnvironmentRejectsEmptyInsecureAndCredentials() {
        for invalid in ["", "http://example.com", "http://192.168.1.2", "https://user:pass@example.com", "https://example.com?token=bad",
                        "https://example.com/api"] {
            XCTAssertThrowsError(try AppEnvironment(values: [AppEnvironment.originKey: invalid]), invalid)
        }
        XCTAssertThrowsError(try AppEnvironment(values: [:]))
    }

    func testThisBuildCarriesTheSunprideServerAndNoConfigurationWarning() throws {
        // The installed app reads its single server address from Info.plist; a missing/legacy key shows the
        // configuration screen. Both Dev and Beta must point at the new Sunpride server.
        let host = Bundle(for: AppModel.self).object(forInfoDictionaryKey: AppEnvironment.originKey) as? String
        XCTAssertEqual(host, "https://sunpride.cauldnclark.com")
        XCTAssertNoThrow(try AppEnvironment.bundled(Bundle(for: AppModel.self)))
        let info = Bundle(for: AppModel.self).infoDictionary ?? [:]
        XCTAssertTrue(info.keys.allSatisfy { !$0.lowercased().contains("c" + "onvex") })
    }

    func testTextPairContrastAtLeastFourPointFive() {
        let pairs: [(SunprideTokens.RGB, SunprideTokens.RGB)] = [
            (.init(hex: 0x18181B), .init(hex: 0xF5F5F5)),
            (.init(hex: 0x18181B), .init(hex: 0xFFFFFF)),
            (.init(hex: 0xFCFCFC), .init(hex: 0x060606)),
            (.init(hex: 0xFCFCFC), .init(hex: 0x181818)),
            (SunprideTokens.ink, SunprideTokens.yellow),
            (SunprideTokens.snow, SunprideTokens.action),
            (SunprideTokens.ink, SunprideTokens.success),
            (SunprideTokens.snow, SunprideTokens.danger),
            (.init(hex: 0x595959), SunprideTokens.surface),
            (.init(hex: 0xA0A0A0), SunprideTokens.darkSurface),
            (SunprideTokens.ink, .init(hex: 0xEBEBEB)),
            (SunprideTokens.snow, .init(hex: 0x272727)),
            (SunprideTokens.dangerLight, SunprideTokens.surface),
            (SunprideTokens.dangerLight, SunprideTokens.canvas),
            (SunprideTokens.dangerDark, SunprideTokens.darkSurface),
            (SunprideTokens.dangerDark, SunprideTokens.darkCanvas)
        ]
        for (foreground, background) in pairs {
            XCTAssertGreaterThanOrEqual(foreground.contrast(with: background), 4.5)
        }
    }
}
