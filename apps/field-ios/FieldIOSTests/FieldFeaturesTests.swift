import ImageIO
import UIKit
import XCTest
@testable import FieldIOS

/// SP-0132: the beta feature list, "Report an issue", version label and the Sunpride logo assets.
final class FieldFeaturesTests: XCTestCase {
    func testBetaShowsTheProductFeaturesAndHidesTheBetaList() {
        let beta = FieldFeatures.forBuild(debug: false, webURL: "")
        XCTAssertTrue(beta.contains(.visits))
        XCTAssertTrue(beta.contains(.team))
        XCTAssertFalse(beta.contains(.unplannedVisits))
        XCTAssertFalse(beta.contains(.phoneKeyDetails))
        XCTAssertFalse(beta.contains(.developerTools))
        XCTAssertEqual(beta.enabled,
                       Set(FieldFeature.allCases).subtracting(FieldFeatures.hiddenInBeta).subtracting(FieldFeatures.developerOnly))
    }

    func testDebugBuildShowsEverythingIncludingDeveloperTools() {
        XCTAssertEqual(FieldFeatures.forBuild(debug: true, webURL: "").enabled, Set(FieldFeature.allCases))
        XCTAssertFalse(FieldFeatures.forBuild(debug: false, webURL: "https://sunpride.keepr.im").contains(.developerTools))
    }

    func testHiddenEntriesAreNeverTheCoreVisitFlow() {
        XCTAssertFalse(FieldFeatures.hiddenInBeta.contains(.visits))
        XCTAssertFalse(FieldFeatures.hiddenInBeta.contains(.team))
        XCTAssertTrue(FieldFeatures.developerOnly == [.developerTools])
    }

    func testReportAnIssueOpensTheWebTrackerOrIsHidden() {
        XCTAssertEqual(FieldFeatures.reportIssueURL("https://sunpride.keepr.im")?.absoluteString,
                       "https://sunpride.keepr.im/issues/new")
        XCTAssertEqual(FieldFeatures.reportIssueURL(" https://sunpride.keepr.im/ ")?.absoluteString,
                       "https://sunpride.keepr.im/issues/new")
        XCTAssertEqual(FieldFeatures.reportIssueURL("http://192.168.1.20:3000")?.absoluteString,
                       "http://192.168.1.20:3000/issues/new")
        XCTAssertEqual(FieldFeatures.forBuild(debug: false, webURL: "https://sunpride.keepr.im").reportIssueURL?.absoluteString,
                       "https://sunpride.keepr.im/issues/new")
        for bad in ["", "   ", "sunpride.keepr.im", "javascript:alert(1)", "ftp://sunpride.keepr.im", "https://",
                    "https://sunpride.keepr.im?x=1", "https://sunpride.keepr.im/#a", "https://sunpride keepr.im",
                    "https://user:pw@sunpride.keepr.im", "$(FIELD_WEB_URL)"] {
            XCTAssertNil(FieldFeatures.reportIssueURL(bad), bad)
        }
        XCTAssertNil(FieldFeatures.forBuild(debug: false, webURL: "").reportIssueURL)
    }

    func testThisBuildCarriesTheTrackerLink() {
        // Dev and Beta xcconfigs both point "Report an issue" at the Sunpride web tracker.
        XCTAssertEqual(FieldFeatures.current.reportIssueURL?.absoluteString, "https://sunpride.keepr.im/issues/new")
        // Unit tests run the Debug configuration: every feature, developer tools included.
        XCTAssertEqual(FieldFeatures.current.enabled, Set(FieldFeature.allCases))
    }

    func testVersionLabelPrefersTheBetaLabel() {
        XCTAssertEqual(AppVersion.label(info: ["CFBundleShortVersionString": "1.0.0", "CFBundleVersion": "7",
                                               "FIELD_VERSION_LABEL": "1.0.0-beta.7"]), "1.0.0-beta.7 (7)")
        XCTAssertEqual(AppVersion.label(info: ["CFBundleShortVersionString": "1.0", "CFBundleVersion": "1",
                                               "FIELD_VERSION_LABEL": ""]), "1.0 (1)")
        XCTAssertEqual(AppVersion.label(info: ["CFBundleShortVersionString": "1.0", "CFBundleVersion": "1",
                                               "FIELD_VERSION_LABEL": "$(FIELD_VERSION_LABEL)"]), "1.0 (1)")
        XCTAssertEqual(AppVersion.label(info: nil), "unknown (unknown)")
        XCTAssertEqual(AppVersion.label(info: Bundle.main.infoDictionary), "1.0 (1)")
    }

    // MARK: Logo assets (icon, launch screen, sign-in)

    func testLaunchScreenIsTheLogoOnTheLogoRed() throws {
        let launch = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "UILaunchScreen") as? [String: Any])
        XCTAssertEqual(launch["UIColorName"] as? String, "LaunchBackground")
        XCTAssertEqual(launch["UIImageName"] as? String, "SunprideLogo")
        let red = try XCTUnwrap(UIColor(named: "LaunchBackground"))
        var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        XCTAssertTrue(red.getRed(&r, green: &g, blue: &b, alpha: &a))
        // #EE1C25: the logo's own red (= SunprideTokens.red and the Android splash).
        XCTAssertEqual([r, g, b, a].map { Int(($0 * 255).rounded()) }, [0xEE, 0x1C, 0x25, 255])
        let logo = try XCTUnwrap(UIImage(named: "SunprideLogo"))
        XCTAssertEqual(logo.size, CGSize(width: 160, height: 160))
    }

    func testAppIconIsTheCatalogIcon() throws {
        let icons = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any])
        let primary = try XCTUnwrap(icons["CFBundlePrimaryIcon"] as? [String: Any])
        XCTAssertEqual(primary["CFBundleIconName"] as? String, "AppIcon")
    }

    /// Reads the checked-in icon set from source (simulator only; a phone has no repo checkout).
    func testIconSetHasEverySizeAndIsOpaque() throws {
        #if !targetEnvironment(simulator)
        throw XCTSkip("Reads source files from the repository; runs on the simulator")
        #else
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let set = root.appending(path: "FieldIOS/Resources/Assets.xcassets/AppIcon.appiconset")
        let contents = try JSONSerialization.jsonObject(with: Data(contentsOf: set.appending(path: "Contents.json")))
        let images = try XCTUnwrap((contents as? [String: Any])?["images"] as? [[String: String]])
        XCTAssertEqual(images.count, 18)
        XCTAssertTrue(images.contains { $0["idiom"] == "ios-marketing" && $0["size"] == "1024x1024" })
        for image in images {
            let points = try XCTUnwrap(Double(try XCTUnwrap(image["size"]).split(separator: "x")[0]))
            let scale = try XCTUnwrap(Double(try XCTUnwrap(image["scale"]).dropLast()))
            let file = set.appending(path: try XCTUnwrap(image["filename"]))
            let source = try XCTUnwrap(CGImageSourceCreateWithURL(file as CFURL, nil))
            let bitmap = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
            XCTAssertEqual(bitmap.width, Int((points * scale).rounded()), file.lastPathComponent)
            XCTAssertEqual(bitmap.height, bitmap.width)
            XCTAssertTrue([.none, .noneSkipLast, .noneSkipFirst].contains(bitmap.alphaInfo), "\(file.lastPathComponent) has alpha")
        }
        #endif
    }
}
