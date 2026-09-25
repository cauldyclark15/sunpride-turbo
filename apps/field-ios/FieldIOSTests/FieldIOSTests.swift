import XCTest
@testable import FieldIOS

final class FieldIOSTests: XCTestCase {
    func testEnvironmentAcceptsHTTPSAndLocalhostHTTP() throws {
        let https = try AppEnvironment(values: ["CONVEX_SITE_URL": "https://example.convex.site", "CONVEX_URL": "https://example.convex.cloud"])
        XCTAssertEqual(https.siteURL.host, "example.convex.site")
        let local = try AppEnvironment(values: ["CONVEX_SITE_URL": "http://localhost:3000", "CONVEX_URL": "http://localhost:3001"])
        XCTAssertEqual(local.convexURL.port, 3001)
    }

    func testEnvironmentRejectsEmptyInsecureAndCredentials() {
        for invalid in ["", "http://example.com", "http://127.0.0.1", "https://user:pass@example.com", "https://example.com?token=bad"] {
            XCTAssertThrowsError(try AppEnvironment(values: ["CONVEX_SITE_URL": invalid, "CONVEX_URL": "https://example.com"]), invalid)
        }
        XCTAssertThrowsError(try AppEnvironment(values: [:]))
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
            (SunprideTokens.snow, .init(hex: 0x272727))
        ]
        for (foreground, background) in pairs {
            XCTAssertGreaterThanOrEqual(foreground.contrast(with: background), 4.5)
        }
    }
}
